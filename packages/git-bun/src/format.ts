import type { BranchInfo, CommitInfo, FileStatus, StatusInfo, WorktreeInfo } from "./types";

// Field separator woven into every machine-readable `--format`/`--pretty` string.
// ASCII Unit Separator (0x1F) is a control character that never appears in commit
// subjects, author names, branch names, or paths, so splitting on it can't be
// fooled by content the way a space or tab could.
export const FIELD_SEP = "\u001f";

function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

// --- log -------------------------------------------------------------------

// %H sha, %h short sha, %an author name, %ae author email, %at author date
// (unix seconds), %s subject. Every field is single-line, so one commit is one
// output line and records split cleanly on "\n".
const LOG_FIELDS = ["%H", "%h", "%an", "%ae", "%at", "%s"] as const;

/** `--pretty` format string that {@link parseLog} knows how to read. */
export const LOG_FORMAT = LOG_FIELDS.join(FIELD_SEP);

export function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const cols = line.split(FIELD_SEP);
      return {
        sha: cols[0] ?? "",
        shortSha: cols[1] ?? "",
        authorName: cols[2] ?? "",
        authorEmail: cols[3] ?? "",
        authorDate: toInt(cols[4]),
        subject: cols[5] ?? "",
      };
    });
}

// --- status (porcelain v2) -------------------------------------------------

/**
 * Parse `git status --porcelain=v2 -z --branch` output. NUL termination keeps
 * paths verbatim instead of applying Git's configurable C-style quoting.
 */
export function parseStatus(stdout: string): StatusInfo {
  const info: StatusInfo = { ahead: 0, behind: 0, clean: true, files: [] };
  if (stdout.length > 0 && !stdout.endsWith("\0")) {
    throw new Error("Malformed git status porcelain v2 output: missing trailing NUL");
  }
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length === 0) continue;
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      // git prints "(detached)" when there is no branch.
      if (head !== "(detached)") info.branch = head;
    } else if (record.startsWith("# branch.upstream ")) {
      info.upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(record);
      if (m) {
        info.ahead = toInt(m[1]);
        info.behind = toInt(m[2]);
      }
    } else if (record[0] === "1") {
      info.files.push(parseChangedEntry(record, "1"));
    } else if (record[0] === "2") {
      const file = parseChangedEntry(record, "2");
      const origPath = records[++i];
      if (!origPath) throw malformedStatusRecord("2", "missing original path");
      info.files.push({ ...file, origPath });
    } else if (record[0] === "u") {
      info.files.push(parseChangedEntry(record, "u"));
    } else if (record[0] === "?") {
      if (!record.startsWith("? ") || record.length === 2) {
        throw malformedStatusRecord("?", "expected a nonempty path");
      }
      info.files.push({ path: record.slice(2), code: "??", staged: false });
    }
    // "! " (ignored) records are not surfaced by default.
  }
  info.clean = info.files.length === 0;
  return info;
}

function parseChangedEntry(record: string, kind: "1" | "2" | "u"): FileStatus {
  const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < fieldCount; i++) {
    const end = record.indexOf(" ", start);
    if (end === -1 || end === start) {
      throw malformedStatusRecord(kind, `expected ${fieldCount} metadata fields`);
    }
    fields.push(record.slice(start, end));
    start = end + 1;
  }
  if (fields[0] !== kind) throw malformedStatusRecord(kind, "invalid record type field");
  const path = record.slice(start);
  if (path.length === 0) throw malformedStatusRecord(kind, "expected a nonempty path");
  const code = fields[1] ?? "";
  validateChangedMetadata(kind, fields);
  return { path, code, staged: kind === "u" ? false : code[0] !== "." };
}

function validateChangedMetadata(kind: "1" | "2" | "u", fields: string[]): void {
  const code = fields[1] ?? "";
  const validCode =
    kind === "1"
      ? /^[.MTAD][.MTD]$/.test(code) && code !== ".."
      : kind === "2"
        ? /^[RC][.MTD]$/.test(code)
        : /^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(code);
  if (!validCode) throw malformedStatusRecord(kind, `invalid XY token ${JSON.stringify(code)}`);

  const sub = fields[2] ?? "";
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/.test(sub)) {
    throw malformedStatusRecord(kind, `invalid SUB token ${JSON.stringify(sub)}`);
  }

  const modeIndexes = kind === "u" ? [3, 4, 5, 6] : [3, 4, 5];
  for (const index of modeIndexes) {
    const mode = fields[index] ?? "";
    if (!/^[0-7]{6}$/.test(mode)) {
      throw malformedStatusRecord(kind, `invalid mode token ${JSON.stringify(mode)}`);
    }
  }

  const oidIndexes = kind === "u" ? [7, 8, 9] : [6, 7];
  const oids = oidIndexes.map((index) => fields[index] ?? "");
  if (oids.some((oid) => !/^[0-9a-f]+$/i.test(oid)) || oids.some((oid) => oid.length !== oids[0]?.length)) {
    throw malformedStatusRecord(kind, "object IDs must be equal-width hexadecimal tokens");
  }

  if (kind === "2") {
    const score = fields[8] ?? "";
    if (!/^[RC](?:100|[0-9]{1,2})$/.test(score) || score[0] !== code[0]) {
      throw malformedStatusRecord(kind, `invalid rename/copy score ${JSON.stringify(score)}`);
    }
  }
}

function malformedStatusRecord(kind: string, reason: string): Error {
  return new Error(`Malformed git status porcelain v2 ${JSON.stringify(kind)} record: ${reason}`);
}

// --- worktree list (porcelain) ---------------------------------------------

export function parseWorktrees(stdout: string): WorktreeInfo[] {
  return stdout
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const wt: WorktreeInfo = {
        path: "",
        sha: "",
        detached: false,
        bare: false,
        locked: false,
      };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) wt.path = line.slice("worktree ".length);
        else if (line.startsWith("HEAD ")) wt.sha = line.slice("HEAD ".length);
        else if (line.startsWith("branch ")) wt.branch = line.slice("branch refs/heads/".length);
        else if (line === "detached") wt.detached = true;
        else if (line === "bare") wt.bare = true;
        else if (line === "locked" || line.startsWith("locked ")) wt.locked = true;
      }
      return wt;
    });
}

// --- branch (--format) -----------------------------------------------------

// %(refname:short) name, %(objectname) sha, %(HEAD) "*" for the current branch,
// %(upstream:short) tracking branch (empty when unset).
const BRANCH_FIELDS = ["%(refname:short)", "%(objectname)", "%(HEAD)", "%(upstream:short)"] as const;

/** `--format` string that {@link parseBranches} knows how to read. */
export const BRANCH_FORMAT = BRANCH_FIELDS.join(FIELD_SEP);

export function parseBranches(stdout: string): BranchInfo[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const cols = line.split(FIELD_SEP);
      return {
        name: cols[0] ?? "",
        sha: cols[1] ?? "",
        current: cols[2]?.trim() === "*",
        upstream: cols[3] ? cols[3] : undefined,
      };
    });
}
