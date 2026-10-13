/**
 * AI Advisor evidence functions (#4912, #4913).
 *
 * detect_evidence_gaps honours framework_type/project_id, covers both
 * frameworks, and is uncapped. analyze_document routes to the real evidence
 * analyzer instead of the retired keyword stub.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn();
jest.mock("../../database/db", () => ({
  sequelize: { query: (...args: any[]) => mockQuery(...args) },
}));

jest.mock("../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

jest.mock("../../utils/evidenceAi.utils", () => ({
  getEvidenceGapsQuery: jest.fn(),
}));

jest.mock("../evidenceAnalyzer/analyzer.service", () => ({
  analyzeEvidence: jest.fn(),
}));

jest.mock("../../utils/llmKey.utils", () => ({
  getLLMKeysWithKeyQuery: jest.fn(),
  getLLMProviderUrl: jest.fn((name: string) => `https://${name}.example`),
}));

import { availableEvidenceAiTools } from "./evidenceAiFunctions";
import { getEvidenceGapsQuery } from "../../utils/evidenceAi.utils";
import { analyzeEvidence } from "../evidenceAnalyzer/analyzer.service";
import { getLLMKeysWithKeyQuery } from "../../utils/llmKey.utils";

const detectEvidenceGaps = availableEvidenceAiTools.detect_evidence_gaps as any;
const analyzeDocument = availableEvidenceAiTools.analyze_document as any;

describe("detect_evidence_gaps (#4912)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("honours framework_type and project_id and reports no truncation", async () => {
    (getEvidenceGapsQuery as jest.Mock).mockResolvedValue([
      {
        framework_type: "iso_42001",
        control_id: 3,
        control_title: "A.2",
        evidence_count: 0,
        adequate_count: 0,
        gap_type: "no_evidence",
      },
    ]);

    const result = await detectEvidenceGaps({ framework_type: "iso_42001", project_id: 9 }, 1);

    expect(getEvidenceGapsQuery).toHaveBeenCalledWith(1, "iso_42001", ["D", "F"], 9);
    expect(result.framework_type).toBe("iso_42001");
    expect(result.project_id).toBe(9);
    expect(result.truncated).toBe(false);
    expect(result.controls_without_evidence).toBe(1);
    expect(result.gaps).toHaveLength(1);
  });

  it("defaults to both frameworks when framework_type is missing or unknown", async () => {
    (getEvidenceGapsQuery as jest.Mock).mockResolvedValue([]);

    const result = await detectEvidenceGaps({ framework_type: "nist" }, 1);

    expect(getEvidenceGapsQuery).toHaveBeenCalledWith(1, undefined, ["D", "F"], undefined);
    expect(result.framework_type).toBe("all");
    expect(result.truncated).toBe(false);
  });
});

describe("analyze_document (#4913)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes to the real analyzer with the file's stored content and metadata", async () => {
    mockQuery.mockResolvedValue([
      [
        {
          id: 4,
          filename: "policy.pdf",
          type: "application/pdf",
          content: Buffer.from("hello world evidence"),
          uploaded_time: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    (getLLMKeysWithKeyQuery as jest.Mock).mockResolvedValue([
      { key: "k", url: "", name: "OpenAI", model: "gpt-4", custom_headers: null },
    ]);
    (analyzeEvidence as jest.Mock).mockResolvedValue({
      summary: "S",
      overall_quality_grade: "B",
    });

    const result = await analyzeDocument({ file_id: 4 }, 1);

    expect(analyzeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "policy.pdf",
        documentText: "hello world evidence",
      }),
    );
    expect(result.file_id).toBe(4);
    expect(result.overall_quality_grade).toBe("B");
  });

  it("fails clearly when the file does not exist", async () => {
    mockQuery.mockResolvedValue([[]]);

    await expect(analyzeDocument({ file_id: 99 }, 1)).rejects.toThrow(/not found/);
    expect(analyzeEvidence).not.toHaveBeenCalled();
  });
});
