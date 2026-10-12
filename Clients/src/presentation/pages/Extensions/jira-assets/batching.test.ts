import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  deselectDone,
  finishImport,
  IMPORT_INTERRUPTED_MESSAGE,
  IMPORT_PARTLY_FAILED_MESSAGE,
  IMPORTED_BEFORE_STOP_LABEL,
  IMPORTED_LABEL,
  importInBatches,
  NOT_IMPORTED_LABEL,
  REMOVAL_INTERRUPTED_PARTIAL_MESSAGE,
  REMOVAL_PARTLY_SKIPPED_MESSAGE,
  REMOVED_BEFORE_STOP_LABEL,
  REMOVED_LABEL,
  removeInBatches,
  SKIPPED_LABEL,
  UNLINKED_LABEL,
  runInBatches,
} from "./batching";
import { REMOVAL_INTERRUPTED_MESSAGE, SYNC_RUNNING_MESSAGE } from "./runOutcome";

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));
const nums = (n: number, from = 1) => ids(n, from).map(Number);
const conflict = (data: unknown) =>
  Object.assign(new Error("Conflict"), { status: 409, response: { data } });
const ok = (batch: string[], extra: Record<string, unknown> = {}) => ({
  success: true,
  imported: batch.length,
  ...extra,
});

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
    expect(run.error).toBeUndefined();
    expect(run.done.map((d) => d.result)).toEqual([100, 100, 50]);
  });

  it("stops at the first error", async () => {
    const boom = new Error("boom");
    const send = vi
      .fn<(batch: string[]) => Promise<number>>()
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(boom);

    const run = await runInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(run.done).toHaveLength(1);
    expect(run.error).toBe(boom);
  });
});

describe("importInBatches", () => {
  it("adds up every batch and deselects everything on full success", async () => {
    const send = vi.fn(async (batch: string[]) => ok(batch));

    const summary = await importInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      type: "success",
      counts: [{ label: IMPORTED_LABEL, value: 250 }],
    });
    expect(summary.doneIds).toHaveLength(250);
  });

  it("does not call it finished when a batch reports 80 of 100 objects failed", async () => {
    const failedIds = ids(80, 21); // "21".."100"
    const send = vi
      .fn<(batch: string[]) => Promise<any>>()
      .mockResolvedValueOnce({
        success: true,
        imported: 20,
        errors: failedIds.map((id) => `Failed to import ${id}: boom`),
        failed_ids: failedIds,
      })
      .mockImplementation(async (batch: string[]) => ok(batch));

    const summary = await importInBatches(ids(150), send);

    expect(summary.type).toBe("warning");
    expect(summary.text).toBe(IMPORT_PARTLY_FAILED_MESSAGE);
    expect(summary.counts).toEqual([
      { label: IMPORTED_LABEL, value: 70 },
      { label: NOT_IMPORTED_LABEL, value: 80 },
    ]);
    // The 80 failed ids stay selected; the 20 imported and the 50 of batch 2 leave.
    expect(summary.doneIds).toEqual([...ids(20), ...ids(50, 101)]);
  });

  it("keeps a batch selected when it reports errors without ids", async () => {
    const send = vi.fn(async () => ({ success: true, imported: 99, errors: ["Failed: x"] }));

    const summary = await importInBatches(ids(100), send);

    expect(summary.type).toBe("warning");
    expect(summary.doneIds).toEqual([]);
  });

  it("stops on a 409 mid-way, says a sync is running, keeps unsent ids selected", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<any>>()
      .mockImplementationOnce(async (batch) => ok(batch))
      .mockRejectedValueOnce(conflict("A Jira Assets sync is already running"));

    const summary = await importInBatches(ids(250), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      type: "error",
      text: SYNC_RUNNING_MESSAGE,
      counts: [{ label: IMPORTED_BEFORE_STOP_LABEL, value: 100 }],
    });
    expect(summary.doneIds).toEqual(ids(100));
  });

  it("counts what an interrupted batch imported, but keeps that batch selected", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<any>>()
      .mockImplementationOnce(async (batch) => ok(batch))
      .mockRejectedValueOnce(conflict({ code: "import_interrupted", imported: 30, skipped: 0 }));

    const summary = await importInBatches(ids(250), send);

    expect(summary).toMatchObject({
      type: "error",
      text: IMPORT_INTERRUPTED_MESSAGE,
      counts: [{ label: IMPORTED_BEFORE_STOP_LABEL, value: 130 }],
    });
    expect(summary.doneIds).toEqual(ids(100));
  });

  it("treats a response without success as a failure and stops", async () => {
    const send = vi.fn(async () => ({ success: false, error: "Nope" }));

    const summary = await importInBatches(ids(150), send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ type: "error", text: "Nope", doneIds: [] });
  });
});

