import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import LLMKeyRequiredNotice from "..";

let mockUserRoleName = "Admin";
vi.mock("../../../../application/hooks/useAuth", () => ({
  useAuth: () => ({ userRoleName: mockUserRoleName }),
}));

let mockPermissions: string[] = [];
let mockPermissionsLoading = false;
vi.mock("../../../../application/hooks/useRolePermissions", () => ({
  useMyPermissions: () => ({
    can: (key: string) => mockPermissions.includes(key),
    isPending: mockPermissionsLoading,
  }),
}));

const mockNavigate = vi.fn();
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => mockNavigate,
}));

const renderNotice = () =>
  renderWithProviders(
    <LLMKeyRequiredNotice
      adminMessage="Configure a key."
      memberMessage="Ask your administrator."
      icon={null}
      iconBackground="transparent"
    />,
  );

describe("LLMKeyRequiredNotice", () => {
  beforeEach(() => {
    mockUserRoleName = "Admin";
    mockPermissions = [];
    mockPermissionsLoading = false;
    mockNavigate.mockReset();
  });

  it("links admins straight to the add-key form", async () => {
    const user = userEvent.setup();
    renderNotice();
    expect(screen.getByRole("status")).toHaveTextContent("Configure a key.");
    await user.click(screen.getByRole("button", { name: "Go to settings" }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/apikeys?addKey=1");
  });

  it("tells other roles to ask an administrator, with no link", () => {
    mockUserRoleName = "Editor";
    renderNotice();
    expect(screen.getByRole("status")).toHaveTextContent("Ask your administrator.");
    expect(screen.queryByRole("button", { name: "Go to settings" })).not.toBeInTheDocument();
  });

  it("links a custom role holding llmKeys.admin to the add-key form", () => {
    // The server allows any role with llmKeys.admin, not only Admin.
    mockUserRoleName = "Platform admin";
    mockPermissions = ["llmKeys.admin"];
    renderNotice();
    expect(screen.getByRole("status")).toHaveTextContent("Configure a key.");
    expect(screen.getByRole("button", { name: "Go to settings" })).toBeInTheDocument();
  });

  it("does not give an Auditor the link from another user's cached permissions", () => {
    // Built-in roles follow the role list, so a stale permission list that
    // still holds llmKeys.admin cannot upgrade them.
    mockUserRoleName = "Auditor";
    mockPermissions = ["llmKeys.admin"];
    renderNotice();
    expect(screen.getByRole("status")).toHaveTextContent("Ask your administrator.");
  });

  it("waits for a custom role's permissions instead of telling it to ask an administrator", () => {
    mockUserRoleName = "Platform admin";
    mockPermissionsLoading = true;
    renderNotice();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
