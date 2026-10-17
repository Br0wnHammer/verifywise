jest.setTimeout(60000);

import { cleanupDatabase, seedTwoOrgsAndUsers } from "../helpers";
import { JiraCloudMock } from "../../mocks/jiraCloud/server";
import { insertProject, rows, seedReadyConfig, withMock } from "./fixtures";
import { loadConfig, clientFor } from "../../../extensions/jira-incidents/jiraIncidents.config";
import { runImport } from "../../../extensions/jira-incidents/jiraIncidents.import";
import { newCounts, RunState } from "../../../extensions/jira-incidents/jiraIncidents.run";
import { sequelize } from "../../../database/db";

async function stateFor(orgId: number): Promise<RunState> {
  const config = (await loadConfig(orgId))!;
  return {
    orgId,
    runId: null,
    startedAt: new Date(),
    config,
    client: clientFor(config),
    counts: newCounts(),
    stopReason: null,
    heartbeat: async () => {},
    deadline: new AbortController().signal,
    warnedNoFrontendUrl: false,
  };
}

describe("jira incidents import", () => {
  let mock: JiraCloudMock;
  let orgA: number;
  let projectId: number;
  beforeEach(async () => {
    mock = await withMock();
    process.env.FRONTEND_URL = "https://app.verifywise.test";
    const seed = await seedTwoOrgsAndUsers();
    orgA = seed.orgA;
    projectId = await insertProject(orgA, seed.userA);
  });
  afterEach(async () => {
    await mock.close();
    await cleanupDatabase();
  });

  it("imports a new issue with summary, description, severity and status", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    const issue = mock.addIssue({
      summary: "Chatbot leaked a phone number",
      priorityId: "2",
      statusId: "3",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Seen in prod" }] }],
      },
    });
    const state = await stateFor(orgA);
    await runImport(state);

    const [incident] = await rows<any>(
      `SELECT * FROM ai_incident_managements WHERE organization_id = :orgA`,
      { orgA },
    );
    expect(incident).toMatchObject({
      description: "Chatbot leaked a phone number\n\nSeen in prod",
      severity: "Very serious",
      status: "Investigating",
      project_id: projectId,
      ai_project: "Fraud model",
      type: "Malfunction",
      reporter: "Jira sync",
      approval_status: "Pending",
    });
    const [link] = await rows<any>(
      `SELECT * FROM jira_incident_links WHERE organization_id = :orgA`,
      { orgA },
    );
    expect(link).toMatchObject({
      incident_id: incident.id,
      jira_issue_id: issue.id,
      state: "ok",
      last_jira_status_id: "3",
      last_vw_status: "Investigating",
    });
    expect(mock.state.issues[0].remoteLinks[0]).toEqual({
      globalId: `verifywise:incident:${orgA}:${incident.id}`,
      url: `https://app.verifywise.test/ai-incident-managements?incidentId=${incident.id}`,
      title: `VerifyWise ${incident.incident_id}`,
    });
    expect(state.counts.imported).toBe(1);
    expect((await loadConfig(orgA))!.lastCheckedAt).toEqual(state.startedAt);
  });

  it("issue created just before the cut-off is not imported, even in a far time zone", async () => {
    mock.state.account.timeZone = "Pacific/Kiritimati";
    const importFrom = new Date("2026-10-14T10:00:30Z");
    await seedReadyConfig(orgA, projectId, mock, importFrom);
    mock.addIssue({ summary: "before", created: "2026-10-14T10:00:10.000+0000" });
    mock.addIssue({ summary: "after", created: "2026-10-14T10:00:40.000+0000" });
    await runImport(await stateFor(orgA));
    const incidents = await rows<{ description: string }>(
      `SELECT description FROM ai_incident_managements WHERE organization_id = :orgA`,
      { orgA },
    );
    expect(incidents.map((i) => i.description)).toEqual(["after"]);
  });

  it("never imports an issue twice, across overlapping windows", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    mock.addIssue({ summary: "Once only please" });
    await runImport(await stateFor(orgA));
    await runImport(await stateFor(orgA));
    expect(
      await rows(`SELECT id FROM ai_incident_managements WHERE organization_id = :orgA`, { orgA }),
    ).toHaveLength(1);
  });

  it("deleted_in_verifywise is never re-imported", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    mock.addIssue({ summary: "Delete me later" });
    await runImport(await stateFor(orgA));
    const [incident] = await rows<{ id: number }>(
      `SELECT id FROM ai_incident_managements WHERE organization_id = :orgA`,
      { orgA },
    );
    const { deleteIncidentByIdQuery } = await import("../../../utils/incidentManagement.utils");
    await sequelize.transaction((t) => deleteIncidentByIdQuery(incident.id, orgA, t));
    await sequelize.query(
      `UPDATE jira_incidents_config SET last_checked_at = NULL WHERE organization_id = :orgA`,
      { replacements: { orgA } },
    );
    await runImport(await stateFor(orgA));
    expect(
      await rows(`SELECT id FROM ai_incident_managements WHERE organization_id = :orgA`, { orgA }),
    ).toHaveLength(0);
  });

  it("pages across search pages", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    for (let i = 0; i < 120; i++) mock.addIssue({ summary: `Issue number ${i}` });
    await runImport(await stateFor(orgA));
    expect(
      await rows(`SELECT id FROM ai_incident_managements WHERE organization_id = :orgA`, { orgA }),
    ).toHaveLength(120);
  });

  it("rate limit mid-run keeps completed imports and does not advance last_checked_at", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    for (let i = 0; i < 60; i++) mock.addIssue({ summary: `Issue number ${i}` });
    // The first search page (50 issues) succeeds; the second is rate limited.
    mock.state.failNext.push({
      status: 429,
      retryAfter: 120,
      path: "/rest/api/3/search/jql",
      afterCalls: 1,
    });
    const state = await stateFor(orgA);
    await runImport(state);
    expect(state.stopReason).toMatch(/Rate limited/);
    expect(state.counts.imported).toBe(50);
    expect((await loadConfig(orgA))!.lastCheckedAt).toBeNull();

    await runImport(await stateFor(orgA));
    expect(
      await rows(`SELECT id FROM ai_incident_managements WHERE organization_id = :orgA`, { orgA }),
    ).toHaveLength(60);
  });

  it("skips the remote link and warns once without FRONTEND_URL", async () => {
    delete process.env.FRONTEND_URL;
    await seedReadyConfig(orgA, projectId, mock);
    mock.addIssue({ summary: "First issue here" });
    mock.addIssue({ summary: "Second issue here" });
    const state = await stateFor(orgA);
    await runImport(state);
    expect(state.counts.imported).toBe(2);
    expect(mock.state.issues.every((i) => i.remoteLinks.length === 0)).toBe(true);
    expect(state.warnedNoFrontendUrl).toBe(true);
  });

  it("logs a failed remote link as an error without undoing the import", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    mock.addIssue({ summary: "Remote link fails" });
    mock.state.failNext.push({ status: 500, path: "/rest/api/3/issue/" });
    const state = await stateFor(orgA);
    await runImport(state);
    expect(state.counts).toMatchObject({ imported: 1, errors: 1 });
    const events = await rows<{ kind: string }>(
      `SELECT kind FROM jira_incident_sync_events WHERE organization_id = :orgA ORDER BY id`,
      { orgA },
    );
    expect(events.map((e) => e.kind)).toEqual(["imported", "error"]);
  });

  it("an unmapped Jira status imports as Open with the link in error and an empty snapshot", async () => {
    await seedReadyConfig(orgA, projectId, mock);
    await sequelize.query(
      `UPDATE jira_incidents_config SET status_map_in = status_map_in - '3' WHERE organization_id = :orgA`,
      { replacements: { orgA } },
    );
    const issue = mock.addIssue({ summary: "Unmapped status here", statusId: "3" });
    const state = await stateFor(orgA);
    await runImport(state);

    const [incident] = await rows<any>(
      `SELECT * FROM ai_incident_managements WHERE organization_id = :orgA`,
      { orgA },
    );
    expect(incident.status).toBe("Open");
    const [link] = await rows<any>(
      `SELECT * FROM jira_incident_links WHERE organization_id = :orgA`,
      { orgA },
    );
    expect(link).toMatchObject({
      jira_issue_id: issue.id,
      state: "error",
      last_jira_status_id: "",
      last_vw_status: "Open",
    });
    expect(link.state_reason).toMatch(/^Jira status '.+' isn't mapped$/);
    const events = await rows<{ kind: string }>(
      `SELECT kind FROM jira_incident_sync_events WHERE organization_id = :orgA ORDER BY id`,
      { orgA },
    );
    expect(events.map((e) => e.kind)).toEqual(["imported", "error"]);
    expect(state.counts).toMatchObject({ imported: 1, errors: 1 });
    // Task 9 must add the second half: after mapping the status, one runStatusSync sets the incident and link ok.
  });
});
