import { describe, expect, it } from "vitest";
import {
  blockedWakePathKinds,
  describeBlockedWakePath,
  hasLiveBlockedWakePath,
  isScheduledMonitorLive,
  resolveScheduledMonitorNextCheckAt,
  type BlockedWakePathFacts,
} from "./blocked-wake-path.js";

const noWakePath: BlockedWakePathFacts = {
  hasUnresolvedBlocker: false,
  hasUnblockDescriptor: false,
  hasPendingInteraction: false,
  hasPendingApproval: false,
  hasScheduledMonitor: false,
};

describe("blocked wake paths", () => {
  it("treats a blocked issue with no wake path as stranded", () => {
    expect(hasLiveBlockedWakePath(noWakePath)).toBe(false);
    expect(blockedWakePathKinds(noWakePath)).toEqual([]);
    expect(describeBlockedWakePath(noWakePath)).toEqual([]);
  });

  it("counts each durable wake path", () => {
    expect(
      hasLiveBlockedWakePath({ ...noWakePath, hasUnresolvedBlocker: true }),
    ).toBe(true);
    expect(
      hasLiveBlockedWakePath({ ...noWakePath, hasUnblockDescriptor: true }),
    ).toBe(true);
    expect(
      hasLiveBlockedWakePath({ ...noWakePath, hasPendingInteraction: true }),
    ).toBe(true);
    expect(
      hasLiveBlockedWakePath({ ...noWakePath, hasPendingApproval: true }),
    ).toBe(true);
    expect(
      hasLiveBlockedWakePath({ ...noWakePath, hasScheduledMonitor: true }),
    ).toBe(true);
  });

  it("describes every present wake path", () => {
    const kinds = blockedWakePathKinds({
      hasUnresolvedBlocker: true,
      hasUnblockDescriptor: true,
      hasPendingInteraction: false,
      hasPendingApproval: true,
      hasScheduledMonitor: true,
    });
    expect(kinds).toEqual([
      "unresolved_blocker",
      "unblock_descriptor",
      "pending_approval",
      "scheduled_monitor",
    ]);
    expect(describeBlockedWakePath({
      hasUnresolvedBlocker: true,
      hasUnblockDescriptor: false,
      hasPendingInteraction: false,
      hasPendingApproval: false,
      hasScheduledMonitor: false,
    })).toEqual([
      "an unresolved first-class blocker (blockedByIssueIds)",
    ]);
  });

  it("only counts a monitor that is still scheduled in the future", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    expect(
      isScheduledMonitorLive(new Date("2026-10-22T13:00:00.000Z"), now),
    ).toBe(true);
    expect(
      isScheduledMonitorLive(new Date("2026-10-22T11:00:00.000Z"), now),
    ).toBe(false);
    expect(isScheduledMonitorLive(null, now)).toBe(false);
    expect(isScheduledMonitorLive(undefined, now)).toBe(false);
    expect(isScheduledMonitorLive("not-a-date", now)).toBe(false);
  });

  it("resolves the monitor that survives a write", () => {
    const stored = new Date("2026-10-22T13:00:00.000Z");
    expect(
      resolveScheduledMonitorNextCheckAt({
        monitorNextCheckAt: stored,
        policyMonitorNextCheckAt: null,
      })?.toISOString(),
    ).toBe(stored.toISOString());
    expect(
      resolveScheduledMonitorNextCheckAt({
        monitorNextCheckAt: stored,
        policyMonitorNextCheckAt: "2026-10-22T14:00:00.000Z",
      })?.toISOString(),
    ).toBe("2026-10-22T14:00:00.000Z");
    expect(
      resolveScheduledMonitorNextCheckAt({
        monitorNextCheckAt: stored,
        patchExecutionPolicy: {
          monitor: { nextCheckAt: "2026-10-22T15:00:00.000Z" },
        },
      })?.toISOString(),
    ).toBe("2026-10-22T15:00:00.000Z");
    expect(
      resolveScheduledMonitorNextCheckAt({
        monitorNextCheckAt: stored,
        patchExecutionPolicy: { monitor: undefined },
      }),
    ).toBeNull();
    expect(resolveScheduledMonitorNextCheckAt({})).toBeNull();
  });
});
