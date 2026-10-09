// Mock Google API (Gmail + Calendar) for running gmail-mcp's tests without Google.
// No real OAuth, no network: the MCP server points at this via GOOGLE_API_BASE_URL.
//
// Env:
//   PORT            listen port (default 9099)
//   MOCK_BARE_LIST  =1 makes /messages return bare rows (no payload/snippet) plus one
//                   phantom row that GET /messages/phantom-9 will 404 on — this
//                   reproduces the "list rows with all-null enrichment" production
//                   symptom and the backfill-failure path.
//   MOCK_LOG_FILE   if set, every request is appended here as one line — tests use
//                   this to assert the backfill traffic the server produced.

import http from "node:http";
import fs from "node:fs";

const b64u = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const MSGS = [
  {
    id: "msg-unread-1",
    threadId: "th-1",
    labelIds: ["INBOX", "UNREAD", "STARRED"],
    snippet: "Can you review the PR before EOD?",
    payload: {
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "smoke-test@gmail.com" },
        { name: "Subject", value: "PR review request" },
        { name: "Date", value: "Mon, 8 Sep 2026 14:02:11 -0700" },
      ],
    },
  },
  {
    id: "msg-read-2",
    threadId: "th-2",
    labelIds: ["INBOX"],
    snippet: "Lunch at 12?",
    payload: {
      headers: [
        { name: "From", value: "Bob <bob@example.com>" },
        { name: "To", value: "smoke-test@gmail.com" },
        { name: "Subject", value: "Lunch?" },
        { name: "Date", value: "Tue, 9 Sep 2026 09:15:00 -0700" },
      ],
    },
  },
];

const FULL = {
  id: "msg-unread-1",
  threadId: "th-1",
  labelIds: ["INBOX", "UNREAD", "STARRED"],
  snippet: "Can you review the PR before EOD?",
  payload: {
    mimeType: "multipart/mixed",
    headers: MSGS[0].payload.headers,
    parts: [
      {
        mimeType: "text/plain",
        body: { data: b64u("Can you review the PR before EOD? =3D=3D\nThanks!") },
        headers: [{ name: "Content-Transfer-Encoding", value: "quoted-printable" }],
      },
      {
        mimeType: "application/pdf",
        body: { attachmentId: "att-123" },
        filename: "report.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="report.pdf"' }],
      },
    ],
  },
};

const LABELS = [
  { name: "INBOX", id: "INBOX", messagesUnread: 1, messagesTotal: 42 },
  { name: "Work", id: "Label_1", messagesUnread: 2, messagesTotal: 17 },
  { name: "SENT", id: "SENT", messagesTotal: 130 },
];

// ---- Calendar fixtures ----
const CALS = [
  { id: "primary", summary: "Personal", primary: true, timeZone: "America/New_York", accessRole: "owner" },
  { id: "work@group.calendar.google.com", summary: "Work", timeZone: "America/Chicago", accessRole: "writer" },
];

