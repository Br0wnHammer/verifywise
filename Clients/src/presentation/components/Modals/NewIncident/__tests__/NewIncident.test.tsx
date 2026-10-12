import { vi, describe, it, expect, beforeAll } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../../Inputs/Field", () => ({
  default: (props: any) => (
    <input
      data-testid={`field-${props.id || "field"}`}
      value={props.value ?? ""}
      onChange={props.onChange ?? (() => {})}
    />
  ),
}));
vi.mock("../../../Inputs/Datepicker", () => ({
  default: () => <div data-testid="datepicker" />,
}));
vi.mock("../../../Inputs/Select", () => ({
  default: () => <div data-testid="select" />,
}));
vi.mock("../../../HistorySidebar", () => ({
  HistorySidebar: () => null,
  default: () => null,
}));
vi.mock("../../../../../application/hooks/useProjects", () => ({
  useProjects: () => ({ data: [], approvedProjects: [] }),
}));
vi.mock("../../../../../application/hooks/useModalKeyHandling", () => ({
  useModalKeyHandling: vi.fn(),
}));
vi.mock("../../../../../application/repository/entity.repository", () => ({
  getAllEntities: vi.fn().mockResolvedValue({ data: [] }),
}));
vi.mock("../../../../../application/repository/user.repository", () => ({
  getAllUsers: vi.fn().mockResolvedValue({ data: [] }),
}));

import { renderWithProviders } from "../../../../../test/renderWithProviders";
import SideDrawerIncident, { NewIncidentFormValues, isSameFormValue } from "../index";

// Enum values as plain strings (the enum members are string-valued); avoids a
// test-only import of the enum module.
const validInitialData = {
  ai_project: "AI Recruitment Screening Platform",
  project_id: 1,
  type: "Performance",
  severity: "Minor",
  status: "Open",
  occurred_date: "2026-09-01",
  date_detected: "2026-09-01",
  reporter: "Jane Doe",
  categories_of_harm: [],
  description: "The model ranked candidates unfairly.",
  interim_report: false,
  approval_status: "Pending",
} as unknown as NewIncidentFormValues;

