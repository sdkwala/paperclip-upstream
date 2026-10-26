import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agentRuntimeState,
  agentTaskSessions,
  agents,
  budgetPolicies,
  caseHandoffs,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged the stranded blocked issue.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded blocked reconciliation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stranded blocked issue reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-blocked-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Status-change wakes are enqueued in the background; let them land before
    // the cleanup deletes the rows they reference.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(caseHandoffs);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedIssue(opts?: {
    blockedForMs?: number;
    withBlocker?: boolean;
    blockerStatus?: string;
    withDescriptor?: boolean;
    withMonitor?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const nonce = companyId.replace(/-/g, "").slice(0, 6).toUpperCase();
    const blockedForMs = opts?.blockedForMs ?? 60 * 60 * 1000;
    const blockedAt = new Date(Date.now() - blockedForMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `SB${nonce}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      membershipRole: "operator",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Release engineer",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      // `enabled: false` keeps the wake on the queue without dispatching a run,
      // so the fixture never writes background execution rows.
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Release: merge + deploy",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${nonce}-1`,
        blockedTransitionAt: blockedAt,
        createdAt: blockedAt,
        updatedAt: blockedAt,
        ...(opts?.withDescriptor
          ? {
              unblockDescriptor: {
                owner: { agentId },
                action: "Wait for the release window",
              },
            }
          : {}),
        ...(opts?.withMonitor
          ? { monitorNextCheckAt: new Date(Date.now() + 30 * 60 * 1000) }
          : {}),
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Upstream dependency",
        status: opts?.blockerStatus ?? "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${nonce}-2`,
      },
    ]);
    if (opts?.withBlocker) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    return { companyId, agentId, issueId, blockerIssueId };
  }

  async function readIssue(issueId: string) {
    return db
      .select({ status: issues.status, blockedTransitionAt: issues.blockedTransitionAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("returns a blocked issue with no wake path to the actionable queue and wakes the assignee", async () => {
    const fixture = await seedBlockedIssue();

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(1);
    expect(result.issueIds).toEqual([fixture.issueId]);
    expect((await readIssue(fixture.issueId))?.status).toBe("todo");

    const comments = await db
      .select({ body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("no live wake path");
    expect(comments[0]?.authorType).toBe("system");

    const wakes = await db
      .select({
        reason: agentWakeupRequests.reason,
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, fixture.agentId));
    expect(wakes.some((wake) => wake.reason === "issue_blocked_wake_path_missing")).toBe(true);

    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.issueId));
    expect(activity.map((row) => row.action)).toContain("issue.blocked_wake_path_missing");
  });

  it("leaves a blocked issue that still has an open first-class blocker alone", async () => {
    const fixture = await seedBlockedIssue({ withBlocker: true });

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("leaves a blocked issue with an unblock descriptor alone", async () => {
    const fixture = await seedBlockedIssue({ withDescriptor: true });

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("leaves a blocked issue with a scheduled monitor alone", async () => {
    const fixture = await seedBlockedIssue({ withMonitor: true });

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("leaves a blocked issue that was just parked alone", async () => {
    const fixture = await seedBlockedIssue({ blockedForMs: 60 * 1000 });

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("leaves a blocked issue whose only blocker was cancelled for the liveness sweep", async () => {
    const fixture = await seedBlockedIssue({
      withBlocker: true,
      blockerStatus: "cancelled",
    });

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    // A cancelled blocker never fires `issue_blockers_resolved`, so it is not
    // a wake path either. The stranded reconciler owns the fix.
    expect(result.demoted).toBe(1);
    expect((await readIssue(fixture.issueId))?.status).toBe("todo");
  });

  it("does not re-demote the same issue twice inside the cooldown window", async () => {
    const fixture = await seedBlockedIssue();

    const first = await heartbeatService(db).reconcileStrandedBlockedIssues();
    expect(first.demoted).toBe(1);

    // Drop the wake the first reconciliation created so the only thing left
    // that could stop the second pass is the cooldown window.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);

    // Re-block the issue the way a confused agent would, then reconcile again.
    await db
      .update(issues)
      .set({
        status: "blocked",
        blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .where(eq(issues.id, fixture.issueId));

    const second = await heartbeatService(db).reconcileStrandedBlockedIssues();
    expect(second.demoted).toBe(0);
    expect(second.cooldownSkipped).toBe(1);
  });

  it("only reconciles the requested company", async () => {
    const fixture = await seedBlockedIssue();

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues({
      companyId: randomUUID(),
    });

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("leaves blocked issues without an agent assignee alone", async () => {
    const fixture = await seedBlockedIssue();
    await db
      .update(issues)
      .set({ assigneeAgentId: null })
      .where(eq(issues.id, fixture.issueId));

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
    expect((await readIssue(fixture.issueId))?.status).toBe("blocked");
  });

  it("ignores issues that are not blocked", async () => {
    const fixture = await seedBlockedIssue();
    await db
      .update(issues)
      .set({ status: "todo", blockedTransitionAt: null })
      .where(
        and(eq(issues.id, fixture.issueId), eq(issues.companyId, fixture.companyId)),
      );

    const result = await heartbeatService(db).reconcileStrandedBlockedIssues();

    expect(result.demoted).toBe(0);
  });
});
