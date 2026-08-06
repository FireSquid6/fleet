import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeUrl } from "./client";

export interface Session {
  token: string;
  /** `null` when the token came from `FLEET_TOKEN`, which carries no name. */
  username: string | null;
}

export interface CredentialOptions {
  env?: Record<string, string | undefined>;
}

export const TOKEN_ENV_VAR = "FLEET_TOKEN";

const APP_DIRECTORY = "fleet-client-cli";
const SESSION_FILE = "session.json";

function stateHome(env: Record<string, string | undefined>): string {
  const configured = env.XDG_STATE_HOME?.trim();
  return configured ? configured : join(env.HOME?.trim() || homedir(), ".local", "state");
}

/**
 * The readable half is lossy — `http://a.b` and `https://a.b` reduce to the same
 * text — so the digest of the whole URL is what actually keeps two bridges apart.
 */
function slug(normalizedUrl: string): string {
  const readable = normalizedUrl.replace(/^https?:\/\//i, "").replace(/[^A-Za-z0-9._-]/g, "-");
  const digest = new Bun.CryptoHasher("sha256").update(normalizedUrl).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

export function sessionDirectory(url: string, opts: CredentialOptions = {}): string {
  return join(stateHome(opts.env ?? process.env), APP_DIRECTORY, slug(normalizeUrl(url)));
}

export function sessionFile(url: string, opts: CredentialOptions = {}): string {
  return join(sessionDirectory(url, opts), SESSION_FILE);
}

export async function readSession(url: string, opts: CredentialOptions = {}): Promise<Session | null> {
  const env = opts.env ?? process.env;
  const fromEnv = env[TOKEN_ENV_VAR]?.trim();
  if (fromEnv) return { token: fromEnv, username: null };

  try {
    const parsed: unknown = await Bun.file(sessionFile(url, opts)).json();
    if (!parsed || typeof parsed !== "object") return null;
    const { token, username } = parsed as { token?: unknown; username?: unknown };
    if (typeof token !== "string" || token === "") return null;
    return { token, username: typeof username === "string" ? username : null };
  } catch {
    return null;
  }
}

/**
 * Written through a `wx` temporary so the token never exists under any mode but
 * `0600`, not even for the instant a create-then-chmod would leave it readable.
 */
export async function writeSession(
  url: string,
  session: Session,
  opts: CredentialOptions = {},
): Promise<void> {
  const directory = sessionDirectory(url, opts);
  // `mkdir`'s mode is ignored for a directory that already exists and is masked
  // by the umask for one that does not, so neither alone guarantees 0700.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const target = join(directory, SESSION_FILE);
  const temporary = join(directory, `.${SESSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(session));
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function clearSession(url: string, opts: CredentialOptions = {}): Promise<void> {
  await rm(sessionFile(url, opts), { force: true });
}
