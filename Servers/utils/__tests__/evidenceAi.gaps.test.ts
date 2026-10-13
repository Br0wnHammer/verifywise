/**
 * Evidence gaps query (#4911): links must map to the struct row they are
 * evidence for, and counts must be filterable by project.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
jest.mock("../../database/db", () => ({
  sequelize: { query: (...args: any[]) => mockQuery(...args) },
}));

import { getEvidenceGapsQuery } from "../evidenceAi.utils";

describe("getEvidenceGapsQuery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([[]]);
  });

  it("maps EU 'control' and 'subcontrol' links to struct control ids", async () => {
    await getEvidenceGapsQuery(1, "eu_ai_act");
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("WHEN 'control' THEN fel.entity_id::int");
    expect(sql).toContain("WHEN 'subcontrol' THEN");
    expect(sql).toContain("FROM subcontrols_eu s");
    expect(sql).toContain("subcontrols_struct_eu ss ON ss.id = s.subcontrol_meta_id");
    // Assessment-answer links have no control mapping: excluded, not miscounted.
    expect(sql).not.toContain("WHEN 'assessment' THEN");
  });

  it("maps ISO 'annex_category' links via annexcategory_meta_id", async () => {
    await getEvidenceGapsQuery(1, "iso_42001");
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("WHEN 'annex_category' THEN");
    expect(sql).toContain("annexcategories_iso a");
    expect(sql).toContain("annexcategory_meta_id");
  });

  it("restricts counted files to the project when projectId is given", async () => {
    await getEvidenceGapsQuery(1, "eu_ai_act", ["D", "F"], 7);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("pf.project_id = :projectId");
    expect(mockQuery.mock.calls[0][1].replacements.projectId).toBe(7);
  });

  it("passes a null project filter when no project is given", async () => {
    await getEvidenceGapsQuery(1);
    expect(mockQuery.mock.calls[0][1].replacements.projectId).toBeNull();
    expect(mockQuery.mock.calls.length).toBe(2); // both frameworks
  });
});
