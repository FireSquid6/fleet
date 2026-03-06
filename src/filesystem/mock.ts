import { Glob } from "bun";
import { normalize } from "node:path";
import type { CommandResult, ContentMatch, DirectoryEntry, Filesystem } from "./index";

type CommandHandler = (
  command: string,
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export class MockFilesystem implements Filesystem {
  private files: Map<string, string>;
  private commandHandler: CommandHandler;

  constructor(
    initialFiles: Record<string, string> = {},
    commandHandler?: CommandHandler,
  ) {
    this.files = new Map(Object.entries(initialFiles).map(([k, v]) => [this.normalize(k), v]));
    this.commandHandler = commandHandler ?? (() => {
      throw new Error("runCommand is not configured on this MockFilesystem");
    });
  }

  private normalize(path: string): string {
    return "/" + normalize(path).replace(/^\/+/, "");
  }

  getType(): string {
    return "mock";
  }

  getRootPath(): string {
    return "/";
  }

  async readFile(path: string): Promise<string> {
    const abs = this.normalize(path);
    if (!this.files.has(abs)) throw new Error(`File not found: ${path}`);
    return this.files.get(abs)!;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(this.normalize(path), contents);
  }

  async editFile(path: string, oldString: string, newString: string): Promise<void> {
    const abs = this.normalize(path);
    if (!this.files.has(abs)) throw new Error(`File not found: ${path}`);
    const contents = this.files.get(abs)!;
    if (!contents.includes(oldString)) throw new Error(`Edit failed: string not found in ${path}`);
    this.files.set(abs, contents.replace(oldString, newString));
  }

  async deleteFile(path: string): Promise<void> {
    const abs = this.normalize(path);
    if (!this.files.has(abs)) throw new Error(`File not found: ${path}`);
    this.files.delete(abs);
  }

  async listDirectory(path: string): Promise<DirectoryEntry[]> {
    const abs = this.normalize(path);
    const prefix = abs === "/" ? "/" : abs + "/";
    const seen = new Set<string>();
    const entries: DirectoryEntry[] = [];

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const top = rest.split("/")[0];
      if (!top || seen.has(top)) continue;
      seen.add(top);
      const isDir = rest.includes("/");
      entries.push({ name: top, type: isDir ? "directory" : "file" });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async searchFiles(pattern: string, directory?: string): Promise<string[]> {
    const base = directory ? this.normalize(directory) : "/";
    const prefix = base === "/" ? "/" : base + "/";
    const glob = new Glob(pattern);
    const matches: string[] = [];

    for (const filePath of this.files.keys()) {
      const relative = filePath.startsWith(prefix)
        ? filePath.slice(prefix.length)
        : filePath.startsWith("/")
          ? filePath.slice(1)
          : filePath;

      if (glob.match(relative)) {
        matches.push(relative);
      }
    }

    return matches.sort();
  }

  async searchContent(pattern: string, directory?: string): Promise<ContentMatch[]> {
    const base = directory ? this.normalize(directory) : "/";
    const prefix = base === "/" ? "/" : base + "/";
    const regex = new RegExp(pattern);
    const matches: ContentMatch[] = [];

    for (const [filePath, contents] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const relative = filePath.slice(prefix.length);
      contents.split("\n").forEach((text, i) => {
        if (regex.test(text)) {
          matches.push({ file: relative, line: i + 1, text: text.trim() });
        }
      });
    }

    return matches;
  }

  async runCommand(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult> {
    return this.commandHandler(command, options);
  }

  // Test helpers

  getFiles(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }

  hasFile(path: string): boolean {
    return this.files.has(this.normalize(path));
  }
}
