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
function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

const LIST_HEADERS = ["Subject", "From", "Date"];

// metadataHeaders is a real Gmail API param that the googleapis TS types omit
async function listMessages(
  gmail: GmailClient,
  opts: { q?: string; labelIds?: string[]; maxResults: number },
): Promise<any[]> {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: opts.q,
    labelIds: opts.labelIds,
    maxResults: opts.maxResults,
    metadataHeaders: LIST_HEADERS,
  } as any);
  return res.data?.messages ?? [];
}

function base64UrlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// base64url-decode, then a safe quoted-printable pass (only if soft line breaks are present)
function decodeBody(data: string, mimeType?: string | null): string {
  let s = base64UrlDecode(data);
  if (mimeType?.startsWith("text/") && /=\r?\n/.test(s)) {
    s = s
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return s;
}

function header(hs: Header[] | undefined, name: string): string {
  return hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summarize(messages: unknown[]): string {
  if (!messages.length) return "No messages found.";
  return messages
    .map((m, i) => {
      const mm = m as { id: string; threadId?: string; snippet?: string; payload?: { headers?: Header[] } };
      return [
        `${i + 1}. [id=${mm.id}${mm.threadId ? ` thread=${mm.threadId}` : ""}] ${header(mm.payload?.headers, "Date")}`,
        `   From: ${header(mm.payload?.headers, "From") || "?"}`,
        `   Subject: ${header(mm.payload?.headers, "Subject") || "(no subject)"}`,
        mm.snippet ? `   ${mm.snippet}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
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
        "Search messages using Gmail query syntax. Examples: 'from:bob@example.com', 'subject:invoice after:2024/01/01', 'is:unread has:attachment newer_than:30d', 'in:inbox label:work', 'before:2023/12/31 has:attachment size>1M'.",
      inputSchema: {
        q: z.string().describe("Gmail search query string"),
        maxResults: z.number().int().min(1).max(100).default(10).describe("Max messages to return (default 10)"),
      },
    },
    async ({ q, maxResults }) => {
      try {
        const gmail = await getGmail();
        const msgs = await listMessages(gmail, { q, maxResults });
        return text(summarize(msgs));
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
      inputSchema: { messageId: z.string().describe("The message id") },
    },
    async ({ messageId }) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const m = res.data as { payload?: Part };
        const hs = m.payload?.headers ?? [];
        const headerStr = hs.map((h) => `${h.name}: ${h.value}`).join("\n");
        const chosen = findPart(m.payload, "text/plain") ?? findPart(m.payload, "text/html");
        let body = "";
        if (chosen?.body?.data) body = decodeBody(chosen.body.data, chosen.mimeType);
        else if (m.payload?.body?.data) body = decodeBody(m.payload.body.data, m.payload.mimeType);
        const attachments = (m.payload?.body?.attachmentId ? ["(has separately-stored attachment)"] : []);
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
      description: "List recent messages from a label/folder (default INBOX). Use gmail_search_messages for full-text search.",
      inputSchema: {
        labelId: z.string().default("INBOX").describe("Label/folder id: INBOX, SENT, DRAFT, STARRED, TRASH, or a custom label name"),
        maxResults: z.number().int().min(1).max(100).default(10).describe("Max messages (default 10)"),
      },
    },
    async ({ labelId, maxResults }) => {
      try {
        const gmail = await getGmail();
        const msgs = await listMessages(gmail, { labelIds: [labelId], maxResults });
        return text(summarize(msgs));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool("gmail_list_labels", {
    title: "List labels",
    description: "List all labels/folders in the mailbox with ids and unread counts.",
  }, async () => {
    try {
      const gmail = await getGmail();
      const res = await gmail.users.labels.list({ userId: "me" });
      const lines = ((res.data.labels ?? []) as { name: string; id: string; messagesUnread?: number; messagesTotal?: number }[]).map(
        (l) => `- ${l.name} [id=${l.id}]${l.messagesUnread ? ` (${l.messagesUnread} unread)` : l.messagesTotal ? ` (${l.messagesTotal} total)` : ""}`,
      );
      return text(lines.length ? lines.join("\n") : "No labels.");
    } catch (e) {
      return fail(e);
    }
  });

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
        addLabelIds: z.array(z.string()).optional().describe("Label ids/names to add"),
        removeLabelIds: z.array(z.string()).optional().describe("Label ids/names to remove"),
      },
    },
    async ({ messageId, addLabelIds, removeLabelIds }) => {
      try {
        const gmail = await getGmail();
        const res = await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds, removeLabelIds } });
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