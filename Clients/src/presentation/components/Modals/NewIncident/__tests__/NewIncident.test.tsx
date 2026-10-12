import { vi, describe, it, expect, beforeAll } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("../../../Inputs/Field", () => ({
  default: (props: any) => (
    <input
      data-testid={`field-${props.id || "field"}`}
      value={props.value ?? ""}
      onChange={props.onChange}
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
import SideDrawerIncident, { NewIncidentFormValues } from "../index";
import { useModalKeyHandling } from "../../../../../application/hooks/useModalKeyHandling";

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

  const savableData = {
    ...validInitialData,
    categories_of_harm: ["Health"],
  } as unknown as NewIncidentFormValues;

  it("closes only after the save resolves", async () => {
    const setIsOpen = vi.fn();
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={setIsOpen}
        onSuccess={onSuccess}
        initialData={savableData}
      />,
    );

    fireEvent.click(screen.getByText("Save incident"));

    await waitFor(() => expect(setIsOpen).toHaveBeenCalledWith(false));
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ description: savableData.description }),
    );
  });

  it("stays open with the entered values when the save fails", async () => {
    const setIsOpen = vi.fn();
    const onSuccess = vi.fn().mockRejectedValue(new Error("400"));
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={setIsOpen}
        onSuccess={onSuccess}
        initialData={savableData}
      />,
    );

    fireEvent.click(screen.getByText("Save incident"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(setIsOpen).not.toHaveBeenCalled();

    // Retrying submits the same values, so nothing the user typed was reset.
    fireEvent.click(screen.getByText("Save incident"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
    expect(onSuccess.mock.calls[1][0]).toEqual(onSuccess.mock.calls[0][0]);
    expect(setIsOpen).not.toHaveBeenCalled();
  });

  /** A save the test resolves by hand. */
  const deferredSave = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { onSuccess: vi.fn(() => promise), resolve };
  };

  /** The onClose the drawer last handed to useModalKeyHandling (the Esc path). */
  const latestEscHandler = () => {
    const calls = vi.mocked(useModalKeyHandling).mock.calls;
    return (calls[calls.length - 1][0] as { onClose: () => void }).onClose;
  };

  it("ignores Esc and disables Cancel while a save is in flight", async () => {
    const setIsOpen = vi.fn();
    const save = deferredSave();
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={setIsOpen}
        onSuccess={save.onSuccess}
        initialData={savableData}
      />,
    );

    fireEvent.click(screen.getByText("Save incident"));
    await waitFor(() => expect(save.onSuccess).toHaveBeenCalledTimes(1));

    expect(screen.getByText("Cancel").closest("button")).toBeDisabled();
    act(() => latestEscHandler()());
    expect(setIsOpen).not.toHaveBeenCalled();

    // A second click on Save while saving does not submit twice.
    fireEvent.click(screen.getByText("Save incident"));
    expect(save.onSuccess).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve());
    await waitFor(() => expect(setIsOpen).toHaveBeenCalledWith(false));
  });

  it("does not let a late save close a newer draft", async () => {
    const setIsOpen = vi.fn();
    const save = deferredSave();
    const view = renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={setIsOpen}
        onSuccess={save.onSuccess}
        initialData={savableData}
      />,
    );

    fireEvent.click(screen.getByText("Save incident"));
    await waitFor(() => expect(save.onSuccess).toHaveBeenCalledTimes(1));

    // The page closes the drawer and the user opens a new draft before the
    // first save settles.
    const props = { setIsOpen, onSuccess: save.onSuccess, initialData: savableData };
    view.rerender(<SideDrawerIncident isOpen={false} {...props} />);
    view.rerender(<SideDrawerIncident isOpen={true} {...props} />);

    await act(async () => save.resolve());
    expect(setIsOpen).not.toHaveBeenCalled();
    // The new draft is not stuck in a saving state.
    expect(screen.getByText("Cancel").closest("button")).not.toBeDisabled();
  });

  const legacyShortDescription = {
    ...savableData,
    description: "abc",
  } as unknown as NewIncidentFormValues;

  it("does not re-validate an unchanged description in edit mode", async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={vi.fn()}
        onSuccess={onSuccess}
        initialData={legacyShortDescription}
        isEdit
      />,
    );

    fireEvent.click(screen.getByText("Update incident"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("validates the same short description when creating", () => {
    const onSuccess = vi.fn();
    renderWithProviders(
      <SideDrawerIncident
        isOpen={true}
        setIsOpen={vi.fn()}
        onSuccess={onSuccess}
        initialData={legacyShortDescription}
      />,
    );

    // Field is mocked here, so the inline message itself is covered by the
    // validator tests; this checks the submit is blocked.
    fireEvent.click(screen.getByText("Save incident"));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("keeps the user's edits when the parent re-renders after a failed save", async () => {
    const onSuccess = vi.fn().mockRejectedValue(new Error("400"));
    const props = { isOpen: true, setIsOpen: vi.fn(), onSuccess, isEdit: true, incidentId: 42 };
    const view = renderWithProviders(<SideDrawerIncident {...props} initialData={savableData} />);

    fireEvent.change(screen.getByTestId("field-description"), {
      target: { value: "Edited description text" },
    });
    fireEvent.click(screen.getByText("Update incident"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    // The page re-renders (for example to show the error toast) and passes a
    // new, equal initialData object for the same incident.
    view.rerender(<SideDrawerIncident {...props} initialData={{ ...savableData }} />);

    expect(screen.getByTestId("field-description")).toHaveValue("Edited description text");
  });

  it("re-seeds the form when a different incident is loaded", () => {
    const props = { isOpen: true, setIsOpen: vi.fn(), isEdit: true };
    const view = renderWithProviders(
      <SideDrawerIncident {...props} incidentId={42} initialData={savableData} />,
    );
    const other = {
      ...savableData,
      description: "A different incident entirely.",
    } as unknown as NewIncidentFormValues;
    view.rerender(<SideDrawerIncident {...props} incidentId={43} initialData={other} />);

    expect(screen.getByTestId("field-description")).toHaveValue("A different incident entirely.");
  });
});
