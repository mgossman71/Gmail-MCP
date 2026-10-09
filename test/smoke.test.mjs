// End-to-end smoke tests: run the real built MCP server (dist/index.js) over HTTP
// against the bundled mock Google API (test/mock-google.mjs). No Google, no OAuth,
// no network beyond localhost. Two server instances: one against a "normal" mock,
// one against the MOCK_BARE_LIST mock that reproduces the all-null list-rows
// production symptom (verifies the enrichment backfill + enriched:false path).
//
// Requires: `npm run build` first (the npm test script handles the order).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

const NORMAL = { mock: 19099, server: 19199 };
const BARE = { mock: 19299, server: 19399 };

const children = [];
let bareLog = "";

function startProc(args, env, label) {
  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  proc.stdout.on("data", (d) => out.push(d));
  proc.stderr.on("data", (d) => out.push(d));
  proc.__dump = () => Buffer.concat(out).toString("utf8").slice(-4000);
  children.push(proc);
  console.error(`[smoke] started ${label}`);
  return proc;
}

async function waitFor(url, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await SLEEP(150);
  }
  throw new Error(`timed out waiting for ${what} at ${url}`);
}

async function startPair({ mock, server }, extraMockEnv = {}, label = "server") {
  const logFile = path.join(os.tmpdir(), `gmail-mcp-mock-${mock}-${process.pid}.log`);
  fs.writeFileSync(logFile, "");
  const mockProc = startProc(["test/mock-google.mjs"], { PORT: String(mock), MOCK_LOG_FILE: logFile, ...extraMockEnv }, `mock(${mock})`);
  await waitFor(`http://127.0.0.1:${mock}/gmail/v1/users/me/profile`, "mock");
  const serverProc = startProc(
    ["dist/index.js"],
    {
      MCP_PORT: String(server),
      MCP_TRANSPORT: "http",
      HTTP_HOST: "127.0.0.1",
      GOOGLE_API_BASE_URL: `http://127.0.0.1:${mock}`,
      NODE_ENV: "test",
    },
    label,
  );
  await waitFor(`http://127.0.0.1:${server}/healthz`, label);
  return { mockProc, serverProc, logFile, base: `http://127.0.0.1:${server}` };
}

let normal, bare;

before(async () => {
  if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) {
    throw new Error("dist/ not found — run `npm run build` (or `npm test`) first");
  }
  normal = await startPair(NORMAL, {}, "normal-server");
  bare = await startPair(BARE, { MOCK_BARE_LIST: "1" }, "bare-server");
  bareLog = bare.logFile;
});

after(async () => {
  for (const p of children) p.kill("SIGTERM");
  await SLEEP(300);
  for (const p of children) if (!p.killed) p.kill("SIGKILL");
  children.length = 0;
});

let rpcId = 0;

// The Streamable HTTP transport requires an MCP session: initialize once per
// server, then send the mcp-session-id header on every request. Responses are
// SSE (text/event-stream) with the JSON-RPC payload in the data: line.
const sessions = new Map();

async function mcpSession(base) {
  if (sessions.has(base)) return sessions.get(base);
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke-test", version: "1.0" } },
    }),
  });
  const sid = r.headers.get("mcp-session-id");
  const raw = await r.text();
  if (!r.ok || !sid) throw new Error(`initialize failed: ${r.status} ${raw.slice(0, 300)}`);
  // initialized notification (per spec; fire-and-forget)
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
  const s = { sid };
  sessions.set(base, s);
  return s;
}

function parseMcpResponse(raw, contentType) {
  if ((contentType || "").includes("text/event-stream")) {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    return JSON.parse(data || "{}");
  }
  return raw ? JSON.parse(raw) : {};
}

async function call(base, tool, args = {}) {
  const s = await mcpSession(base);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": s.sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  const j = parseMcpResponse(raw, res.headers.get("content-type"));
  const text = (j.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, isError: Boolean(j.result?.isError), error: j.error };
}

const jsonOf = (r) => {
  try {
    return JSON.parse(r.text);
  } catch (e) {
    throw new Error(`expected JSON, got: ${r.text.slice(0, 300)}\n(${e.message})`);
  }
};

// ============================ normal API ============================

