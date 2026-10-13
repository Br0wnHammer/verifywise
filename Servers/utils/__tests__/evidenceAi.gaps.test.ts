/**
 * Evidence gaps query (#4911): links must map to the struct row they are
 * evidence for, and counts must be filterable by project.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn() as jest.Mock;
jest.mock("../../database/db", () => ({
  sequelize: { query: (...args: any[]) => mockQuery(...args) },
}));

import { getEvidenceGapsQuery } from "../evidenceAi.utils";

describe("getEvidenceGapsQuery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockImplementation(() => Promise.resolve([[]]));
  });

  it("maps EU 'control' and 'subcontrol' links to struct control ids", async () => {
    await getEvidenceGapsQuery(1, "eu_ai_act");
    const firstCall = mockQuery.mock.calls[0] as any[];
    expect(String(firstCall[0])).toContain("WHEN 'control' THEN fel.entity_id::int");
    expect(String(firstCall[0])).toContain("WHEN 'subcontrol' THEN");
    expect(String(firstCall[0])).toContain("FROM subcontrols_eu s");
    expect(String(firstCall[0])).toContain("subcontrols_struct_eu ss ON ss.id = s.subcontrol_meta_id");
    // Assessment-answer links have no control mapping: excluded, not miscounted.
    expect(String(firstCall[0])).not.toContain("WHEN 'assessment' THEN");
  });

  it("maps ISO 'annex_category' links via annexcategory_meta_id", async () => {
    await getEvidenceGapsQuery(1, "iso_42001");
    const firstCall = mockQuery.mock.calls[0] as any[];
    expect(String(firstCall[0])).toContain("WHEN 'annex_category' THEN");
    expect(String(firstCall[0])).toContain("annexcategories_iso a");
    expect(String(firstCall[0])).toContain("annexcategory_meta_id");
  });

  it("restricts counted files to the project when projectId is given", async () => {
    await getEvidenceGapsQuery(1, "eu_ai_act", ["D", "F"], 7);
    const firstCall = mockQuery.mock.calls[0] as any[];
    expect(String(firstCall[0])).toContain("pf.project_id = :projectId");
    expect(firstCall[1].replacements.projectId).toBe(7);
  });

  it("passes a null project filter when no project is given", async () => {
    await getEvidenceGapsQuery(1);
    const firstCall = mockQuery.mock.calls[0] as any[];
    expect(firstCall[1].replacements.projectId).toBeNull();
    expect(mockQuery.mock.calls.length).toBe(2); // both frameworks
  });
});
