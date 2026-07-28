import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pollerPath = path.resolve("scripts/discord-mention-poller.py");

describe("discord mention poller", () => {
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
