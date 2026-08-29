#!/usr/bin/env python3
"""Associative-recall producer for OpenClaw.

Watch the active main-agent SQLite transcript for new user messages, ask a
small retrieval model to select one critical memory fragment, and enqueue it
through the memory-prepend listener. The next adopted agent turn claims and
prepends queued fragments.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


OPENCLAW_HOME = Path.home() / ".openclaw"
WORKSPACE = OPENCLAW_HOME / "workspace"
AGENT_DB_PATH = OPENCLAW_HOME / "agents" / "main" / "agent" / "openclaw-agent.sqlite"
MAIN_SESSION_KEY = "agent:main:main"
DEFAULT_ENQUEUE_URL = "http://127.0.0.1:8100/memory/enqueue"
DEFAULT_MODEL_URL = "http://127.0.0.1:4001/v1/chat/completions"
DEFAULT_MODEL = "aineko-recall"

TIER2_GLOBS = [
    "memory/tier2-*.md",
    "memory/20??-??-??.md",
]

HEARTBEAT_PATTERN = re.compile(r"Read HEARTBEAT\.md if it exists", re.IGNORECASE)


def open_session_database(database_path: Path = AGENT_DB_PATH) -> sqlite3.Connection:
    """Open the canonical agent database without taking a write-capable handle."""
    database_uri = f"{database_path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(
        database_uri,
        uri=True,
        timeout=2.0,
        isolation_level=None,
    )
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 2000")
    return connection


def find_active_session(connection: sqlite3.Connection) -> str | None:
    """Resolve the current transcript id for the canonical main session."""
    row = connection.execute(
        """SELECT current_session_id
             FROM session_nodes
            WHERE session_key = ? AND archived_at IS NULL""",
        (MAIN_SESSION_KEY,),
    ).fetchone()
    return row[0] if row and isinstance(row[0], str) and row[0] else None


def extract_message_text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts).strip()


def tail_last_user_message(
    connection: sqlite3.Connection,
    session_id: str,
    after_seq: int | None = None,
) -> dict | None:
    """Read the latest user message from the current SQLite transcript."""
    row = connection.execute(
        """SELECT seq, event_json
             FROM transcript_events
            WHERE session_id = ?
              AND json_extract(event_json, '$.type') = 'message'
              AND json_extract(event_json, '$.message.role') = 'user'
            ORDER BY seq DESC
            LIMIT 1""",
        (session_id,),
    ).fetchone()
    if not row or not isinstance(row[0], int) or not isinstance(row[1], str):
        return None
    seq = row[0]
    if after_seq is not None and seq <= after_seq:
        return None
    try:
        entry = json.loads(row[1])
    except json.JSONDecodeError:
        return None
    message = entry.get("message") if isinstance(entry, dict) else None
    content = extract_message_text(message)
    if not content or HEARTBEAT_PATTERN.search(content):
        return None
    return {"seq": seq, "content": content}


def find_current_message_cursor(
    connection: sqlite3.Connection,
) -> tuple[str, int] | None:
    """Seed startup state so a producer restart does not rescore an old turn."""
    session_id = find_active_session(connection)
    if not session_id:
        return None
    latest = tail_last_user_message(connection, session_id)
    if not latest:
        return None
    return (session_id, latest["seq"])


def get_recent_conversation(
    connection: sqlite3.Connection,
    session_id: str,
    n_turns: int = 6,
) -> str:
    """Extract a bounded recent human/assistant window for scoring context."""
    rows = connection.execute(
        """SELECT event_json
             FROM transcript_events
            WHERE session_id = ?
              AND json_extract(event_json, '$.type') = 'message'
              AND json_extract(event_json, '$.message.role') IN ('user', 'assistant')
            ORDER BY seq DESC
            LIMIT ?""",
        (session_id, max(n_turns * 4, n_turns)),
    ).fetchall()

    messages = []
    for (event_json,) in rows:
        if not isinstance(event_json, str):
            continue
        try:
            entry = json.loads(event_json)
        except json.JSONDecodeError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        content = extract_message_text(message)
        if not content:
            continue
        if role == "user" and HEARTBEAT_PATTERN.search(content):
            continue
        if content == "HEARTBEAT_OK":
            continue
        item = (role, content[:500])
        if messages and messages[-1] == item:
            continue
        messages.append(item)
        if len(messages) >= n_turns:
            break

    messages.reverse()
    return "\n".join(f"[{role}]: {content}" for role, content in messages)


def gather_memory_snippets(max_chars: int = 30000) -> str:
    """Read tier-2 and recent daily memory files up to a bounded size."""
    snippets = []
    total = 0
    for pattern in TIER2_GLOBS:
        for path in sorted(WORKSPACE.glob(pattern)):
            try:
                text = path.read_text(encoding="utf-8")
                header = f"\n--- {path.relative_to(WORKSPACE)} ---\n"
                if total + len(header) + len(text) > max_chars:
                    remaining = max_chars - total - len(header)
                    if remaining > 200:
                        snippets.append(header + text[:remaining] + "\n[truncated]")
                    return "".join(snippets)
                snippets.append(header + text)
                total += len(header) + len(text)
            except OSError:
                continue
    return "".join(snippets)


def rate_memories(
    conversation: str,
    memories: str,
    model_url: str = DEFAULT_MODEL_URL,
    model: str = DEFAULT_MODEL,
    timeout_seconds: float = 30.0,
) -> dict | None:
    """Ask the configured OpenAI-compatible model for one memory fragment."""
    prompt = f"""You are a memory retrieval system for an AI agent named Aineko.

