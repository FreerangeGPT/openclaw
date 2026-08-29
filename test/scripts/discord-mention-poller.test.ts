import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pollerPath = path.resolve("scripts/discord-mention-poller.py");

describe("discord mention poller", () => {
  it("passes its agent wait timeout through to the gateway CLI", () => {
    const probe = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("discord_mention_poller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

captured = {}
def run_cmd(argv, timeout=None):
    captured["argv"] = argv
    captured["subprocess_timeout"] = timeout
    return 0, '{"status":"accepted"}', ""

module.run_cmd = run_cmd
ok = module.call_openclaw_agent(
    openclaw_bin="openclaw",
    payload={"message": "test"},
    verbose=False,
    expect_final=False,
    timeout_seconds=660,
)
timeout_index = captured["argv"].index("--timeout")
gateway_timeout = captured["argv"][timeout_index + 1]
subprocess_timeout = captured["subprocess_timeout"]
module.call_openclaw_agent(
    openclaw_bin="openclaw",
    payload={"message": "test"},
    verbose=False,
    expect_final=False,
    timeout_seconds=0,
)
clamped_timeout_index = captured["argv"].index("--timeout")
print(json.dumps({
    "ok": ok,
    "gateway_timeout": gateway_timeout,
    "clamped_gateway_timeout": captured["argv"][clamped_timeout_index + 1],
    "subprocess_timeout": subprocess_timeout,
    "clamped_subprocess_timeout": captured["subprocess_timeout"],
}))
`;
    const result = spawnSync("python3", ["-c", probe, pollerPath], {
      encoding: "utf-8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      gateway_timeout: "660000",
      clamped_gateway_timeout: "1000",
      subprocess_timeout: 665,
      clamped_subprocess_timeout: 6,
    });
  });

  it("loads a named-account token from a permission-restricted file", () => {
    const probe = String.raw`
import importlib.util
import json
import os
import pathlib
import sys
import tempfile

spec = importlib.util.spec_from_file_location("discord_mention_poller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module.openclaw_config_get = lambda *_args, **_kwargs: {
    "accounts": {
        "aineko-bot": {
            "enabled": True,
            "token": "__OPENCLAW_REDACTED__",
        },
    },
}

with tempfile.TemporaryDirectory() as root:
    token_path = pathlib.Path(root) / "discord.token"
    token_path.write_text("Bot test-token-value\n", encoding="utf-8")
    os.chmod(token_path, 0o600)
    _raw, _merged, token, source = module.load_discord_config(
        "openclaw",
        "aineko-bot",
        str(token_path),
    )
    print(json.dumps({
        "token_loaded": token == "test-token-value",
        "source": source,
    }))
`;
    const result = spawnSync("python3", ["-c", probe, pollerPath], {
      encoding: "utf-8",
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      token_loaded: true,
      source: "file:discord.token",
    });
  });

  it("rejects redacted and group-readable token sources", () => {
    const probe = String.raw`
import importlib.util
import json
import os
import pathlib
import sys
import tempfile

spec = importlib.util.spec_from_file_location("discord_mention_poller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module.openclaw_config_get = lambda *_args, **_kwargs: {
    "accounts": {
        "aineko-bot": {
            "enabled": True,
            "token": "__OPENCLAW_REDACTED__",
        },
    },
}

config_rejected = False
try:
    module.load_discord_config("openclaw", "aineko-bot")
except RuntimeError as ex:
    config_rejected = "missing or redacted" in str(ex)

with tempfile.TemporaryDirectory() as root:
    token_path = pathlib.Path(root) / "discord.token"
    token_path.write_text("test-token-value\n", encoding="utf-8")
    os.chmod(token_path, 0o640)
    mode_rejected = False
    try:
        module.read_discord_token_file(str(token_path))
    except RuntimeError as ex:
        mode_rejected = "group/world accessible" in str(ex)

    token_path.write_text("__OPENCLAW_REDACTED__\n", encoding="utf-8")
    os.chmod(token_path, 0o600)
    redacted_file_rejected = False
    try:
        module.read_discord_token_file(str(token_path))
    except RuntimeError as ex:
        redacted_file_rejected = "empty or redacted" in str(ex)

    fifo_rejected = True
    if hasattr(os, "mkfifo"):
        fifo_path = pathlib.Path(root) / "discord.fifo"
        os.mkfifo(fifo_path, 0o600)
        fifo_rejected = False
        try:
            module.read_discord_token_file(str(fifo_path))
        except RuntimeError as ex:
            fifo_rejected = "regular file" in str(ex)

    symlink_rejected = True
    if hasattr(os, "O_NOFOLLOW") and hasattr(os, "symlink"):
        target_path = pathlib.Path(root) / "target.token"
        target_path.write_text("different-token-value\n", encoding="utf-8")
        os.chmod(target_path, 0o600)
        symlink_path = pathlib.Path(root) / "discord.link"
        os.symlink(target_path, symlink_path)
        symlink_rejected = False
        try:
            module.read_discord_token_file(str(symlink_path))
        except RuntimeError as ex:
            symlink_rejected = "unavailable" in str(ex)

print(json.dumps({
    "config_rejected": config_rejected,
    "fifo_rejected": fifo_rejected,
    "mode_rejected": mode_rejected,
    "redacted_file_rejected": redacted_file_rejected,
    "symlink_rejected": symlink_rejected,
}))
`;
    const result = spawnSync("python3", ["-c", probe, pollerPath], {
      encoding: "utf-8",
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      config_rejected: true,
      fifo_rejected: true,
      mode_rejected: true,
      redacted_file_rejected: true,
      symlink_rejected: true,
    });
  });

  it("stops at the first failed injection without advancing past the gap", () => {
    const probe = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("discord_mention_poller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

messages = [
    {"id": "101", "author": {"id": "other", "bot": True}},
    {"id": "102", "author": {"id": "other", "bot": True}},
    {"id": "103", "author": {"id": "other", "bot": True}},
]
calls = []
outcomes = iter([True, False, True])
module.fetch_messages = lambda **kwargs: messages
module.is_human_message = lambda message: False
module.is_bot_message = lambda message: True
module.author_id = lambda message: "other"
module.message_mentions_bot = lambda message, bot_id: True
module.author_label = lambda message: ("other", "other")
module.build_agent_payload = lambda **kwargs: {}
module.call_openclaw_agent = lambda **kwargs: calls.append(len(calls) + 101) or next(outcomes)
module.log = lambda message: None
module.warn = lambda message: None

state = module.ChannelState(channel_id="channel", cursor_id="100")
module.poll_one_channel(
    token="token",
    openclaw_bin="openclaw",
    agent_id="main",
    discord_account="default",
    bot_user_id="self",
    include_bot_messages_without_mention=False,
    expect_final=True,
    gateway_timeout=30,
    force_thread_id=False,
    state=state,
    base_interval=30,
    fast_interval=5,
    fast_hold_seconds=120,
    fetch_limit=50,
    verbose=False,
)
print(json.dumps({
    "calls": calls,
    "cursor_id": state.cursor_id,
    "last_injected_id": state.last_injected_id,
}))
`;
    const result = spawnSync("python3", ["-c", probe, pollerPath], {
      encoding: "utf-8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      calls: [101, 102],
      cursor_id: "100",
      last_injected_id: "101",
    });
  });
});