describe("removeInBatches", () => {
  it("does not call it finished when the server skipped some; keeps the skipped selected", async () => {
    const send = vi.fn(async () => ({ removed: 2, unlinked: 0, skipped: 1, skipped_ids: [3] }));

    const summary = await removeInBatches([1, 2, 3], send);

    expect(summary).toEqual({
      type: "warning",
      text: REMOVAL_PARTLY_SKIPPED_MESSAGE,
      counts: [
        { label: REMOVED_LABEL, value: 2 },
        { label: SKIPPED_LABEL, value: 1 },
      ],
      doneIds: [1, 2],
    });
    expect(deselectDone(new Set([1, 2, 3]), summary.doneIds)).toEqual(new Set([3]));
  });

  it("reports links cleaned up separately from use cases removed", async () => {
    const send = vi.fn(async () => ({ removed: 1, unlinked: 1, skipped: 0, skipped_ids: [] }));

    const summary = await removeInBatches([1, 2], send);

    expect(summary).toMatchObject({
      type: "success",
      counts: [
        { label: REMOVED_LABEL, value: 1 },
        { label: UNLINKED_LABEL, value: 1 },
      ],
      doneIds: [1, 2],
    });
  });

  it("stops at an error on the 2nd batch, reports the 100 removed, deselects only those", async () => {
    const send = vi
      .fn<(batch: number[]) => Promise<{ removed: number; skipped_ids: number[] }>>()
      .mockResolvedValueOnce({ removed: 100, skipped_ids: [] })
      .mockRejectedValueOnce(
        conflict({ code: "removal_interrupted", message: REMOVAL_INTERRUPTED_MESSAGE }),
      );

    const summary = await removeInBatches(nums(250), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      type: "error",
      text: REMOVAL_INTERRUPTED_PARTIAL_MESSAGE,
      counts: [{ label: REMOVED_BEFORE_STOP_LABEL, value: 100 }],
      doneIds: nums(100),
    });
    expect(deselectDone(new Set(nums(250)), summary.doneIds)).toEqual(new Set(nums(150, 101)));
  });

  it("keeps the server's 'nothing was removed' when the first batch is interrupted", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        conflict({ code: "removal_interrupted", message: REMOVAL_INTERRUPTED_MESSAGE }),
      );

    const summary = await removeInBatches([1, 2], send);

    expect(summary).toMatchObject({ text: REMOVAL_INTERRUPTED_MESSAGE, doneIds: [] });
  });

  it("says a sync is running on a plain 409", async () => {
    const send = vi.fn().mockRejectedValueOnce(conflict("busy"));

    const summary = await removeInBatches([1, 2], send);

    expect(summary).toMatchObject({ type: "error", text: SYNC_RUNNING_MESSAGE });
  });
});

describe("finishImport (the panel's state after an import)", () => {
  const picker = (list: string[]) => list.map((id) => ({ id, key: `K-${id}` }));

  it("interrupted batch, 30 of 50 imported: only the 20 still shown stay selected", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<any>>()
      .mockRejectedValueOnce(conflict({ code: "import_interrupted", imported: 30 }));
    const summary = await importInBatches(ids(50), send);

    // Fresh /use-cases after the import: objects 1..30 are imported now.
    const next = finishImport(
      { objects: picker(ids(50)), selected: new Set(ids(50)) },
      summary,
      new Set(ids(30)),
    );

    expect(next.objects.map((o) => o.id)).toEqual(ids(20, 31));
    expect(next.selected).toEqual(new Set(ids(20, 31)));
    // The "Import N selected" count matches what the user can see.
    expect(next.selected.size).toBe(next.objects.length);
    expect(next.message).toEqual({
      type: "error",
      text: IMPORT_INTERRUPTED_MESSAGE,
      counts: [{ label: IMPORTED_BEFORE_STOP_LABEL, value: 30 }],
    });
  });

  it("250 ids, batch 2 interrupted: selected = unhandled of batch 2 + the unsent batch", async () => {
    const send = vi
      .fn<(batch: string[]) => Promise<any>>()
      .mockImplementationOnce(async (batch) => ok(batch))
      .mockRejectedValueOnce(conflict({ code: "import_interrupted", imported: 40 }));
    const summary = await importInBatches(ids(250), send);
    expect(send).toHaveBeenCalledTimes(2);

    // Batch 1 (1..100) and the first 40 of batch 2 (101..140) are imported.
    const next = finishImport(
      { objects: picker(ids(250)), selected: new Set(ids(250)) },
      summary,
      new Set(ids(140)),
    );

    expect(next.selected).toEqual(new Set([...ids(60, 141), ...ids(50, 201)]));
    expect(next.selected.size).toBe(next.objects.length);
    expect(next.message.counts).toEqual([{ label: IMPORTED_BEFORE_STOP_LABEL, value: 140 }]);
  });

  it("a batch kept whole (errors without ids) keeps only its failed objects selected", async () => {
    const send = vi.fn(async () => ({ success: true, imported: 3, errors: ["Failed: x"] }));
    const summary = await importInBatches(ids(4), send);

    const next = finishImport(
      { objects: picker(ids(4)), selected: new Set(ids(4)) },
      summary,
      new Set(["1", "2", "3"]),
    );

    expect(next.selected).toEqual(new Set(["4"]));
    expect(next.objects.map((o) => o.id)).toEqual(["4"]);
  });

  it("never keeps an id selected that is not in the picker", () => {
    const summary = { type: "success" as const, text: "", counts: [], doneIds: [] };

    const next = finishImport(
      { objects: picker(["1", "2"]), selected: new Set(["1", "2", "99"]) },
      summary,
      new Set<string>(),
    );

    expect(next.selected).toEqual(new Set(["1", "2"]));
  });

  it("leaves the picker alone when the fresh list could not be read", () => {
    const summary = { type: "success" as const, text: "", counts: [], doneIds: ["1"] };

    const next = finishImport(
      { objects: picker(["1", "2"]), selected: new Set(["1", "2"]) },
      summary,
      null,
    );

    expect(next.objects.map((o) => o.id)).toEqual(["1", "2"]);
    expect(next.selected).toEqual(new Set(["2"]));
  });
});