Given the recent conversation and a corpus of memory files, find the SINGLE most important memory fragment that the agent likely needs but probably doesn't have in immediate context.

Rules:
- Return ONLY memories that are CRITICAL and RELEVANT to the current conversation topic
- Don't surface things already being discussed
- Don't surface general identity/operational info (that's in Tier 1)
- Focus on: specific facts, dates, people, prior decisions, research findings, or context that would change how the agent responds
- Score 0-10 where 10 = "the agent will make a mistake without this"

RECENT CONVERSATION:
{conversation}

MEMORY CORPUS:
{memories}

Respond in JSON only:
{{"score": <0-10>, "fragment": "<the critical text, max 500 chars>", "source": "<filename>", "reason": "<why this matters right now>"}}

If nothing scores above 5, respond: {{"score": 0, "fragment": "", "source": "", "reason": "nothing critical"}}"""

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "Return exactly one JSON object and no markdown.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0,
            "max_tokens": 512,
            "reasoning_effort": "none",
            "stream": False,
        },
        ensure_ascii=True,
    ).encode("utf-8")
    request = urllib.request.Request(
        model_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            response_payload = json.load(response)
        message = response_payload["choices"][0]["message"]
        text = (
            message.get("content")
            or message.get("reasoning_content")
            or message.get("reasoning")
        )
        if not isinstance(text, str):
            return None
        text = re.sub(r"^```(?:json)?\s*", "", text.strip())
        text = re.sub(r"\s*```$", "", text)
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            return None
        rating = json.loads(text[start : end + 1])
        return rating if isinstance(rating, dict) else None
    except urllib.error.HTTPError as error:
        print(
            f"[memory-sidecar] model call returned HTTP {error.code}",
            file=sys.stderr,
        )
    except (
        urllib.error.URLError,
        TimeoutError,
        OSError,
        KeyError,
        IndexError,
        TypeError,
        json.JSONDecodeError,
    ) as error:
        print(f"[memory-sidecar] model call failed: {error}", file=sys.stderr)
    return None


def format_memory_prepend_text(fragment: str, source: str, reason: str) -> str:
    """Keep useful provenance without duplicating the consumer's block label."""
    lines = []
    if source.strip():
        lines.append(f"Source: {source.strip()}")
    if reason.strip():
        lines.append(f"Why now: {reason.strip()}")
    lines.append(fragment.strip())
    return "\n".join(lines)


