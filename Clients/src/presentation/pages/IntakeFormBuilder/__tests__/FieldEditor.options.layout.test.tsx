import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import { FieldEditor } from "../FieldEditor";
import { IntakeEntityType } from "../../../../domain/intake/enums";
import type { FormField } from "../types";

// The settings panel is 325px wide while the shared Field enforces
// min-width: 220px, so option rows must opt out via minWidth: 0 to fit.
const SELECT_FIELD: FormField = {
  id: "sector",
  type: "select",
  label: "Sector",
  order: 0,
  options: [
    { label: "Option 1", value: "option1" },
    { label: "Option 2", value: "option2" },
  ],
};

const MULTISELECT_FIELD: FormField = {
  ...SELECT_FIELD,
  id: "regions",
  type: "multiselect",
  label: "Regions",
};

function expectShrinkableOptionRow(index: number) {
  for (const inputId of [`option-label-${index}`, `option-value-${index}`]) {
    const input = document.getElementById(inputId);
    expect(input, `${inputId} should render`).not.toBeNull();
    const fieldRoot = input!.closest(".field");
    expect(fieldRoot, `${inputId} should sit inside a Field root`).not.toBeNull();
    expect(getComputedStyle(fieldRoot!).minWidth).toBe("0px");
    const wrapper = fieldRoot!.parentElement!;
    expect(getComputedStyle(wrapper).minWidth).toBe("0px");
    expect(getComputedStyle(wrapper).flexGrow).toBe("1");
  }
}

describe("FieldEditor options layout", () => {
  it("lets dropdown option label/value inputs shrink below the Field min-width", () => {
    renderWithProviders(
      <FieldEditor
        field={SELECT_FIELD}
        allFields={[SELECT_FIELD]}
        entityType={IntakeEntityType.USE_CASE}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expectShrinkableOptionRow(0);
    expectShrinkableOptionRow(1);
    expect(screen.getByRole("button", { name: /Add option/ })).toBeInTheDocument();
  });

  it("lets multi-select option label/value inputs shrink below the Field min-width", () => {
    renderWithProviders(
      <FieldEditor
        field={MULTISELECT_FIELD}
        allFields={[MULTISELECT_FIELD]}
        entityType={IntakeEntityType.USE_CASE}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expectShrinkableOptionRow(0);
    expect(screen.getByRole("button", { name: /Add option/ })).toBeInTheDocument();
  });
});
