import type { User } from "fleet-protocol";
import {
  clearSession,
  edenErrorMessage,
  makeBridgeClient,
  promptLine,
  promptSecret,
  readSession,
  writeSession,
  TOKEN_ENV_VAR,
  type EdenResult,
  type FleetBridgeClient,
  type Session,
} from "fleet-cli-kit";

/** A failure to obtain credentials, as opposed to a failure of the call itself. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionDeps {
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  warn?: (text: string) => void;
  promptLine?: (question: string) => Promise<string>;
  promptSecret?: (question: string) => Promise<string>;
}

export class BridgeSession {
  private readonly env: Record<string, string | undefined>;
  private readonly isTty: boolean;
  private readonly warn: (text: string) => void;
  private readonly line: (question: string) => Promise<string>;
  private readonly secret: (question: string) => Promise<string>;
  private token: string | null | undefined;

  constructor(
    readonly url: string,
    deps: SessionDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.isTty = deps.isTty ?? Boolean(process.stdin.isTTY);
    this.warn = deps.warn ?? ((text: string) => void process.stderr.write(text));
    this.line = deps.promptLine ?? promptLine;
    this.secret = deps.promptSecret ?? promptSecret;
  }

  async client(): Promise<FleetBridgeClient> {
    return makeBridgeClient(this.url, (await this.resolveToken()) ?? undefined);
  }

  /**
   * A stored token can be revoked or expire at any time, so a 401 is answered by
   * discarding it and replaying the call once with a fresh one. Exactly once: a
   * password that is simply wrong has to fail rather than loop.
   */
  async call<R extends EdenResult<unknown>>(fn: (client: FleetBridgeClient) => Promise<R>): Promise<R> {
    const first = await fn(await this.client());
    if (first.error?.status !== 401) return first;

    await this.forget();
    const token = await this.acquire();
    this.token = token;
    if (token === null) return first;
    return fn(makeBridgeClient(this.url, token));
  }

  async logIn(username?: string): Promise<Session> {
    // Under CI or a redirected stdin the prompts below would never be answered,
    // so refuse loudly instead of blocking forever on a read that cannot return.
    if (!this.isTty) {
      throw new SessionError(
        `credentials for ${this.url} have to be typed at a terminal, and stdin is not one — set ${TOKEN_ENV_VAR} instead`,
      );
    }

    const name = username ?? (await this.line(`username for ${this.url}: `));
    const password = await this.secret("password: ");
    const { data, error } = await makeBridgeClient(this.url).auth.login.post({ username: name, password });
    if (error) throw new SessionError(`login to ${this.url} failed: ${edenErrorMessage(error.value)}`);
    if (!data) throw new SessionError(`login to ${this.url} returned no session`);

    const session: Session = { token: data.token, username: data.user.username };
    await writeSession(this.url, session, { env: this.env });
    this.token = session.token;
    return session;
  }

  async logOut(): Promise<void> {
    const stored = await readSession(this.url, { env: this.env });
    if (stored) {
      const { error } = await makeBridgeClient(this.url, stored.token).auth.logout.post();
      if (error) {
        this.warn(
          `fleet: could not revoke the session on ${this.url} (${edenErrorMessage(error.value)}); clearing it locally anyway\n`,
        );
      }
    }
    await this.forget();
  }

  async currentUser(): Promise<User | null> {
    const stored = await readSession(this.url, { env: this.env });
    if (!stored) return null;

    const { data, error } = await makeBridgeClient(this.url, stored.token).auth.me.get();
    if (error) {
      if (error.status !== 401) {
        throw new SessionError(`could not ask ${this.url} who we are: ${edenErrorMessage(error.value)}`);
      }
      await this.forget();
      return null;
    }
    return data;
  }

  private async resolveToken(): Promise<string | null> {
    if (this.token !== undefined) return this.token;
    const stored = await readSession(this.url, { env: this.env });
    return (this.token = stored ? stored.token : await this.acquire());
  }

  private async acquire(): Promise<string | null> {
    if (!(await this.authRequired())) return null;
    if (!this.isTty) {
      throw new SessionError(
        `not logged in to ${this.url} and stdin is not a terminal — run \`fleet login --bridge-url ${this.url}\` first, or set ${TOKEN_ENV_VAR}`,
      );
    }
    return (await this.logIn()).token;
  }

  private async authRequired(): Promise<boolean> {
    const { data, error } = await makeBridgeClient(this.url).auth.mode.get();
    // A bridge that cannot answer is treated as open: the caller's own request
    // then reports the real problem, rather than this demanding a password for a
    // bridge that is merely unreachable.
    return error || !data ? false : data.authRequired;
  }

  private async forget(): Promise<void> {
    this.token = undefined;
    await clearSession(this.url, { env: this.env });
  }
}
