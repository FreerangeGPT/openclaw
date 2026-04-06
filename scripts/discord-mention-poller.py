#!/usr/bin/env python3
"""
Discord mention poller -> OpenClaw session injector (zero external deps).

What it does:
1. Ensures only one poller instance is running (PID file check).
2. Reads Discord token + channel hints from `openclaw config`.
3. Polls Discord channels on a staggered schedule.
4. Injects missed bot-authored mentions into the exact Discord session key via:
   `openclaw gateway call agent`.

Default behavior is daemon mode (infinite loop). This is intended for cron-style
"ensure running" jobs: if already running, it exits quickly; if not, it starts.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DISCORD_API_BASE = "https://discord.com/api/v10"
DEFAULT_AGENT_ID = "main"
DEFAULT_DISCORD_ACCOUNT = "default"
DEFAULT_BASE_INTERVAL = 30.0
DEFAULT_FAST_INTERVAL = 5.0
DEFAULT_FAST_HOLD_SECONDS = 120.0
DEFAULT_OFFSET_STEP = 5.0
DEFAULT_FETCH_LIMIT = 50
DEFAULT_OPENCLAW_BIN = "openclaw"
DEFAULT_GATEWAY_CALL_TIMEOUT = 180.0
SCRIPT_VERSION = 1

STOP_REQUESTED = False


def ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    print(f"[{ts()}] {msg}", flush=True)


def warn(msg: str) -> None:
    log(f"WARN: {msg}")


def err(msg: str) -> None:
    log(f"ERROR: {msg}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Poll Discord mentions and inject missed messages into OpenClaw Discord sessions.",
    )
    parser.add_argument("--agent-id", default=os.environ.get("OPENCLAW_AGENT_ID", DEFAULT_AGENT_ID))
    parser.add_argument(
        "--discord-account",
        default=os.environ.get("OPENCLAW_DISCORD_ACCOUNT", DEFAULT_DISCORD_ACCOUNT),
        help="Discord account id from channels.discord.accounts.<id> (default: default).",
    )
    parser.add_argument(
        "--channels",
        default=os.environ.get("OPENCLAW_DISCORD_POLL_CHANNELS", ""),
        help="Comma-separated Discord channel ids (channel:123 also accepted).",
    )
    parser.add_argument(
        "--openclaw-bin",
        default=os.environ.get("OPENCLAW_BIN", DEFAULT_OPENCLAW_BIN),
        help="OpenClaw binary path/name.",
    )
    parser.add_argument(
        "--base-interval",
        type=float,
        default=float(os.environ.get("OPENCLAW_POLL_BASE_INTERVAL", DEFAULT_BASE_INTERVAL)),
    )
    parser.add_argument(
        "--fast-interval",
        type=float,
        default=float(os.environ.get("OPENCLAW_POLL_FAST_INTERVAL", DEFAULT_FAST_INTERVAL)),
    )
    parser.add_argument(
        "--fast-hold-seconds",
        type=float,
        default=float(os.environ.get("OPENCLAW_POLL_FAST_HOLD_SECONDS", DEFAULT_FAST_HOLD_SECONDS)),
    )
    parser.add_argument(
        "--offset-step",
        type=float,
        default=float(os.environ.get("OPENCLAW_POLL_OFFSET_STEP", DEFAULT_OFFSET_STEP)),
        help="Initial per-channel stagger in seconds (0, +step, +2*step...).",
    )
    parser.add_argument(
        "--fetch-limit",
        type=int,
        default=int(os.environ.get("OPENCLAW_POLL_FETCH_LIMIT", DEFAULT_FETCH_LIMIT)),
        help="Discord messages fetched per poll per channel (1-100).",
    )
    parser.add_argument(
        "--expect-final",
        action="store_true",
        help="Wait for final `agent` result (status=ok/error) instead of initial accepted ack.",
    )
    parser.add_argument(
        "--gateway-timeout",
        type=float,
        default=float(os.environ.get("OPENCLAW_GATEWAY_CALL_TIMEOUT", DEFAULT_GATEWAY_CALL_TIMEOUT)),
        help="Timeout in seconds for each `openclaw gateway call agent` invocation.",
    )
    parser.add_argument(
        "--process-backlog",
        action="store_true",
        help="On first run without cursor, process recent messages immediately (default skips existing).",
    )
    parser.add_argument(
        "--include-bot-messages-without-mention",
        action="store_true",
        help=(
            "Inject all bot-authored messages after the last human watermark, not only "
            "messages that @mention this bot."
        ),
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one poll pass for each channel and exit.",
    )
    parser.add_argument(
        "--force-thread-id",
        action="store_true",
        help=(
            "Legacy behavior: set threadId=<channelId> on injected runs. "
            "Disabled by default for webhook-parity session coherence."
        ),
    )
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--state-file",
        default="",
        help="State file path (default under ~/.openclaw/pollers).",
    )
    parser.add_argument(
        "--pid-file",
        default="",
        help="PID file path (default under ~/.openclaw/pollers).",
    )
    return parser.parse_args()


def normalize_channel_id(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if value.lower().startswith("channel:"):
        value = value.split(":", 1)[1].strip()
    return value


def parse_channel_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [segment.strip() for segment in raw.split(",")]
    elif isinstance(raw, list):
        parts = [str(item).strip() for item in raw]
    else:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for part in parts:
        cid = normalize_channel_id(part)
        if not cid or cid in seen:
            continue
        seen.add(cid)
        result.append(cid)
    return result


def clamp_fetch_limit(limit: int) -> int:
    if limit < 1:
        return 1
    if limit > 100:
        return 100
    return limit


def run_cmd(argv: list[str], timeout: float | None = None) -> tuple[int, str, str]:
    proc = subprocess.run(
        argv,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def openclaw_config_get(openclaw_bin: str, path: str) -> Any:
    code, out, stderr = run_cmd([openclaw_bin, "config", "get", path, "--json"], timeout=20)
    if code != 0:
        raise RuntimeError(stderr.strip() or f"openclaw config get {path} failed")
    text = out.strip()
    if not text:
        return None
    return json.loads(text)


def normalize_discord_token(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    lower = value.lower()
    if lower.startswith("bot "):
        value = value[4:].strip()
    return value


def merge_discord_account_config(discord_cfg: dict[str, Any], account_id: str) -> dict[str, Any]:
    base = {k: v for k, v in discord_cfg.items() if k != "accounts"}
    accounts = discord_cfg.get("accounts")
    if isinstance(accounts, dict):
        account_cfg = accounts.get(account_id)
        if isinstance(account_cfg, dict):
            merged = dict(base)
            merged.update(account_cfg)
            return merged
    return base


def resolve_discord_token(discord_cfg: dict[str, Any], account_id: str) -> tuple[str, str]:
    accounts = discord_cfg.get("accounts")
    account_cfg = accounts.get(account_id) if isinstance(accounts, dict) else None
    if isinstance(account_cfg, dict):
        token = normalize_discord_token(account_cfg.get("token"))
        if token:
            return token, "config:accounts"

    if account_id == DEFAULT_DISCORD_ACCOUNT:
        token = normalize_discord_token(discord_cfg.get("token"))
        if token:
            return token, "config:root"
        token = normalize_discord_token(os.environ.get("DISCORD_BOT_TOKEN"))
        if token:
            return token, "env:DISCORD_BOT_TOKEN"

    return "", "none"


def discover_channels_from_config(discord_cfg_merged: dict[str, Any]) -> list[str]:
    channels: list[str] = []
    seen: set[str] = set()

    def add(values: Any) -> None:
        for cid in parse_channel_list(values):
            if cid in seen:
                continue
            seen.add(cid)
            channels.append(cid)

    poller = discord_cfg_merged.get("poller")
    if isinstance(poller, dict):
        add(poller.get("channels"))
    add(discord_cfg_merged.get("pollChannels"))

    guilds = discord_cfg_merged.get("guilds")
    if isinstance(guilds, dict):
        for entry in guilds.values():
            if not isinstance(entry, dict):
                continue
            guild_channels = entry.get("channels")
            if not isinstance(guild_channels, dict):
                continue
            for key in guild_channels.keys():
                cid = normalize_channel_id(key)
                if not cid.isdigit():
                    continue
                if cid in seen:
                    continue
                seen.add(cid)
                channels.append(cid)

    return channels


class DiscordRateLimitedError(RuntimeError):
    def __init__(self, retry_after_seconds: float, message: str) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


def discord_request(
    token: str,
    method: str,
    path: str,
    query: dict[str, str] | None = None,
    timeout: float = 20,
) -> Any:
    params = urllib.parse.urlencode(query or {})
    url = f"{DISCORD_API_BASE}{path}"
    if params:
        url = f"{url}?{params}"
    req = urllib.request.Request(
        url=url,
        method=method,
        headers={
            "Authorization": f"Bot {token}",
            "Accept": "application/json",
            "User-Agent": "openclaw-discord-mention-poller/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            if not body:
                return None
            return json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        payload: dict[str, Any] = {}
        if body:
            try:
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    payload = parsed
            except json.JSONDecodeError:
                payload = {}
        if e.code == 429:
            retry_after = payload.get("retry_after")
            retry = float(retry_after) if isinstance(retry_after, (int, float)) else 1.0
            raise DiscordRateLimitedError(
                retry_after_seconds=max(retry, 0.5),
                message=f"Discord API rate limited on {path}",
            ) from e
        detail = payload.get("message")
        suffix = f": {detail}" if isinstance(detail, str) and detail.strip() else ""
        raise RuntimeError(f"Discord API {e.code} on {path}{suffix}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Discord API connection error on {path}: {e}") from e


def to_int_snowflake(value: Any) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def is_bot_message(message: dict[str, Any]) -> bool:
    author = message.get("author")
    if not isinstance(author, dict):
        return False
    return bool(author.get("bot"))


def is_human_message(message: dict[str, Any]) -> bool:
    author = message.get("author")
    if not isinstance(author, dict):
        return False
    return not bool(author.get("bot"))


def message_mentions_bot(message: dict[str, Any], bot_user_id: str) -> bool:
    mentions = message.get("mentions")
    if isinstance(mentions, list):
        for mention in mentions:
            if isinstance(mention, dict) and str(mention.get("id", "")).strip() == bot_user_id:
                return True
    content = str(message.get("content", "") or "")
    if not content:
        return False
    return f"<@{bot_user_id}>" in content or f"<@!{bot_user_id}>" in content


def compact_message_text(message: dict[str, Any], max_chars: int = 2500) -> str:
    content = str(message.get("content", "") or "").strip()
    if not content:
        content = "(no text content)"

    attachments = message.get("attachments")
    attachment_lines: list[str] = []
    if isinstance(attachments, list) and attachments:
        for item in attachments[:5]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("filename", "") or "").strip() or "file"
            url = str(item.get("url", "") or "").strip()
            if url:
                attachment_lines.append(f"- {name}: {url}")
            else:
                attachment_lines.append(f"- {name}")
    if attachment_lines:
        content = f"{content}\n\nAttachments:\n" + "\n".join(attachment_lines)

    content = content.strip()
    if len(content) <= max_chars:
        return content
    return content[: max_chars - 3].rstrip() + "..."


def author_label(message: dict[str, Any]) -> tuple[str, str]:
    author = message.get("author")
    if not isinstance(author, dict):
        return "unknown", "unknown"
    user_id = str(author.get("id", "") or "").strip() or "unknown"
    name = (
        str(author.get("global_name", "") or "").strip()
        or str(author.get("username", "") or "").strip()
        or user_id
    )
    return name, user_id


def author_id(message: dict[str, Any]) -> str:
    author = message.get("author")
    if not isinstance(author, dict):
        return ""
    return str(author.get("id", "") or "").strip()


def build_agent_payload(
    *,
    message: dict[str, Any],
    channel_id: str,
    agent_id: str,
    was_mentioned: bool,
    account_id: str | None = None,
    force_thread_id: bool = False,
) -> dict[str, Any]:
    message_id = str(message.get("id", "") or "").strip()
    timestamp = str(message.get("timestamp", "") or "").strip()
    author_name, author_id = author_label(message)
    body = compact_message_text(message)

    action_line = (
        "Action: You saw a message in a Discord group/chat channel. "
        "You can respond, or not. Be yourself."
    )

    prompt = "\n".join(
        [
            "[Discord message polled (non-webhook)]",
            f"ChannelId: {channel_id}",
            f"MessageId: {message_id}",
            f"Author: {author_name} ({author_id})",
            f"Timestamp: {timestamp or 'unknown'}",
            f"MentionedYou: {'yes' if was_mentioned else 'no'}",
            action_line,
            "",
            "Message Content:",
            f"[{author_name}] {body}",
        ]
    ).strip()

    session_key = f"agent:{agent_id}:discord:channel:{channel_id}"
    payload: dict[str, Any] = {
        "idempotencyKey": f"discord-poll:{message_id}",
        "agentId": agent_id,
        "message": prompt,
        "sessionKey": session_key,
        "deliver": True,
        "channel": "discord",
        "to": f"channel:{channel_id}",
        "replyTo": f"channel:{channel_id}",
        "inputProvenance": {
            "kind": "external_user",
            "sourceChannel": "discord",
        },
    }
    if force_thread_id:
        # Legacy mode: pin explicit threadId to channel id.
        # This can diverge from native Discord webhook context for non-thread channels.
        payload["threadId"] = channel_id
    if account_id:
        payload["accountId"] = account_id
        payload["replyAccountId"] = account_id
    return payload


def parse_json_payload(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return {"value": parsed}


def call_openclaw_agent(
    openclaw_bin: str,
    payload: dict[str, Any],
    verbose: bool,
    expect_final: bool,
    timeout_seconds: float,
) -> bool:
    params = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    cmd = [
        openclaw_bin,
        "gateway",
        "call",
        "agent",
        "--params",
        params,
        "--json",
    ]
    if expect_final:
        cmd.append("--expect-final")
    try:
        code, out, stderr = run_cmd(cmd, timeout=max(1.0, timeout_seconds))
    except subprocess.TimeoutExpired:
        err("openclaw gateway call agent timed out")
        return False
    if code != 0:
        detail = stderr.strip() or out.strip() or f"exit={code}"
        err(f"inject failed: {detail}")
        if "pairing required" in detail.lower():
            warn(
                "Gateway rejected operator connect with 'pairing required'. "
                "Approve pending device pairing on this host: "
                "`openclaw devices list` then `openclaw devices approve --latest`.",
            )
        return False

    parsed = parse_json_payload(out)
    status = ""
    run_id = ""
    summary = ""
    payload_count: int | None = None
    sent_target_count: int | None = None
    meta_stop_reason = ""
    meta_aborted: bool | None = None
    if parsed is not None:
        status = str(parsed.get("status", "") or "").strip().lower()
        run_id = str(parsed.get("runId", "") or "").strip()
        summary = str(parsed.get("summary", "") or "").strip()
        result = parsed.get("result")
        if isinstance(result, dict):
            payloads = result.get("payloads")
            if isinstance(payloads, list):
                payload_count = len(payloads)
            sent_targets = result.get("messagingToolSentTargets")
            if isinstance(sent_targets, list):
                sent_target_count = len(sent_targets)
            meta = result.get("meta")
            if isinstance(meta, dict):
                meta_stop_reason = str(meta.get("stopReason", "") or "").strip()
                aborted_val = meta.get("aborted")
                if isinstance(aborted_val, bool):
                    meta_aborted = aborted_val

    if status == "error":
        detail = summary or json.dumps(parsed or {}, ensure_ascii=True)
        err(f"inject failed: {detail}")
        return False
    if expect_final and status and status != "ok":
        detail = summary or json.dumps(parsed or {}, ensure_ascii=True)
        err(f"inject failed: expected final status=ok, got status={status} ({detail})")
        return False
    if not expect_final and status and status not in {"accepted", "ok"}:
        detail = summary or json.dumps(parsed or {}, ensure_ascii=True)
        err(f"inject failed: unexpected status={status} ({detail})")
        return False

    if verbose:
        if status:
            parts = [f"status={status}"]
            if run_id:
                parts.append(f"runId={run_id}")
            if summary and summary != "completed":
                parts.append(f"summary={summary}")
            if payload_count is not None:
                parts.append(f"payloads={payload_count}")
            if sent_target_count is not None:
                parts.append(f"sentTargets={sent_target_count}")
            if meta_stop_reason:
                parts.append(f"stopReason={meta_stop_reason}")
            if meta_aborted is not None:
                parts.append(f"aborted={'yes' if meta_aborted else 'no'}")
            log(f"inject ok: {' '.join(parts)}")
        elif parsed is not None:
            log(f"inject ok: {json.dumps(parsed, ensure_ascii=True)}")
        else:
            text = out.strip()
            if text:
                log(f"inject ok: {text.splitlines()[-1]}")
            else:
                log("inject ok")

    if status == "ok":
        no_payloads = payload_count is not None and payload_count == 0
        no_tool_sends = sent_target_count is not None and sent_target_count == 0
        if no_payloads and no_tool_sends:
            warn(
                "inject completed with no outbound content (payloads=0, sentTargets=0); "
                "agent chose not to send a reply for this turn",
            )
    return True


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def commandline_for_pid(pid: int) -> str:
    code, out, _ = run_cmd(["ps", "-p", str(pid), "-o", "command="], timeout=5)
    if code != 0:
        return ""
    return out.strip()


def ensure_pid_or_exit(pid_file: Path) -> None:
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    if pid_file.exists():
        raw = pid_file.read_text(encoding="utf-8").strip()
        old_pid = int(raw) if raw.isdigit() else 0
        if old_pid and process_alive(old_pid):
            cmdline = commandline_for_pid(old_pid)
            this_name = Path(sys.argv[0]).name
            if this_name in cmdline:
                log(f"already running (pid {old_pid}), exiting")
                raise SystemExit(0)
            warn(f"pid file points to active non-matching process {old_pid}, replacing it")
        else:
            warn("stale pid file detected, replacing it")

    pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")

    def cleanup() -> None:
        try:
            if pid_file.exists():
                current = pid_file.read_text(encoding="utf-8").strip()
                if current == str(os.getpid()):
                    pid_file.unlink()
        except OSError:
            pass

    atexit.register(cleanup)


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def install_signal_handlers() -> None:
    def _handle(signum: int, _frame: Any) -> None:
        global STOP_REQUESTED
        STOP_REQUESTED = True
        log(f"received signal {signum}, shutting down")

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)


@dataclass
class ChannelState:
    channel_id: str
    cursor_id: str = ""
    last_human_id: str = ""
    last_injected_id: str = ""
    poll_interval_sec: float = DEFAULT_BASE_INTERVAL
    hot_until_ts: float = 0.0
    next_poll_ts: float = 0.0

    @classmethod
    def from_raw(cls, channel_id: str, raw: dict[str, Any], default_interval: float) -> "ChannelState":
        state = cls(channel_id=channel_id)
        state.cursor_id = str(raw.get("cursor_id", "") or "").strip()
        state.last_human_id = str(raw.get("last_human_id", "") or "").strip()
        state.last_injected_id = str(raw.get("last_injected_id", "") or "").strip()
        try:
            state.poll_interval_sec = float(raw.get("poll_interval_sec", default_interval))
        except (TypeError, ValueError):
            state.poll_interval_sec = default_interval
        try:
            state.hot_until_ts = float(raw.get("hot_until_ts", 0.0))
        except (TypeError, ValueError):
            state.hot_until_ts = 0.0
        try:
            state.next_poll_ts = float(raw.get("next_poll_ts", 0.0))
        except (TypeError, ValueError):
            state.next_poll_ts = 0.0
        return state

    def to_raw(self) -> dict[str, Any]:
        return {
            "cursor_id": self.cursor_id,
            "last_human_id": self.last_human_id,
            "last_injected_id": self.last_injected_id,
            "poll_interval_sec": round(self.poll_interval_sec, 3),
            "hot_until_ts": round(self.hot_until_ts, 3),
            "next_poll_ts": round(self.next_poll_ts, 3),
        }


def load_channel_states(
    channel_ids: list[str],
    state_file: Path,
    default_interval: float,
) -> dict[str, ChannelState]:
    root = load_json_file(state_file)
    channels_raw = root.get("channels")
    if not isinstance(channels_raw, dict):
        channels_raw = {}
    states: dict[str, ChannelState] = {}
    for cid in channel_ids:
        raw = channels_raw.get(cid)
        if isinstance(raw, dict):
            states[cid] = ChannelState.from_raw(cid, raw, default_interval)
        else:
            states[cid] = ChannelState(channel_id=cid, poll_interval_sec=default_interval)
    return states


def save_channel_states(
    *,
    state_file: Path,
    states: dict[str, ChannelState],
    agent_id: str,
    discord_account: str,
) -> None:
    payload = {
        "version": SCRIPT_VERSION,
        "updated_at": int(time.time()),
        "agent_id": agent_id,
        "discord_account": discord_account,
        "channels": {cid: state.to_raw() for cid, state in states.items()},
    }
    atomic_write_json(state_file, payload)


def fetch_bot_identity(token: str) -> tuple[str, str]:
    profile = discord_request(token, "GET", "/users/@me")
    if not isinstance(profile, dict):
        raise RuntimeError("Discord /users/@me returned invalid payload")
    user_id = str(profile.get("id", "") or "").strip()
    username = str(profile.get("username", "") or "").strip() or user_id
    if not user_id:
        raise RuntimeError("Discord /users/@me missing id")
    return user_id, username


def fetch_messages(token: str, channel_id: str, after_id: str, limit: int) -> list[dict[str, Any]]:
    query = {"limit": str(limit)}
    if after_id:
        query["after"] = after_id
    payload = discord_request(token, "GET", f"/channels/{channel_id}/messages", query=query)
    if isinstance(payload, list):
        return [msg for msg in payload if isinstance(msg, dict)]
    raise RuntimeError(f"Discord messages endpoint returned invalid payload for channel {channel_id}")


def bootstrap_channel_cursor(
    *,
    token: str,
    state: ChannelState,
    process_backlog: bool,
    fetch_limit: int,
    verbose: bool,
) -> None:
    if state.cursor_id or process_backlog:
        return
    messages = fetch_messages(token, state.channel_id, after_id="", limit=max(1, min(fetch_limit, 10)))
    if not messages:
        if verbose:
            log(f"bootstrap {state.channel_id}: no messages")
        return
    newest = max(messages, key=lambda m: to_int_snowflake(m.get("id")))
    newest_id = str(newest.get("id", "") or "").strip()
    if newest_id:
        state.cursor_id = newest_id
    if is_human_message(newest):
        state.last_human_id = newest_id
    if verbose:
        log(f"bootstrap {state.channel_id}: set cursor={state.cursor_id or '(none)'}")


def apply_poll_backoff(
    state: ChannelState,
    *,
    now_ts: float,
    base_interval: float,
    fast_interval: float,
    fast_hold_seconds: float,
    has_activity: bool,
) -> None:
    if has_activity:
        state.poll_interval_sec = fast_interval
        state.hot_until_ts = now_ts + fast_hold_seconds
        return

    if now_ts < state.hot_until_ts:
        state.poll_interval_sec = fast_interval
        return

    next_interval = state.poll_interval_sec * 1.4
    if next_interval < fast_interval:
        next_interval = fast_interval
    if next_interval > base_interval:
        next_interval = base_interval
    state.poll_interval_sec = next_interval


def poll_one_channel(
    *,
    token: str,
    openclaw_bin: str,
    agent_id: str,
    discord_account: str,
    bot_user_id: str,
    include_bot_messages_without_mention: bool,
    expect_final: bool,
    gateway_timeout: float,
    force_thread_id: bool,
    state: ChannelState,
    base_interval: float,
    fast_interval: float,
    fast_hold_seconds: float,
    fetch_limit: int,
    verbose: bool,
) -> None:
    now_ts = time.time()

    try:
        messages = fetch_messages(
            token=token,
            channel_id=state.channel_id,
            after_id=state.cursor_id,
            limit=fetch_limit,
        )
    except DiscordRateLimitedError as rate:
        warn(
            f"channel {state.channel_id}: Discord rate-limited, pausing {rate.retry_after_seconds:.1f}s",
        )
        state.next_poll_ts = now_ts + max(rate.retry_after_seconds, fast_interval)
        return
    except Exception as ex:
        err(f"channel {state.channel_id}: poll failed: {ex}")
        state.next_poll_ts = now_ts + max(state.poll_interval_sec, fast_interval)
        return

    if not messages:
        apply_poll_backoff(
            state,
            now_ts=now_ts,
            base_interval=base_interval,
            fast_interval=fast_interval,
            fast_hold_seconds=fast_hold_seconds,
            has_activity=False,
        )
        state.next_poll_ts = now_ts + state.poll_interval_sec
        return

    messages.sort(key=lambda item: to_int_snowflake(item.get("id")))
    newest_id_int = to_int_snowflake(messages[-1].get("id"))
    prev_cursor_id = state.cursor_id

    prev_last_human = to_int_snowflake(state.last_human_id)
    batch_max_human = prev_last_human
    candidates: list[dict[str, Any]] = []
    skipped_self = 0

    for msg in messages:
        msg_id = to_int_snowflake(msg.get("id"))
        if msg_id <= 0:
            continue
        if is_human_message(msg):
            if msg_id > batch_max_human:
                batch_max_human = msg_id
            continue
        if not is_bot_message(msg):
            continue
        msg_author_id = author_id(msg)
        if msg_author_id and msg_author_id == bot_user_id:
            skipped_self += 1
            continue
        if include_bot_messages_without_mention or message_mentions_bot(msg, bot_user_id):
            candidates.append(msg)

    injected_any = False
    injection_failed = False
    last_injected = to_int_snowflake(state.last_injected_id)

    for msg in candidates:
        msg_id = to_int_snowflake(msg.get("id"))
        if msg_id <= 0:
            continue
        if msg_id <= batch_max_human:
            continue
        if msg_id <= last_injected:
            continue
        was_mentioned = message_mentions_bot(msg, bot_user_id)
        author_name, msg_author_id = author_label(msg)
        if verbose:
            log(
                "channel {}: candidate message {} author={}({}) mentioned={}".format(
                    state.channel_id,
                    msg_id,
                    author_name,
                    msg_author_id,
                    "yes" if was_mentioned else "no",
                )
            )
        payload = build_agent_payload(
            message=msg,
            channel_id=state.channel_id,
            agent_id=agent_id,
            was_mentioned=was_mentioned,
            account_id=discord_account,
            force_thread_id=force_thread_id,
        )
        ok = call_openclaw_agent(
            openclaw_bin=openclaw_bin,
            payload=payload,
            verbose=verbose,
            expect_final=expect_final,
            timeout_seconds=gateway_timeout,
        )
        if not ok:
            injection_failed = True
            continue
        injected_any = True
        last_injected = msg_id
        state.last_injected_id = str(msg_id)
        log(f"channel {state.channel_id}: injected message {msg_id}")

    if batch_max_human > 0:
        state.last_human_id = str(batch_max_human)

    if not injection_failed and newest_id_int > 0:
        state.cursor_id = str(newest_id_int)
    else:
        state.cursor_id = prev_cursor_id
        if injection_failed:
            warn(
                f"channel {state.channel_id}: one or more injections failed; cursor kept at {prev_cursor_id or '(empty)'} for retry",
            )

    has_activity = True
    apply_poll_backoff(
        state,
        now_ts=now_ts,
        base_interval=base_interval,
        fast_interval=fast_interval,
        fast_hold_seconds=fast_hold_seconds,
        has_activity=has_activity or injected_any,
    )
    state.next_poll_ts = now_ts + state.poll_interval_sec

    if verbose:
        log(
            "channel {}: fetched={} candidates={} skippedSelf={} injected={} interval={:.1f}s".format(
                state.channel_id,
                len(messages),
                len(candidates),
                skipped_self,
                "yes" if injected_any else "no",
                state.poll_interval_sec,
            )
        )


def load_discord_config(openclaw_bin: str, discord_account: str) -> tuple[dict[str, Any], dict[str, Any], str, str]:
    cfg_raw = openclaw_config_get(openclaw_bin, "channels.discord")
    if cfg_raw is None:
        cfg_raw = {}
    if not isinstance(cfg_raw, dict):
        raise RuntimeError("channels.discord config is not an object")

    merged = merge_discord_account_config(cfg_raw, discord_account)
    base_enabled = cfg_raw.get("enabled", True) is not False
    account_enabled = merged.get("enabled", True) is not False
    if not (base_enabled and account_enabled):
        raise RuntimeError(
            f"Discord account '{discord_account}' is disabled in config (enabled=false)",
        )

    token, source = resolve_discord_token(cfg_raw, discord_account)
    if not token:
        raise RuntimeError(
            "Discord token missing. Set channels.discord.token (default account), "
            "or channels.discord.accounts.<id>.token, or DISCORD_BOT_TOKEN for default account.",
        )

    return cfg_raw, merged, token, source


def resolve_channel_ids(args: argparse.Namespace, merged_discord_cfg: dict[str, Any]) -> list[str]:
    cli_channels = parse_channel_list(args.channels)
    if cli_channels:
        return cli_channels

    config_channels = discover_channels_from_config(merged_discord_cfg)
    if config_channels:
        return config_channels

    raise RuntimeError(
        "No channels configured. Pass --channels or set channels.discord.poller.channels "
        "(or channels.discord.pollChannels) in config.",
    )


def resolve_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    if args.state_file:
        state_file = Path(args.state_file).expanduser().resolve()
    else:
        root = Path("~/.openclaw/pollers").expanduser().resolve()
        slug = f"discord-{args.agent_id}-{args.discord_account}"
        state_file = root / f"{slug}.state.json"

    if args.pid_file:
        pid_file = Path(args.pid_file).expanduser().resolve()
    else:
        root = state_file.parent
        slug = f"discord-{args.agent_id}-{args.discord_account}"
        pid_file = root / f"{slug}.pid"

    return state_file, pid_file


def main() -> int:
    args = parse_args()
    args.fetch_limit = clamp_fetch_limit(args.fetch_limit)
    args.base_interval = max(1.0, float(args.base_interval))
    args.fast_interval = max(1.0, float(args.fast_interval))
    args.fast_hold_seconds = max(1.0, float(args.fast_hold_seconds))
    args.offset_step = max(0.0, float(args.offset_step))
    args.gateway_timeout = max(1.0, float(args.gateway_timeout))

    state_file, pid_file = resolve_paths(args)
    ensure_pid_or_exit(pid_file)
    install_signal_handlers()

    try:
        _raw_cfg, merged_cfg, token, token_source = load_discord_config(
            openclaw_bin=args.openclaw_bin,
            discord_account=args.discord_account,
        )
    except Exception as ex:
        err(str(ex))
        return 1

    try:
        channel_ids = resolve_channel_ids(args, merged_cfg)
    except Exception as ex:
        err(str(ex))
        return 1

    try:
        bot_user_id, bot_username = fetch_bot_identity(token)
    except Exception as ex:
        err(f"failed to resolve bot identity: {ex}")
        return 1

    log(
        "starting poller: agent={} account={} bot={}({}) channels={} tokenSource={} mode={} expectFinal={} forceThreadId={}".format(
            args.agent_id,
            args.discord_account,
            bot_username,
            bot_user_id,
            ",".join(channel_ids),
            token_source,
            "all-bot-messages" if args.include_bot_messages_without_mention else "mention-only",
            "yes" if args.expect_final else "no",
            "yes" if args.force_thread_id else "no",
        )
    )

    states = load_channel_states(
        channel_ids=channel_ids,
        state_file=state_file,
        default_interval=args.base_interval,
    )

    now_ts = time.time()
    for index, channel_id in enumerate(channel_ids):
        state = states[channel_id]
        if state.next_poll_ts <= 0:
            state.next_poll_ts = now_ts + (index * args.offset_step)
        if state.poll_interval_sec <= 0:
            state.poll_interval_sec = args.base_interval

    for channel_id in channel_ids:
        try:
            bootstrap_channel_cursor(
                token=token,
                state=states[channel_id],
                process_backlog=args.process_backlog,
                fetch_limit=args.fetch_limit,
                verbose=args.verbose,
            )
        except DiscordRateLimitedError as rate:
            warn(
                f"bootstrap channel {channel_id}: rate-limited, delaying first poll by {rate.retry_after_seconds:.1f}s",
            )
            states[channel_id].next_poll_ts = time.time() + rate.retry_after_seconds
        except Exception as ex:
            warn(f"bootstrap channel {channel_id} failed: {ex}")

    save_channel_states(
        state_file=state_file,
        states=states,
        agent_id=args.agent_id,
        discord_account=args.discord_account,
    )

    if args.once:
        for cid in channel_ids:
            poll_one_channel(
                token=token,
                openclaw_bin=args.openclaw_bin,
                agent_id=args.agent_id,
                discord_account=args.discord_account,
                bot_user_id=bot_user_id,
                include_bot_messages_without_mention=args.include_bot_messages_without_mention,
                expect_final=args.expect_final,
                gateway_timeout=args.gateway_timeout,
                force_thread_id=args.force_thread_id,
                state=states[cid],
                base_interval=args.base_interval,
                fast_interval=args.fast_interval,
                fast_hold_seconds=args.fast_hold_seconds,
                fetch_limit=args.fetch_limit,
                verbose=args.verbose,
            )
        save_channel_states(
            state_file=state_file,
            states=states,
            agent_id=args.agent_id,
            discord_account=args.discord_account,
        )
        return 0

    while not STOP_REQUESTED:
        now_ts = time.time()
        due = [state for state in states.values() if state.next_poll_ts <= now_ts]

        if not due:
            next_due = min(state.next_poll_ts for state in states.values())
            sleep_for = max(0.2, min(1.0, next_due - now_ts))
            time.sleep(sleep_for)
            continue

        due.sort(key=lambda state: state.next_poll_ts)
        for state in due:
            if STOP_REQUESTED:
                break
            poll_one_channel(
                token=token,
                openclaw_bin=args.openclaw_bin,
                agent_id=args.agent_id,
                discord_account=args.discord_account,
                bot_user_id=bot_user_id,
                include_bot_messages_without_mention=args.include_bot_messages_without_mention,
                expect_final=args.expect_final,
                gateway_timeout=args.gateway_timeout,
                force_thread_id=args.force_thread_id,
                state=state,
                base_interval=args.base_interval,
                fast_interval=args.fast_interval,
                fast_hold_seconds=args.fast_hold_seconds,
                fetch_limit=args.fetch_limit,
                verbose=args.verbose,
            )
            save_channel_states(
                state_file=state_file,
                states=states,
                agent_id=args.agent_id,
                discord_account=args.discord_account,
            )

    save_channel_states(
        state_file=state_file,
        states=states,
        agent_id=args.agent_id,
        discord_account=args.discord_account,
    )
    log("poller stopped")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
