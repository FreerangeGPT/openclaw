import { Command } from "commander";
import {
  listProjectMcpServers,
  setProjectMcpServer,
  unsetProjectMcpServer,
} from "../agents/pi-project-mcp.js";
import { parseConfigValue } from "../auto-reply/reply/config-value.js";
import { defaultRuntime } from "../runtime.js";

function fail(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
}

function printJson(value: unknown): void {
  defaultRuntime.log(JSON.stringify(value, null, 2));
}

export function registerMcpCli(program: Command) {
  const mcp = program
    .command("mcp")
    .description("Manage embedded Pi MCP servers in project .pi/settings.json");

  mcp
    .command("list")
    .description("List project MCP servers")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const loaded = await listProjectMcpServers({
        workspaceDir: process.cwd(),
      });
      if (!loaded.ok) {
        fail(loaded.error);
      }
      if (opts.json) {
        printJson(loaded.mcpServers);
        return;
      }
      const names = Object.keys(loaded.mcpServers).toSorted();
      if (names.length === 0) {
        defaultRuntime.log(`No project MCP servers configured in ${loaded.path}.`);
        return;
      }
      defaultRuntime.log(`Project MCP servers (${loaded.path}):`);
      for (const name of names) {
        defaultRuntime.log(`- ${name}`);
      }
    });

  mcp
    .command("show")
    .description("Show one project MCP server or the full MCP config")
    .argument("[name]", "MCP server name")
    .option("--json", "Print JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const loaded = await listProjectMcpServers({
        workspaceDir: process.cwd(),
      });
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const value = name ? loaded.mcpServers[name] : loaded.mcpServers;
      if (name && !value) {
        fail(`No MCP server named "${name}" in ${loaded.path}.`);
      }
      if (opts.json) {
        printJson(value ?? {});
        return;
      }
      if (name) {
        defaultRuntime.log(`MCP server "${name}" (${loaded.path}):`);
      } else {
        defaultRuntime.log(`Project MCP servers (${loaded.path}):`);
      }
      printJson(value ?? {});
    });

  mcp
    .command("set")
    .description("Set one project MCP server from a JSON object")
    .argument("<name>", "MCP server name")
    .argument("<value>", 'JSON object, for example {"command":"uvx","args":["context7-mcp"]}')
    .action(async (name: string, rawValue: string) => {
      const parsed = parseConfigValue(rawValue);
      if (parsed.error) {
        fail(parsed.error);
      }
      const result = await setProjectMcpServer({
        workspaceDir: process.cwd(),
        name,
        server: parsed.value,
      });
      if (!result.ok) {
        fail(result.error);
      }
      defaultRuntime.log(`Saved MCP server "${name}" to ${result.path}.`);
    });

  mcp
    .command("unset")
    .description("Remove one project MCP server")
    .argument("<name>", "MCP server name")
    .action(async (name: string) => {
      const result = await unsetProjectMcpServer({
        workspaceDir: process.cwd(),
        name,
      });
      if (!result.ok) {
        fail(result.error);
      }
      if (!result.removed) {
        fail(`No MCP server named "${name}" in ${result.path}.`);
      }
      defaultRuntime.log(`Removed MCP server "${name}" from ${result.path}.`);
    });
}
