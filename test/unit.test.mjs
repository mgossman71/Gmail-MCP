// Unit tests for the pure helpers in src/gmail.ts (tested against the compiled
// dist/ output — same code Docker ships). Run via `npm test` (builds first).
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeBody, toRow, summarize } from "../dist/gmail.js";

const b64u = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const HEADERS = [
  { name: "From", value: "Alice <alice@example.com>" },
  { name: "To", value: "me@example.com" },
  { name: "Subject", value: "Hello" },
  { name: "Date", value: "Mon, 8 Sep 2026 14:02:11 -0700" },
];

// ---- decodeBody ----

test("decodeBody: quoted-printable decodes =XX escapes", () => {
  assert.equal(decodeBody(b64u("a =3D=3D b"), "text/plain", "quoted-printable"), "a == b");
});

test("decodeBody: quoted-printable strips soft line breaks (= at end of line)", () => {
  assert.equal(decodeBody(b64u("soft=\nline"), "text/plain", "quoted-printable"), "softline");
});

test("decodeBody: quoted-printable decodes UTF-8 byte escapes", () => {
  // "café" → é is =E9 in QP
  assert.equal(decodeBody(b64u("caf=E9"), "text/plain", "quoted-printable"), "café");
});

test("decodeBody: no Content-Transfer-Encoding → plain base64url text, no QP pass", () => {
  // A literal "=3D" in a 7bit body must survive untouched (not decoded to "=")
  assert.equal(decodeBody(b64u("1 + 1 =3D 2"), "text/plain", "7bit"), "1 + 1 =3D 2");
});

test("decodeBody: non-text part is never QP-decoded", () => {
  // binary payloads keep their literal "=XX" bytes even with a QP CTE
  assert.equal(decodeBody(b64u("=3D"), "application/octet-stream", "quoted-printable"), "=3D");
});

test("decodeBody: empty data → empty string", () => {
  assert.equal(decodeBody("", "text/plain", undefined), "");
});

// ---- toRow ----

const item = (over = {}) => ({
  m: { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "snip", payload: { headers: HEADERS }, ...over.m },
  enriched: over.enriched ?? true,
});

test("toRow: enriched row exposes all fields + flags", () => {
  const r = toRow(item());
  assert.equal(r.id, "m1");
  assert.equal(r.threadId, "t1");
  assert.equal(r.from, "Alice <alice@example.com>");
  assert.equal(r.to, "me@example.com");
  assert.equal(r.subject, "Hello");
  assert.equal(r.date, "Mon, 8 Sep 2026 14:02:11 -0700");
  assert.equal(r.snippet, "snip");
  assert.deepEqual(r.labels, ["INBOX", "UNREAD"]);
  assert.equal(r.unread, true);
  assert.equal(r.starred, false);
  assert.equal(r.enriched, true);
});

test("toRow: bare row (enrichment failed) → nulls + enriched:false", () => {
  const r = toRow(item({ m: { id: "bare", labelIds: ["INBOX"], snippet: undefined, payload: undefined }, enriched: false }));
  assert.equal(r.from, null);
  assert.equal(r.subject, null);
  assert.equal(r.snippet, null);
  assert.equal(r.enriched, false);
});

test("toRow: missing Subject header on an enriched row → null is a fact, not an error", () => {
  const r = toRow(item({ m: { id: "m2", payload: { headers: HEADERS.filter((h) => h.name !== "Subject") } } }));
  assert.equal(r.subject, null);
  assert.equal(r.enriched, true); // the API answered; absence is genuine
});

test("toRow: missing threadId → null (not undefined)", () => {
  const r = toRow(item({ m: { id: "m3", threadId: undefined } }));
  assert.equal(r.threadId, null);
});

// ---- summarize ----

test("summarize: empty list", () => {
  assert.equal(summarize([]), "No messages found.");
});

test("summarize: renders from/subject + flags", () => {
  const s = summarize([item(), item({ m: { id: "m4", threadId: "t4", labelIds: ["INBOX", "STARRED"] } })]);
  assert.match(s, /\[id=m1 thread=t1\] \(UNREAD\)/);
  assert.match(s, /From: Alice <alice@example\.com>/);
  assert.match(s, /Subject: Hello/);
  assert.match(s, /Can you review|snip/); // snippet line present for m1
  assert.match(s, /\(STARRED\)/);
});

test("summarize: missing subject renders placeholder, never crashes", () => {
  const s = summarize([item({ m: { id: "no-subj", payload: { headers: [] } } })]);
  assert.match(s, /Subject: \(no subject\)/);
});
