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
