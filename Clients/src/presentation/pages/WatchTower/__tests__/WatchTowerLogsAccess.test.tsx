import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import WatchTower from "../index";

// Every request goes through apiServices; record the URLs it is asked for.
const mockGet = vi.fn();
vi.mock("../../../../infrastructure/api/networkServices", () => ({
  apiServices: { get: (url: string) => mockGet(url) },
}));

// Isolate the Events tab; the Logs tab stays real so its request is observable.
vi.mock("../Events", () => ({
  __esModule: true,
  default: () => <div data-testid="watchtower-events" />,
}));

// Admin holds logs.admin; the other built-in roles do not.
let mockCanViewLogs = false;
vi.mock("../../../../application/hooks/useMyPermissions", () => ({
  useHasPermission: (key: string) => key === "logs.admin" && mockCanViewLogs,
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

const logsRequests = () => mockGet.mock.calls.filter(([url]) => url === "/logger/logs");

describe("Event Tracker logs access", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: { data: { success: true, data: [], message: "" } } });
  });

  describe("non-Admin", () => {
    beforeEach(() => {
      mockCanViewLogs = false;
    });

    it("does not show the Logs tab on /event-tracker", () => {
      renderWithProviders(<WatchTower />, { route: "/event-tracker" });
      expect(screen.getByRole("tab", { name: /events/i })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /logs/i })).not.toBeInTheDocument();
      expect(logsRequests()).toHaveLength(0);
    });

    it("lands on the Events tab when opening /event-tracker/logs directly", async () => {
      renderWithProviders(<WatchTower />, { route: "/event-tracker/logs" });
      expect(screen.getByTestId("watchtower-events")).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /logs/i })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /events/i })).toHaveAttribute("aria-selected", "true");
      // Give any effect a chance to fire before asserting nothing was requested.
      await new Promise((r) => setTimeout(r, 0));
      expect(logsRequests()).toHaveLength(0);
    });
  });

  describe("Admin", () => {
    beforeEach(() => {
      mockCanViewLogs = true;
    });

    it("shows the Logs tab on /event-tracker", () => {
      renderWithProviders(<WatchTower />, { route: "/event-tracker" });
      expect(screen.getByRole("tab", { name: /logs/i })).toBeInTheDocument();
    });

    it("loads the logs on /event-tracker/logs", async () => {
      renderWithProviders(<WatchTower />, { route: "/event-tracker/logs" });
      expect(screen.getByRole("tab", { name: /logs/i })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(logsRequests()).toHaveLength(1));
    });
  });
});
