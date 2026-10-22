import { useState } from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import RoutingSettingsSection, { getRoutingErrors } from "../routing/RoutingSettingsSection";
import type { FormRouting } from "../types";

const reviewers = [
  { _id: 1, name: "Ada Lovelace", email: "ada@example.com" },
  { _id: 2, name: "Grace Hopper", email: "grace@example.com" },
];

let latest: FormRouting | null = null;

const Harness = ({ initial = null }: { initial?: FormRouting | null }) => {
  const [value, setValue] = useState<FormRouting | null>(initial);
  latest = value;
  return <RoutingSettingsSection value={value} onChange={setValue} reviewers={reviewers} />;
};

const on = (patch: Partial<FormRouting> = {}): FormRouting => ({
  enabled: true,
  seniorReviewerIds: [1],
  standardReviewerIds: [2],
  threshold: 50,
  closeCallMargin: 10,
  secondReviewRate: 10,
  ...patch,
});

describe("RoutingSettingsSection", () => {
  it("is off by default and hides the fields", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByText("Route by risk score")).toBeInTheDocument();
    expect(screen.queryByLabelText("Threshold")).not.toBeInTheDocument();
    expect(screen.queryByText("Senior reviewers")).not.toBeInTheDocument();
  });

  it("shows the fields with 50, 10 and 10 when turned on", () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("Route by risk score"));
    expect(screen.getByLabelText("Threshold")).toHaveValue(50);
    expect(screen.getByLabelText("Close-call margin")).toHaveValue(10);
    expect(screen.getByLabelText("Second review share %")).toHaveValue(10);
    expect(screen.getByText("Senior reviewers")).toBeInTheDocument();
    expect(screen.getByText("Standard reviewers")).toBeInTheDocument();
  });

  it("asks for at least one senior and one standard reviewer when on with none", () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("Route by risk score"));
    expect(screen.getByText("Pick at least one senior reviewer")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one standard reviewer")).toBeInTheDocument();
  });

  it("flags a threshold of 0", () => {
    renderWithProviders(<Harness initial={on()} />);
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "0" } });
    expect(screen.getByText("Use a number from 1 to 99")).toBeInTheDocument();
  });

  it("flags a cleared margin instead of treating it as zero", () => {
    renderWithProviders(<Harness initial={on()} />);
    fireEvent.change(screen.getByLabelText("Close-call margin"), { target: { value: "" } });
    expect(screen.getByText("Use a number from 0 to 25")).toBeInTheDocument();
  });

  it("updates the helper line when the threshold changes", () => {
    renderWithProviders(<Harness initial={on()} />);
    expect(screen.getByTestId("routing-helper")).toHaveTextContent(
      "Scores of 50 or more, prohibited practices and scores within 10 points of 50 go to senior reviewers.",
    );
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "60" } });
    expect(screen.getByTestId("routing-helper")).toHaveTextContent(
      "Scores of 60 or more, prohibited practices and scores within 10 points of 60 go to senior reviewers.",
    );
  });

  it("shows no errors for valid settings", () => {
    renderWithProviders(<Harness initial={on()} />);
    expect(screen.queryByText(/Use a number from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick at least one/)).not.toBeInTheDocument();
  });

  it("resets a cleared number to its default when routing is turned off", () => {
    renderWithProviders(<Harness initial={on()} />);
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "" } });
    expect(screen.getByText("Use a number from 1 to 99")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Route by risk score"));
    expect(latest?.enabled).toBe(false);
    expect(latest?.threshold).toBe(50);
    expect(getRoutingErrors(latest)).toEqual({});
  });

  it("reports out-of-range numbers even while routing is off, so a save is blocked", () => {
    expect(getRoutingErrors(on({ enabled: false, threshold: 0 }))).toEqual({
      threshold: "Use a number from 1 to 99",
    });
    expect(getRoutingErrors(on({ enabled: false, seniorReviewerIds: [] }))).toEqual({});
  });

  it("renders the helper line as separate text fragments", () => {
    renderWithProviders(<Harness initial={on()} />);
    expect(screen.getByText("Scores of")).toBeInTheDocument();
    expect(screen.getByText("points of")).toBeInTheDocument();
    expect(screen.getByText("go to senior reviewers.")).toBeInTheDocument();
  });
});
