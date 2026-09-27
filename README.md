# Gmail + Google Calendar MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes one Gmail account
and its Google Calendar as 17 tools over HTTP. Point any MCP client at it.

**Tools:** 10 Gmail (search, read, send, drafts, labels, read/unread, delete) +
7 Calendar (list/create/update/delete events, find free time).
**Runs at:** `http://localhost:3333/mcp`

## Before you start
You need:
- A **Google account** (any Gmail)
- **Node.js 20+** — check with `node -v`; download from https://nodejs.org if missing
- **Docker** *(optional, for running in a container)* — https://docs.docker.com/get-docker/

Setup is two parts: a **one-time Google setup** (~5 min, in your browser) and a
**local setup** (a few commands).

## Part 1 — One-time Google setup (~5 min)
This creates the "app" Google lets your server talk to Gmail/Calendar, then
authorizes your account once.

1. **Open the Google Cloud Console** — https://console.cloud.google.com — and
   sign in with the Google account you want to use.
2. **Create a project** — top bar → project dropdown → **New Project** → name it
   (e.g. `gmail-mcp`) → **Create**. (Or: https://console.cloud.google.com/projects)
3. **Enable the two APIs** (required, or it can't reach Gmail/Calendar):
   - Gmail: https://console.cloud.google.com/apis/library/gmail.googleapis.com → **Enable**
   - Calendar: https://console.cloud.google.com/apis/library/calendar.googleapis.com → **Enable**
4. **Set up the OAuth consent screen** — https://console.cloud.google.com/apis/credentials/consent
   - User type: **External** → **Get started** → fill in app name + your emails.
   - **Add or remove scopes** → add exactly these two:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
   - **Save and continue** through the screens. On the last screen, **Testing** is
     fine (no review needed for personal use).
5. **Create the client and download the file** — https://console.cloud.google.com/apis/credentials/oauth-client
   - **Create Client ID** → Application type: **Desktop app** → name it → **Create**.
   - Click **Download** in the dialog and save the file.
   - Put that file in this project folder and rename it `credentials.json`.
     (It contains an `"installed"` block with a `client_id` and `client_secret`.)

> ✅ Checkpoint: you now have one file — `credentials.json` — in the project folder.
> That's all the Google side needs.

## Part 2 — Local setup
**No Docker:**
```bash
npm install
npm run auth    # opens your browser once → click "Allow"
npm run start   # server runs at http://localhost:3333/mcp
```
`npm run auth` saves `token.json`; it refreshes automatically, so you usually only
do it once.

**In Docker:**
```bash
npm install
npm run auth    # on the host — a container can't pop a browser
docker compose up
```
Server runs at `http://localhost:3333/mcp`. Your `credentials.json` and `token.json`
are shared into the container automatically.

## Connect an MCP client
Point any MCP client at the endpoint:
```json
{ "mcpServers": { "gmail-mcp": { "url": "http://localhost:3333/mcp" } } }
```
For **Claude Desktop**, put that in `claude_desktop_config.json`.
(If you later set `MCP_AUTH_TOKEN` in `.env`, the client must also send
`Authorization: Bearer <token>`.)

## Configuration (`.env`)
Copy `.env.example` to `.env` to customize. Defaults shown:
| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_CREDENTIALS_PATH` | `./credentials.json` | Where your Google client-secret file is |
| `GMAIL_ACCOUNT` | _(unset)_ | If set, refuse to run unless the signed-in Gmail matches |
| `DEFAULT_CALENDAR` | `primary` | Default calendar for calendar tools |
| `MCP_PORT` | `3333` | Port the server listens on |
| `MCP_AUTH_TOKEN` | _(unset)_ | Require this bearer token from clients |

## The 17 tools
- **Gmail:** `search_messages`, `get_message`, `list_messages`, `list_labels`, `send_email`, `create_draft`, `mark_read`, `mark_unread`, `apply_labels`, `delete_message`
- **Calendar:** `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `find_free_time`

## Troubleshooting
- **`credentials.json not found`** — you haven't downloaded it, or it isn't named exactly `credentials.json` in the project folder.
- **`credentials.json is missing client_id / client_secret`** — wrong file; you need the `"installed"` block from a **Desktop app** client.
- **`No token.json … run npm run auth`** — run `npm run auth` first.
- **`Authenticated as X, but GMAIL_ACCOUNT is set to Y`** — wrong account; delete `token.json` and re-run `npm run auth`.

## Progress
- [x] 01-scaffold
- [x] 02-auth
- [x] 03-gmail
- [x] 04-calendar
- [x] 05-server
- [x] 06-verified
- [x] 07-docker
- [ ] 08-e2e — needs real `credentials.json` + `token.json`, then `docker compose up`