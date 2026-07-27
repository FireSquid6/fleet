// git-bun: a typed, headless API over the git CLI for Bun.
//
// The Git class is the primary way to drive git. Every instance is bound to a
// working directory at construction and confined to it — creating a worktree,
// cloning, or initializing returns a new Git handle bound to the resulting
// directory. The low-level GitCommand helper is exported as an escape hatch for
// subcommands this library does not wrap, and GitBackend is the seam for
// alternative transports.

export { Git, type GitOptions } from "./src/git";

export {
  GitCommand,
  type GitCommandOptions,
} from "./src/command";
export {
  ShellBackend,
  type GitBackend,
  type GitRunResult,
} from "./src/backend";
export { GitError } from "./src/errors";

export {
  FIELD_SEP,
  LOG_FORMAT,
  BRANCH_FORMAT,
  parseLog,
  parseStatus,
  parseWorktrees,
  parseBranches,
  parseLsRemote,
} from "./src/format";

export type {
  CommitInfo,
  FileStatus,
  StatusInfo,
  WorktreeInfo,
  BranchInfo,
  RemoteInfo,
  RemoteRef,
  ResetMode,
  InitOptions,
  CloneOptions,
  LogOptions,
  DiffOptions,
  ShowOptions,
  AddOptions,
  CommitOptions,
  ResetOptions,
  RestoreOptions,
  ListBranchesOptions,
  LsRemoteOptions,
  CreateBranchOptions,
  CheckoutOptions,
  SwitchOptions,
  DeleteBranchOptions,
  FetchOptions,
  PullOptions,
  PushOptions,
  WorktreeAddOptions,
  WorktreeRemoveOptions,
  ConfigScope,
} from "./src/types";
