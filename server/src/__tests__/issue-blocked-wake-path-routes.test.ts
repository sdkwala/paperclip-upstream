import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agentTaskSessions,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked wake path route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

describeEmbeddedPostgres("blocked issue wake path guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-wake-path-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Status-change wakes are enqueued in the background; let them land before
    // the cleanup deletes the rows they reference.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agentTaskSessions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedFixture(opts?: {
    issueStatus?: string;
    withBlocker?: boolean;
    blockerStatus?: string;
    withDescriptor?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const nonce = companyId.replace(/-/g, "").slice(0, 6).toUpperCase();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `BW${nonce}`,
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
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      scopeKind: "issue",
      issueId,
      contextSnapshot: { issueId, taskId: issueId },
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Release: merge + deploy",
        status: opts?.issueStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${nonce}-1`,
        ...(opts?.withDescriptor
          ? {
              unblockDescriptor: {
                owner: { agentId },
                action: "Wait for the release window",
              },
            }
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

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
      .then((rows) => rows[0]!);
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then((rows) => rows[0]!);
    return { companyId, agentId, runId, issueId, blockerIssueId, company, agent };
  }

  async function readIssueStatus(issueId: string) {
    return db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("rejects a blocked status with no live wake path", async () => {
    const fixture = await seedFixture();
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ status: "blocked" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("invalid_issue_disposition");
    expect(response.body.missing).toBe("wake_path");
    expect(response.body.validWakePaths).toEqual(
      expect.arrayContaining(["unresolved_blocker", "unblock_descriptor", "scheduled_monitor"]),
    );
    expect((await readIssueStatus(fixture.issueId))?.status).toBe("todo");
  });

  it("rejects a blocked status with no live wake path for the agent assignee", async () => {
    const fixture = await seedFixture();
    const app = createApp(db, agentActor(fixture.company, fixture.agent, fixture.runId));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .set("X-Paperclip-Run-Id", fixture.runId)
      .send({ status: "blocked" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("invalid_issue_disposition");
    expect((await readIssueStatus(fixture.issueId))?.status).toBe("todo");
  });

  it("accepts blocked with a first-class blocker edge", async () => {
    const fixture = await seedFixture();
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [fixture.blockerIssueId] });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("blocked");
    expect((await readIssueStatus(fixture.issueId))?.status).toBe("blocked");
  });

  it("accepts blocked with an unblock descriptor", async () => {
    const fixture = await seedFixture();
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: {
          owner: { userId: "board-user" },
          action: "Approve the release window",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("blocked");
  });

  it("returns a blocked issue with no wake path to the actionable queue", async () => {
    const fixture = await seedFixture({ issueStatus: "blocked" });
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ title: "Release: merge + deploy (renamed)" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("todo");
    expect((await readIssueStatus(fixture.issueId))?.status).toBe("todo");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.blocked_wake_path_missing");
  });

  it("keeps a blocked issue that still has an open first-class blocker", async () => {
    const fixture = await seedFixture({ issueStatus: "blocked", withBlocker: true });
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ title: "Release: merge + deploy (renamed)" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("blocked");
    expect((await readIssueStatus(fixture.issueId))?.status).toBe("blocked");
  });

  it("keeps a blocked issue that has an unblock descriptor", async () => {
    const fixture = await seedFixture({ issueStatus: "blocked", withDescriptor: true });
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ title: "Release: merge + deploy (renamed)" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("blocked");
  });

  it("returns a blocked issue whose only blocker was cancelled to the actionable queue", async () => {
    const fixture = await seedFixture({
      issueStatus: "blocked",
      withBlocker: true,
      blockerStatus: "cancelled",
    });
    const app = createApp(db, boardActor(fixture.company));

    const response = await request(app)
      .patch(`/api/issues/${fixture.issueId}`)
      .send({ title: "Release: merge + deploy (renamed)" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("todo");
  });
});
