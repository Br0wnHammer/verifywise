import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Request, Response } from "express";

/**
 * DELETE /reporting/:id used to delete any file in the organization by id.
 * These tests run the real controller and reporting utils against a small
 * in-memory stand-in for the `files` and `file_folder_mappings` tables, so
 * they check which rows survive rather than the SQL text.
 */

type FileRow = { id: number; organization_id: number; source: string };
type MappingRow = { file_id: number; organization_id: number };

const db: { files: FileRow[]; mappings: MappingRow[] } = { files: [], mappings: [] };
const transaction = { commit: jest.fn(), rollback: jest.fn() };

/** Applies the WHERE clauses the reporting utils use for files. */
function matchingFiles(sql: string, r: any): FileRow[] {
  return db.files.filter(
    (f) =>
      f.organization_id === r.organizationId &&
      f.id === r.id &&
      (!/source IN \(:sources\)/.test(sql) || r.sources.includes(f.source)),
  );
}

function fakeQuery(sql: string, options: any = {}): any {
  const r = options.replacements ?? {};
  if (/^\s*DELETE FROM file_folder_mappings/.test(sql)) {
    const guarded = /EXISTS/.test(sql);
    if (!guarded || matchingFiles(sql, r).length > 0) {
      db.mappings = db.mappings.filter(
        (m) => !(m.organization_id === r.organizationId && m.file_id === r.id),
      );
    }
    return [[], 0];
  }
  if (/^\s*DELETE FROM files/.test(sql)) {
    const hit = matchingFiles(sql, r);
    db.files = db.files.filter((f) => !hit.includes(f));
    return hit;
  }
  if (/^\s*SELECT \* FROM files/.test(sql)) {
    return matchingFiles(sql, r);
  }
  throw new Error(`unexpected query: ${sql}`);
}

jest.mock("../../database/db", () => ({
  sequelize: {
    query: jest.fn(async (sql: string, options: any) => fakeQuery(sql, options)),
    transaction: jest.fn(async () => transaction),
  },
}));
// Prevent loading the real reporting engine (Playwright/docx) at import time.
jest.mock("../../services/reporting", () => ({ generateReport: jest.fn() }));
jest.mock("../../utils/reportRun.utils", () => ({
  createRunQuery: jest.fn(),
  updateRunStatusQuery: jest.fn(),
}));
jest.mock("../../services/automations/automationProducer", () => ({
  enqueueAutomationAction: jest.fn(),
}));
jest.mock("../../utils/user.utils", () => ({ getUserByIdQuery: jest.fn() }));
jest.mock("../../utils/organization.utils", () => ({ getOrganizationByIdQuery: jest.fn() }));
jest.mock("../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn(),
  logSuccess: jest.fn(),
  logFailure: jest.fn(),
}));
jest.mock("../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../utils/i18n.utils", () => ({
  translateError: jest.fn((_r, e) => (e as Error).message),
}));

import { deleteGeneratedReportById } from "../reporting.ctrl";

const ORG = 5;

function createMockReq(id: number): Partial<Request> {
  return {
    params: { id: String(id) },
    organizationId: ORG,
    userId: 3,
    role: "Admin",
    t: (k: string) => k,
  } as unknown as Partial<Request>;
}
function createMockRes(): Response & { status: jest.Mock } {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("deleteGeneratedReportById", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.files = [
      { id: 1, organization_id: ORG, source: "Project risks report" },
      { id: 2, organization_id: ORG, source: "File Manager" },
      { id: 3, organization_id: ORG, source: "Assessment tracker evidence" },
      { id: 4, organization_id: 99, source: "All reports" },
    ];
    db.mappings = [
      { file_id: 1, organization_id: ORG },
      { file_id: 2, organization_id: ORG },
    ];
  });

  it.each([
    ["a File Manager upload", 2],
    ["an evidence file", 3],
  ])("answers 404 for %s and leaves it and its folder mapping in place", async (_label, id) => {
    const res = createMockRes();

    await deleteGeneratedReportById(createMockReq(id) as Request, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.files.map((f) => f.id)).toContain(id);
    expect(db.mappings).toHaveLength(2);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("answers 404 for a report in another organization", async () => {
    const res = createMockRes();

    await deleteGeneratedReportById(createMockReq(4) as Request, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.files.map((f) => f.id)).toContain(4);
  });

  it("answers 404 for a missing id", async () => {
    const res = createMockRes();

    await deleteGeneratedReportById(createMockReq(404) as Request, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.files).toHaveLength(4);
  });

  it("deletes a generated report and its folder mapping", async () => {
    const res = createMockRes();

    await deleteGeneratedReportById(createMockReq(1) as Request, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.files.map((f) => f.id)).toEqual([2, 3, 4]);
    expect(db.mappings).toEqual([{ file_id: 2, organization_id: ORG }]);
    expect(transaction.commit).toHaveBeenCalledTimes(1);
  });
});
