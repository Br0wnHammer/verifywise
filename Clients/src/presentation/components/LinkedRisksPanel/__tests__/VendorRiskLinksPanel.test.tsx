import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@mui/material";
import { light } from "../../../themes";
import { RiskLink } from "../../../../domain/interfaces/i.riskLink";

const mockUseVendorRiskLinks = vi.fn();
const mockMutateStatus = vi.fn();
const mockCreate = vi.fn();
const mockUseShared = vi.fn();

vi.mock("../../../../application/hooks/useRiskLinks", () => ({
  useVendorRiskLinks: (vendorRiskId: number, status?: string) =>
    mockUseVendorRiskLinks(vendorRiskId, status),
  useUpdateVendorRiskLinkStatus: () => ({ mutate: mockMutateStatus, isPending: false }),
  useCreateVendorRiskLink: () => ({ mutate: mockCreate, isPending: false }),
  useVendorRiskSharedProjects: (...args: unknown[]) => mockUseShared(...args),
}));

const mockGetAllProjectRisks = vi.fn();

vi.mock("../../../../application/repository/projectRisk.repository", () => ({
  getAllProjectRisks: (...args: unknown[]) => mockGetAllProjectRisks(...args),
}));

import VendorRiskLinksPanel from "../VendorRiskLinksPanel";

const VENDOR_RISK_ID = 7;

const child = (overrides: Partial<RiskLink> = {}): RiskLink => ({
  id: 1,
  status: "confirmed",
  source: "user",
  relationType: "inherits_from",
  score: 0,
  reasons: [],
  direction: "incoming",
  decidedAt: null,
  lastComputedAt: null,
  dismissReason: null,
  dismissNote: null,
  parentLevelChangedAt: null,
  relatedRisk: {
    id: 9,
    entityType: "risk",
    name: "Loan model bias",
    riskLevel: "High risk",
    ownerId: 2,
  },
  ...overrides,
});

const queryResult = (links: RiskLink[], extra: any = {}) => ({
  data: links,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  ...extra,
});

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={light}>
      <QueryClientProvider client={client}>
        <VendorRiskLinksPanel vendorRiskId={VENDOR_RISK_ID} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseShared.mockReturnValue({ data: [] });
  mockGetAllProjectRisks.mockResolvedValue({ data: [] });
});

describe("VendorRiskLinksPanel list", () => {
  it("lists the inheriting project risks under Child risks, and nothing else", () => {
    mockUseVendorRiskLinks.mockReturnValue(
      queryResult([
        child(),
        child({
          id: 2,
          status: "suggested",
          source: "agent",
          relatedRisk: {
            id: 10,
            entityType: "risk",
            name: "Onboarding data leak",
            riskLevel: null,
            ownerId: null,
          },
        }),
      ]),
    );
    renderPanel();

    expect(mockUseVendorRiskLinks).toHaveBeenLastCalledWith(VENDOR_RISK_ID, undefined);
    expect(screen.getByText("Child risks")).toBeInTheDocument();
    expect(screen.getByText("Loan model bias")).toBeInTheDocument();
    expect(screen.getByText("Onboarding data leak")).toBeInTheDocument();
    expect(
      screen.getByText("When the level of this risk changes, each child is flagged for review."),
    ).toBeInTheDocument();
    // A vendor risk is never a child and never in a related_to pair, and the
    // scan and the hierarchy pass both run from a project risk.
    expect(screen.queryByText("Parent risk")).not.toBeInTheDocument();
    expect(screen.queryByText("Relates to")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scan for related risks/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /suggest hierarchy/i })).toBeNull();
  });

  // The warning is about the child. On the parent's side it would read as a
  // statement about the vendor risk itself.
  it("never shows the stale-parent warning on the parent's side", () => {
    mockUseVendorRiskLinks.mockReturnValue(
      queryResult([child({ parentLevelChangedAt: "2026-10-01T10:00:00Z" })]),
    );
    renderPanel();

    expect(screen.queryByText("Parent level changed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
  });

  it("explains the empty list", () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([]));
    renderPanel();

    expect(
      screen.getByText("No project risks inherit from this vendor risk yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Child risks")).not.toBeInTheDocument();
  });

  it("offers a retry when the list fails to load", async () => {
    const refetch = vi.fn();
    mockUseVendorRiskLinks.mockReturnValue(queryResult([], { isError: true, refetch }));
    renderPanel();

    expect(screen.getByText("Failed to load linked risks.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("re-queries with the dismissed status", async () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([child()]));
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Show dismissed" }));

    await waitFor(() =>
      expect(mockUseVendorRiskLinks).toHaveBeenLastCalledWith(VENDOR_RISK_ID, "dismissed"),
    );
  });
});

