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
   - **Save and continue** through the screens, adding your Gmail address as a test user.
   - **Fill in Branding** (required before publishing): https://console.cloud.google.com/auth/branding
     → app name (avoid "Google"/"Gmail" in it), support email, home page
     `https://github.com/mgossman71/Gmail-MCP`, privacy policy
     `https://github.com/mgossman71/Gmail-MCP/blob/main/PRIVACY.md`, authorized
     domain `github.com`, developer email. Skip the logo (it triggers review). **Save**.
   - **Publish the app:** go to **Audience** (https://console.cloud.google.com/auth/audience)
     → **Publish app** → **Confirm** so the status reads **In production**.
     ⚠️ **Don't skip this.** While the app is in **Testing**, Google expires the
     refresh token every **7 days** and you'd have to re-run auth weekly. No
     verification/review is needed for personal use: Google just shows a
     "Google hasn't verified this app" screen during auth → **Advanced** →
     **Go to <app name> (unsafe)** → **Continue**.
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

## Running on a headless server (no browser)
The **running server needs no browser** — it just reads `credentials.json` +
`token.json` and refreshes tokens automatically. You only need a browser **once**,
for the initial authorization. Two options:

**Option A — authorize on another machine, copy the files (simplest):**
```bash
# 1. On any machine WITH a browser (e.g. your laptop):
cd gmail-mcp
npm install && npm run auth          # opens the browser → saves token.json

# 2. Copy both files to the headless server:
scp credentials.json token.json you@server:~/gmail-mcp/

# 3. On the server (no browser ever):
chmod 600 credentials.json token.json   # protect the refresh token
docker compose up
```

**Option B — authorize directly on the server over SSH (`npm run auth:headless`):**
```bash
# On the server, place credentials.json first (README Part 1), then:
npm install
npm run auth:headless
# It prints a URL and an `ssh -L` command. Run that ssh command from a machine
# with a browser, open the printed URL there, and the callback tunnels back.
docker compose up
```

**Token lifecycle:** access tokens (1 hour) refresh automatically while the server
runs. Google revokes a refresh token after ~6 months of inactivity, if you change
your password / sign the account out, or **after 7 days if the OAuth app is still
in Testing** (see Part 1, step 4). Just re-run auth (Option A or B) and re-copy
`token.json`. The running server picks up the new `token.json` automatically; no restart needed.

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
| `AUTH_CALLBACK_PORT` | `8899` | Callback port for `npm run auth:headless` (forward over SSH) |

## The 17 tools
- **Gmail:** `search_messages`, `get_message`, `list_messages`, `list_labels`, `send_email`, `create_draft`, `mark_read`, `mark_unread`, `apply_labels`, `delete_message`
- **Calendar:** `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `find_free_time`

## Troubleshooting
- **`credentials.json not found`** — you haven't downloaded it, or it isn't named exactly `credentials.json` in the project folder.
- **`credentials.json is missing client_id / client_secret`** — wrong file; you need the `"installed"` block from a **Desktop app** client.
- **`No token.json … run npm run auth`** — run `npm run auth` first.
- **`invalid_grant` / auth stops working every ~7 days** — the OAuth app is in **Testing**. Publish it to **In production** (Part 1, step 4), then delete `token.json` and re-run `npm run auth`.
- **`Authenticated as X, but GMAIL_ACCOUNT is set to Y`** — wrong account; delete `token.json` and re-run `npm run auth`.
- **`npm run auth` hangs / does nothing on the server** — there's no browser there. Use `npm run auth:headless` (over SSH) or authorize on another machine and copy `token.json` (see "Running on a headless server").
- **`Address already in use` (headless)** — set a different `AUTH_CALLBACK_PORT` in `.env` and use the same port in the `ssh -L` command.

## Progress
- [x] 01-scaffold
- [x] 02-auth
- [x] 03-gmail
- [x] 04-calendar
- [x] 05-server
- [x] 06-verified
- [x] 07-docker
- [ ] 08-e2e — needs real `credentials.json` + `token.json`, then `docker compose up`