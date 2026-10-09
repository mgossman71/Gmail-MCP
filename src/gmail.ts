import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGmail } from "./auth.js";
type GmailClient = Awaited<ReturnType<typeof getGmail>>;

type Header = { name: string; value: string };
type Part = {
  mimeType?: string | null;
  body?: { data?: string | null; attachmentId?: string | null } | null;
  parts?: Part[];
  headers?: Header[];
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

// Turn Google API failures into messages that say what to DO about them.
function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (
    (lower.includes("insufficient") && lower.includes("scope")) ||
    lower.includes("permission denied") ||
    lower.includes(" 403")
  ) {
    return (
      msg +
      " — this looks like a missing OAuth scope. Check the granted/missing scopes at /healthz; " +
      "if any requested scope is missing, re-run `npm run auth` (or `npm run auth:headless`) with full scopes."
    );
  }
  if (lower.includes("invalid_grant") || lower.includes("rejected the refresh token")) {
    return msg; // already carries its own remediation steps
  }
  if (lower.includes("invalid label") || lower.includes("not found") || lower.includes("invalid argument")) {
    return msg + " — check the input (label names/ids and message ids come from gmail_list_labels / list results).";
  }
  return msg;
}

function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${describeError(e)}` }], isError: true };
}

const LIST_HEADERS = ["Subject", "From", "To", "Date"];

const formatSchema = z
  .enum(["text", "json"])
  .default("text")
  .describe("Output format: 'text' = human-readable (default); 'json' = a pure JSON payload you can parse directly");

type ListMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Header[] };
};

/** A listed message plus whether its enrichment fields were actually returned by the API. */
type ListedMessage = { m: ListMessage; enriched: boolean };

const hasEnrichment = (m: ListMessage): boolean => Boolean(m.payload?.headers?.length);

// metadataHeaders is a real Gmail API param that the googleapis TS types omit
async function listMessages(
  gmail: GmailClient,
  opts: { q?: string; labelIds?: string[]; maxResults: number },
): Promise<ListedMessage[]> {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: opts.q,
    labelIds: opts.labelIds,
    maxResults: opts.maxResults,
    metadataHeaders: LIST_HEADERS,
  } as any);
  const msgs = (res.data?.messages ?? []) as unknown as ListMessage[];
  await backfillEnrichment(gmail, msgs);
  return msgs.map((m) => ({ m, enriched: hasEnrichment(m) }));
}

// Some list responses come back as bare rows (no payload.headers / no snippet).
// Backfill those rows with cheap per-message metadata fetches (full headers +
// snippet, no bodies). Failures degrade to the bare row for that message only.
async function backfillEnrichment(gmail: GmailClient, msgs: ListMessage[]): Promise<void> {
  const needs = msgs.filter((m) => !hasEnrichment(m) || !m.snippet);
  if (!needs.length) return;
  const BATCH = 10;
  for (let i = 0; i < needs.length; i += BATCH) {
    const chunk = needs.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map((m) =>
        gmail.users.messages
          .get({ userId: "me", id: m.id, format: "metadata" } as any)
          .then((r) => r.data),
      ),
    );
    results.forEach((r, j) => {
      if (r.status !== "fulfilled" || !r.value) return;
      if (r.value.payload?.headers) chunk[j].payload = { ...chunk[j].payload, headers: r.value.payload.headers as Header[] };
      if (r.value.snippet && !chunk[j].snippet) chunk[j].snippet = r.value.snippet;
    });
  }
}

function base64UrlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// base64url-decode, then a quoted-printable pass when the part is actually QP-encoded
// (per its Content-Transfer-Encoding header, or soft line breaks).
export function decodeBody(data: string, mimeType?: string | null, cte?: string): string {
  let s = base64UrlDecode(data);
  const isQp = cte?.toLowerCase() === "quoted-printable" || /=\r?\n/.test(s);
  if (mimeType?.startsWith("text/") && isQp) {
    s = s
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return s;
}

function header(hs: Header[] | undefined, name: string): string {
  return hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Structured row for JSON output / internal use. */
export function toRow(item: ListedMessage): Record<string, unknown> {
  const m = item.m;
  const hs = m.payload?.headers;
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    threadId: m.threadId ?? null,
    from: header(hs, "From") || null,
    to: header(hs, "To") || null,
    subject: header(hs, "Subject") || null,
    date: header(hs, "Date") || null,
    snippet: m.snippet ?? null,
    labels,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    enriched: item.enriched,
  };
}

export function summarize(items: ListedMessage[]): string {
  if (!items.length) return "No messages found.";
  return items
    .map((item, i) => {
      const m = item.m;
      const r = toRow(item);
      const flags = [r.unread ? "UNREAD" : "", r.starred ? "STARRED" : ""].filter(Boolean).join(" ");
      return [
        `${i + 1}. [id=${m.id}${m.threadId ? ` thread=${m.threadId}` : ""}]${flags ? ` (${flags})` : ""} ${r.date ?? ""}`.trimEnd(),
        `   From: ${r.from ?? "?"}`,
        `   Subject: ${r.subject ?? "(no subject)"}`,
        r.snippet ? `   ${r.snippet}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function findPart(part: Part | undefined, type: string): Part | null {
  if (!part) return null;
  if (part.body && part.mimeType?.startsWith(type)) return part;
  for (const p of part.parts ?? []) {
    const r = findPart(p, type);
    if (r) return r;
  }
  return null;
}

