# Code Review — `73681f3`

**Commit:** `73681f3 fix(calendar): harden update_event all-day vs timed toggle edge cases (derive start, avoid clobbering to empty)`
**Branch:** `code-review` (even with `origin/main`, working tree clean)
**Scope:** `git diff HEAD~1` — 1 file, `src/calendar.ts`, +16/−6, all inside `calendar_update_event`
**Date:** 2026-09-27

5 findings, most severe first. **All 5 are now fixed** in the follow-up commit — see each finding's *Resolved* note and the summary under **Resolution**.

---

## 1. End-only update on an all-day event is silently dropped — HIGH

> ✅ **Resolved** — `o.end` is now applied independently of whether the start changed (`if (o.end) end.date = o.end`), so an end-only update is always written.

`src/calendar.ts:215` · **regression introduced by this commit**

The new guard `if (newStart && ev.start?.date !== newStart)` gates the **end** assignment as well as the start.

```ts
const newStart = o.start ?? ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
if (newStart && ev.start?.date !== newStart) {
  ev.start!.date = newStart;
  ev.end!.date = o.end ?? addDays(newStart, 1);   // <-- skipped when start is unchanged
}
```

**Failure scenario:** `calendar_update_event({ eventId, end: "2026-10-05" })` on an all-day event starting
2026-10-01. `allDay` is `true`, `newStart = ev.start.date = "2026-10-01"`, so `ev.start?.date !== newStart`
is `false` and the whole block is skipped. `o.end` is never written, the unchanged event is PUT back, and the
caller still gets `Updated event.` Same for `{ start: <same date>, end: <new date> }`.

The pre-commit code assigned `ev.end!.date = o.end || …` unconditionally, so this behaviour is new.

**Fix:** apply `o.end` independently of whether the start changed.

---

## 2. All-day → timed conversion is a silent no-op reported as success — MEDIUM

> ✅ **Resolved** — when a timed conversion has no start time to work from, the handler now `return fail(...)` telling the caller to supply `start`, instead of silently reporting success.

`src/calendar.ts:225`

```ts
const newStart = o.start ?? ev.start?.dateTime;
if (newStart) { … }
```

**Failure scenario:** `calendar_update_event({ eventId, isAllDay: false, end: "2026-10-01T17:00:00Z" })` on an
all-day event. An all-day event has no `dateTime`, so `newStart` is `undefined` and the `if` body never runs:
the event stays all-day, the supplied `end` is discarded, and the tool still replies `Updated event.`

**Fix:** if the conversion genuinely can't be performed without a time, return `fail(...)` telling the caller to
supply `start`, rather than reporting success for a change that did not happen.

---

## 3. Moving a multi-day all-day event collapses it to one day — MEDIUM

> ✅ **Resolved** — when `o.end` is omitted and the start moves, the end is now shifted by the same day-delta (`addDays(oldEnd, diffDays(oldStart, newStart))`), preserving the original span.

`src/calendar.ts:217`

```ts
ev.end!.date = o.end ?? addDays(newStart, 1);
```

This ignores the event's existing span.

**Failure scenario:** a 4-day all-day event (start 2026-10-01, end 2026-10-05 exclusive) updated with only
`start: "2026-10-02"` comes back as a single-day event ending 2026-10-03.

**Fix:** preserve the original duration when `o.end` is omitted — shift `ev.end.date` by the same delta —
falling back to +1 day only when there is no prior end.

*(Behaviour predates the commit, but sits on a line it rewrote and is within the "harden the toggle" intent.)*

---

## 4. Moving a timed event shortens it to one hour — MEDIUM

> ✅ **Resolved** — when only `start` is given, the end is recomputed as `newStart + (original end − original start)`, preserving the original duration.

`src/calendar.ts:227`

```ts
ev.end!.dateTime = o.end ?? (o.start ? addHours(o.start, 1) : ev.end?.dateTime);
```

**Failure scenario:** a 09:00–17:00 meeting updated with only `start: "2026-10-01T10:00:00Z"` is rewritten to
10:00–11:00, silently shortening an 8-hour event to 1 hour.

**Fix:** preserve the existing duration when only `start` is given.

*(Also predates the commit; same rationale as #3.)*

---

## 5. Unguarded `delete` on `ev.start` / `ev.end` can throw — LOW

> ✅ **Resolved** — the block now guards `if (!ev.start || !ev.end) return fail(...)` before touching either, so a cancelled/placeholder event returns a clear message instead of throwing.

`src/calendar.ts:219`

```ts
delete ev.start!.dateTime;
delete ev.end!.dateTime;
```

These now run unconditionally, outside the `if (newStart …)` guard, and the non-null assertions are unsound.

**Failure scenario:** `events.get` on a cancelled recurring instance returns `status: "cancelled"` with no
`start`/`end`; `delete undefined.dateTime` throws a `TypeError`, surfaced to the caller as the opaque
`Error: Cannot convert undefined or null to object`. If `ev.start` exists but holds neither `date` nor
`dateTime`, the deletes instead PUT an event with no time at all and Google returns a 400.

**Fix:** guard on `ev.start && ev.end` (or bail out with a clear message) before touching them.

---

## Nit (not counted as a finding)

> ✅ **Resolved** — both comments now say the start is reused from the event's *existing* start (date / time), not "the current time".

Both new comments are inaccurate. Line 212–213 says the date is derived "from the current time" when it is
actually derived from the event's existing start; line 222 says "reuse the current time" for the same reason.

---

## Notes

- No other files, callers, or call sites are affected by this commit.
- The `buildEvent` / create path is unchanged.
- There is no test suite in the repo, so no tests to update.

## Resolution

All 5 findings (plus the nit) are addressed in a single rewrite of the time-handling block in
`calendar_update_event`:

1. A `!ev.start || !ev.end` guard bails with a clear error before any time mutation (finding #5).
2. `o.end` / `o.start` are applied independently of each other and of the start-change check (findings #1, #3, #4).
3. When only `start` moves, the original duration is preserved — shifted by day-delta for all-day events and by
   measured time-span for timed events — falling back to +1 day / +1 hour only when there is no prior end.
4. An all-day → timed conversion with no start time now `fail(...)`s instead of silently succeeding (finding #2).
5. Both toggle comments corrected to reference the event's existing start.

Verified with `npm run typecheck` (`tsc --noEmit`, strict) and a standalone replication of the branch logic run
against all five failure scenarios plus extra cases (start+end both given, end-only on timed, timed→all-day) —
all pass.