test("healthz reports account + scopes (mock mode)", async () => {
  const r = await fetch(`${normal.base}/healthz`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.endpoint, "/mcp");
  // account verification is a background fetch; allow it a moment to land
  for (let i = 0; i < 10 && j.account.authenticated !== "smoke-test@gmail.com"; i++) {
    await SLEEP(200);
    Object.assign(j, await (await fetch(`${normal.base}/healthz`)).json());
  }
  assert.equal(j.account.authenticated, "smoke-test@gmail.com");
  assert.ok(j.scopes.requested.includes("https://www.googleapis.com/auth/gmail.modify"));
  assert.ok(Array.isArray(j.scopes.missing));
});

test("gmail_list_messages (text) shows from + subject in one call", async () => {
  const r = await call(normal.base, "gmail_list_messages", { labelId: "INBOX" });
  assert.equal(r.isError, false);
  assert.match(r.text, /Alice <alice@example\.com>/);
  assert.match(r.text, /Subject: PR review request/);
  assert.match(r.text, /UNREAD/);
  assert.match(r.text, /STARRED/);
});

test("gmail_list_messages (json) rows populated with enriched:true", async () => {
  const rows = jsonOf(await call(normal.base, "gmail_list_messages", { labelId: "INBOX", format: "json" }));
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  for (const row of rows) {
    assert.ok(row.from && row.to && row.subject && row.date && row.snippet, `row ${row.id} should be fully populated`);
    assert.equal(row.enriched, true);
  }
  assert.equal(a.id, "msg-unread-1");
  assert.equal(a.unread, true);
  assert.equal(a.starred, true);
  assert.equal(b.unread, false);
});

