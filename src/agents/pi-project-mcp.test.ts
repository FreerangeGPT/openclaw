import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  listProjectMcpServers,
  setProjectMcpServer,
  unsetProjectMcpServer,
} from "./pi-project-mcp.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-mcp-"));
  tempDirs.push(dir);
  return dir;
}

describe("pi project mcp settings", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes and removes project MCP servers in .pi/settings.json", async () => {
    await withTempHome("openclaw-project-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();

      const setResult = await setProjectMcpServer({
        workspaceDir,
        name: "context7",
        server: {
          command: "uvx",
          args: ["context7-mcp"],
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listProjectMcpServers({ workspaceDir });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected project MCP config to load");
      }
      expect(loaded.mcpServers.context7).toEqual({
        command: "uvx",
        args: ["context7-mcp"],
      });

      const raw = await fs.readFile(path.join(workspaceDir, ".pi", "settings.json"), "utf-8");
      expect(JSON.parse(raw)).toEqual({
        mcpServers: {
          context7: {
            command: "uvx",
            args: ["context7-mcp"],
          },
        },
      });

      const unsetResult = await unsetProjectMcpServer({
        workspaceDir,
        name: "context7",
      });
      expect(unsetResult.ok).toBe(true);

      const reloaded = await listProjectMcpServers({ workspaceDir });
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) {
        throw new Error("expected project MCP config to reload");
      }
      expect(reloaded.mcpServers).toEqual({});
    });
  });

  it("rejects unsupported non-stdio MCP configs", async () => {
    await withTempHome("openclaw-project-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const result = await setProjectMcpServer({
        workspaceDir,
        name: "remote",
        server: {
          url: "https://example.com/mcp",
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected invalid MCP config to fail");
      }
      expect(result.error).toContain("only stdio MCP servers are supported right now");
    });
  });
});
