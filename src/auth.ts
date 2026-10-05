import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { authenticate } from "@google-cloud/local-auth";
import "dotenv/config";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

const CREDENTIALS_PATH = path.resolve(
  process.env.GOOGLE_CREDENTIALS_PATH || "credentials.json",
);
const TOKEN_PATH = path.resolve(path.dirname(CREDENTIALS_PATH), "token.json");
const REQUIRED_ACCOUNT = (process.env.GMAIL_ACCOUNT || "").trim().toLowerCase() || null;

function log(...a: unknown[]): void {
  console.error("[gmail-mcp]", ...a);
}

function clientFromKeyfile(): OAuth2Client {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}. Complete goal.md steps 1-3 (Google Cloud Console) first.`,
    );
  }
  const key = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const k = key.installed ?? key.web;
  if (!k?.client_id || !k?.client_secret) {
    throw new Error("credentials.json is missing client_id / client_secret.");
  }
  return new OAuth2Client({ clientId: k.client_id, clientSecret: k.client_secret });
}

async function assertAccount(client: OAuth2Client): Promise<void> {
  if (!REQUIRED_ACCOUNT) return;
  const { data } = await google
    .gmail({ version: "v1", auth: client })
    .users.getProfile({ userId: "me" });
  const email = (data.emailAddress || "").toLowerCase();
  if (email !== REQUIRED_ACCOUNT) {
    throw new Error(
      `Authenticated as ${email}, but GMAIL_ACCOUNT is set to ${REQUIRED_ACCOUNT}.`,
    );
  }
  log(`authenticated as ${email}`);
}

// ---- Headless auth (used by the running server / container) ----
let authPromise: Promise<OAuth2Client> | null = null;
let tokenMtime = 0;

function readToken(): Record<string, unknown> {
  return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
}

async function buildAuth(): Promise<OAuth2Client> {
  const client = clientFromKeyfile();
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(
      `No token.json at ${TOKEN_PATH}. On the host, run: npm run auth`,
    );
  }
  tokenMtime = statSync(TOKEN_PATH).mtimeMs;
  client.setCredentials(readToken());
  // Persist refreshed tokens so token.json stays current (keeps the existing
  // refresh_token if Google doesn't send a new one).
  client.on("tokens", (tokens) => {
    try {
      saveToken({ ...client.credentials, ...tokens });
      tokenMtime = statSync(TOKEN_PATH).mtimeMs;
    } catch (e) {
      log("failed to persist refreshed token:", e);
    }
  });
  try {
    await client.getAccessToken(); // refreshes if the cached access token is stale
  } catch (e) {
    if (String((e as { message?: string })?.message ?? e).includes("invalid_grant")) {
      throw new Error(
        "Google rejected the refresh token (invalid_grant) — it expired or was revoked. " +
          "Re-run `npm run auth` (or `npm run auth:headless`). If this happens every ~7 days, " +
          "your OAuth consent screen is in Testing mode: publish it to Production (see README).",
      );
    }
    throw e;
  }
  await assertAccount(client);
  return client;
}

/** Cached, lazily-created authenticated OAuth2Client (refreshes transparently). */
export function getAuth(): Promise<OAuth2Client> {
  // Pick up a re-authorized token.json without restarting the server.
  if (authPromise && existsSync(TOKEN_PATH) && statSync(TOKEN_PATH).mtimeMs !== tokenMtime) {
    log("token.json changed on disk; reloading credentials");
    authPromise = null;
  }
  if (!authPromise) {
    authPromise = buildAuth().catch((e) => {
      authPromise = null; // allow a retry after fixing credentials/token
      throw e;
    });
  }
  return authPromise;
}

export async function getGmail() {
  const auth = await getAuth();
  return google.gmail({ version: "v1", auth });
}

export async function getCalendar() {
  const auth = await getAuth();
  return google.calendar({ version: "v3", auth });
}

// ---- One-time authorization (produces token.json) ----
async function hasValidToken(): Promise<boolean> {
  if (!existsSync(TOKEN_PATH)) return false;
  try {
    const client = clientFromKeyfile();
    client.setCredentials(readToken());
    await client.getAccessToken(); // refreshes if the cached access token is stale
    await assertAccount(client);
    return true;
  } catch {
    return false;
  }
}

function saveToken(credentials: Record<string, unknown>): void {
  // Never drop a refresh_token we already have: Google omits it on re-consent.
  if (!credentials.refresh_token && existsSync(TOKEN_PATH)) {
    try {
      const prev = readToken();
      if (prev.refresh_token) credentials = { ...credentials, refresh_token: prev.refresh_token };
    } catch {
      /* ignore unreadable old token */
    }
  }
  if (!credentials.refresh_token) {
    log("WARNING: no refresh_token received; access will stop after ~1 hour.");
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  log(`Saved token to ${TOKEN_PATH}`);
}

// Interactive: run on a machine WITH a browser.  npm run auth
async function runInteractive(): Promise<void> {
  if (await hasValidToken()) {
    log("Already authorized (token.json is valid). Nothing to do.");
    return;
  }
  log("Opening your browser to authorize Gmail + Calendar…");
  const client = await authenticate({ keyfilePath: CREDENTIALS_PATH, scopes: SCOPES });
  saveToken({ ...client.credentials });
  log("Done. Run: npm run start   (or)   docker compose up");
}

// Headless: run on a server with NO browser. The URL is opened on any other
// device and its callback is tunneled back over SSH.  npm run auth:headless
async function runHeadless(): Promise<void> {
  if (await hasValidToken()) {
    log("Already authorized (token.json is valid). Nothing to do.");
    return;
  }
  const client = clientFromKeyfile();
  const port = Number(process.env.AUTH_CALLBACK_PORT || 8899);
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const authorizeUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: "offline",
    prompt: "consent", // always return a refresh_token, even on re-authorization
    scope: SCOPES.join(" "),
  });

  const hostname = process.env.HOSTNAME || "<server-hostname>";
  log("Headless auth — no browser needed on this machine.");
  log(`1) From the machine that HAS a browser, forward the callback port:`);
  log(`     ssh -L ${port}:localhost:${port} <you>@${hostname}`);
  log(`2) In that machine's browser, open this URL:`);
  log(`     ${authorizeUrl}`);
  log(`Waiting for the callback on 127.0.0.1:${port} … (Ctrl-C to cancel)`);

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "", `http://localhost:${port}`);
        if (url.pathname !== "/oauth2callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error) {
          res.end("Authorization rejected.");
          server.close();
          reject(new Error(`Authorization error: ${error}`));
          return;
        }
        if (!code) {
          res.end("No authorization code provided.");
          server.close();
          reject(new Error("No authorization code provided."));
          return;
        }
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        client.setCredentials(tokens);
        saveToken({ ...tokens });
        res.end("Authentication successful! Close this tab and return to the server.");
        server.close();
        resolve();
        log("Done. Run: docker compose up   (or)   npm run start");
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

// CLI entry points:
//   npm run auth          → tsx src/auth.ts --interactive   (needs a browser)
//   npm run auth:headless → tsx src/auth.ts --headless       (no browser, use SSH)
function cliError(e: unknown): never {
  console.error(`[gmail-mcp] ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (process.argv.includes("--headless")) {
  runHeadless().catch(cliError);
} else if (process.argv.includes("--interactive")) {
  runInteractive().catch(cliError);
}