describe("VendorRiskLinksPanel decisions", () => {
  it("confirms a suggested child", async () => {
    mockUseVendorRiskLinks.mockReturnValue(
      queryResult([child({ id: 31, status: "suggested", source: "agent" })]),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mockMutateStatus).toHaveBeenCalledWith(
      { id: 31, status: "confirmed" },
      expect.anything(),
    );
  });

  it("asks why before dismissing a suggestion, offering the inheritance reasons", async () => {
    mockUseVendorRiskLinks.mockReturnValue(
      queryResult([child({ id: 32, status: "suggested", source: "agent" })]),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mockMutateStatus).not.toHaveBeenCalled();
    expect(screen.getAllByRole("radio")).toHaveLength(4);

    await userEvent.click(
      screen.getByRole("radio", { name: "Right that it's a child, wrong parent" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(mockMutateStatus).toHaveBeenCalledWith(
      { id: 32, status: "dismissed", dismissal: { dismissReason: "wrong_parent" } },
      expect.anything(),
    );
  });

  it("un-links a confirmed child without asking", async () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([child({ id: 33 })]));
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(mockMutateStatus).toHaveBeenCalledWith(
      { id: 33, status: "dismissed" },
      expect.anything(),
    );
  });

  it("shows the server's message when a decision fails", async () => {
    mockUseVendorRiskLinks.mockReturnValue(
      queryResult([child({ id: 34, status: "suggested", source: "agent" })]),
    );
    mockMutateStatus.mockImplementation((_vars, { onError }) =>
      onError({ status: 409, message: "This risk already has a parent. Remove it first." }),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByText("This risk already has a parent. Remove it first."),
    ).toBeInTheDocument();
  });
});

describe("VendorRiskLinksPanel link form", () => {
  const openPicker = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Link a project risk" }));
    await userEvent.click(screen.getByPlaceholderText("Search risks"));
    return screen.findByRole("listbox");
  };

  it("lists risks in the vendor's projects first and leaves out current children", async () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([child()]));
    mockGetAllProjectRisks.mockResolvedValue({
      data: [
        { id: 9, risk_name: "Loan model bias" },
        { id: 11, risk_name: "Unrelated risk" },
        { id: 12, risk_name: "Shared risk" },
      ],
    });
    mockUseShared.mockReturnValue({ data: [{ id: 12, projects: ["Lending", "Onboarding"] }] });
    renderPanel();

    const listbox = await openPicker();
    const options = await within(listbox).findAllByRole("option");

    expect(mockUseShared).toHaveBeenCalledWith(VENDOR_RISK_ID, true);
    expect(options.map((o) => o.textContent)).toEqual([
      "Shared riskSame project: Lending +1",
      "Unrelated risk",
    ]);
  });

  it("links the chosen project risk as a child of this vendor risk", async () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([]));
    mockGetAllProjectRisks.mockResolvedValue({ data: [{ id: 12, risk_name: "Shared risk" }] });
    renderPanel();

    const listbox = await openPicker();
    await userEvent.click(await within(listbox).findByText("Shared risk"));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));

    expect(mockCreate).toHaveBeenCalledWith(
      { sourceRiskId: 12, targetVendorRiskId: VENDOR_RISK_ID, relationType: "inherits_from" },
      expect.anything(),
    );
  });

  it("shows why the server refused the link", async () => {
    mockUseVendorRiskLinks.mockReturnValue(queryResult([]));
    mockGetAllProjectRisks.mockResolvedValue({ data: [{ id: 12, risk_name: "Shared risk" }] });
    mockCreate.mockImplementation((_input, { onError }) =>
      onError({ status: 409, message: "This risk already has a parent. Remove it first." }),
    );
    renderPanel();

    const listbox = await openPicker();
    await userEvent.click(await within(listbox).findByText("Shared risk"));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));

    expect(
      await screen.findByText("This risk already has a parent. Remove it first."),
    ).toBeInTheDocument();
  });
});
