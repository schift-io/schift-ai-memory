#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { validateUpstreamBearer } from "./http-auth.js";
import { createServer, SchiftMcpConfig } from "./index.js";
import { readMcpConfigFromEnv } from "./local-config.js";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

function printHelp() {
  console.log(`schift-ai-memory-mcp

Usage:
  schift-ai-memory-mcp                         Start stdio MCP server
  schift-ai-memory-mcp --http                  Start Streamable HTTP server at /mcp
  schift-ai-memory-mcp token                   Generate an MCP bearer token
  schift-ai-memory-mcp init --client <target>  Print client/deploy configuration

Targets:
  claude        Claude Code stdio config
  cursor        Cursor stdio config
  remote        Remote MCP server env + client URL/header summary

Options for init:
  --bucket <name>       Default Schift bucket name or id
  --server-url <url>    Remote MCP URL, defaults to https://mcp.schift.io/mcp
  --token <token>       MCP bearer token to put in generated remote config
  --auth-mode <mode>    upstream-bearer (hosted) or static (self-host)
`);
}

function printInitConfig() {
  const client = argValue("--client") ?? "remote";
  const bucket = argValue("--bucket") ?? "docs";
  const token = argValue("--token") ?? generateBearerToken();
  const serverUrl = argValue("--server-url") ?? "https://mcp.schift.io/mcp";
  const authMode = argValue("--auth-mode") ?? "upstream-bearer";

  if (client === "claude") {
    console.log(JSON.stringify({
      schift: {
        command: "schift-ai-memory-mcp",
        env: {
          SCHIFT_API_KEY: "sk-...",
          SCHIFT_DEFAULT_BUCKET: bucket,
        },
      },
    }, null, 2));
    return;
  }

  if (client === "cursor") {
    console.log(JSON.stringify({
      mcpServers: {
        schift: {
          command: "schift-ai-memory-mcp",
          env: {
            SCHIFT_API_KEY: "sk-...",
            SCHIFT_DEFAULT_BUCKET: bucket,
          },
        },
      },
    }, null, 2));
    return;
  }

  if (client === "remote" || client === "chatgpt") {
    const hosted = authMode === "upstream-bearer";
    console.log(JSON.stringify({
      deployEnv: {
        SCHIFT_DEFAULT_BUCKET: bucket,
        ...(hosted
          ? { SCHIFT_MCP_AUTH_MODE: "upstream-bearer" }
          : {
              SCHIFT_API_KEY: "sk-...",
              SCHIFT_MCP_BEARER_TOKEN: token,
              SCHIFT_MCP_AUTH_MODE: "static",
            }),
        SCHIFT_MCP_TRANSPORT: "http",
      },
      client: {
        server_url: serverUrl,
        headers: {
          Authorization: hosted
            ? "Bearer <schift-api-key-or-oauth-access-token>"
            : `Bearer ${token}`,
        },
      },
      responsesApiTool: {
        type: "mcp",
        server_label: "schift",
        server_url: serverUrl,
        headers: {
          Authorization: hosted
            ? "Bearer <schift-api-key-or-oauth-access-token>"
            : `Bearer ${token}`,
        },
        allowed_tools: ["search", "fetch", "schift_search", "schift_memory_search"],
        require_approval: "never",
      },
    }, null, 2));
    return;
  }

  console.error(`[schift-ai-memory-mcp] unknown init client: ${client}`);
  process.exit(1);
}

function readConfig(): SchiftMcpConfig {
  try {
    return readMcpConfigFromEnv() as SchiftMcpConfig;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function readHttpConfig(apiKey: string): SchiftMcpConfig {
  return readMcpConfigFromEnv({ apiKey }) as SchiftMcpConfig;
}

async function runStdio() {
  const server = createServer(readConfig());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[schift-ai-memory-mcp] connected on stdio");
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (process.env.SCHIFT_MCP_AUTH_MODE === "upstream-bearer") {
    return extractBearerToken(req) !== undefined;
  }
  const expected = process.env.SCHIFT_MCP_BEARER_TOKEN;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

async function runHttp() {
  const authMode = process.env.SCHIFT_MCP_AUTH_MODE ?? "static";
  if (
    authMode !== "upstream-bearer" &&
    !process.env.SCHIFT_MCP_BEARER_TOKEN &&
    process.env.SCHIFT_MCP_ALLOW_UNAUTHENTICATED !== "1"
  ) {
    console.error(
      "[schift-ai-memory-mcp] SCHIFT_MCP_BEARER_TOKEN is required for HTTP mode. " +
        "Run `schift-ai-memory-mcp token` to generate one, or set SCHIFT_MCP_ALLOW_UNAUTHENTICATED=1 for local-only development.",
    );
    process.exit(1);
  }

  const staticConfig = authMode === "upstream-bearer" ? undefined : readConfig();
  const port = Number.parseInt(
    process.env.PORT ?? process.env.SCHIFT_MCP_PORT ?? "8787",
    10,
  );
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { status: "ok", service: "schift-ai-memory-mcp" });
      return;
    }
    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;
      let transport = sessionId ? transports[sessionId] : undefined;
      const parsedBody = req.method === "POST" ? await readBody(req) : undefined;

      if (!transport && req.method === "POST" && isInitializeRequest(parsedBody)) {
        const requestConfig = authMode === "upstream-bearer"
          ? readHttpConfig(extractBearerToken(req) as string)
          : staticConfig as SchiftMcpConfig;
        if (authMode === "upstream-bearer") {
          const validation = await validateUpstreamBearer(requestConfig);
          if (!validation.ok) {
            writeJson(res, validation.status, { error: "unauthorized", detail: validation.error });
            return;
          }
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports[newSessionId] = transport;
          },
          onsessionclosed: (closedSessionId) => {
            delete transports[closedSessionId];
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) delete transports[closedSessionId];
        };
        await createServer(requestConfig).connect(transport);
      }

      if (!transport) {
        writeJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: missing or invalid MCP session",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      console.error("[schift-ai-memory-mcp] http error:", err);
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`[schift-ai-memory-mcp] streamable HTTP listening on http://localhost:${port}/mcp`);
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "token") {
    console.log(generateBearerToken());
    return;
  }
  if (command === "init") {
    printInitConfig();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  const transport = process.env.SCHIFT_MCP_TRANSPORT;
  if (process.argv.includes("--http") || transport === "http") {
    await runHttp();
    return;
  }
  await runStdio();
}

main().catch((err) => {
  console.error("[schift-ai-memory-mcp] fatal:", err);
  process.exit(1);
});
