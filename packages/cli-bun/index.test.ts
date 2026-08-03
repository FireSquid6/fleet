import { describe, expect, test } from "bun:test";
import { CliCommand, CliError, toInt, type Backend, type RunResult } from "./index";

function fakeBackend(result: RunResult): Backend & { calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  return {
    calls,
    async run(args: readonly string[]): Promise<RunResult> {
      calls.push(args);
      return result;
    },
  };
}

class FakeError extends CliError {
  constructor(args: readonly string[], result: RunResult) {
    super("fake", args, result);
    this.name = "FakeError";
  }
}

class FakeCommand extends CliCommand {
  constructor(backend: Backend) {
    super(backend, (args, result) => new FakeError(args, result));
  }

  protected globalArgs(): readonly string[] {
    return ["-g", "global"];
  }
}

describe("toInt", () => {
  test("parses integers and falls back to 0", () => {
    expect(toInt("42")).toBe(42);
    expect(toInt("")).toBe(0);
    expect(toInt(undefined)).toBe(0);
    expect(toInt("nope")).toBe(0);
  });
});

describe("CliError", () => {
  test("prefers stderr, falls back to stdout, then to no output", () => {
    const base = { stdout: "out\n", stderr: "err\n", exitCode: 2 };
    expect(new CliError("fake", ["a", "b"], base).message).toBe(
      "fake a b failed (exit 2): err",
    );
    expect(new CliError("fake", ["a"], { ...base, stderr: "  " }).message).toBe(
      "fake a failed (exit 2): out",
    );
    expect(
      new CliError("fake", ["a"], { stdout: "", stderr: "", exitCode: 1 }).message,
    ).toBe("fake a failed (exit 1): no output");
  });

  test("carries the args and raw result", () => {
    const error = new CliError("fake", ["a"], { stdout: "o", stderr: "e", exitCode: 3 });
    expect(error.args).toEqual(["a"]);
    expect(error.stdout).toBe("o");
    expect(error.stderr).toBe("e");
    expect(error.exitCode).toBe(3);
    expect(error.name).toBe("CliError");
  });
});

describe("CliCommand", () => {
  test("prepends globalArgs to every invocation", async () => {
    const backend = fakeBackend({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const command = new FakeCommand(backend);
    await command.run(["status"]);
    expect(backend.calls[0]).toEqual(["-g", "global", "status"]);
  });

  test("run returns untrimmed stdout and tryRun never throws", async () => {
    const ok = new FakeCommand(fakeBackend({ stdout: " ok \n", stderr: "", exitCode: 0 }));
    expect(await ok.run(["x"])).toBe(" ok \n");

    const failing = new FakeCommand(fakeBackend({ stdout: "", stderr: "boom", exitCode: 1 }));
    expect((await failing.tryRun(["x"])).exitCode).toBe(1);
    await expect(failing.run(["x"])).rejects.toThrow(FakeError);
  });
});
