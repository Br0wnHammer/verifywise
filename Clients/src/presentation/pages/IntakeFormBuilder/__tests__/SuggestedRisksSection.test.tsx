import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import SuggestedRisksSection from "../assessment/SuggestedRisksSection";
import {
  acceptAllSuggestedRisks,
  updateSuggestedRisk,
  type IntakeSuggestedRisk,
  type SuggestedRisksBlock,
} from "../../../../application/repository/intakeForm.repository";

vi.mock("../../../../application/repository/intakeForm.repository", () => ({
  updateSuggestedRisk: vi.fn(),
  acceptAllSuggestedRisks: vi.fn(),
}));

const item = (overrides: Partial<IntakeSuggestedRisk> = {}): IntakeSuggestedRisk => ({
  id: "a",
  source: "ai",
  name: "Biased ranking",
  description: "Rankings disadvantage some groups.",
  categories: [],
  likelihood: "Possible",
  severity: "Major",
  impact: "i",
  mitigationPlan: "Audit rankings",
  implementationStrategy: "HR owns it",
  deadline: null,
  state: "suggested",
  ...overrides,
});
const block = (
  items: IntakeSuggestedRisk[],
  overrides: Partial<SuggestedRisksBlock> = {},
): SuggestedRisksBlock => ({
  status: "complete",
  items,
  droppedCount: 0,
  stageStartedAt: "x",
  generatedAt: "y",
  ...overrides,
});

const render = (
  b: SuggestedRisksBlock | null,
  props: {
    isModel?: boolean;
    readOnly?: boolean;
    onChange?: (b: SuggestedRisksBlock) => void;
  } = {},
) =>
  renderWithProviders(
    <SuggestedRisksSection
      submissionId={11}
      block={b}
      isModel={props.isModel ?? false}
      readOnly={props.readOnly ?? false}
      onChange={props.onChange ?? vi.fn()}
    />,
  );

describe("SuggestedRisksSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists suggestions with their source and counts", () => {
    render(
      block([
        item(),
        item({ id: "b", source: "mit", name: "Data leak", state: "accepted" }),
        item({ id: "c", name: "Drift", state: "dismissed" }),
      ]),
    );
    expect(screen.getAllByText("AI-suggested")).toHaveLength(2);
    expect(screen.getByText("From the risk catalog")).toBeInTheDocument();
    expect(screen.getByText("Data leak")).toBeInTheDocument();
    expect(screen.getAllByText("1")).toHaveLength(2); // 1 accepted · 1 dismissed
    expect(
      screen.getByText("Accepted risks are added to the register when you approve."),
    ).toBeInTheDocument();
  });

  it("accept calls the API and shows the accepted state from the response", async () => {
    vi.mocked(updateSuggestedRisk).mockResolvedValue({ data: item({ state: "accepted" }) });
    const onChange = vi.fn();
    render(block([item()]), { onChange });
    fireEvent.click(screen.getByTestId("suggested-risk-a-accept"));
    await waitFor(() =>
      expect(updateSuggestedRisk).toHaveBeenCalledWith(11, "a", { state: "accepted" }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ state: "accepted" })] }),
    );
  });

  it("can't accept a suggestion without a mitigation plan", () => {
    render(block([item({ mitigationPlan: "" })]));
    expect(
      screen.getByText("Add a mitigation plan before accepting this risk."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("suggested-risk-a-accept")).toBeDisabled();
  });

  it("accept all calls the endpoint and accepts the ones with a plan", async () => {
    vi.mocked(acceptAllSuggestedRisks).mockResolvedValue({ data: { accepted: 1, skipped: 1 } });
    const onChange = vi.fn();
    render(block([item(), item({ id: "b", mitigationPlan: "" })]), { onChange });
    fireEvent.click(screen.getByTestId("suggested-risks-accept-all"));
    await waitFor(() => expect(acceptAllSuggestedRisks).toHaveBeenCalledWith(11));
    const next = onChange.mock.calls[0][0] as SuggestedRisksBlock;
    expect(next.items.map((i) => i.state)).toEqual(["accepted", "suggested"]);
    expect(
      await screen.findByText("not accepted: they need a mitigation plan first"),
    ).toBeInTheDocument();
  });

  it("edit saves only the changed fields", async () => {
    vi.mocked(updateSuggestedRisk).mockResolvedValue({ data: item({ name: "Unfair ranking" }) });
    render(block([item()]));
    fireEvent.click(screen.getByTestId("suggested-risk-a-edit"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unfair ranking" } });
    fireEvent.click(screen.getByTestId("suggestion-a-save"));
    await waitFor(() =>
      expect(updateSuggestedRisk).toHaveBeenCalledWith(11, "a", { name: "Unfair ranking" }),
    );
  });

  it("shows model category and level for model submissions", () => {
    render(block([item({ modelRiskCategory: "Bias & Fairness", modelRiskLevel: "High" })]), {
      isModel: true,
    });
    expect(screen.getByText("Bias & Fairness")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("suggested-risk-a-edit"));
    expect(screen.getByText("Model risk category")).toBeInTheDocument();
    expect(screen.getByText("Model risk level")).toBeInTheDocument();
  });

  it("says how many lower-rated suggestions were dropped", () => {
    render(block([item()], { droppedCount: 4 }));
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("lower-rated suggestions not shown")).toBeInTheDocument();
  });

  it("explains the not configured, failed and pending states", () => {
    const { unmount } = render(block([], { status: "ai_not_configured" }));
    expect(
      screen.getByText("AI scoring isn't set up for this form, so no risks are suggested."),
    ).toBeInTheDocument();
    unmount();
    const failed = render(block([], { status: "ai_failed" }));
    expect(
      screen.getByText("Risk suggestions failed. Use Retry in the score section to try again."),
    ).toBeInTheDocument();
    failed.unmount();
    render(block([], { status: "pending" }));
    expect(screen.getByText("Suggesting risks…")).toBeInTheDocument();
  });

  it("read-only hides every action", () => {
    render(block([item()]), { readOnly: true });
    expect(screen.queryByTestId("suggested-risk-a-accept")).toBeNull();
    expect(screen.queryByTestId("suggested-risks-accept-all")).toBeNull();
    expect(
      screen.queryByText("Accepted risks are added to the register when you approve."),
    ).toBeNull();
  });
});