test("gmail_search_messages (json) returns enriched rows", async () => {
  const rows = jsonOf(await call(normal.base, "gmail_search_messages", { q: "subject:PR", format: "json" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "msg-unread-1");
  assert.equal(rows[0].subject, "PR review request");
  assert.equal(rows[0].enriched, true);
});

test("gmail_get_message (text): QP body decoded + attachment listed", async () => {
  const r = await call(normal.base, "gmail_get_message", { messageId: "msg-unread-1" });
  assert.equal(r.isError, false);
  assert.match(r.text, /==/); // "=3D=3D" must decode to literal "=="
  assert.match(r.text, /Thanks!/);
  assert.match(r.text, /report\.pdf/);
});

test("gmail_get_message (json): body + attachment metadata", async () => {
  const m = jsonOf(await call(normal.base, "gmail_get_message", { messageId: "msg-unread-1", format: "json" }));
  assert.equal(m.id, "msg-unread-1");
  assert.match(m.body, /==/);
  assert.deepEqual(m.attachments, ["report.pdf"]);
  assert.equal(m.from, "Alice <alice@example.com>");
});

test("gmail_list_labels (json)", async () => {
  const labels = jsonOf(await call(normal.base, "gmail_list_labels", { format: "json" }));
  assert.equal(labels.length, 3);
  const inbox = labels.find((l) => l.id === "INBOX");
  assert.equal(inbox.name, "INBOX");
  assert.equal(inbox.messagesUnread, 1);
  const work = labels.find((l) => l.id === "Label_1");
  assert.equal(work.name, "Work");
});

test("gmail_apply_labels accepts a single label string", async () => {
  const r = await call(normal.base, "gmail_apply_labels", { messageId: "msg-read-2", labels: "Work", remove: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Updated\. labels=/);
});

test("gmail_apply_labels accepts an array of labels", async () => {
  const r = await call(normal.base, "gmail_apply_labels", { messageId: "msg-read-2", labels: ["Work", "INBOX"], remove: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Updated\. labels=/);
});

test("gmail_send_email returns the new message id", async () => {
  const r = await call(normal.base, "gmail_send_email", { to: "alice@example.com", subject: "Hi", body: "hello" });
  assert.equal(r.isError, false);
  assert.match(r.text, /msg-sent-1/);
});

test("403 surfaces as an error with scope remediation", async () => {
  const r = await call(normal.base, "gmail_get_message", { messageId: "scope-err-403" });
  assert.equal(r.isError, true);
  assert.match(r.text, /insufficient authentication scopes/);
  assert.match(r.text, /healthz/);
});

test("404 surfaces as an error with input guidance", async () => {
  const r = await call(normal.base, "gmail_get_message", { messageId: "nope-404" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found/i);
});
// ============================ calendar ============================

test("calendar_list_calendars (text)", async () => {
  const r = await call(normal.base, "calendar_list_calendars");
  assert.equal(r.isError, false);
  assert.match(r.text, /Personal/);
  assert.match(r.text, /Work/);
});

test("calendar_list_events (text) within a window", async () => {
  const r = await call(normal.base, "calendar_list_events", {
    calendarId: "primary",
    timeMin: "2026-10-12T00:00:00Z",
    timeMax: "2026-10-13T00:00:00Z",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /evt-1/);
  assert.match(r.text, /Design sync/);
  assert.doesNotMatch(r.text, /Dentist/);
});

test("calendar_get_event returns the fetched event", async () => {
  const r = await call(normal.base, "calendar_get_event", { eventId: "evt-1" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /\[id=evt-1\]/);
  assert.match(r.text, /Design sync/);
});

test("calendar_create_event (timed) then calendar_get_event sees it", async () => {
  const c = await call(normal.base, "calendar_create_event", {
    summary: "Test event",
    start: "2026-10-20T15:00:00-05:00",
    location: "HQ",
    attendees: ["alice@example.com"],
  });
  assert.equal(c.isError, false, c.text);
  assert.match(c.text, /Created event/);
  assert.match(c.text, /Test event/);
  const idMatch = c.text.match(/\[id=(evt-new-\d+)\]/);
  assert.ok(idMatch, `expected a new event id in: ${c.text}`);
  const g = await call(normal.base, "calendar_get_event", { eventId: idMatch[1] });
  assert.equal(g.isError, false);
  assert.match(g.text, /Test event/);
});

test("calendar_update_event changes fields", async () => {
  const r = await call(normal.base, "calendar_update_event", { eventId: "evt-1", summary: "Design sync (moved)", location: "Room 2" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Updated event/);
  assert.match(r.text, /Design sync \(moved\)/);
  assert.match(r.text, /Room 2/);
});

test("calendar_delete_event removes it (subsequent get 404s)", async () => {
  const d = await call(normal.base, "calendar_delete_event", { eventId: "evt-2" });
  assert.equal(d.isError, false, d.text);
  assert.match(d.text, /deleted/);
  const g = await call(normal.base, "calendar_get_event", { eventId: "evt-2" });
  assert.equal(g.isError, true);
});

test("calendar_find_free_time finds slots around busy time", async () => {
  // evt-1 occupies 15:00–15:30 -05:00 on Oct 12 → free slots either side.
  const r = await call(normal.base, "calendar_find_free_time", {
    start: "2026-10-12T14:00:00Z",
    end: "2026-10-12T16:00:00Z",
    attendees: ["primary"],
    minSlotMinutes: 15,
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /free slot/i);
});

// ======================= bare list (backfill) =======================

test("BARE list (json): rows backfilled, phantom degrades to enriched:false", async () => {
  const rows = jsonOf(await call(bare.base, "gmail_list_messages", { labelId: "INBOX", format: "json" }));
  assert.equal(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of ["msg-unread-1", "msg-read-2"]) {
    const row = byId[id];
    assert.ok(row, `row ${id} present`);
    assert.ok(row.from && row.to && row.subject && row.date && row.snippet, `${id} should be backfilled`);
    assert.equal(row.enriched, true);
  }
  const ph = byId["phantom-9"];
  assert.ok(ph, "phantom row present (degraded, not dropped)");
  assert.equal(ph.enriched, false);
  assert.equal(ph.from, null); // null = not fetched, per the contract
  assert.equal(ph.unread, true); // labels from the bare row still usable
});

test("BARE search (json) also backfills", async () => {
  const rows = jsonOf(await call(bare.base, "gmail_search_messages", { q: "Lunch", format: "json" }));
  const hit = rows.find((r) => r.id === "msg-read-2");
  assert.ok(hit);
  assert.equal(hit.enriched, true);
  assert.equal(hit.subject, "Lunch?");
});

test("BARE list (text) shows backfilled from/subject", async () => {
  const r = await call(bare.base, "gmail_list_messages", { labelId: "INBOX" });
  assert.equal(r.isError, false);
  assert.match(r.text, /From: Alice <alice@example\.com>/);
  assert.match(r.text, /Subject: PR review request/);
});

test("backfill used per-message metadata fetches (mock request log)", async () => {
  await SLEEP(200); // let appendFile flush
  const log = fs.readFileSync(bareLog, "utf8");
  for (const id of ["msg-unread-1", "msg-read-2", "phantom-9"]) {
    const line = log
      .split("\n")
      .find((l) => l.includes(`/messages/${id}`) && l.includes("format=metadata"));
    assert.ok(line, `expected a format=metadata fetch for ${id}; log:\n${log.slice(0, 1500)}`);
  }
});

