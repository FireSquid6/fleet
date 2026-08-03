import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarget, Tmux, TmuxError } from "./index";

// Pure helper — no tmux required, so it always runs.
describe("buildTarget", () => {
  test("assembles session:window.pane from its parts", () => {
    expect(buildTarget({ session: "build" })).toBe("build");
    expect(buildTarget({ session: "build", window: "server" })).toBe("build:server");
    expect(buildTarget({ session: "build", window: 1, pane: 0 })).toBe("build:1.0");
    expect(buildTarget({ session: "$0", pane: "%2" })).toBe("$0.%2");
  });
});

// End-to-end tests run against a dedicated namespace + throwaway socket so they
// can never see or disturb the user's own tmux server (which lives on the
// default socket). Using `socketPath` also exercises the `-S` override path.
// The server is killed in teardown.
const NAMESPACE = "tmux-bun-test";
const SOCKET = join(tmpdir(), `tmux-bun-test-${process.pid}.sock`);

const tmuxAvailable = await (async () => {
  try {
    return (await Bun.$`tmux -V`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
})();

const suite = tmuxAvailable ? describe : describe.skip;
if (!tmuxAvailable) {
  console.warn("tmux not found on PATH — skipping tmux-bun end-to-end tests");
}

suite("tmux-bun end-to-end", () => {
  // `configFile: "/dev/null"` pins base-index/pane-base-index to their defaults
  // so window/pane indices are deterministic regardless of the user's tmux.conf.
  const tmux = new Tmux({ namespace: NAMESPACE, socketPath: SOCKET, configFile: "/dev/null" });

  // Start from a clean slate: kill any leftover server and wait for it to fully
  // exit so the first `newSession` starts a fresh one rather than racing a dying
  // process ("server exited unexpectedly").
  beforeAll(async () => {
    await tmux.killServer();
    for (let i = 0; i < 50 && (await tmux.isRunning()); i++) await Bun.sleep(20);
  });
  afterAll(async () => {
    await tmux.killServer();
  });

  test("server starts not running, then reports running after a session", async () => {
    expect(await tmux.isRunning()).toBe(false);
    expect(await tmux.listSessions()).toEqual([]);

    // This "keeper" session is intentionally left running for the whole suite.
    // Because tmux exits its server when the last session closes, keeping one
    // session alive lets later tests create and kill their own sessions without
    // ever tearing the server down mid-suite. afterAll's killServer cleans it up.
    const keeper = await tmux.newSession({ name: "keeper", width: 120, height: 40 });
    expect(keeper.target).toMatch(/^\$\d+$/); // stable session id, e.g. "$0"
    expect(await tmux.isRunning()).toBe(true);
    expect(await tmux.hasSession("keeper")).toBe(true);
  });

  test("sessions can be listed, probed, renamed, and killed", async () => {
    const session = await tmux.newSession({ name: "alpha" });

    expect(await tmux.hasSession("alpha")).toBe(true);
    expect(await tmux.hasSession("ghost")).toBe(false);

    const info = await session.info();
    expect(info.name).toBe("alpha");
    expect(info.attached).toBe(false); // headless — never attached
    expect(info.windows).toBeGreaterThanOrEqual(1);

    // The id-keyed handle survives the rename; a name-keyed one would not.
    await session.rename("beta");
    expect(await tmux.hasSession("beta")).toBe(true);
    expect(await tmux.hasSession("alpha")).toBe(false);
    expect((await session.info()).name).toBe("beta");

    const names = (await tmux.listSessions()).map((s) => s.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");

    await session.kill();
    expect(await session.exists()).toBe(false);
  });

  test("windows can be created, listed, renamed, selected, and killed", async () => {
    const session = await tmux.newSession({ name: "win" });

    const window = await session.newWindow({ name: "work" });
    expect(window.target).toMatch(/^@\d+$/); // stable window id, e.g. "@1"
    expect((await session.listWindows()).map((w) => w.name)).toContain("work");

    await window.rename("editor");
    expect((await window.info()).name).toBe("editor");

    await window.select();
    expect((await window.info()).active).toBe(true);

    await window.kill();
    expect(await window.exists()).toBe(false);

    await session.kill();
  });

  test("panes can be split, listed, resized, and killed", async () => {
    const session = await tmux.newSession({ name: "pan", width: 200, height: 50 });
    const window = await session.newWindow({ name: "grid" });

    expect((await window.listPanes()).length).toBe(1);

    const right = await window.split({ direction: "horizontal", percent: true, size: 40 });
    expect(right.target).toMatch(/^%\d+$/); // stable pane id, e.g. "%2"
    expect((await window.listPanes()).length).toBe(2);

    const bottom = await right.split({ direction: "vertical" });
    expect((await window.listPanes()).length).toBe(3);

    await right.resize({ width: 20 });
    expect((await right.info()).width).toBe(20);

    await bottom.kill();
    expect((await window.listPanes()).length).toBe(2);

    await session.kill();
  });

  test("send-keys + capture round-trips text through a pane", async () => {
    const session = await tmux.newSession({ name: "io", width: 120, height: 40 });
    const pane = session.window(0).pane(0);

    await pane.sendKeys("echo hello-from-tmux-bun", { enter: true });

    // Poll capture until the output appears (the shell runs the command async).
    let captured = "";
    for (let i = 0; i < 40; i++) {
      captured = await pane.capture();
      if (captured.includes("hello-from-tmux-bun")) break;
      await Bun.sleep(50);
    }
    expect(captured).toContain("hello-from-tmux-bun");

    await session.kill();
  });

  test("Pane.run returns just the command's output", async () => {
    const session = await tmux.newSession({ name: "run", width: 120, height: 40 });
    const pane = session.window(0).pane(0);

    const output = await pane.run("echo apple; echo banana");
    const lines = output.split("\n").filter((l) => l.length > 0);
    expect(lines).toContain("apple");
    expect(lines).toContain("banana");

    await session.kill();
  });

  test("options can be set and read back", async () => {
    const session = await tmux.newSession({ name: "opt" }); // start the server

    await tmux.setOption("history-limit", "12345", { global: true });
    expect(await tmux.getOption("history-limit", { global: true })).toBe("12345");
    // An unset option reads back as undefined rather than throwing.
    expect(await tmux.getOption("this-option-does-not-exist")).toBeUndefined();

    await session.kill();
  });

  test("genuine failures surface as TmuxError", async () => {
    const session = await tmux.newSession({ name: "err" });

    // Renaming a nonexistent session is a real failure, not an existence probe.
    await expect(tmux.session("no-such-session").rename("x")).rejects.toThrow(TmuxError);

    await session.kill();
  });
});

// Isolation is the hard requirement: an instance bound to a namespace must not
// be able to see the user's own sessions on the DEFAULT socket, and its own
// sessions must be invisible there. This test proves both directions.
suite("namespace isolation from the default socket", () => {
  const DEFAULT_PROBE = `tmux-bun-default-probe-${process.pid}`;
  const ISO_ONLY = `tmux-bun-iso-only-${process.pid}`;
  const isoNamespace = "tmux-bun-iso";

  afterAll(async () => {
    // Clean up only our own probe session on the DEFAULT socket, then tear down
    // the namespaced server. We never kill the user's default server.
    await Bun.$`tmux kill-session -t ${DEFAULT_PROBE}`.quiet().nothrow();
    await new Tmux({ namespace: isoNamespace }).killServer();
  });

  test("a namespaced instance is isolated from default-socket sessions", async () => {
    // Create a session on the user's DEFAULT tmux socket (no -L / -S).
    await Bun.$`tmux new-session -d -s ${DEFAULT_PROBE}`.quiet().nothrow();
    const onDefault = await Bun.$`tmux has-session -t ${DEFAULT_PROBE}`.quiet().nothrow();
    if (onDefault.exitCode !== 0) {
      // Sandbox may forbid the default server; the isolation guarantee still
      // holds, we just can't stage the cross-socket fixture here.
      console.warn("could not create a default-socket session; skipping isolation assertions");
      return;
    }

    const iso = new Tmux({ namespace: isoNamespace });
    await iso.killServer();

    expect(await iso.hasSession(DEFAULT_PROBE)).toBe(false);
    expect((await iso.listSessions()).map((s) => s.name)).not.toContain(DEFAULT_PROBE);

    await iso.newSession({ name: ISO_ONLY });
    const defaultSees = await Bun.$`tmux has-session -t ${ISO_ONLY}`.quiet().nothrow();
    expect(defaultSees.exitCode).not.toBe(0);
  });
});
