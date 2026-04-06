import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readRequestBodyWithLimit } from "../src/infra/http-body.js";
import {
  DEFAULT_MEMORY_PREPEND_MAX_CHARS,
  DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS,
  prepareMemoryPrependQueueDrain,
} from "../src/infra/memory-prepend-queue.js";
import { prependAssociativeRecallToTelegramUpdate } from "../src/infra/memory-prepend-telegram.js";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8100;
const DEFAULT_TARGET_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;

type ShimConfig = {
  bind: string;
  port: number;
  targetBaseUrl: URL;
  healthPath: string;
  queuePath?: string;
  workspaceDir?: string;
  maxFragments: number;
  maxChars: number;
  maxBodyBytes: number;
  bodyTimeoutMs: number;
};

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfig(env: NodeJS.ProcessEnv): ShimConfig {
  return {
    bind: env.OPENCLAW_MEMORY_PREPEND_BIND?.trim() || DEFAULT_BIND,
    port: readPositiveInt(env.OPENCLAW_MEMORY_PREPEND_PORT, DEFAULT_PORT),
    targetBaseUrl: new URL(env.OPENCLAW_MEMORY_PREPEND_TARGET_BASE_URL || DEFAULT_TARGET_BASE_URL),
    healthPath: env.OPENCLAW_MEMORY_PREPEND_HEALTH_PATH?.trim() || DEFAULT_HEALTH_PATH,
    queuePath: env.OPENCLAW_MEMORY_PREPEND_QUEUE_PATH?.trim() || undefined,
    workspaceDir: env.OPENCLAW_MEMORY_PREPEND_WORKSPACE_DIR?.trim() || undefined,
    maxFragments: readPositiveInt(
      env.OPENCLAW_MEMORY_PREPEND_MAX_FRAGMENTS,
      DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS,
    ),
    maxChars: readPositiveInt(
      env.OPENCLAW_MEMORY_PREPEND_MAX_CHARS,
      DEFAULT_MEMORY_PREPEND_MAX_CHARS,
    ),
    maxBodyBytes: readPositiveInt(
      env.OPENCLAW_MEMORY_PREPEND_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
    ),
    bodyTimeoutMs: readPositiveInt(
      env.OPENCLAW_MEMORY_PREPEND_BODY_TIMEOUT_MS,
      DEFAULT_BODY_TIMEOUT_MS,
    ),
  };
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  const mediaType = first?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function isHopByHopHeader(name: string): boolean {
  switch (name.toLowerCase()) {
    case "connection":
    case "content-length":
    case "host":
    case "keep-alive":
    case "proxy-authenticate":
    case "proxy-authorization":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
      return true;
    default:
      return false;
  }
}

function copyRequestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (isHopByHopHeader(name) || value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(headers: Headers, res: ServerResponse): void {
  headers.forEach((value, name) => {
    if (isHopByHopHeader(name)) {
      return;
    }
    res.setHeader(name, value);
  });
}

function resolveForwardUrl(req: IncomingMessage, targetBaseUrl: URL): URL {
  const relative = req.url?.startsWith("/") ? req.url : `/${req.url ?? ""}`;
  return new URL(relative, targetBaseUrl);
}

async function forwardWebhookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: ShimConfig;
}): Promise<void> {
  const rawBody = await readRequestBodyWithLimit(params.req, {
    maxBytes: params.config.maxBodyBytes,
    timeoutMs: params.config.bodyTimeoutMs,
  });
  let forwardBody = rawBody;
  let didInject = false;
  let preparedDrain: Awaited<ReturnType<typeof prepareMemoryPrependQueueDrain>> | undefined;

  if (isJsonContentType(params.req.headers["content-type"])) {
    try {
      const parsedBody = JSON.parse(rawBody);
      preparedDrain = await prepareMemoryPrependQueueDrain({
        workspaceDir: params.config.workspaceDir,
        queuePath: params.config.queuePath,
        maxFragments: params.config.maxFragments,
        maxChars: params.config.maxChars,
      });
      if (preparedDrain.block) {
        const injected = prependAssociativeRecallToTelegramUpdate({
          update: parsedBody,
          recallBlock: preparedDrain.block,
        });
        if (injected.didInject) {
          forwardBody = JSON.stringify(injected.update);
          didInject = true;
        }
      }
    } catch {
      preparedDrain = undefined;
    }
  }

  const response = await fetch(resolveForwardUrl(params.req, params.config.targetBaseUrl), {
    method: params.req.method,
    headers: copyRequestHeaders(params.req),
    body: params.req.method === "GET" || params.req.method === "HEAD" ? undefined : forwardBody,
    redirect: "manual",
  });

  if (didInject && preparedDrain && response.ok) {
    const commitResult = await preparedDrain.commit();
    if (!commitResult.applied && commitResult.reason !== "noop") {
      console.warn(
        `[memory-prepend-shim] queue commit skipped (${commitResult.reason}) at ${preparedDrain.queuePath}`,
      );
    }
  }

  params.res.statusCode = response.status;
  copyResponseHeaders(response.headers, params.res);
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  params.res.end(responseBuffer);
}

async function main() {
  const config = readConfig(process.env);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === config.healthPath) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("ok");
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end("Method Not Allowed");
        return;
      }
      await forwardWebhookRequest({ req, res, config });
    } catch (error) {
      res.statusCode = 502;
      res.end(`memory-prepend-shim error: ${String(error)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(
    `[memory-prepend-shim] listening on http://${config.bind}:${config.port} -> ${config.targetBaseUrl.origin}`,
  );

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

await main();
