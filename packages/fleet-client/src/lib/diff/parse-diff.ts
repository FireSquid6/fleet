// Parses a unified `git diff` into a structured list of files.
// Ported from the pipediff reference tool — a dependency-free state-machine parser.

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  content: string;
  // Line numbers in the old / new file (null when not applicable).
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffFile {
  // Stable identifier used by the UI.
  id: string;
  oldPath: string;
  newPath: string;
  // Display path (new path, or old path for deletions).
  path: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/**
 * Parse a full unified diff (as produced by `git diff`) into files.
 * Tolerant of the common variations: added/deleted/renamed files, binary
 * files, and multiple files in one stream.
 */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");

  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const pushFile = () => {
    if (current) {
      // Resolve display path & status now that we've seen the headers.
      if (current.oldPath === "/dev/null") current.status = "added";
      else if (current.newPath === "/dev/null") current.status = "deleted";

      const rawPath =
        current.newPath && current.newPath !== "/dev/null" ? current.newPath : current.oldPath;
      current.path = stripPrefix(rawPath);
      current.oldPath = stripPrefix(current.oldPath);
      current.newPath = stripPrefix(current.newPath);
      files.push(current);
    }
    current = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      // diff --git a/foo b/bar
      const m = line.match(/^diff --git (.+?) (.+)$/);
      const a = m ? m[1]! : "";
      const b = m ? m[2]! : "";
      current = {
        id: `file-${files.length}`,
        oldPath: a,
        newPath: b,
        path: stripPrefix(b || a),
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") current.oldPath = p;
      else current.oldPath = "/dev/null";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") current.newPath = p;
      else current.newPath = "/dev/null";
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLineNo = m ? parseInt(m[1]!, 10) : 0;
      newLineNo = m ? parseInt(m[2]!, 10) : 0;
      currentHunk = { header: line, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    // Body lines of a hunk.
    if (currentHunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" — attach as meta.
        currentHunk.lines.push({ kind: "meta", content: line, oldLine: null, newLine: null });
        continue;
      }
      const marker = line[0];
      if (marker === "+") {
        currentHunk.lines.push({ kind: "add", content: line.slice(1), oldLine: null, newLine: newLineNo++ });
        current.additions++;
      } else if (marker === "-") {
        currentHunk.lines.push({ kind: "del", content: line.slice(1), oldLine: oldLineNo++, newLine: null });
        current.deletions++;
      } else if (line.startsWith(" ")) {
        // Context line. In a unified diff every context line (even a blank
        // one) is prefixed with a single space.
        currentHunk.lines.push({
          kind: "context",
          content: line.slice(1),
          oldLine: oldLineNo++,
          newLine: newLineNo++,
        });
      } else {
        // Not a valid hunk body line — e.g. the empty string left by the
        // trailing newline when splitting, or the start of the next section.
        // End the current hunk so we don't invent phantom lines.
        currentHunk = null;
      }
    }
  }

  pushFile();
  return files;
}
