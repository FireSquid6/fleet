import { beforeEach, describe, expect, test } from "bun:test";
import { AuthDatabase } from "../src/auth/auth-database";
import { AuthService } from "../src/auth/auth-service";
import { ADMIN_ENV_VARS, ensureFirstUser } from "../src/auth/bootstrap";

const PASSWORD = "first-admin-password";

const ENV = {
  FLEET_BRIDGE_ADMIN_USER: "root",
  FLEET_BRIDGE_ADMIN_EMAIL: "root@fleet.test",
  FLEET_BRIDGE_ADMIN_PASSWORD: PASSWORD,
};

describe("ensureFirstUser", () => {
  let auth: AuthService;
  let output: string[];

  beforeEach(() => {
    const db = new AuthDatabase(":memory:");
    db.migrate();
    auth = new AuthService(db);
    output = [];
  });

  /** Answers prompts from fixed queues and records what was asked. */
  function fakePrompts(lines: string[], secrets: string[]) {
    const asked: string[] = [];
    const next = (queue: string[], question: string) => {
      asked.push(question);
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return Promise.resolve(answer);
    };
    return {
      asked,
      promptLine: (question: string) => next(lines, question),
      promptSecret: (question: string) => next(secrets, question),
    };
  }

  test("creates the admin from the environment without prompting", async () => {
    await ensureFirstUser(auth, {
      env: ENV,
      isTty: true,
      stdout: (text) => output.push(text),
      promptLine: () => Promise.reject(new Error("should not prompt")),
      promptSecret: () => Promise.reject(new Error("should not prompt")),
    });

    expect(auth.getUser("root")).toMatchObject({ email: "root@fleet.test", role: "admin" });
    expect(await auth.login("root", PASSWORD)).toMatchObject({ user: { username: "root" } });
    expect(output).toEqual([]);
  });

  test("prompts on a TTY and re-asks when the confirmation does not match", async () => {
    const prompts = fakePrompts(
      ["ada", "ada@fleet.test"],
      ["typo-password", "confirm-mismatch", PASSWORD, PASSWORD],
    );

    await ensureFirstUser(auth, {
      env: {},
      isTty: true,
      stdout: (text) => output.push(text),
      promptLine: prompts.promptLine,
      promptSecret: prompts.promptSecret,
    });

    expect(auth.getUser("ada")).toMatchObject({ email: "ada@fleet.test", role: "admin" });
    expect(await auth.login("ada", PASSWORD)).toMatchObject({ user: { username: "ada" } });
    expect(prompts.asked).toHaveLength(6);
    expect(output.join("")).toContain("did not match");
  });

  test("fails fast off a TTY, naming the environment variables", async () => {
    const failure = ensureFirstUser(auth, {
      env: {},
      isTty: false,
      stdout: (text) => output.push(text),
    });

    await expect(failure).rejects.toThrow(new RegExp(ADMIN_ENV_VARS.join(".*")));
    expect(auth.hasUsers()).toBe(false);
  });

  test("a half-configured environment names the variables that are missing", async () => {
    for (const isTty of [true, false]) {
      const failure = ensureFirstUser(auth, {
        env: { FLEET_BRIDGE_ADMIN_USER: "root", FLEET_BRIDGE_ADMIN_PASSWORD: PASSWORD },
        isTty,
        stdout: (text) => output.push(text),
        promptLine: () => Promise.reject(new Error("should not prompt")),
        promptSecret: () => Promise.reject(new Error("should not prompt")),
      });

      await expect(failure).rejects.toThrow(/FLEET_BRIDGE_ADMIN_EMAIL/);
      await expect(failure).rejects.toThrow(/half configured/);
    }
    expect(auth.hasUsers()).toBe(false);
  });

  test("does nothing once a user exists", async () => {
    await auth.createUser({ username: "ada", email: "ada@fleet.test", password: PASSWORD });

    await ensureFirstUser(auth, {
      env: ENV,
      isTty: true,
      promptLine: () => Promise.reject(new Error("should not prompt")),
      promptSecret: () => Promise.reject(new Error("should not prompt")),
    });

    expect(auth.listUsers()).toHaveLength(1);
    expect(auth.getUser("root")).toBeUndefined();
  });
});
