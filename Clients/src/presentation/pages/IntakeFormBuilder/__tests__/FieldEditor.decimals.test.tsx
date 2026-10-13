import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import { FieldEditor } from "../FieldEditor";
import { IntakeEntityType } from "../../../../domain/intake/enums";
import type { FormField } from "../types";

const TOTAL: FormField = {
  id: "total",
  type: "calculated",
  label: "Total",
  order: 0,
  formula: "1",
  decimals: 2,
};

describe("FieldEditor decimals", () => {
  it("can be cleared while typing instead of snapping back to the default", () => {
    renderWithProviders(
      <FieldEditor
        field={TOTAL}
        allFields={[TOTAL]}
        entityType={IntakeEntityType.USE_CASE}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = document.getElementById("field-decimals") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "4" } });
    expect(input.value).toBe("4");
  });
});
