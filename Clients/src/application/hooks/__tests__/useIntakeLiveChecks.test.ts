import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { LiveCheckHint } from "../../../domain/types/intakeLiveChecks";

const postLiveChecks = vi.fn();
vi.mock("../../repository/intakeForm.repository", () => ({
  DEFAULT_RATE_LIMIT_PAUSE_SECONDS: 300,
  postLiveChecks: (...args: unknown[]) => postLiveChecks(...args),
}));
import { useIntakeLiveChecks } from "../useIntakeLiveChecks";
import type { FormSchema } from "../../repository/intakeForm.repository";

const schema = {
  version: "1",
  fields: [
    { id: "q1", type: "textarea", label: "Purpose", order: 1 },
    { id: "q2", type: "text", label: "Data", order: 2 },
  ],
} as unknown as FormSchema;
const ref = { publicId: "abc" };
const LONG = "We will score job applicants automatically using their CVs";

const aiHint = (id: string, questionId = "q1"): LiveCheckHint => ({
  id,
  kind: "vague",
  source: "ai",
  questionId,
  title: "t",
  text: "x",
});

type Props = { values: Record<string, unknown>; enabled?: boolean; aiAvailable?: boolean };
const setup = (initial: Props) =>
  renderHook(
    (p: Props) =>
      useIntakeLiveChecks({
        ref,
        schema,
        values: p.values,
        enabled: p.enabled ?? true,
        aiAvailable: p.aiAvailable ?? true,
      }),
    { initialProps: initial },
  );

const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useIntakeLiveChecks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postLiveChecks.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("shows rule hints with no network call for short answers", () => {
    const { result } = setup({ values: { q1: "facial recognition" } });
    expect(result.current.hints.some((h) => h.source === "rule")).toBe(true);
    expect(result.current.hintsFor("q1").length).toBeGreaterThan(0);
    expect(postLiveChecks).not.toHaveBeenCalled();
  });

  it("calls once, 2 s after the last keystroke and not before", async () => {
    postLiveChecks.mockResolvedValue({ aiAvailable: true, hints: [aiHint("a1")] });
    const { result, rerender } = setup({ values: { q1: LONG } });
    await flush(1500);
    rerender({ values: { q1: LONG + " now" } });
    await flush(1500);
    expect(postLiveChecks).not.toHaveBeenCalled();
    await flush(600);
    expect(postLiveChecks).toHaveBeenCalledTimes(1);
    expect(postLiveChecks.mock.calls[0][0]).toEqual(ref);
    expect(postLiveChecks.mock.calls[0][1]).toEqual({ q1: LONG + " now" });
    expect(result.current.hints.some((h) => h.id === "a1")).toBe(true);
  });

  it("does not call when every answer is under 20 chars", async () => {
    setup({ values: { q1: "short", q2: "tiny" } });
    await flush(5000);
    expect(postLiveChecks).not.toHaveBeenCalled();
  });

  it("does not call when AI is not available", async () => {
    setup({ values: { q1: LONG }, aiAvailable: false });
    await flush(5000);
    expect(postLiveChecks).not.toHaveBeenCalled();
  });

  it("returns no hints and makes no call when disabled", async () => {
    const { result } = setup({ values: { q1: "facial recognition " + LONG }, enabled: false });
    await flush(5000);
    expect(result.current.hints).toEqual([]);
    expect(postLiveChecks).not.toHaveBeenCalled();
  });

  it("drops a slower older response that arrives after a newer one", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    postLiveChecks
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce({ aiAvailable: true, hints: [aiHint("new")] });
    const { result, rerender } = setup({ values: { q1: LONG } });
    await flush(2100);
    rerender({ values: { q1: LONG + " more" } });
    await flush(2100);
    expect(postLiveChecks).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveOld({ aiAvailable: true, hints: [aiHint("old")] });
    });
    const ids = result.current.hints.map((h) => h.id);
    expect(ids).toContain("new");
    expect(ids).not.toContain("old");
  });

  it("marks AI hints stale while their answer is edited", async () => {
    postLiveChecks.mockResolvedValue({ aiAvailable: true, hints: [aiHint("a1")] });
    const { result, rerender } = setup({ values: { q1: LONG } });
    await flush(2100);
    expect(result.current.staleQuestionIds.size).toBe(0);
    rerender({ values: { q1: LONG + "!" } });
    expect(result.current.staleQuestionIds.has("q1")).toBe(true);
  });

  it("pauses AI after a 429 and suppresses calls", async () => {
    const { LiveCheckRequestError } = await vi.importActual<
      typeof import("../../repository/intakeForm.repository")
    >("../../repository/intakeForm.repository");
    postLiveChecks.mockRejectedValue(new LiveCheckRequestError("slow down", 429, 60));
    const { result, rerender } = setup({ values: { q1: LONG } });
    await flush(2100);
    expect(result.current.aiPaused).toBe(true);
    rerender({ values: { q1: LONG + " again" } });
    await flush(3000);
    expect(postLiveChecks).toHaveBeenCalledTimes(1);
    await flush(60_000);
    expect(result.current.aiPaused).toBe(false);
  });

  it("keeps rule and earlier AI hints on a network error", async () => {
    postLiveChecks.mockResolvedValueOnce({ aiAvailable: true, hints: [aiHint("a1")] });
    const { result, rerender } = setup({ values: { q1: "facial recognition " + LONG } });
    await flush(2100);
    postLiveChecks.mockRejectedValueOnce(new Error("offline"));
    rerender({ values: { q1: "facial recognition " + LONG + " x" } });
    await flush(2100);
    const ids = result.current.hints.map((h) => h.id);
    expect(ids).toContain("a1");
    expect(result.current.hints.some((h) => h.source === "rule")).toBe(true);
    expect(result.current.aiPaused).toBe(false);
  });
});
