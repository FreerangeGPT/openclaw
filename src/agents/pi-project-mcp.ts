import fs from "node:fs/promises";
import path from "node:path";
import { resolveStdioMcpServerLaunchConfig } from "./mcp-stdio.js";

export type ProjectMcpServers = Record<string, Record<string, unknown>>;

type ProjectSettingsObject = Record<string, unknown>;

type ProjectMcpReadResult =
  | {
      ok: true;
      path: string;
      projectSettings: ProjectSettingsObject;
      mcpServers: ProjectMcpServers;
    }
  | { ok: false; path: string; error: string };

type ProjectMcpWriteResult =
  | { ok: true; path: string; mcpServers: ProjectMcpServers; removed?: boolean }
  | { ok: false; path: string; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMcpServers(value: unknown): ProjectMcpServers {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, server]) => isRecord(server))
      .map(([name, server]) => [name, { ...(server as Record<string, unknown>) }]),
  );
}

function resolveProjectSettingsPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".pi", "settings.json");
}

async function loadProjectSettings(pathname: string): Promise<ProjectMcpReadResult> {
  try {
    const raw = await fs.readFile(pathname, "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (raw === null) {
      return {
        ok: true,
        path: pathname,
        projectSettings: {},
        mcpServers: {},
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        ok: false,
        path: pathname,
        error: "Project Pi settings must contain a JSON object.",
      };
    }
    return {
      ok: true,
      path: pathname,
      projectSettings: parsed,
      mcpServers: normalizeMcpServers(parsed.mcpServers),
    };
  } catch (error) {
    return {
      ok: false,
      path: pathname,
      error: `Project Pi settings are invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function writeProjectSettings(
  pathname: string,
  projectSettings: ProjectSettingsObject,
): Promise<ProjectMcpWriteResult> {
  try {
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, `${JSON.stringify(projectSettings, null, 2)}\n`, "utf-8");
    return {
      ok: true,
      path: pathname,
      mcpServers: normalizeMcpServers(projectSettings.mcpServers),
    };
  } catch (error) {
    return {
      ok: false,
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function setProjectMcpServer(params: {
  workspaceDir: string;
  name: string;
  server: unknown;
}): Promise<ProjectMcpWriteResult> {
  const name = params.name.trim();
  const pathname = resolveProjectSettingsPath(params.workspaceDir);
  if (!name) {
    return { ok: false, path: pathname, error: "MCP server name is required." };
  }
  if (!isRecord(params.server)) {
    return { ok: false, path: pathname, error: "MCP server config must be a JSON object." };
  }
  const launch = resolveStdioMcpServerLaunchConfig(params.server);
  if (!launch.ok) {
    return {
      ok: false,
      path: pathname,
      error: `Invalid MCP server "${name}": ${launch.reason}.`,
    };
  }

  const loaded = await loadProjectSettings(pathname);
  if (!loaded.ok) {
    return loaded;
  }
  const nextSettings = structuredClone(loaded.projectSettings);
  const nextMcpServers = normalizeMcpServers(nextSettings.mcpServers);
  nextMcpServers[name] = { ...params.server };
  nextSettings.mcpServers = nextMcpServers;
  return await writeProjectSettings(pathname, nextSettings);
}

export async function unsetProjectMcpServer(params: {
  workspaceDir: string;
  name: string;
}): Promise<ProjectMcpWriteResult> {
  const name = params.name.trim();
  const pathname = resolveProjectSettingsPath(params.workspaceDir);
  if (!name) {
    return { ok: false, path: pathname, error: "MCP server name is required." };
  }

  const loaded = await loadProjectSettings(pathname);
  if (!loaded.ok) {
    return loaded;
  }
  if (!Object.hasOwn(loaded.mcpServers, name)) {
    return {
      ok: true,
      path: pathname,
      mcpServers: loaded.mcpServers,
      removed: false,
    };
  }
  const nextSettings = structuredClone(loaded.projectSettings);
  const nextMcpServers = normalizeMcpServers(nextSettings.mcpServers);
  delete nextMcpServers[name];
  if (Object.keys(nextMcpServers).length > 0) {
    nextSettings.mcpServers = nextMcpServers;
  } else {
    delete nextSettings.mcpServers;
  }
  const written = await writeProjectSettings(pathname, nextSettings);
  return written.ok ? { ...written, removed: true } : written;
}

export async function listProjectMcpServers(params: {
  workspaceDir: string;
}): Promise<ProjectMcpReadResult> {
  return await loadProjectSettings(resolveProjectSettingsPath(params.workspaceDir));
}
