import { randomUUID } from "node:crypto";
import "dotenv/config";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Response } from "express";
import { registerGmailTools } from "./gmail.js";
import { registerCalendarTools } from "./calendar.js";
import { getHealthInfo, verifyAccountForHealth } from "./auth.js";

const PORT = Number(process.env.MCP_PORT || 3333);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();

// All logging goes to stderr (stdout is never used by the HTTP transport).
function log(...a: unknown[]): void {
  console.error("[gmail-mcp]", ...a);
}

function createServer(): McpServer {
  const server = new McpServer({ name: "gmail-mcp", version: "1.0.0" });
  registerGmailTools(server);
  registerCalendarTools(server);
  return server;
}

function authorized(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!MCP_AUTH_TOKEN) return true;
  const h = req.headers["authorization"];
  const value = Array.isArray(h) ? h[0] : h;
  return value === `Bearer ${MCP_AUTH_TOKEN}`;
}

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

const app = createMcpExpressApp({ host: HOST });

type Session = { transport: StreamableHTTPServerTransport; server: McpServer };
const sessions = new Map<string, Session>();

app.all("/mcp", async (req, res) => {
  if (!authorized(req)) {
    rpcError(res, 401, "Unauthorized");
    return;
  }

  const header = req.headers["mcp-session-id"];
  const sid = Array.isArray(header) ? header[0] : header;

  // Existing session
  if (sid) {
    const session = sessions.get(sid);
    if (!session) {
      rpcError(res, 404, "Unknown or expired session");
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session: only the initial (initialize) POST may open one.
  if (req.method !== "POST") {
    rpcError(res, 405, "Method not allowed");
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const server = createServer();
  const session: Session = { transport, server };
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
    void server.close();
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  // The session id is assigned while processing the initialize request above.
  if (transport.sessionId) sessions.set(transport.sessionId, session);
});

// Lightweight liveness probe (does not require an MCP session or Google auth).
// `account` identifies which mailbox this port is bound to (disambiguates the
// two-instance setup); `scopes.missing` non-empty means re-auth is needed.
app.get("/healthz", (_req, res) => {
  const info = getHealthInfo();
  res.status(200).json({
    ok: true,
    name: "gmail-mcp",
    endpoint: "/mcp",
    port: PORT,
    account: {
      expected: info.expectedAccount,
      authenticated: info.authenticatedEmail,
    },
    scopes: info.scopes,
  });
});

app.listen(PORT, HOST, () => {
  log(`MCP server listening on http://${HOST}:${PORT}/mcp`);
  log(`17 tools registered (10 Gmail + 7 Calendar)`);
  if (!MCP_AUTH_TOKEN) log("no MCP_AUTH_TOKEN set; endpoint is unauthenticated (ok for local-only use)");
  verifyAccountForHealth(); // best-effort; fills /healthz account.authenticated
});