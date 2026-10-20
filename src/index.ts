/**
 * index.ts — local entry point for the ViroReact knowledge tools.
 *
 * Serves the read-only tools in src/tools over MCP Streamable HTTP at /viro
 * (/mcp is an alias), answering from knowledge/reactviro.db. If the database is
 * missing it is downloaded from KB_URL, or built with `npm run index`.
 *
 * This is the open part of the hosted server at https://mcp.reactvision.xyz/viro.
 * It has no authentication, so it binds to 127.0.0.1 unless HOST says otherwise.
 *
 * Environment:
 *   - PORT      HTTP port (default 3000)
 *   - HOST      Bind address (default 127.0.0.1)
 *   - KB_URL    Where to download reactviro.db from when it is not on disk
 */
import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { DB_PATH, KB_DIR, openDb } from "./db.js";
import { registerFileTools } from "./tools/files.js";
import { registerCustomTools } from "./tools/custom.js";
import { applyArgAliases } from "./tools/argAliases.js";

async function ensureDb(): Promise<void> {
  if (existsSync(DB_PATH)) return;
  const url = process.env["KB_URL"];
  if (!url) {
    console.error(`knowledge/${config.dbName} not found and KB_URL is not set.`);
    console.error("Run `npm run index`, or set KB_URL to a download URL for the database.");
    process.exit(1);
  }
  console.log(`Downloading knowledge base from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KB download failed: HTTP ${res.status}`);
  await mkdir(KB_DIR, { recursive: true });
  await writeFile(DB_PATH, Buffer.from(await res.arrayBuffer()));
}

await ensureDb();
const db = openDb();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: config.name, version: config.version });
  registerFileTools(server, db);
  registerCustomTools(server, db);
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: config.name, version: config.version });
});

async function handleMcp(req: Request, res: Response): Promise<void> {
  // Stateless: a fresh server and transport per request.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close().catch(() => {}));
  try {
    applyArgAliases(req.body);
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp_error", (err as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
}

// No server→client stream and no sessions: answer 405, which clients treat as
// "no stream here" rather than as the session ending.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } });
}

for (const path of ["/viro", "/mcp"]) {
  app.post(path, handleMcp);
  app.get(path, methodNotAllowed);
  app.delete(path, methodNotAllowed);
}

const PORT = Number(process.env["PORT"] ?? config.port);
const HOST = process.env["HOST"] ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`${config.name} listening on http://${HOST}:${PORT}/viro`);
});
