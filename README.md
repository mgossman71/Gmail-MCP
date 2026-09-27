# gmail-mcp

MCP server exposing one Gmail account + its Google Calendar over HTTP. See `goal.md`.

## Quick start
1. **One-time Google setup** (human, in Google Cloud Console):
   - New project -> enable **Gmail API** + **Google Calendar API**.
   - OAuth consent screen (External) -> add your email + scopes `gmail.modify`, `calendar` -> publish (Testing is fine).
   - Credentials -> Create OAuth client ID -> **Desktop app** -> download -> save as `./credentials.json`.
2. On this machine: `npm install` then `npm run auth` (opens a browser once).
3. `docker compose up` -> server at `http://localhost:3333/mcp`.

## Tools
10 Gmail + 7 Calendar = 17.
- Gmail: `search_messages`, `get_message`, `list_messages`, `list_labels`, `send_email`, `create_draft`, `mark_read`, `mark_unread`, `apply_labels`, `delete_message`
- Calendar: `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `find_free_time`

## Client config (HTTP)
Endpoint: `http://localhost:3333/mcp` (Streamable HTTP). Point any MCP client at it.

```json
{ "mcpServers": { "gmail-mcp": { "url": "http://localhost:3333/mcp" } } }
```

If you set `MCP_AUTH_TOKEN`, the client must also send `Authorization: Bearer <token>`.

## Config (`.env`)
| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CREDENTIALS_PATH` | `./credentials.json` | OAuth client secret (Desktop app) |
| `GMAIL_ACCOUNT` | _(unset)_ | If set, reject unless the signed-in account matches |
| `DEFAULT_CALENDAR` | `primary` | Default calendar for calendar tools |
| `MCP_PORT` | `3333` | HTTP port |
| `MCP_HOST` | `0.0.0.0` | Bind address |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token required by clients |

## Dev without Docker
`npm install && npm run auth && npm run start`

## Progress
- [x] 01-scaffold
- [x] 02-auth
- [x] 03-gmail
- [x] 04-calendar
- [x] 05-server
- [x] 06-verified
- [x] 07-docker
- [ ] 08-e2e — needs real `credentials.json` + `token.json`, then `docker compose up`