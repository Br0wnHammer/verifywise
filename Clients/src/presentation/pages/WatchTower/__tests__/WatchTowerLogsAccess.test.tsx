import { screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import WatchTower from "../index";

// Every request goes through apiServices. The permission hooks and the logs
// panel run for real; only the HTTP layer is stubbed, keyed by URL.
let permissionsResponse: () => Promise<unknown>;
const mockGet = vi.fn((url: string) => {
  if (url === "/roles/my-permissions") return permissionsResponse();
  if (url === "/logger/logs") {
    return Promise.resolve({ data: { data: { success: true, data: [], message: "" } } });
  }
  return Promise.reject(new Error(`unexpected request ${url}`));
});
vi.mock("../../../../infrastructure/api/networkServices", () => ({
  apiServices: { get: (url: string) => mockGet(url) },
}));

// The Events panel is stubbed so its mount is observable.
vi.mock("../Events", () => ({
  __esModule: true,
  default: () => <div data-testid="watchtower-events" />,
}));

vi.mock("../../../components/UserGuide/UserGuideSidebarContext", () => ({
  useUserGuideSidebarContext: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    currentPath: undefined,
    contentWidth: 400,
    setContentWidth: vi.fn(),
    totalSidebarWidth: 40,
    requiredPaddingRight: 0,
    openTab: vi.fn(),
    requestedTab: undefined,
    clearRequestedTab: vi.fn(),
  }),
  TAB_BAR_WIDTH: 40,
  DEFAULT_CONTENT_WIDTH: 400,
  MIN_GAP: 0,
}));

const tokenFor = (roleName: string) =>
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    btoa(JSON.stringify({ id: "5", organizationId: "1", roleName, expire: "9999999999999" })),
    "signature",
  ].join(".");

const LocationProbe = () => <div data-testid="location">{useLocation().pathname}</div>;

const renderAs = (roleName: string, route: string) =>
  renderWithProviders(
    <>
      <WatchTower />
      <LocationProbe />
    </>,
    { route, preloadedAuth: { authToken: tokenFor(roleName) } },
  );

const grants = (keys: string[]) => () => Promise.resolve({ data: { data: keys } });
const fails = () => Promise.reject(new Error("network down"));
const never = () => new Promise(() => {});

const logsRequests = () => mockGet.mock.calls.filter(([url]) => url === "/logger/logs");
const location = () => screen.getByTestId("location").textContent;
const RAW_LOGS = /raw logs/i;

describe("Event Tracker logs access", () => {
  beforeEach(() => {
    mockGet.mockClear();
  });

  describe("while permissions load", () => {
    beforeEach(() => {
      permissionsResponse = never;
    });

    it.each(["/event-tracker", "/event-tracker/logs"])(
      "shows a loading state on %s and mounts neither tab",
      async (route) => {
        renderAs("Editor", route);
        expect(screen.getByTestId("event-tracker-loading")).toBeInTheDocument();
        expect(screen.queryByTestId("watchtower-events")).not.toBeInTheDocument();
        expect(screen.queryByRole("tab")).not.toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 0));
        expect(logsRequests()).toHaveLength(0);
        expect(location()).toBe(route);
      },
    );
  });

  describe("non-Admin", () => {
    it("does not show the Logs tab on /event-tracker", async () => {
      permissionsResponse = grants(["risks.edit"]);
      renderAs("Editor", "/event-tracker");
      expect(await screen.findByTestId("watchtower-events")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /events/i })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /logs/i })).not.toBeInTheDocument();
      expect(screen.queryByText(RAW_LOGS)).not.toBeInTheDocument();
      expect(logsRequests()).toHaveLength(0);
    });

    it("is redirected from /event-tracker/logs to /event-tracker", async () => {
      permissionsResponse = grants(["risks.edit"]);
      renderAs("Editor", "/event-tracker/logs");
      await waitFor(() => expect(location()).toBe("/event-tracker"));
      expect(await screen.findByTestId("watchtower-events")).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /logs/i })).not.toBeInTheDocument();
      expect(logsRequests()).toHaveLength(0);
    });

    it("is redirected and gets no Logs tab when the permissions request fails", async () => {
      permissionsResponse = fails;
      renderAs("Editor", "/event-tracker/logs");
      await waitFor(() => expect(location()).toBe("/event-tracker"));
      expect(await screen.findByTestId("watchtower-events")).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /logs/i })).not.toBeInTheDocument();
      expect(logsRequests()).toHaveLength(0);
    });
  });

  describe("Admin", () => {
    it("shows the Logs tab and the raw logs description on /event-tracker", async () => {
      permissionsResponse = grants(["logs.admin"]);
      renderAs("Admin", "/event-tracker");
      expect(await screen.findByRole("tab", { name: /logs/i })).toBeInTheDocument();
      expect(screen.getByText(RAW_LOGS)).toBeInTheDocument();
    });

    it("stays on /event-tracker/logs and loads the logs", async () => {
      permissionsResponse = grants(["logs.admin"]);
      renderAs("Admin", "/event-tracker/logs");
      expect(await screen.findByRole("tab", { name: /logs/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await waitFor(() => expect(logsRequests()).toHaveLength(1));
      expect(location()).toBe("/event-tracker/logs");
      expect(screen.queryByTestId("watchtower-events")).not.toBeInTheDocument();
    });

    it("still gets the Logs tab when the permissions request fails", async () => {
      permissionsResponse = fails;
      renderAs("Admin", "/event-tracker/logs");
      expect(await screen.findByRole("tab", { name: /logs/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await waitFor(() => expect(logsRequests()).toHaveLength(1));
      expect(location()).toBe("/event-tracker/logs");
    });
  });

  it("shows the Logs tab to a custom role granted logs.admin", async () => {
    permissionsResponse = grants(["logs.admin"]);
    renderAs("Log reader", "/event-tracker");
    expect(await screen.findByRole("tab", { name: /logs/i })).toBeInTheDocument();
  });
});
