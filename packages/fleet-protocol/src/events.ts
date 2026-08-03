import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";
import { WorkspaceSummarySchema } from "./workspace";

const EventBase = z.object({
  ship: FleetIdentifierSchema,
  /** ISO 8601 timestamp of when the event was emitted. */
  at: z.string(),
});

/** Snapshot of the current workspaces, sent once when a client connects. */
export const SyncEventSchema = EventBase.extend({
  type: z.literal("sync"),
  workspaces: z.array(WorkspaceSummarySchema),
});

/** A workspace was created (cloned) — starts inactive. */
export const WorkspaceCreatedEventSchema = EventBase.extend({
  type: z.literal("workspace.created"),
  workspace: WorkspaceSummarySchema,
});

export const WorkspaceBranchChangedEventSchema = EventBase.extend({
  type: z.literal("workspace.branch_changed"),
  workspace: WorkspaceSummarySchema,
});

/** A workspace was activated (a tmux session was started). */
export const WorkspaceActivatedEventSchema = EventBase.extend({
  type: z.literal("workspace.activated"),
  workspace: WorkspaceSummarySchema,
});

/** A workspace was deactivated (its tmux session was killed). */
export const WorkspaceDeactivatedEventSchema = EventBase.extend({
  type: z.literal("workspace.deactivated"),
  workspace: WorkspaceSummarySchema,
});

export const WorkspaceAgentStatusChangedEventSchema = EventBase.extend({
  type: z.literal("workspace.agent_status_changed"),
  workspace: WorkspaceSummarySchema,
});

/** A workspace was removed (deactivated if needed, then its directory deleted). */
export const WorkspaceRemovedEventSchema = EventBase.extend({
  type: z.literal("workspace.removed"),
  workspace: WorkspaceSummarySchema,
});

/** Every event the ship's `/events` socket can emit. */
export const FleetEventSchema = z.discriminatedUnion("type", [
  SyncEventSchema,
  WorkspaceCreatedEventSchema,
  WorkspaceBranchChangedEventSchema,
  WorkspaceActivatedEventSchema,
  WorkspaceDeactivatedEventSchema,
  WorkspaceAgentStatusChangedEventSchema,
  WorkspaceRemovedEventSchema,
]);

export type SyncEvent = z.infer<typeof SyncEventSchema>;
export type FleetEvent = z.infer<typeof FleetEventSchema>;

/** Accepts a JSON string or an already-parsed object. Throws `ZodError` on mismatch. */
export function decodeFleetEvent(raw: string | unknown): FleetEvent {
  return FleetEventSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}
