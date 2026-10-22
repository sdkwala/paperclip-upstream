/**
 * Durable wake paths for `blocked` issues.
 *
 * The heartbeat procedure tells an agent to "skip `blocked` unless you can
 * unblock". A `blocked` issue therefore only gets revisited when something
 * outside the agent's own initiative wakes it. The only mechanisms that do
 * that are:
 *
 * - a first-class `blockedByIssueIds` edge that is still open (the
 *   `issue_blockers_resolved` wake fires when it completes),
 * - a structured `unblockDescriptor` naming an owner and an exact action
 *   (the named owner is notified on the transition into `blocked`),
 * - a pending issue-thread interaction or a linked pending approval that names
 *   a responder,
 * - a scheduled issue monitor (`monitorNextCheckAt`), which re-wakes the
 *   assignee on a timer.
 *
 * A `blocked` issue with none of those is a dead end: no wake can ever fire
 * for it, so it strands silently. This module is the single place that
 * defines whether a blocked issue still has a live wake path, so the write
 * guard, the reconciliation backstop, and the liveness classifier all agree.
 */

/** The durable wake paths a `blocked` issue can rely on. */
export type BlockedWakePathFacts = {
  /** At least one first-class blocker edge that can still resolve. */
  hasUnresolvedBlocker: boolean;
  /** A structured unblock descriptor naming an owner and an exact action. */
  hasUnblockDescriptor: boolean;
  /** A pending issue-thread interaction naming a responder. */
  hasPendingInteraction: boolean;
  /** A linked approval that is still pending. */
  hasPendingApproval: boolean;
  /** A scheduled issue monitor that will re-wake the assignee. */
  hasScheduledMonitor: boolean;
  /**
   * An active workspace repair owns the issue. The repair process resolves the
   * blocked state itself, so the issue is not stranded.
   */
  hasWorkspaceRepairHold: boolean;
};

export const BLOCKED_WAKE_PATH_KINDS = [
  "unresolved_blocker",
  "unblock_descriptor",
  "pending_interaction",
  "pending_approval",
  "scheduled_monitor",
  "workspace_repair_hold",
] as const;

export type BlockedWakePathKind = (typeof BLOCKED_WAKE_PATH_KINDS)[number];

export const BLOCKED_WAKE_PATH_LABELS: Record<BlockedWakePathKind, string> = {
  unresolved_blocker: "an unresolved first-class blocker (blockedByIssueIds)",
  unblock_descriptor: "an unblockDescriptor naming an owner and an exact action",
  pending_interaction: "a pending issue-thread interaction",
  pending_approval: "a linked pending approval",
  scheduled_monitor: "a scheduled issue monitor",
  workspace_repair_hold: "an active workspace repair that owns the issue",
};

/** The wake paths that are actually present on this issue. */
export function blockedWakePathKinds(facts: BlockedWakePathFacts): BlockedWakePathKind[] {
  const kinds: BlockedWakePathKind[] = [];
  if (facts.hasUnresolvedBlocker) kinds.push("unresolved_blocker");
  if (facts.hasUnblockDescriptor) kinds.push("unblock_descriptor");
  if (facts.hasPendingInteraction) kinds.push("pending_interaction");
  if (facts.hasPendingApproval) kinds.push("pending_approval");
  if (facts.hasScheduledMonitor) kinds.push("scheduled_monitor");
  if (facts.hasWorkspaceRepairHold) kinds.push("workspace_repair_hold");
  return kinds;
}

/** True when something will wake this issue's assignee again. */
export function hasLiveBlockedWakePath(facts: BlockedWakePathFacts): boolean {
  return blockedWakePathKinds(facts).length > 0;
}

/** Human-readable labels for the wake paths that are present. */
export function describeBlockedWakePath(facts: BlockedWakePathFacts): string[] {
  return blockedWakePathKinds(facts).map((kind) => BLOCKED_WAKE_PATH_LABELS[kind]);
}

/**
 * The error message used when a write tries to park an issue in `blocked`
 * without a live wake path.
 */
export function blockedWakePathRequirementMessage(): string {
  return (
    "Blocked requires a live wake path: an unresolved first-class blocker " +
    "(blockedByIssueIds), an unblockDescriptor naming an owner and an exact " +
    "action, a pending interaction/approval, a scheduled issue monitor, or an " +
    "active workspace repair. " +
    "A blocked issue with no wake path is skipped by every heartbeat and can " +
    "never wake its assignee again."
  );
}

/** The wake paths a caller may use to satisfy the requirement. */
export const BLOCKED_WAKE_PATH_VALID_PATHS = [
  "unresolved_blocker",
  "unblock_descriptor",
  "pending_interaction",
  "pending_approval",
  "scheduled_monitor",
  "workspace_repair_hold",
] as const;

/**
 * A monitor only counts as a live wake path while its next check is still in
 * the future. A monitor whose check already elapsed cannot wake anybody.
 */
export function isScheduledMonitorLive(
  nextCheckAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!nextCheckAt) return false;
  const ms = nextCheckAt instanceof Date ? nextCheckAt.getTime() : Date.parse(nextCheckAt);
  if (!Number.isFinite(ms)) return false;
  return ms > now.getTime();
}

/**
 * Resolve the next check time of the monitor that would apply after a write:
 * the patch's execution policy wins over the stored policy, and the stored
 * `monitorNextCheckAt` column wins over the policy when both exist.
 */
export function resolveScheduledMonitorNextCheckAt(input: {
  monitorNextCheckAt?: Date | string | null;
  executionPolicy?: unknown;
  patchExecutionPolicy?: unknown;
  policyMonitorNextCheckAt?: string | null;
}): Date | null {
  const patchPolicy = input.patchExecutionPolicy;
  if (patchPolicy !== undefined) {
    const monitor = (patchPolicy as { monitor?: { nextCheckAt?: unknown } } | null)?.monitor;
    if (!monitor || typeof monitor.nextCheckAt !== "string") return null;
    const parsed = new Date(monitor.nextCheckAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const policyNextCheckAt = input.policyMonitorNextCheckAt ?? null;
  if (policyNextCheckAt) {
    const parsed = new Date(policyNextCheckAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const column = input.monitorNextCheckAt ?? null;
  if (!column) return null;
  const parsed = column instanceof Date ? column : new Date(column);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
