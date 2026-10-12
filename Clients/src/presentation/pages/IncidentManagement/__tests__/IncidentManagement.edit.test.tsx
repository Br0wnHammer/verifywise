import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";

const captured = vi.hoisted(() => ({
  drawerProps: null as any,
}));

vi.mock("../../../components/HelperIcon", () => ({ default: () => null }));
vi.mock("../../../assets/icons/plus-circle-white.svg", () => ({
  ReactComponent: () => <svg data-testid="add-icon" />,
}));

const STORED_INCIDENT = {
  id: 42,
  incident_id: "INC-42",
  ai_project: "Chatbot",
  status: "Closed",
  severity: "Serious",
  occurred_date: "2026-09-20T00:00:00.000Z",
  date_detected: "2026-09-21T00:00:00.000Z",
  reporter: "Ada",
  categories_of_harm: ["Economic Loss"],
  description: "Model produced unsafe output",
  approval_status: "Approved",
  approved_by: "Jane Doe",
  approval_date: null as string | null,
  approval_notes: "Closure signed off",
  updated_at: "2026-10-10T12:34:56.789Z",
};

vi.mock("../../../../application/repository/entity.repository", () => ({
  getAllEntities: vi.fn().mockResolvedValue({ data: [] }),
  archiveIncidentById: vi.fn(),
  getEntityById: vi.fn(),
  updateEntityById: vi.fn(),
}));
vi.mock("../../../../application/repository/incident_management.repository", () => ({
  createIncidentManagement: vi.fn(),
}));
vi.mock("../../../../application/hooks/useAuth", () => ({
  useAuth: () => ({ userRoleName: "Admin", userToken: { name: "Test User" } }),
}));
vi.mock("../../../../application/hooks/useFilterBy", () => ({
  useFilterBy: () => ({ filterData: (data: unknown[]) => data, handleFilterChange: vi.fn() }),
}));
vi.mock("../../../../application/hooks/useTableGrouping", () => ({
  useTableGrouping: () => [],
  useGroupByState: () => ({ groupBy: null, groupSortOrder: "asc", handleGroupChange: vi.fn() }),
}));
vi.mock("../../../../application/hooks/useColumnVisibility", () => ({
  useColumnVisibility: () => ({
    visibleColumns: new Set(["incident_id", "status", "actions"]),
    allColumns: [],
    toggleColumn: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
}));
vi.mock("../../../../application/tools/log.engine", () => ({ logEngine: vi.fn() }));
vi.mock("../../../components/Table/GroupedTableView", () => ({
  GroupedTableView: ({ ungroupedData, renderTable }: any) => (
    <div>{renderTable(ungroupedData || [])}</div>
  ),
}));
vi.mock("../../../components/Table/GroupBy", () => ({ GroupBy: () => null }));
vi.mock("../../../components/Table/FilterBy", () => ({ FilterBy: () => null }));
vi.mock("../../../components/Table/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("../../../components/Table/ColumnSelector", () => ({ ColumnSelector: () => null }));
// The table exposes an edit trigger for incident 42.
vi.mock("../IncidentTable", () => ({
  default: ({ onEdit }: any) => (
    <button type="button" onClick={() => onEdit?.("42", "edit")}>
      edit incident
    </button>
  ),
}));
// The drawer is replaced by a probe that records its props.
vi.mock("../../../components/Modals/NewIncident", () => ({
  default: (props: any) => {
    captured.drawerProps = props;
    return null;
  },
}));
vi.mock("../../../components/PageTour", () => ({ default: () => null }));
vi.mock("../IncidentManagementSteps", () => ({ default: [] }));
vi.mock("../../../components/Cards/StatusTileCards", () => ({ StatusTileCards: () => null }));

import IncidentManagement from "../index";
import {
  getEntityById,
  updateEntityById,
} from "../../../../application/repository/entity.repository";

async function openEditDrawer(incident: Record<string, unknown>) {
  vi.mocked(getEntityById).mockResolvedValue({ data: incident } as any);
  renderWithProviders(<IncidentManagement />, { route: "/incidents" });
  fireEvent.click(await screen.findByText("edit incident"));
  await waitFor(() => expect(captured.drawerProps?.initialData).toBeTruthy());
  return captured.drawerProps;
}

describe("IncidentManagement edit drawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.drawerProps = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a null approval date through instead of defaulting to today", async () => {
    const props = await openEditDrawer({ ...STORED_INCIDENT, approval_date: null });
    expect(props.initialData.approval_date).toBeNull();
  });

  it("passes the stored approval date as its calendar date and the loaded updated_at", async () => {
    const props = await openEditDrawer({
      ...STORED_INCIDENT,
      approval_date: "2026-10-01T00:00:00.000Z",
    });
    expect(props.initialData.approval_date).toBe("2026-10-01");
    expect(props.initialData.expected_updated_at).toBe("2026-10-10T12:34:56.789Z");
  });

  it("after a 409, refetches the incident and hands the drawer the latest version", async () => {
    const props = await openEditDrawer(STORED_INCIDENT);
    vi.mocked(updateEntityById).mockRejectedValue(
      Object.assign(new Error("Conflict"), { status: 409 }),
    );
    vi.mocked(getEntityById).mockResolvedValue({
      data: { ...STORED_INCIDENT, updated_at: "2026-10-11T08:00:00.000Z" },
    } as any);

    let result: unknown;
    await act(async () => {
      result = await props.onSuccess({ ...props.initialData, status: "Investigating" });
    });

    // Merged into the open form, so the next save carries the new version.
    expect(result).toEqual({ expected_updated_at: "2026-10-11T08:00:00.000Z" });
    expect(getEntityById).toHaveBeenLastCalledWith({ routeUrl: "/ai-incident-managements/42" });
    expect(
      await screen.findByText(
        "This incident was changed by someone else since you opened it. Your edits are kept: save again to overwrite their changes.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the drawer open (resolves false) when a save fails for another reason", async () => {
    const props = await openEditDrawer(STORED_INCIDENT);
    vi.mocked(updateEntityById).mockRejectedValue(
      Object.assign(new Error("Server error"), { status: 500 }),
    );

    let result: unknown;
    await act(async () => {
      result = await props.onSuccess({ ...props.initialData, status: "Investigating" });
    });

    expect(result).toBe(false);
    expect(await screen.findByText("Failed to update incident.")).toBeInTheDocument();
  });

  it("hands the drawer the same initialData object across re-renders (an alert does not reset edits)", async () => {
    const props = await openEditDrawer(STORED_INCIDENT);
    const first = props.initialData;
    vi.mocked(updateEntityById).mockRejectedValue(
      Object.assign(new Error("Server error"), { status: 500 }),
    );

    await act(async () => {
      await props.onSuccess({ ...props.initialData, status: "Investigating" });
    });
    await screen.findByText("Failed to update incident.");

    expect(captured.drawerProps.initialData).toBe(first);
  });

  it("closes the drawer (resolves true) after a successful save", async () => {
    const props = await openEditDrawer(STORED_INCIDENT);
    vi.mocked(updateEntityById).mockResolvedValue({ data: {} } as any);

    let result: unknown;
    await act(async () => {
      result = await props.onSuccess({ ...props.initialData, status: "Investigating" });
    });

    expect(result).toBe(true);
    expect(updateEntityById).toHaveBeenCalledWith({
      routeUrl: "/ai-incident-managements/42",
      body: expect.objectContaining({
        status: "Investigating",
        expected_updated_at: "2026-10-10T12:34:56.789Z",
      }),
    });
  });
});
