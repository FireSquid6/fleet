/**
 * auth-service.test.ts — units for the auth core over a real Store on a tmp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth-service";
import { BridgeError } from "../src/fleet-manager";
import { Store } from "../src/store/store";

describe("AuthService", () => {
  let dir: string;
  let store: Store;

  function service(sessionTtlMs = 60_000): AuthService {
    return new AuthService(store, { sessionTtlMs });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-auth-"));
    store = new Store(dir);
    await store.load();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("createUser persists and rejects duplicates with 409", async () => {
    const auth = service();
    const user = await auth.createUser("alice", "hunter2");
    expect(user.username).toBe("alice");
    expect(await auth.userCount()).toBe(1);

    const dup = auth.createUser("alice", "other");
    await expect(dup).rejects.toBeInstanceOf(BridgeError);
    await expect(dup).rejects.toMatchObject({ status: 409 });
  });

  test("verifyLogin accepts the right password and 401s otherwise", async () => {
    const auth = service();
    await auth.createUser("bob", "correct-horse");

    expect((await auth.verifyLogin("bob", "correct-horse")).username).toBe("bob");
    await expect(auth.verifyLogin("bob", "wrong")).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyLogin("nobody", "correct-horse")).rejects.toMatchObject({ status: 401 });
  });

  test("stored password is hashed, not plaintext", async () => {
    const auth = service();
    await auth.createUser("carol", "s3cret");
    const record = await store.getUserByUsername("carol");
    expect(record?.passwordHash).toBeDefined();
    expect(record?.passwordHash).not.toBe("s3cret");
    expect(await Bun.password.verify("s3cret", record!.passwordHash)).toBe(true);
  });

  test("createSession + resolveSession round-trips to the user", async () => {
    const auth = service();
    const user = await auth.createUser("dave", "pw");
    const token = await auth.createSession(user.id);

    const resolved = await auth.resolveSession(token);
    expect(resolved).toMatchObject({ id: user.id, username: "dave" });
    expect(await auth.resolveSession(undefined)).toBeNull();
    expect(await auth.resolveSession("bogus")).toBeNull();
  });

  test("expired sessions resolve to null and are pruned", async () => {
    const auth = service(0); // expiresAt == createdAt, so already expired on resolve
    const user = await auth.createUser("erin", "pw");
    const token = await auth.createSession(user.id);

    expect(await auth.resolveSession(token)).toBeNull();
    expect(await store.getSession(token)).toBeUndefined(); // lazily pruned
  });

  test("revokeSession invalidates a live session", async () => {
    const auth = service();
    const user = await auth.createUser("frank", "pw");
    const token = await auth.createSession(user.id);

    expect(await auth.resolveSession(token)).not.toBeNull();
    await auth.revokeSession(token);
    expect(await auth.resolveSession(token)).toBeNull();
  });

  test("tickets are single-use", async () => {
    const auth = service();
    const ticket = auth.issueTicket("user-1");

    expect(auth.consumeTicket(ticket)).toBe("user-1");
    expect(auth.consumeTicket(ticket)).toBeNull(); // already consumed
    expect(auth.consumeTicket("never-issued")).toBeNull();
    expect(auth.consumeTicket(undefined)).toBeNull();
  });
});
