/**
 * The vendor risk's Linked risks tab in German, French and Spanish, through the
 * real DOM translator and dictionary, the same way i18n.test.tsx checks the
 * project risk panel.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import {
  LANGS,
  expectNoUntranslatedText,
  resetAudit,
  setLanguage,
  tr,
} from "../../../../test/i18nHelpers";
import type { RiskLink } from "../../../../domain/interfaces/i.riskLink";

const mockUseVendorRiskLinks = vi.fn();
const mockGetAllProjectRisks = vi.fn();

vi.mock("../../../../application/hooks/useRiskLinks", () => ({
  useVendorRiskLinks: (vendorRiskId: number, status?: string) =>
    mockUseVendorRiskLinks(vendorRiskId, status),
  useUpdateVendorRiskLinkStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateVendorRiskLink: () => ({ mutate: vi.fn(), isPending: false }),
  useVendorRiskSharedProjects: () => ({ data: [{ id: 12, projects: ["Lending"] }] }),
  useSuggestVendorRiskHierarchy: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../../../application/hooks/useIsAdmin", () => ({
  useIsAdmin: () => true,
}));

vi.mock("../../../../application/repository/projectRisk.repository", () => ({
  getAllProjectRisks: (...args: unknown[]) => mockGetAllProjectRisks(...args),
}));

import VendorRiskLinksPanel from "../VendorRiskLinksPanel";

/** Names the fixtures put on screen; the user's own data is never translated. */
const FIXTURES = new Set(["Loan model bias", "Shared risk", "Lending"]);

const child = (overrides: Partial<RiskLink> = {}): RiskLink => ({
  id: 1,
  status: "suggested",
  source: "agent",
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

const result = (links: RiskLink[]) => ({
  data: links,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllProjectRisks.mockResolvedValue({ data: [{ id: 12, risk_name: "Shared risk" }] });
});

afterAll(() => setLanguage("en"));

describe.each(LANGS)("vendor risk linked risks tab in %s", (lang) => {
  beforeEach(async () => {
    await setLanguage(lang, true);
    resetAudit();
  });

  it("translates the child list, its hint and the actions", async () => {
    mockUseVendorRiskLinks.mockReturnValue(result([child()]));
    renderWithProviders(<VendorRiskLinksPanel vendorRiskId={7} />);

    for (const key of [
      "Child risks",
      "When the level of this risk changes, each child is flagged for review.",
      "Link a project risk",
      "Suggest children",
      "Show dismissed",
      "High risk",
      "Confirm",
      "Dismiss",
    ]) {
      expect((await screen.findAllByText(tr(lang, key))).length).toBeGreaterThan(0);
    }

    expectNoUntranslatedText(lang, FIXTURES);
  });

  it("translates the empty state", async () => {
    mockUseVendorRiskLinks.mockReturnValue(result([]));
    renderWithProviders(<VendorRiskLinksPanel vendorRiskId={7} />);

    expect(
      await screen.findByText(tr(lang, "No project risks inherit from this vendor risk yet.")),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        tr(
          lang,
          "Link a project risk that this vendor risk applies to. Suggestions from Suggest children appear here too.",
        ),
      ),
    ).toBeInTheDocument();

    expectNoUntranslatedText(lang, FIXTURES);
  });

  it("translates the link form, its hint and the shared-project chip", async () => {
    mockUseVendorRiskLinks.mockReturnValue(result([]));
    renderWithProviders(<VendorRiskLinksPanel vendorRiskId={7} />);

    await userEvent.click(
      await screen.findByRole("button", { name: tr(lang, "Link a project risk") }),
    );
    expect(
      await screen.findByText(
        tr(
          lang,
          "A project risk can have only one parent, and a risk with child risks of its own cannot become a child.",
        ),
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByPlaceholderText(tr(lang, "Search risks")));
    const listbox = await screen.findByRole("listbox");
    expect(
      await within(listbox).findByText(tr(lang, "Same project: {name}", { name: "Lending" })),
    ).toBeInTheDocument();

    expectNoUntranslatedText(lang, FIXTURES);
  });
});
