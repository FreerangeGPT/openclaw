import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidecarPath = path.resolve("scripts/memory-sidecar.py");

function runProbe(probe: string) {
  return spawnSync("python3", ["-c", probe, sidecarPath], {
    encoding: "utf-8",
    timeout: 15_000,
  });
}

describe("memory sidecar producer", () => {
  it("finds and tails the canonical main session in SQLite", () => {
    const probe = String.raw`
import importlib.util
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("memory_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    database_path = Path(directory) / "openclaw-agent.sqlite"
    writable = sqlite3.connect(database_path)
    writable.executescript("""
        CREATE TABLE session_nodes (
            session_key TEXT PRIMARY KEY,
            current_session_id TEXT NOT NULL,
            archived_at INTEGER
        );
        CREATE TABLE transcript_events (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            event_json TEXT NOT NULL,
            PRIMARY KEY (session_id, seq)
        );
    """)
    writable.execute(
        "INSERT INTO session_nodes VALUES (?, ?, NULL)",
        ("agent:main:main", "main-session"),
    )
    writable.execute(
        "INSERT INTO session_nodes VALUES (?, ?, NULL)",
        ("agent:main:main:heartbeat", "heartbeat-session"),
    )
    events = [
        {"type": "message", "message": {"role": "user", "content": "older question"}},
        {"type": "message", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "private"},
            {"type": "text", "text": "useful answer"},
        ]}},
        {"type": "message", "message": {"role": "user", "content": "latest question"}},
        {"type": "message", "message": {"role": "user", "content": "latest question"}},
    ]
    writable.executemany(
        "INSERT INTO transcript_events VALUES (?, ?, ?)",
        [("main-session", index, json.dumps(event)) for index, event in enumerate(events, 1)],
    )
    writable.commit()
    writable.close()

    connection = module.open_session_database(database_path)
    session_id = module.find_active_session(connection)
    startup_cursor = module.find_current_message_cursor(connection)
    latest = module.tail_last_user_message(connection, session_id, after_seq=3)
    already_seen = module.tail_last_user_message(connection, session_id, after_seq=4)
    conversation = module.get_recent_conversation(connection, session_id, n_turns=4)
    try:
        connection.execute(
            "INSERT INTO session_nodes VALUES ('write-probe', 'write-probe', NULL)"
        )
        read_only = False
    except sqlite3.OperationalError:
        read_only = True
    connection.close()

    print(json.dumps({
        "session_id": session_id,
        "startup_cursor": startup_cursor,
        "latest": latest,
        "already_seen": already_seen,
        "conversation": conversation,
        "read_only": read_only,
    }))
`;
    const result = runProbe(probe);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      session_id: "main-session",
      startup_cursor: ["main-session", 4],
      latest: { seq: 4, content: "latest question" },
      already_seen: null,
      conversation: [
        "[user]: older question",
        "[assistant]: useful answer",
        "[user]: latest question",
      ].join("\n"),
      read_only: true,
    });
  });

  it("rates memories through the Tokenator-first recall pool", () => {
    const probe = String.raw`
import importlib.util
import io
import json
import sys

spec = importlib.util.spec_from_file_location("memory_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

captured = {}
class Response:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def read(self, *args):
        return self.body.read(*args)

def urlopen(request, timeout):
    captured["url"] = request.full_url
    captured["payload"] = json.loads(request.data.decode("utf-8"))
    captured["timeout"] = timeout
    response = Response()
    rating = {
        "score": 8,
        "fragment": "remember this",
        "source": "memory/tier2.md",
        "reason": "relevant",
    }
    response.body = io.BytesIO(json.dumps({
        "choices": [{"message": {"content": "model preface\\n" + json.dumps(rating)}}]
    }).encode("utf-8"))
    return response

module.urllib.request.urlopen = urlopen
rating = module.rate_memories(
    "recent conversation",
    "memory corpus",
    model_url="http://proxy.test/v1/chat/completions",
    model="aineko-recall",
    timeout_seconds=4,
)
print(json.dumps({"rating": rating, **captured}))
`;
    const result = runProbe(probe);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.rating).toEqual({
      score: 8,
      fragment: "remember this",
      source: "memory/tier2.md",
      reason: "relevant",
    });
    expect(output.url).toBe("http://proxy.test/v1/chat/completions");
    expect(output.timeout).toBe(4);
    expect(output.payload).toMatchObject({
      model: "aineko-recall",
      max_tokens: 512,
      reasoning_effort: "none",
      stream: false,
    });
    expect(output.payload.messages[1].content).toContain("recent conversation");
    expect(output.payload.messages[1].content).toContain("memory corpus");
  });

  it("posts the canonical payload to the loopback enqueue endpoint", () => {
    const probe = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("memory_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

captured = {}
class Response:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def getcode(self):
        return 201
    def read(self):
        return b'{"enqueued":true}'

def urlopen(request, timeout):
    captured["url"] = request.full_url
    captured["method"] = request.method
    captured["content_type"] = request.headers["Content-type"]
    captured["body"] = json.loads(request.data.decode("utf-8"))
    captured["timeout"] = timeout
    return Response()

module.urllib.request.urlopen = urlopen
ok = module.inject_memory(
    "Remember the launch date.",
    "memory/tier2-project.md",
    "The user is scheduling the launch.",
)
print(json.dumps({"ok": ok, **captured}))
`;
    const result = runProbe(probe);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      url: "http://127.0.0.1:8100/memory/enqueue",
      method: "POST",
      content_type: "application/json",
      body: {
        text: [
          "Source: memory/tier2-project.md",
          "Why now: The user is scheduling the launch.",
          "Remember the launch date.",
        ].join("\n"),
      },
      timeout: 5,
    });
  });

  it("accepts a deduplicated response and rejects transport failures", () => {
    const probe = String.raw`
import importlib.util
import json
import sys
import urllib.error

spec = importlib.util.spec_from_file_location("memory_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class DuplicateResponse:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def getcode(self):
        return 200
    def read(self):
        return b'{"enqueued":false}'

module.urllib.request.urlopen = lambda *_args, **_kwargs: DuplicateResponse()
deduplicated = module.inject_memory("fragment", "source", "reason")

def fail(*_args, **_kwargs):
    raise urllib.error.URLError("listener unavailable")
module.urllib.request.urlopen = fail
failed = module.inject_memory("fragment", "source", "reason")
print(json.dumps({"deduplicated": deduplicated, "failed": failed}))
`;
    const result = runProbe(probe);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      deduplicated: true,
      failed: false,
    });
  });
});