beforeAll(() => {
  // jsdom does not implement scrollIntoView (used by formValidationFocus).
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewIncident (SideDrawerIncident)", () => {
  it("renders without crashing when open", () => {
    renderWithProviders(<SideDrawerIncident isOpen={true} setIsOpen={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });

  it("marks Categories of harm as required", () => {
    renderWithProviders(<SideDrawerIncident isOpen={true} setIsOpen={vi.fn()} />);
    expect(document.querySelector(".MuiFormLabel-asterisk")).toBeTruthy();
  });

  it("shows an inline error and does not submit when Categories of harm is empty (issue #4754)", () => {
    const onSuccess = vi.fn();
    renderWithProviders(
      <SideDrawerIncident isOpen={true} setIsOpen={vi.fn()} onSuccess={onSuccess} />,
    );

    fireEvent.click(screen.getByText("Save incident"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please select at least one Category of Harm.",
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("focuses the Categories of harm group when submit fails validation (issue #4754)", async () => {
    const onSuccess = vi.fn();
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={vi.fn()}
        onSuccess={onSuccess}
        initialData={validInitialData}
      />,
    );

    fireEvent.click(screen.getByText("Save incident"));

    await waitFor(() => {
      expect(document.activeElement?.id).toMatch(/^harm-category-/);
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  describe("save outcome", () => {
    const savable = {
      ...validInitialData,
      incident_id: "INC-42",
      categories_of_harm: ["Economic Loss"],
      expected_updated_at: "2026-10-10T12:00:00.000Z",
    } as unknown as NewIncidentFormValues;

    it("stays open with the user's values when the save resolves false", async () => {
      const setIsOpen = vi.fn();
      const onSuccess = vi.fn().mockResolvedValue(false);
      renderWithProviders(
        <SideDrawerIncident
          isOpen={true}
          setIsOpen={setIsOpen}
          onSuccess={onSuccess}
          initialData={savable}
        />,
      );

      fireEvent.click(screen.getByText("Save incident"));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(setIsOpen).not.toHaveBeenCalled();
    });

    it("when editing, sends only the fields the user changed plus the loaded version", async () => {
      const onSuccess = vi.fn().mockResolvedValue(true);
      renderWithProviders(
        <SideDrawerIncident
          isOpen={true}
          isEdit={true}
          setIsOpen={vi.fn()}
          onSuccess={onSuccess}
          initialData={savable}
        />,
      );

      fireEvent.change(screen.getByTestId("field-description"), {
        target: { value: "A's notes" },
      });
      fireEvent.click(screen.getByText("Update incident"));

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(onSuccess.mock.calls[0][0]).toEqual({
        description: "A's notes",
        expected_updated_at: "2026-10-10T12:00:00.000Z",
      });
    });

    it("after a conflict refresh, keeps the user's edit and never resends the other editor's fields", async () => {
      // A opened the incident while it was Open / Pending.
      const seenByA = {
        ...savable,
        status: "Open",
        approval_status: "Pending",
      } as NewIncidentFormValues;
      // B then closed and approved it; the page refetches and hands the drawer B's version.
      const afterB = {
        ...savable,
        status: "Closed",
        approval_status: "Approved",
        approved_by: "Bea",
        expected_updated_at: "2026-10-11T08:00:00.000Z",
      } as unknown as NewIncidentFormValues;
      const onSuccess = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const { rerender } = renderWithProviders(
        <SideDrawerIncident
          isOpen={true}
          isEdit={true}
          setIsOpen={vi.fn()}
          onSuccess={onSuccess}
          initialData={seenByA}
        />,
      );

      fireEvent.change(screen.getByTestId("field-description"), {
        target: { value: "A's notes" },
      });
      fireEvent.click(screen.getByText("Update incident"));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

      rerender(
        <SideDrawerIncident
          isOpen={true}
          isEdit={true}
          setIsOpen={vi.fn()}
          onSuccess={onSuccess}
          initialData={afterB}
        />,
      );
      // The user's edit survives the refresh.
      expect(screen.getByTestId("field-description")).toHaveValue("A's notes");

      fireEvent.click(screen.getByText("Update incident"));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
      // Only A's edit, on B's version: B's status and approval are not sent back.
      expect(onSuccess.mock.calls[1][0]).toEqual({
        description: "A's notes",
        expected_updated_at: "2026-10-11T08:00:00.000Z",
      });
    });

    it("ignores a second click while a save is in flight", async () => {
      let finish: (value: boolean) => void = () => {};
      const onSuccess = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      renderWithProviders(
        <SideDrawerIncident
          isOpen={true}
          setIsOpen={vi.fn()}
          onSuccess={onSuccess}
          initialData={savable}
        />,
      );

      const save = screen.getByText("Save incident");
      fireEvent.click(save);
      fireEvent.click(save);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(save.closest("button")).toBeDisabled());

      finish(true);
      await waitFor(() => expect(save.closest("button")).not.toBeDisabled());
    });
  });

  it("compares lists as sets, so reordering harm categories is not an edit", () => {
    expect(
      isSameFormValue("categories_of_harm", ["Economic Loss", "Other"], ["Other", "Economic Loss"]),
    ).toBe(true);
    expect(isSameFormValue("categories_of_harm", ["Other"], ["Other", "Economic Loss"])).toBe(
      false,
    );
  });

  it("sends no version when the loaded incident had none (never an empty string)", async () => {
    const onSuccess = vi.fn().mockResolvedValue(true);
    const noVersion = {
      ...validInitialData,
      incident_id: "INC-42",
      categories_of_harm: ["Economic Loss"],
    } as unknown as NewIncidentFormValues;
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        isEdit={true}
        setIsOpen={vi.fn()}
        onSuccess={onSuccess}
        initialData={noVersion}
      />,
    );

    fireEvent.change(screen.getByTestId("field-description"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByText("Update incident"));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0][0]).toEqual({ description: "Edited" });
  });
});
