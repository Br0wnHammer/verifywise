import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import { VisibilityEditor, operatorLabel, visibilitySummary } from "../VisibilityEditor";
import type { FormField } from "../types";

const PERSONAL: FormField = {
  id: "personal",
  type: "select",
  label: "Personal data?",
  order: 0,
  options: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
};

describe("VisibilityEditor", () => {
  it("adds a condition on the first earlier field with its first operator and option", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <VisibilityEditor visibility={undefined} earlierFields={[PERSONAL]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    expect(onChange).toHaveBeenCalledWith({
      match: "all",
      conditions: [{ fieldId: "personal", operator: "equals", value: "yes" }],
    });
  });

  it("clears the rules when the last condition is removed", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <VisibilityEditor
        visibility={{
          match: "all",
          conditions: [{ fieldId: "personal", operator: "equals", value: "yes" }],
        }}
        earlierFields={[PERSONAL]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove condition" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("explains when there is no earlier field to depend on", () => {
    renderWithProviders(
      <VisibilityEditor visibility={undefined} earlierFields={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Add a field above this one to create a rule")).toBeInTheDocument();
  });

  it("words operators for authors", () => {
    expect(operatorLabel("multiselect", "equals")).toBe("includes");
    expect(operatorLabel("select", "not_equals")).toBe("is not");
    expect(operatorLabel("number", "gte")).toBe("≥");
  });

  it("summarises the rules", () => {
    expect(visibilitySummary(undefined)).toBe("Always shown");
    expect(
      visibilitySummary({ match: "any", conditions: [{ fieldId: "a", operator: "is_empty" }] }),
    ).toBe("Shown when any condition matches");
  });
});
