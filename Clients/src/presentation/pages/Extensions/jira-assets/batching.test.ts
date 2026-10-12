import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  IMPORT_INTERRUPTED_MESSAGE,
  IMPORTED_BEFORE_STOP_LABEL,
  importInBatches,
  REMOVAL_INTERRUPTED_PARTIAL_MESSAGE,
  REMOVED_BEFORE_STOP_LABEL,
  removeInBatches,
  runInBatches,
} from "./batching";
import { SYNC_RUNNING_MESSAGE, REMOVAL_INTERRUPTED_MESSAGE } from "./runOutcome";

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
const conflict = (data: unknown) =>
  Object.assign(new Error("Conflict"), { status: 409, response: { data } });

describe("runInBatches", () => {
  it("sends 250 items as 3 sequential requests of up to 100, reporting progress", async () => {
    const send = vi.fn(async (batch: string[]) => batch.length);
    const progress = vi.fn();

    const run = await runInBatches(ids(250), send, progress);

    expect(BATCH_SIZE).toBe(100);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);
    expect(send.mock.calls[1][0][0]).toBe("101");
    expect(progress.mock.calls.map(([p]) => p)).toEqual([
      { from: 1, to: 100, total: 250 },
      { from: 101, to: 200, total: 250 },
      { from: 201, to: 250, total: 250 },
    ]);
    expect(run).toEqual({ results: [100, 100, 50], processed: 250 });
  });

  it("stops at the first error and reports how many were done", async () => {
    const boom = new Error("boom");
    const send = vi
      .fn<(batch: string[]) => Promise<number>>()
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(boom);

    const run = await runInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(run).toEqual({ results: [100], processed: 100, error: boom });
  });

  it("sends nothing for an empty list", async () => {
    const send = vi.fn();
    expect(await runInBatches([], send)).toEqual({ results: [], processed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("importInBatches", () => {
  it("adds up what every batch imported", async () => {
    const send = vi.fn(async (batch: string[]) => ({ success: true, imported: batch.length - 1 }));

    const summary = await importInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ type: "success", count: { value: 247 }, syncRunning: false });
  });

  it("stops on a 409 mid-way and says a sync is running, with what was imported", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<{ success: boolean; imported: number }>>()
      .mockResolvedValueOnce({ success: true, imported: 100 })
      .mockRejectedValueOnce(conflict("A Jira Assets sync is already running"));

    const summary = await importInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      type: "error",
      text: SYNC_RUNNING_MESSAGE,
      count: { label: IMPORTED_BEFORE_STOP_LABEL, value: 100 },
      syncRunning: true,
    });
  });

  it("counts the objects an interrupted batch imported before it stopped", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<{ success: boolean; imported: number }>>()
      .mockResolvedValueOnce({ success: true, imported: 100 })
      .mockRejectedValueOnce(conflict({ code: "import_interrupted", imported: 30, skipped: 0 }));

    const summary = await importInBatches(ids(250), send);

    expect(summary).toMatchObject({
      text: IMPORT_INTERRUPTED_MESSAGE,
      count: { value: 130 },
      syncRunning: false,
    });
  });

  it("treats a response without success as a failure and stops", async () => {
    const send = vi.fn(async () => ({ success: false, error: "Nope" }));

    const summary = await importInBatches(ids(150), send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ type: "error", text: "Nope", count: { value: 0 } });
  });
});

describe("removeInBatches", () => {
  it("adds up what every batch removed", async () => {
    const send = vi.fn(async (batch: number[]) => ({ removed: batch.length }));

    const summary = await removeInBatches(ids(250).map(Number), send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ type: "success", count: { value: 250 } });
  });

  it("stops at an error on the 2nd batch and reports the 100 removed", async () => {
    const send = vi
      .fn<(batch: number[]) => Promise<{ removed: number }>>()
      .mockResolvedValueOnce({ removed: 100 })
      .mockRejectedValueOnce(
        conflict({ code: "removal_interrupted", message: REMOVAL_INTERRUPTED_MESSAGE }),
      );

    const summary = await removeInBatches(ids(250).map(Number), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      type: "error",
      text: REMOVAL_INTERRUPTED_PARTIAL_MESSAGE,
      count: { label: REMOVED_BEFORE_STOP_LABEL, value: 100 },
      syncRunning: false,
    });
  });

  it("keeps the server's 'nothing was removed' when the first batch is interrupted", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        conflict({ code: "removal_interrupted", message: REMOVAL_INTERRUPTED_MESSAGE }),
      );

    const summary = await removeInBatches([1, 2], send);

    expect(summary).toMatchObject({ text: REMOVAL_INTERRUPTED_MESSAGE, count: { value: 0 } });
  });

  it("says a sync is running on a plain 409", async () => {
    const send = vi.fn().mockRejectedValueOnce(conflict("busy"));

    const summary = await removeInBatches([1, 2], send);

    expect(summary).toMatchObject({ text: SYNC_RUNNING_MESSAGE, syncRunning: true });
  });
});
