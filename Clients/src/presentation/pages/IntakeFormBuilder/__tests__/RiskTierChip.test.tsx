import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import RiskTierChip from "../assessment/RiskTierChip";
import type { IntakeSubmission } from "../../../../application/repository/intakeForm.repository";

const v2 = (finalScore: number | null, rulesOnly = false) => ({
  version: 2 as const,
  status: "complete" as const,
  notRuleChecked: false,
  classificationLevel: null,
  ruleMinimum: null,
  ai: null,
  finalScore,
  source: null,
  rulesOnly,
  overallScore: finalScore,
  tier: finalScore === null ? null : ("High" as const),
  stageStartedAt: "x",
  scoredAt: "y",
});
const submission = (overrides: Partial<IntakeSubmission>) =>
  ({ id: 1, riskTier: null, riskAssessment: null, ...overrides }) as IntakeSubmission;

describe("RiskTierChip", () => {
  it("shows the v2 score next to its band", () => {
    renderWithProviders(
      <RiskTierChip submission={submission({ riskAssessment: v2(64), riskTier: "High" })} />,
    );
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("shows a rules-only score as ≥N", () => {
    renderWithProviders(<RiskTierChip submission={submission({ riskAssessment: v2(70, true) })} />);
    expect(screen.getByText("≥70")).toBeInTheDocument();
  });

  it("shows nothing for a v2 assessment without a score", () => {
    const { container } = renderWithProviders(
      <RiskTierChip submission={submission({ riskAssessment: v2(null) })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the v1 tier chip", () => {
    renderWithProviders(
      <RiskTierChip
        submission={submission({
          riskTier: "limited",
          riskAssessment: {
            overallScore: 40,
            tier: "limited",
            dimensions: [],
            llmEnhanced: false,
            scoredAt: "x",
          },
        })}
      />,
    );
    expect(screen.getByText("Limited")).toBeInTheDocument();
  });
});
