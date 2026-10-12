import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";

let mockRole = "Admin";
let mockHasOrganizationAdmin = true;

// Mock hooks
vi.mock("../../../../application/hooks/useAuth", () => ({
  useAuth: () => ({
    userRoleName: mockRole,
    isSuperAdmin: false,
  }),
}));
vi.mock("../../../../application/hooks/useMyPermissions", () => ({
  useHasPermission: (key: string) => key === "organization.admin" && mockHasOrganizationAdmin,
}));

// Mock child tab components
vi.mock("../Profile/index", () => ({
  default: () => <div data-testid="profile-tab" />,
}));

vi.mock("../Password/index", () => ({
  default: () => <div data-testid="password-tab" />,
}));

vi.mock("../Team/index", () => ({
  default: () => <div data-testid="team-tab" />,
}));

vi.mock("../Organization", () => ({
  default: () => <div data-testid="organization-tab" />,
}));

vi.mock("../Preferences/index", () => ({
  default: () => <div data-testid="preferences-tab" />,
}));

vi.mock("../Features/index", () => ({
  default: () => <div data-testid="features-tab" />,
}));

vi.mock("../ApiKeys", () => ({
  default: () => <div data-testid="apikeys-tab" />,
}));

vi.mock("../AuditLedger", () => ({
  default: () => <div data-testid="audit-ledger-tab" />,
}));

vi.mock("../../../components/HelperIcon", () => ({
  default: () => null,
  HelperIcon: () => null,
}));

import ProfilePage from "../index";

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = "Admin";
    mockHasOrganizationAdmin = true;
  });

  it("shows the Data retention tab to a custom role granted organization.admin", () => {
    mockRole = "Compliance lead";
    renderWithProviders(<ProfilePage />, { route: "/settings" });
    expect(screen.getByText("Data retention")).toBeInTheDocument();
    // The audit ledger tab still follows the Admin role.
    expect(screen.queryByText("Audit ledger")).not.toBeInTheDocument();
  });

  it("hides the Data retention tab without organization.admin", () => {
    mockRole = "Editor";
    mockHasOrganizationAdmin = false;
    renderWithProviders(<ProfilePage />, { route: "/settings" });
    expect(screen.queryByText("Data retention")).not.toBeInTheDocument();
  });

  it("renders without crashing", () => {
    const { container } = renderWithProviders(<ProfilePage />, {
      route: "/settings",
    });
    expect(container).toBeTruthy();
  });
});