/** Recursively collect attachment filenames (falls back to the mime type). */
function collectAttachments(part: Part | undefined, out: string[] = []): string[] {
  if (!part) return out;
  if (part.body?.attachmentId) {
    const disp = part.headers?.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    out.push(m ? m[1] : (part.mimeType ?? "attachment"));
  }
  for (const p of part.parts ?? []) collectAttachments(p, out);
  return out;
}

type Attachment = { filename: string; mimeType: string; data: string };
type EmailInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  isHtml: boolean;
  attachments?: Attachment[];
};

function buildRawMessage(o: EmailInput): string {
  const head: string[] = [];
  if (o.cc) head.push(`Cc: ${o.cc}`);
  if (o.bcc) head.push(`Bcc: ${o.bcc}`);
  head.push(`To: ${o.to}`);
  head.push(`Subject: ${o.subject}`);
  head.push("MIME-Version: 1.0");
  const bodyType = o.isHtml ? "text/html" : "text/plain";

  if (o.attachments?.length) {
    const boundary = "mcpboundary" + Math.random().toString(36).slice(2);
    head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    let raw = `--${boundary}\r\n`;
    raw += `Content-Type: ${bodyType}; charset="utf-8"\r\n\r\n${o.body}\r\n`;
    for (const a of o.attachments) {
      raw += `--${boundary}\r\n`;
      raw += `Content-Type: ${a.mimeType}; name="${a.filename}"\r\n`;
      raw += `Content-Transfer-Encoding: base64\r\n`;
      raw += `Content-Disposition: attachment; filename="${a.filename}"\r\n\r\n`;
      raw += a.data + "\r\n";
    }
    raw += `--${boundary}--`;
    return head.join("\r\n") + "\r\n\r\n" + raw;
  }

  head.push(`Content-Type: ${bodyType}; charset="utf-8"`);
  return head.join("\r\n") + "\r\n\r\n" + o.body;
}

