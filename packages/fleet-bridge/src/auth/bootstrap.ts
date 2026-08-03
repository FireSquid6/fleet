import type { AuthService } from "./auth-service";
import { promptLine, promptSecret } from "./prompt";

export const ADMIN_ENV_VARS = [
  "FLEET_BRIDGE_ADMIN_USER",
  "FLEET_BRIDGE_ADMIN_EMAIL",
  "FLEET_BRIDGE_ADMIN_PASSWORD",
] as const;

export interface BootstrapOptions {
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  stdout?: (text: string) => void;
  promptLine?: (question: string) => Promise<string>;
  promptSecret?: (question: string) => Promise<string>;
}

/** Creates the first admin when the auth database is empty; a no-op afterwards. */
export async function ensureFirstUser(auth: AuthService, opts?: BootstrapOptions): Promise<void> {
  if (auth.hasUsers()) return;

  const env = opts?.env ?? process.env;
  const [userVar, emailVar, passwordVar] = ADMIN_ENV_VARS;
  const username = env[userVar];
  const email = env[emailVar];
  const password = env[passwordVar];
  if (username && email && password) {
    await auth.createFirstAdmin({ username, email, password });
    return;
  }

  // Half-configured is almost always a typo in a variable name, and falling
  // through to "you have configured nothing" would send the operator hunting
  // in the wrong place.
  const set = ADMIN_ENV_VARS.filter((name) => env[name]);
  if (set.length > 0) {
    const missing = ADMIN_ENV_VARS.filter((name) => !env[name]);
    throw new Error(
      `fleet-bridge admin bootstrap is only half configured: set ${missing.join(", ")} as well (${set.join(", ")} already set), or unset all three to be asked interactively`,
    );
  }

  // A bridge started by systemd or in a container has a stdin that will never
  // produce a line, so prompting there would hang forever with no output.
  // Failing with the variable names is the only actionable thing left.
  if (!(opts?.isTty ?? Boolean(process.stdin.isTTY))) {
    throw new Error(
      `fleet-bridge has no users and stdin is not a terminal — set ${ADMIN_ENV_VARS.join(", ")} to create the first admin, or start with --insecure-no-auth`,
    );
  }

  const write = opts?.stdout ?? ((text: string) => void process.stdout.write(text));
  const line = opts?.promptLine ?? promptLine;
  const secret = opts?.promptSecret ?? promptSecret;

  write("fleet-bridge has no users yet. Create the first admin.\n");
  const name = await line("username: ");
  const address = await line("email: ");
  let chosen = await secret("password: ");
  while (chosen !== (await secret("confirm password: "))) {
    write("passwords did not match, try again\n");
    chosen = await secret("password: ");
  }

  const admin = await auth.createFirstAdmin({ username: name, email: address, password: chosen });
  write(`created admin "${admin.username}"\n`);
}
