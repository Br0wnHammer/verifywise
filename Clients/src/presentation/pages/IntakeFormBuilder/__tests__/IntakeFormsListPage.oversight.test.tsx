import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import { IntakeFormsListPage } from "../IntakeFormsListPage";
import { useHasPermission } from "../../../../application/hooks/useMyPermissions";

vi.mock("../../../../application/hooks/useMyPermissions", () => ({
  useHasPermission: vi.fn(),
}));

vi.mock("../../../components/Layout/PageHeaderExtended", () => ({
  PageHeaderExtended: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../oversight/OversightTab", () => ({
  OversightTab: () => <div data-testid="oversight-tab" />,
}));

vi.mock("../../../../application/repository/intakeForm.repository", async (orig) => ({
  ...(await orig<object>()),
  getAllIntakeForms: vi.fn().mockResolvedValue({ data: [] }),
  getPendingSubmissions: vi.fn().mockResolvedValue({ data: [] }),
}));

describe("IntakeFormsListPage oversight tab", () => {
  it("hides the tab and the content without intakeForm.edit", async () => {
    vi.mocked(useHasPermission).mockReturnValue(false);
    renderWithProviders(<IntakeFormsListPage />, { route: "/intake-forms/oversight" });
    expect(await screen.findByText("Forms")).toBeInTheDocument();
    expect(screen.queryByText("Oversight")).not.toBeInTheDocument();
    expect(screen.queryByTestId("oversight-tab")).not.toBeInTheDocument();
  });

  it("shows the tab and its content with intakeForm.edit", async () => {
    vi.mocked(useHasPermission).mockReturnValue(true);
    renderWithProviders(<IntakeFormsListPage />, { route: "/intake-forms/oversight" });
    expect(await screen.findByText("Oversight")).toBeInTheDocument();
    expect(screen.getByTestId("oversight-tab")).toBeInTheDocument();
  });
});