def inject_memory(
    fragment: str,
    source: str,
    reason: str,
    enqueue_url: str = DEFAULT_ENQUEUE_URL,
    timeout_seconds: float = 5.0,
) -> bool:
    """POST one fragment to the durable memory-prepend queue listener."""
    payload = json.dumps(
        {"text": format_memory_prepend_text(fragment, source, reason)},
        ensure_ascii=True,
    ).encode("utf-8")
    request = urllib.request.Request(
        enqueue_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = response.getcode()
            response.read()
        if status in (200, 201):
            outcome = "queued" if status == 201 else "already queued"
            print(f"[memory-sidecar] {outcome} fragment from {source}", file=sys.stderr)
            return True
        print(f"[memory-sidecar] enqueue returned HTTP {status}", file=sys.stderr)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
        print(f"[memory-sidecar] enqueue failed: {error}", file=sys.stderr)
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Memory sidecar for OpenClaw")
    parser.add_argument(
        "--interval", type=int, default=15, help="Minimum minutes between injections"
    )
    parser.add_argument("--poll", type=int, default=10, help="Seconds between session checks")
    parser.add_argument(
        "--threshold", type=int, default=6, help="Minimum criticality score to enqueue"
    )
    parser.add_argument(
        "--enqueue-url",
        default=os.environ.get("OPENCLAW_MEMORY_PREPEND_URL", DEFAULT_ENQUEUE_URL),
        help="Loopback memory-prepend enqueue endpoint",
    )
    parser.add_argument(
        "--enqueue-timeout",
        type=float,
        default=5.0,
        help="Seconds to wait for an enqueue response",
    )
    parser.add_argument(
        "--model-url",
        default=DEFAULT_MODEL_URL,
        help="OpenAI-compatible chat completions endpoint",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="kzproxy model or pool alias to use for memory scoring",
    )
    parser.add_argument(
        "--model-timeout",
        type=float,
        default=30.0,
        help="Seconds to wait for a model response",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    print(
        "[memory-sidecar] starting: "
        f"interval={args.interval}m poll={args.poll}s threshold={args.threshold} "
        f"model={args.model} dry_run={args.dry_run}"
    )

    connection = open_session_database()
    last_message_cursor = find_current_message_cursor(connection)
    last_inject_time = 0.0
    pending_injection = None

    try:
        while True:
            try:
                if pending_injection:
                    success = inject_memory(
                        pending_injection["fragment"],
                        pending_injection["source"],
                        pending_injection["reason"],
                        enqueue_url=args.enqueue_url,
                        timeout_seconds=args.enqueue_timeout,
                    )
                    if success:
                        last_inject_time = time.time()
                        pending_injection = None
                    else:
                        if args.verbose:
                            print("[memory-sidecar] retaining failed enqueue for retry")
                        time.sleep(args.poll)
                        continue

                session_id = find_active_session(connection)
                if not session_id:
                    if args.verbose:
                        print("[memory-sidecar] no active session found", file=sys.stderr)
                    time.sleep(args.poll)
                    continue

                after_seq = (
                    last_message_cursor[1]
                    if last_message_cursor and last_message_cursor[0] == session_id
                    else None
                )
                new_msg = tail_last_user_message(
                    connection,
                    session_id,
                    after_seq=after_seq,
                )
                if not new_msg:
                    time.sleep(args.poll)
                    continue
                last_message_cursor = (session_id, new_msg["seq"])

                now = time.time()
                cooldown = args.interval * 60
                if now - last_inject_time < cooldown:
                    if args.verbose:
                        remaining = int(cooldown - (now - last_inject_time))
                        print(f"[memory-sidecar] rate limited, {remaining}s remaining")
                    time.sleep(args.poll)
                    continue

                print(
                    f"[memory-sidecar] scoring session={session_id[:12]} "
                    f"seq={new_msg['seq']}",
                    file=sys.stderr,
                )

                conversation = get_recent_conversation(
                    connection,
                    session_id,
                    n_turns=8,
                )
                memories = gather_memory_snippets(max_chars=25000)
                if not conversation or not memories:
                    if args.verbose:
                        print("[memory-sidecar] no conversation or memory corpus to score")
                    time.sleep(args.poll)
                    continue

                result = rate_memories(
                    conversation,
                    memories,
                    model_url=args.model_url,
                    model=args.model,
                    timeout_seconds=args.model_timeout,
                )
                if not result:
                    print(
                        "[memory-sidecar] rating returned no usable JSON",
                        file=sys.stderr,
                    )
                    time.sleep(args.poll)
                    continue

                raw_score = result.get("score")
                score = (
                    float(raw_score)
                    if isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool)
                    else 0.0
                )
                fragment = result.get("fragment")
                source = result.get("source")
                reason = result.get("reason")
                fragment = fragment if isinstance(fragment, str) else ""
                source = source if isinstance(source, str) else "unknown"
                reason = reason if isinstance(reason, str) else ""
                log_source = source.replace("\n", " ")[:160]
                print(
                    f"[memory-sidecar] score={score:g} source={log_source}",
                    file=sys.stderr,
                )
                if score < args.threshold or not fragment.strip():
                    continue

                if args.dry_run:
                    print(
                        f"[memory-sidecar] DRY RUN — would enqueue score={score:g} "
                        f"from {log_source}"
                    )
                    last_inject_time = now
                    continue

                pending_injection = {
                    "fragment": fragment,
                    "source": source,
                    "reason": reason,
                }
                if inject_memory(
                    fragment,
                    source,
                    reason,
                    enqueue_url=args.enqueue_url,
                    timeout_seconds=args.enqueue_timeout,
                ):
                    last_inject_time = time.time()
                    pending_injection = None

            except KeyboardInterrupt:
                print("\n[memory-sidecar] shutting down")
                break
            except Exception as error:
                print(f"[memory-sidecar] error: {error}", file=sys.stderr)

            time.sleep(args.poll)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
