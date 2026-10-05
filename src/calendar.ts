import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCalendar } from "./auth.js";

type CalClient = Awaited<ReturnType<typeof getCalendar>>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}
function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

function calId(id?: string): string {
  return id || process.env.DEFAULT_CALENDAR || "primary";
}

interface EventLike {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { email?: string; responseStatus?: string }[];
}

function fmtTime(t?: { date?: string; dateTime?: string }): string {
  return t?.dateTime || t?.date || "?";
}

function fmtEvent(e: EventLike, i?: number): string {
  const label = i !== undefined ? `${i}. ` : "";
  const lines = [
    `${label}[id=${e.id ?? "?"}] ${e.summary || "(no title)"}`,
    `   When: ${fmtTime(e.start)} → ${fmtTime(e.end)}`,
    e.location ? `   Where: ${e.location}` : "",
    e.attendees?.length ? `   Attendees: ${e.attendees.map((a) => a.email).filter(Boolean).join(", ")}` : "",
    e.htmlLink ? `   Link: ${e.htmlLink}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function addHours(iso: string, h: number): string {
  return new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();
}
function addDays(date: string, d: number): string {
  const dt = new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}
function diffDays(a: string, b: string): number {
  const toUtc = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s).getTime();
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

interface CreateInput {
  summary: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  isAllDay: boolean;
  timeZone?: string;
}

function buildEvent(input: CreateInput): Record<string, unknown> {
  const ev: Record<string, unknown> = { summary: input.summary };
  if (input.description) ev.description = input.description;
  if (input.location) ev.location = input.location;
  if (input.attendees?.length) ev.attendees = input.attendees.map((email) => ({ email }));
  if (input.isAllDay) {
    ev.start = { date: input.start };
    ev.end = { date: input.end || addDays(input.start, 1) };
  } else {
    const end = input.end || addHours(input.start, 1);
    ev.start = input.timeZone ? { dateTime: input.start, timeZone: input.timeZone } : { dateTime: input.start };
    ev.end = input.timeZone ? { dateTime: end, timeZone: input.timeZone } : { dateTime: end };
  }
  return ev;
}

const createInputSchema = {
  summary: z.string().describe("Event title"),
  start: z.string().describe("Start as ISO 8601 datetime (timed) or YYYY-MM-DD (all-day)"),
  end: z.string().optional().describe("End (default: +1 hour, or next day for all-day)"),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
  isAllDay: z.boolean().default(false),
  timeZone: z.string().optional().describe("IANA timezone for timed events (e.g. America/New_York)"),
  calendarId: z.string().optional().describe("Calendar id (default: primary / DEFAULT_CALENDAR)"),
};

export function registerCalendarTools(server: McpServer): void {
  server.registerTool("calendar_list_calendars", {
    title: "List calendars",
    description: "List the calendars accessible to the account (ids, names, timezones).",
  }, async () => {
    try {
      const calendar = await getCalendar();
      const res = await calendar.calendarList.list();
      const items = (res.data.items ?? []) as { id: string; summary?: string; timeZone?: string; primary?: boolean }[];
      if (!items.length) return text("No calendars.");
      return text(
        items
          .map((c) => `- ${c.summary || "(unnamed)"} [id=${c.id}]${c.primary ? " (primary)" : ""}${c.timeZone ? ` tz=${c.timeZone}` : ""}`)
          .join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "calendar_list_events",
    {
      title: "List events",
      description: "List events in a calendar, optionally filtered by a time range and/or text query.",
      inputSchema: {
        calendarId: z.string().optional().describe("Calendar id (default: primary)"),
        timeMin: z.string().optional().describe("Only events starting on/after this ISO time"),
        timeMax: z.string().optional().describe("Only events starting before this ISO time"),
        query: z.string().optional().describe("Full-text search across event fields"),
        maxResults: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({ calendarId, timeMin, timeMax, query, maxResults }) => {
      try {
        const calendar = await getCalendar();
        const res = await calendar.events.list({
          calendarId: calId(calendarId),
          timeMin,
          timeMax,
          q: query,
          maxResults,
          singleEvents: true,
          orderBy: "startTime",
        });
        const items = (res.data.items ?? []) as EventLike[];
        if (!items.length) return text("No events found.");
        return text(items.map((e, i) => fmtEvent(e, i + 1)).join("\n\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get event",
      description: "Fetch the full details of a single event by id.",
      inputSchema: { eventId: z.string(), calendarId: z.string().optional() },
    },
    async ({ eventId, calendarId }) => {
      try {
        const calendar = await getCalendar();
        const res = await calendar.events.get({ calendarId: calId(calendarId), eventId });
        return text(fmtEvent(res.data as EventLike) + (res.data.description ? `\n\nDescription:\n${res.data.description}` : ""));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "calendar_create_event",
    { title: "Create event", description: "Create a new calendar event (timed or all-day).", inputSchema: createInputSchema },
    async (o) => {
      try {
        const calendar = await getCalendar();
        const res = await calendar.events.insert({ calendarId: calId(o.calendarId), requestBody: buildEvent(o) });
        const e = res.data as EventLike;
        return text(`Created event.\n${fmtEvent(e)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update event",
      description: "Update an existing event. Only the fields you provide are changed; the rest are preserved.",
      inputSchema: {
        eventId: z.string(),
        calendarId: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z.string().optional().describe("New start (ISO datetime, or YYYY-MM-DD for all-day)"),
        end: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        isAllDay: z.boolean().optional(),
      },
    },
    async (o) => {
      try {
        const calendar = await getCalendar();
        const cid = calId(o.calendarId);
        const got = await calendar.events.get({ calendarId: cid, eventId: o.eventId });
        const ev = got.data as EventLike & Record<string, unknown>;
        if (o.summary !== undefined) ev.summary = o.summary;
        if (o.description !== undefined) ev.description = o.description;
        if (o.location !== undefined) ev.location = o.location;
        if (o.attendees) ev.attendees = o.attendees.map((email) => ({ email }));
        if (o.start !== undefined || o.end !== undefined || o.isAllDay !== undefined) {
          if (!ev.start || !ev.end) {
            return fail("This event has no start/end times (it may be cancelled), so its times can't be updated.");
          }
          const start = ev.start;
          const end = ev.end;
          const allDay = o.isAllDay ?? (start.date !== undefined);
          if (allDay) {
            // Convert/keep all-day. Reuse the event's existing start date when no new start
            // is given, so a timed->all-day toggle never leaves the event empty.
            const oldStart = start.date ?? start.dateTime?.slice(0, 10);
            const oldEnd = end.date ?? end.dateTime?.slice(0, 10);
            const newStart = o.start ?? oldStart;
            if (!newStart) return fail("Cannot set this event to all-day without a start date; provide start as YYYY-MM-DD.");
            if (start.date !== newStart) start.date = newStart;
            delete start.dateTime;
            if (o.end) {
              end.date = o.end;
            } else if (newStart === oldStart && end.date) {
              // start didn't move and an all-day end already exists: keep it as-is
            } else if (oldStart && oldEnd) {
              // start moved (or converting from timed): shift the end by the same delta
              end.date = addDays(oldEnd, diffDays(oldStart, newStart));
            } else {
              end.date = addDays(newStart, 1);
            }
            delete end.dateTime;
          } else {
            // Convert/keep timed. Reuse the event's existing start time when no new one is
            // given; an all-day->timed toggle with no time can't be invented, so fail.
            const oldStart = start.dateTime;
            const oldEnd = end.dateTime;
            const newStart = o.start ?? oldStart;
            if (!newStart) return fail("Cannot convert to a timed event without a start time; provide start as an ISO 8601 datetime.");
            start.dateTime = newStart;
            delete start.date;
            const durMs = oldStart && oldEnd ? new Date(oldEnd).getTime() - new Date(oldStart).getTime() : 0;
            if (o.end) {
              end.dateTime = o.end;
            } else if (o.start && oldStart && oldEnd) {
              // start moved: preserve the original duration
              end.dateTime = new Date(new Date(newStart).getTime() + durMs).toISOString();
            } else if (o.start) {
              // start moved but there's no prior end to measure: default to +1 hour
              end.dateTime = addHours(newStart, 1);
            }
            // else: start unchanged and no new end -> keep the existing end as-is
            delete end.date;
          }
        }
        const res = await calendar.events.update({ calendarId: cid, eventId: o.eventId, requestBody: ev });
        return text(`Updated event.\n${fmtEvent(res.data as EventLike)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete event",
      description: "Delete an event from a calendar.",
      inputSchema: { eventId: z.string(), calendarId: z.string().optional() },
    },
    async ({ eventId, calendarId }) => {
      try {
        const calendar = await getCalendar();
        await calendar.events.delete({ calendarId: calId(calendarId), eventId });
        return text("Event deleted.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "calendar_find_free_time",
    {
      title: "Find free time",
      description: "Find free time slots in a time range, taking into account the busy time of the given calendar and/or attendees.",
      inputSchema: {
        start: z.string().describe("Start of the window (ISO datetime)"),
        end: z.string().describe("End of the window (ISO datetime)"),
        attendees: z.array(z.string()).optional().describe("Emails whose busy time to consider"),
        calendarId: z.string().optional().describe("Calendar to include (default: primary)"),
        minSlotMinutes: z.number().int().min(5).default(15).describe("Ignore free slots shorter than this (default 15)"),
      },
    },
    async ({ start, end, attendees, calendarId, minSlotMinutes }) => {
      try {
        const calendar = await getCalendar();
        const ids = [calId(calendarId), ...(attendees ?? [])];
        const res = await calendar.freebusy.query({ requestBody: { timeMin: start, timeMax: end, items: ids.map((id) => ({ id })) } });
        const busyByCal = (res.data.calendars ?? {}) as Record<string, { busy?: { start: string; end: string }[] }>;
        const allBusy = Object.values(busyByCal)
          .flatMap((c) => c.busy ?? [])
          .map((b) => ({ s: b.start > start ? b.start : start, e: b.end < end ? b.end : end }))
          .sort((a, b) => a.s.localeCompare(b.s));
        const free: { start: string; end: string }[] = [];
        let cursor = start;
        for (const b of allBusy) {
          if (b.s > cursor) free.push({ start: cursor, end: b.s });
          if (b.e > cursor) cursor = b.e;
          if (cursor >= end) break;
        }
        if (cursor < end) free.push({ start: cursor, end });
        const minMs = minSlotMinutes * 60_000;
        const slots = free.filter((s) => new Date(s.end).getTime() - new Date(s.start).getTime() >= minMs);
        if (!slots.length) return text(`No free slots of ${minSlotMinutes}+ minutes between ${start} and ${end}.`);
        return text(
          `${slots.length} free slot(s):\n` + slots.map((s, i) => `${i + 1}. ${s.start} → ${s.end}`).join("\n"),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}