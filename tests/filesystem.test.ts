import { describe, test, expect, beforeEach } from "bun:test";
import { MockFilesystem } from "../src/filesystem/mock";

const INITIAL_FILES = {
  "src/index.ts": `import { foo } from "./foo";\nconsole.log(foo);\n`,
  "src/foo.ts": `export const foo = "hello";\n`,
  "src/utils/helpers.ts": `export function add(a: number, b: number) {\n  return a + b;\n}\n`,
  "README.md": `# My Project\n\nA test project.\n`,
};

describe("MockFilesystem", () => {
  let fs: MockFilesystem;

  beforeEach(() => {
    fs = new MockFilesystem(INITIAL_FILES);
  });

  // getType / getRootPath

  test("getType returns 'mock'", () => {
    expect(fs.getType()).toBe("mock");
  });

  test("getRootPath returns '/'", () => {
    expect(fs.getRootPath()).toBe("/");
  });

  // readFile

  test("reads an existing file", async () => {
    const contents = await fs.readFile("src/index.ts");
    expect(contents).toContain("import { foo }");
  });

  test("throws when reading a missing file", async () => {
    expect(fs.readFile("nonexistent.ts")).rejects.toThrow("File not found");
  });

  // writeFile

  test("writes a new file", async () => {
    await fs.writeFile("newfile.ts", "const x = 1;");
    expect(await fs.readFile("newfile.ts")).toBe("const x = 1;");
  });

  test("overwrites an existing file", async () => {
    await fs.writeFile("README.md", "new content");
    expect(await fs.readFile("README.md")).toBe("new content");
  });

  // editFile

  test("replaces a string in a file", async () => {
    await fs.editFile("src/foo.ts", '"hello"', '"world"');
    expect(await fs.readFile("src/foo.ts")).toContain('"world"');
  });

  test("only replaces the first occurrence", async () => {
    await fs.writeFile("dupe.ts", "aaa aaa aaa");
    await fs.editFile("dupe.ts", "aaa", "bbb");
    expect(await fs.readFile("dupe.ts")).toBe("bbb aaa aaa");
  });

  test("throws when the string is not found", async () => {
    expect(fs.editFile("src/foo.ts", "nothere", "x")).rejects.toThrow("Edit failed");
  });

  test("throws when editing a missing file", async () => {
    expect(fs.editFile("missing.ts", "a", "b")).rejects.toThrow("File not found");
  });

  // deleteFile

  test("deletes an existing file", async () => {
    await fs.deleteFile("README.md");
    expect(fs.hasFile("README.md")).toBe(false);
  });

  test("throws when deleting a missing file", async () => {
    expect(fs.deleteFile("missing.ts")).rejects.toThrow("File not found");
  });

  // listDirectory

  test("lists top-level entries", async () => {
    const entries = await fs.listDirectory("/");
    const names = entries.map(e => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
  });

  test("identifies directories correctly", async () => {
    const entries = await fs.listDirectory("/");
    const src = entries.find(e => e.name === "src");
    expect(src?.type).toBe("directory");
  });

  test("identifies files correctly", async () => {
    const entries = await fs.listDirectory("/");
    const readme = entries.find(e => e.name === "README.md");
    expect(readme?.type).toBe("file");
  });

  test("lists a subdirectory", async () => {
    const entries = await fs.listDirectory("src");
    const names = entries.map(e => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("foo.ts");
    expect(names).toContain("utils");
  });

  test("does not include entries from sibling directories", async () => {
    const entries = await fs.listDirectory("src/utils");
    expect(entries.map(e => e.name)).toEqual(["helpers.ts"]);
  });

  test("reflects newly written files", async () => {
    await fs.writeFile("src/bar.ts", "export const bar = 1;");
    const entries = await fs.listDirectory("src");
    expect(entries.map(e => e.name)).toContain("bar.ts");
  });

  // searchFiles

  test("finds files by glob pattern", async () => {
    const matches = await fs.searchFiles("**/*.ts");
    expect(matches).toContain("src/index.ts");
    expect(matches).toContain("src/foo.ts");
    expect(matches).toContain("src/utils/helpers.ts");
  });

  test("does not include non-matching files", async () => {
    const matches = await fs.searchFiles("**/*.ts");
    expect(matches).not.toContain("README.md");
  });

  test("scopes search to a directory", async () => {
    const matches = await fs.searchFiles("*.ts", "src/utils");
    expect(matches).toContain("helpers.ts");
    expect(matches).not.toContain("src/index.ts");
  });

  // searchContent

  test("finds lines matching a pattern", async () => {
    const matches = await fs.searchContent("export const");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every(m => m.text.includes("export const"))).toBe(true);
  });

  test("returns correct file and line number", async () => {
    const matches = await fs.searchContent("export const foo");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toBe("src/foo.ts");
    expect(matches[0]?.line).toBe(1);
  });

  test("scopes search to a directory", async () => {
    const matches = await fs.searchContent("export", "src/utils");
    expect(matches.every(m => m.file.startsWith("helpers.ts"))).toBe(true);
  });

  test("returns empty array when nothing matches", async () => {
    const matches = await fs.searchContent("zzznomatch");
    expect(matches).toHaveLength(0);
  });

  // runCommand

  test("calls the provided command handler", async () => {
    const customFs = new MockFilesystem({}, async (cmd) => ({
      stdout: `ran: ${cmd}`,
      stderr: "",
      exitCode: 0,
    }));
    const result = await customFs.runCommand("echo hello");
    expect(result.stdout).toBe("ran: echo hello");
    expect(result.exitCode).toBe(0);
  });

  test("throws when no command handler is configured", async () => {
    expect(fs.runCommand("ls")).rejects.toThrow("not configured");
  });

  // hasFile / getFiles helpers

  test("hasFile returns true for existing files", () => {
    expect(fs.hasFile("src/index.ts")).toBe(true);
  });

  test("hasFile returns false for missing files", () => {
    expect(fs.hasFile("nope.ts")).toBe(false);
  });

  test("getFiles returns all current files", async () => {
    await fs.writeFile("extra.ts", "x");
    const all = fs.getFiles();
    expect(Object.keys(all)).toContain("/extra.ts");
  });
});