// Gmail's `raw` field is base64url WITHOUT padding
function toRaw(message: string): string {
  return Buffer.from(message, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const emailInputSchema = {
  to: z.string().describe("Recipient(s), comma-separated"),
  cc: z.string().optional().describe("CC recipients, comma-separated"),
  bcc: z.string().optional().describe("BCC recipients, comma-separated"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Message body (plain text, or HTML if isHtml=true)"),
  isHtml: z.boolean().default(false).describe("Set true if body is HTML"),
  attachments: z
    .array(z.object({ filename: z.string(), mimeType: z.string(), data: z.string().describe("Base64-encoded file contents") }))
    .optional()
    .describe("Attachments to include"),
};

export function registerGmailTools(server: McpServer): void {
  server.registerTool(
    "gmail_search_messages",
    {
      title: "Search Gmail",
      description:
        "Search messages using Gmail query syntax. Examples: 'from:bob@example.com', 'subject:invoice after:2024/01/01', 'is:unread has:attachment newer_than:30d', 'in:inbox label:work', 'before:2023/12/31 has:attachment size>1M'. Each result includes id, from, to, subject, date, snippet, unread/starred state, and an `enriched` flag (true = fields verified by the API, so null means truly absent; false = enrichment fetch failed, treat nulls as not-fetched) in this single call — only call gmail_get_message when you need the full body.",
      inputSchema: {
        q: z.string().describe("Gmail search query string"),
        maxResults: z.number().int().min(1).max(100).default(10).describe("Max messages to return (default 10)"),
        format: formatSchema,
      },
    },
    async ({ q, maxResults, format }) => {
      try {
        const gmail = await getGmail();
        const msgs = await listMessages(gmail, { q, maxResults });
        return format === "json" ? jsonResult(msgs.map(toRow)) : text(summarize(msgs));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_get_message",
    {
      title: "Read a message",
      description: "Fetch a full message (headers + body). Provide the message id from a search/list result.",
      inputSchema: { messageId: z.string().describe("The message id"), format: formatSchema },
    },
    async ({ messageId, format }) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const m = res.data as { id?: string; threadId?: string; labelIds?: string[]; snippet?: string; payload?: Part };
        const hs = m.payload?.headers ?? [];
        const chosen = findPart(m.payload, "text/plain") ?? findPart(m.payload, "text/html");
        let body = "";
        if (chosen?.body?.data)
  body = decodeBody(chosen.body.data, chosen.mimeType, chosen.headers?.find((h) => h.name.toLowerCase() === "content-transfer-encoding")?.value);
        else if (m.payload?.body?.data)
  body = decodeBody(m.payload.body.data, m.payload.mimeType, m.payload.headers?.find((h) => h.name.toLowerCase() === "content-transfer-encoding")?.value);
        const attachments = collectAttachments(m.payload);
        if (format === "json") {
          return jsonResult({
            id: m.id ?? messageId,
            threadId: m.threadId ?? null,
            labels: m.labelIds ?? [],
            from: header(hs, "From") || null,
            to: header(hs, "To") || null,
            subject: header(hs, "Subject") || null,
            date: header(hs, "Date") || null,
            snippet: m.snippet ?? null,
            bodyMime: chosen?.mimeType ?? null,
            body: body || null,
            attachments,
          });
        }
        const headerStr = hs.map((h) => `${h.name}: ${h.value}`).join("\n");
        return text(`Headers:\n${headerStr}\n\nBody:\n${body || "(no body)"}\n\nAttachments: ${attachments.join(", ") || "none"}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_list_messages",
    {
      title: "List messages",
      description:
        "List recent messages from a label/folder (default INBOX). Each result includes id, from, to, subject, date, snippet, unread/starred state, and an `enriched` flag (true = fields verified by the API, so null means truly absent; false = enrichment fetch failed, treat nulls as not-fetched) in this single call. Use gmail_search_messages for full-text search.",
      inputSchema: {
        labelId: z.string().default("INBOX").describe("Label/folder id: INBOX, SENT, DRAFT, STARRED, TRASH, or a custom label name"),
        maxResults: z.number().int().min(1).max(100).default(10).describe("Max messages (default 10)"),
        format: formatSchema,
      },
    },
    async ({ labelId, maxResults, format }) => {
      try {
        const gmail = await getGmail();
        const msgs = await listMessages(gmail, { labelIds: [labelId], maxResults });
        return format === "json" ? jsonResult(msgs.map(toRow)) : text(summarize(msgs));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "List labels",
      description: "List all labels/folders in the mailbox with ids and unread counts.",
      inputSchema: { format: formatSchema },
    },
    async ({ format }) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.labels.list({ userId: "me" });
        const labels = (res.data.labels ?? []) as {
          name: string;
          id: string;
          messagesUnread?: number;
          messagesTotal?: number;
        }[];
        if (format === "json") return jsonResult(labels);
        const lines = labels.map(
          (l) => `- ${l.name} [id=${l.id}]${l.messagesUnread ? ` (${l.messagesUnread} unread)` : l.messagesTotal ? ` (${l.messagesTotal} total)` : ""}`,
        );
        return text(lines.length ? lines.join("\n") : "No labels.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_send_email",
    {
      title: "Send email",
      description: "Send an email from the authenticated account. to/cc/bcc are comma-separated lists. Supports base64 attachments.",
      inputSchema: emailInputSchema,
    },
    async (o) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw: toRaw(buildRawMessage(o)) } });
        return text(`Sent. message id=${res.data.id} thread=${res.data.threadId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create draft",
      description: "Create a draft (not sent) with the same fields as gmail_send_email.",
      inputSchema: emailInputSchema,
    },
    async (o) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: toRaw(buildRawMessage(o)) } } });
        return text(`Draft created. id=${res.data.id} messageId=${res.data.message?.id ?? "?"}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_mark_read",
    { title: "Mark read", description: "Mark a message as read.", inputSchema: { messageId: z.string() } },
    async ({ messageId }) => {
      try {
        const gmail = await getGmail();
        await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: ["UNREAD"] } });
        return text("Marked as read.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_mark_unread",
    { title: "Mark unread", description: "Mark a message as unread.", inputSchema: { messageId: z.string() } },
    async ({ messageId }) => {
      try {
        const gmail = await getGmail();
        await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: ["UNREAD"] } });
        return text("Marked as unread.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_apply_labels",
    {
      title: "Apply labels",
      description:
        "Add/remove labels on a message. Common: archive = removeLabelIds ['INBOX']; star = addLabelIds ['STARRED']; move to a folder = addLabelIds [folder] and removeLabelIds ['INBOX'].",
      inputSchema: {
        messageId: z.string(),
        addLabelIds: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Label id(s) or name(s) to add — a single value (\"STARRED\") or an array (['INBOX'])"),
        removeLabelIds: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Label id(s) or name(s) to remove — a single value (\"INBOX\") or an array (['STARRED'])"),
      },
    },
    async ({ messageId, addLabelIds, removeLabelIds }) => {
      try {
        const gmail = await getGmail();
        const add = addLabelIds ? (Array.isArray(addLabelIds) ? addLabelIds : [addLabelIds]) : undefined;
        const remove = removeLabelIds ? (Array.isArray(removeLabelIds) ? removeLabelIds : [removeLabelIds]) : undefined;
        const res = await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: add, removeLabelIds: remove } });
        return text(`Updated. labels=${(res.data.labelIds ?? []).join(", ") || "(none)"}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "gmail_delete_message",
    {
      title: "Delete message",
      description: "Permanently delete a message (not recoverable). To trash instead, use gmail_apply_labels with removeLabelIds ['INBOX'].",
      inputSchema: { messageId: z.string() },
    },
    async ({ messageId }) => {
      try {
        const gmail = await getGmail();
        await gmail.users.messages.delete({ userId: "me", id: messageId });
        return text("Message permanently deleted.");
      } catch (e) {
        return fail(e);
      }
    },
  );
}