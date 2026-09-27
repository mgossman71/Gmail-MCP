import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

async function buildAuth(): Promise<OAuth2Client> {
  const client = clientFromKeyfile();
  if (existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf-8")));
    await client.getAccessToken(); // refreshes if the cached access token is stale
  } else {
    throw new Error(
      `No token.json at ${TOKEN_PATH}. On the host, run: npm run auth`,
    );
  }
  await assertAccount(client);
  return client;
}

/** Cached, lazily-created authenticated OAuth2Client (refreshes transparently). */
export function getAuth(): Promise<OAuth2Client> {
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

// ---- Interactive auth (host, one-time): npm run auth ----
async function runInteractive(): Promise<void> {
  // Reuse an existing, still-refreshable token to avoid re-opening the browser.
  if (existsSync(TOKEN_PATH)) {
    try {
      const client = clientFromKeyfile();
      client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf-8")));
      await client.getAccessToken();
      await assertAccount(client);
      log("Already authorized (token.json is valid). Nothing to do.");
      return;
    } catch {
      log("Existing token.json is no longer valid; re-authorizing…");
    }
  }

  log("Opening your browser to authorize Gmail + Calendar…");
  const client = await authenticate({ keyfilePath: CREDENTIALS_PATH, scopes: SCOPES });
  writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2));
  log(`Saved token to ${TOKEN_PATH}`);
  log("Done. Run: npm run start   (or)   docker compose up");
}

// CLI entry point: npm run auth  (tsx src/auth.ts --interactive)
if (process.argv.includes("--interactive")) {
  runInteractive().catch((e) => {
    console.error(`[gmail-mcp] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}