# gmail-mcp — Project Goal

## What
A local **MCP (Model Context Protocol) server** exposing ONE specific Gmail account
and its Google Calendar over **Streamable HTTP**. Full read/write on both. Runs as a
**Docker Compose** service.

## Stack
- TypeScript + Node (host Node 26; Docker image `node:22-alpine`)
- `@modelcontextprotocol/sdk` -> `McpServer` + `StreamableHTTPServerTransport`
- `express` -> HTTP server on port 3333, endpoint `/mcp`
- `googleapis` -> Gmail API v1, Calendar API v3
- `@google-cloud/local-auth` -> interactive OAuth (host)
- `google-auth-library` -> headless token refresh (container)
- `zod@4` -> tool input schemas; `tsx` (run), `tsc@5` (build)

## Capability & scopes
- Gmail: `https://www.googleapis.com/auth/gmail.modify`
- Calendar: `https://www.googleapis.com/auth/calendar`
-> Full read/write.

## Transport
- HTTP (Streamable HTTP). Container listens on `3333`; client hits `http://localhost:3333/mcp`.
- Optional `MCP_AUTH_TOKEN` bearer guard.

## Tools (17)
- Gmail (10): search_messages, get_message, list_messages, list_labels, send_email,
  create_draft, mark_read, mark_unread, apply_labels, delete_message
- Calendar (7): list_calendars, list_events, get_event, create_event, update_event,
  delete_event, find_free_time

## Auth (two modes in src/auth.ts)
- interactive (host): `npm run auth` -> browser -> writes `token.json` (has refresh_token)
- headless (container): load `credentials.json` + `token.json` -> refresh access token, no browser
- Both JSON files are volume-mounted into the container.

## Config (.env)
- `GOOGLE_CREDENTIALS_PATH` (default `./credentials.json`)
- `GMAIL_ACCOUNT` (optional: pin/verify one email)
- `DEFAULT_CALENDAR` (default `primary`)
- `MCP_PORT` (default `3333`)
- `MCP_AUTH_TOKEN` (optional bearer)

## File layout
- `src/index.ts` — express + StreamableHTTP transport + registerTool for all 17 tools
- `src/auth.ts` — interactive + headless OAuth -> gmail/calendar clients + account pin
- `src/gmail.ts` — 10 tools · `src/calendar.ts` — 7 tools
- plus: goal.md, package.json, tsconfig.json, .env.example, .gitignore,
  Dockerfile, docker-compose.yml, README.md

## Progress (multi-session — checkpoint per milestone; read this to resume)
- [x] 01-scaffold — goal.md + project skeleton
- [x] 02-auth — auth.ts (both modes)
- [x] 03-gmail — 10 Gmail tools
- [x] 04-calendar — 7 Calendar tools
- [x] 05-server — index.ts wires 17 tools + HTTP transport
- [ ] 06-verified — npm install + tsc build passes
- [ ] 07-docker — Dockerfile + compose build; container starts; /mcp responds
- [ ] 08-e2e — full flow via docker compose (after human Google steps)

## Human-only steps (NOT the agent's job)
1. Google Cloud Console -> new project -> enable Gmail API + Google Calendar API
2. OAuth consent screen (External): add your email + the 2 scopes, publish as Testing
3. Create OAuth Client ID -> Desktop app -> download -> save as `credentials.json`
4. (host) `npm install && npm run auth` -> browser, pick your account
5. `docker compose up`

## Conventions
- All logging -> stderr (never stdout — corrupts the JSON-RPC stream).
- Checkpoints contain no secrets: credentials.json/token.json are gitignored;
  checkpoint 06 is taken before credentials.json is added.
- Keep this file terse; it is the cross-session source of truth.