let EVENTS = [
  {
    id: "evt-1",
    summary: "Design sync",
    start: { dateTime: "2026-10-12T15:00:00-05:00" },
    end: { dateTime: "2026-10-12T15:30:00-05:00" },
    attendees: [{ email: "alice@example.com" }],
    htmlLink: "https://calendar.example/evt-1",
  },
  {
    id: "evt-2",
    summary: "Dentist",
    start: { dateTime: "2026-10-13T09:00:00-05:00" },
    end: { dateTime: "2026-10-13T09:30:00-05:00" },
  },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const line = `${req.method} ${url.pathname}${url.search}`;
  console.error("[mock]", line);
  if (process.env.MOCK_LOG_FILE) fs.appendFile(process.env.MOCK_LOG_FILE, line + "\n", () => {});
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = () =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });

  if (p === "/gmail/v1/users/me" || p === "/gmail/v1/users/me/profile") {
    return send(200, { emailAddress: "smoke-test@gmail.com" });
  }
  if (p === "/gmail/v1/users/me/messages") {
    const q = url.searchParams.get("q") ?? "";
    let msgs;
    if (!q) msgs = MSGS;
    else if (/subject:/i.test(q)) {
      // honor the "subject:" operator minimally (Gmail does, the old mock didn't)
      const term = q.toLowerCase().split("subject:")[1].split(/\s+/)[0];
      msgs = MSGS.filter((m) => m.payload.headers.find((h) => h.name === "Subject")?.value.toLowerCase().includes(term));
    } else if (/has:subject/i.test(q)) {
      msgs = MSGS.filter((m) => m.payload.headers.some((h) => h.name === "Subject"));
    } else {
      msgs = MSGS.filter((m) => (m.snippet ?? "").toLowerCase().includes(q.toLowerCase()));
    }
    if (process.env.MOCK_BARE_LIST === "1") {
      // Bare rows (no snippet, no payload) + a phantom that 404s on fetch.
      msgs = [
        ...msgs.map((m) => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds })),
        { id: "phantom-9", threadId: "th-9", labelIds: ["INBOX", "UNREAD"] },
      ];
    }
    return send(200, { messages: msgs });
  }
  if (p === "/gmail/v1/users/me/labels") return send(200, { labels: LABELS });
  if (p === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
    return send(201, { id: "msg-sent-1", threadId: "th-sent" });
  }
  let m = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/);
  if (m && req.method === "POST") {
    return (async () => {
      const rb = JSON.parse(await readBody() || "{}");
      let labels = ["INBOX", "UNREAD"];
      for (const l of rb.addLabelIds ?? []) labels = [...new Set([...labels, l])];
      for (const l of rb.removeLabelIds ?? []) labels = labels.filter((x) => x !== l);
      send(200, { id: m[1], labelIds: labels });
    })();
  }
  m = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
  if (m) {
    if (m[1] === "scope-err-403") {
      return send(403, { error: { code: 403, message: "insufficient authentication scopes", status: "INSUFFICIENT_PERMISSIONS" } });
    }
    if (m[1] === "nope-404" || m[1] === "phantom-9") {
      return send(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } });
    }
    if (m[1] === "msg-unread-1") return send(200, FULL);
    const found = MSGS.find((x) => x.id === m[1]);
    if (found) {
      return send(200, {
        id: found.id,
        threadId: found.threadId,
        labelIds: found.labelIds,
        snippet: found.snippet,
        payload: { mimeType: "text/plain", headers: found.payload.headers, body: { data: b64u(found.snippet) } },
      });
    }
    return send(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } });
  }

  // ---- Calendar ----
  if (p === "/calendar/v3/calendarList" || p === "/calendar/v3/users/me/calendarList") return send(200, { items: CALS });
  if (p === "/calendar/v3/freeBusy" && req.method === "POST") {
    return (async () => {
      const rb = JSON.parse(await readBody() || "{}");
      const calendars = {};
      for (const it of rb.items ?? []) {
        calendars[it.id] = {
          busy: EVENTS.filter((e) => (e.start.dateTime ?? "") >= (rb.timeMin ?? "") && (e.start.dateTime ?? "") < (rb.timeMax ?? "z")).map(
            (e) => ({ start: e.start.dateTime, end: e.end.dateTime }),
          ),
        };
      }
      send(200, { calendars });
    })();
  }
  let c = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);
  if (c) {
    const eid = c[2];
    const ev = EVENTS.find((e) => e.id === eid);
    if (req.method === "GET") return ev ? send(200, ev) : send(404, { error: { code: 404, message: "Event not found" } });
    if (req.method === "PUT") {
      return (async () => {
        if (!ev) return send(404, { error: { code: 404, message: "Event not found" } });
        Object.assign(ev, JSON.parse(await readBody() || "{}"));
        send(200, ev);
      })();
    }
    if (req.method === "DELETE") {
      EVENTS = EVENTS.filter((e) => e.id !== eid);
      return send(204, {});
    }
  }
  c = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  if (c) {
    if (req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const min = url.searchParams.get("timeMin") ?? "";
      const max = url.searchParams.get("timeMax") ?? "z";
      const items = EVENTS.filter(
        (e) =>
          (!min || (e.start.dateTime ?? "") >= min) &&
          (e.start.dateTime ?? "") < max &&
          (!q || (e.summary ?? "").toLowerCase().includes(q)),
      );
      return send(200, { items });
    }
    if (req.method === "POST") {
      return (async () => {
        const rb = JSON.parse(await readBody() || "{}");
        const ev = { ...rb, id: `evt-new-${EVENTS.length + 1}` };
        EVENTS.push(ev);
        send(201, ev);
      })();
    }
  }

  send(500, { error: { code: 500, message: "unhandled mock route " + req.method + " " + p } });
});

const port = Number(process.env.PORT || 9099);
server.listen(port, "127.0.0.1", () => console.error(`[mock] Google API mock listening on ${port}`));
process.on("SIGTERM", () => server.close());
