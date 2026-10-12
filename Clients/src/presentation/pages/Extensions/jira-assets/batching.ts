/**
 * Import and missing-use-case removal send at most BATCH_SIZE ids per request
 * (the server's IMPORT_MAX_OBJECTS / REMOVE_MISSING_MAX_IDS). A bigger
 * selection is sent as sequential batches; the first error stops the rest.
 *
 * Messages are static sentences with the counts kept apart, so the DOM
 * translation layer can translate them.
 */
import { getApiErrorReason } from "../../../../application/utils/apiErrorReason";
import { RUN_CODES, SYNC_RUNNING_MESSAGE, REMOVAL_INTERRUPTED_MESSAGE } from "./runOutcome";

/** Most ids one request may carry; matches the server limit. */
export const BATCH_SIZE = 100;

export interface BatchProgress {
  /** 1-based position of the first item in the batch being sent. */
  from: number;
  /** 1-based position of its last item. */
  to: number;
  total: number;
}

export interface BatchRun<T, R> {
  /** The batches that succeeded, with what the server answered for each. */
  done: Array<{ batch: T[]; result: R }>;
  /** The error that stopped the run, if any. */
  error?: unknown;
}

/** Send `items` in batches of `size`, one request at a time, stopping at the first error. */
export async function runInBatches<T, R>(
  items: T[],
  send: (batch: T[]) => Promise<R>,
  onProgress?: (progress: BatchProgress) => void,
  size: number = BATCH_SIZE,
): Promise<BatchRun<T, R>> {
  const done: BatchRun<T, R>["done"] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    onProgress?.({ from: start + 1, to: start + batch.length, total: items.length });
    try {
      done.push({ batch, result: await send(batch) });
    } catch (error) {
      return { done, error };
    }
  }
  return { done };
}

/** A count shown after a message, with its own label. */
export interface MessageCount {
  label: string;
  value: number;
}

/** What the panel shows when a batched run ends, and which ids to deselect. */
export interface BatchSummary<T> {
  type: "success" | "warning" | "error";
  text: string;
  counts: MessageCount[];
  /**
   * Ids that were handled (imported, already imported, removed, or no longer
   * flagged) and leave the selection. Unsent and failed ids stay selected,
   * so a retry is one click.
   */
  doneIds: T[];
}

export const IMPORT_FINISHED_MESSAGE = "Import finished.";
export const IMPORT_PARTLY_FAILED_MESSAGE =
  "Import finished, but some objects could not be imported. They are still selected; import again to retry.";
export const IMPORTED_LABEL = "Objects imported:";
export const NOT_IMPORTED_LABEL = "Objects not imported:";
export const IMPORTED_BEFORE_STOP_LABEL = "Objects imported before it stopped:";
export const IMPORT_INTERRUPTED_MESSAGE =
  "The import was interrupted because another sync took over.";
export const IMPORT_FAILED_MESSAGE = "The import failed.";

export const REMOVAL_FINISHED_MESSAGE = "Missing use cases removed.";
export const REMOVED_LABEL = "Use cases removed:";
export const REMOVED_BEFORE_STOP_LABEL = "Use cases removed before it stopped:";
export const UNLINKED_LABEL = "Links cleaned up:";
export const SKIPPED_LABEL = "Use cases skipped:";
export const REMOVAL_PARTLY_SKIPPED_MESSAGE =
  "Removal finished, but some use cases were not removed. They are still selected.";
export const REMOVAL_FAILED_MESSAGE = "Failed to remove use cases";
/** An interrupted batch after earlier batches removed some ("nothing was removed" would mislead). */
export const REMOVAL_INTERRUPTED_PARTIAL_MESSAGE =
  "The removal was interrupted before it finished. Try again for the rest.";

type ApiError = { status?: number; message?: string; response?: { data?: any } };

/**
 * The one classification of the error that stopped a run. "interrupted" is a
 * 409 whose code says this run lost its claim part-way; any other 409 means a
 * sync (or another run) is going.
 */
function classifyStop(
  error: unknown,
  interruptedCode: string,
): { kind: "interrupted" | "sync_running" | "failed"; error: ApiError } {
  const e = error as ApiError;
  if (e?.status === 409) {
    return {
      kind: e.response?.data?.code === interruptedCode ? "interrupted" : "sync_running",
      error: e,
    };
  }
  return { kind: "failed", error: e };
}

interface ImportResponse {
  success?: boolean;
  imported?: number;
  errors?: string[];
  failed_ids?: string[];
  error?: string;
}

/** Import `ids` in batches through `send` (POST /import with one batch). */
export async function importInBatches(
  ids: string[],
  send: (batch: string[]) => Promise<ImportResponse>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary<string>> {
  const run = await runInBatches(
    ids,
    async (batch) => {
      const response = await send(batch);
      // A response without success is a failure too; stop there.
      if (!response?.success) throw new Error(response?.error || IMPORT_FAILED_MESSAGE);
      return response;
    },
    onProgress,
  );

  let imported = 0;
  let failed = 0;
  const doneIds: string[] = [];
  for (const { batch, result } of run.done) {
    imported += result.imported ?? 0;
    const failedIds = new Set(result.failed_ids ?? []);
    const errorCount = result.errors?.length ?? 0;
    failed += Math.max(failedIds.size, errorCount);
    // Without per-object ids the failed ones cannot be told apart: keep the
    // whole batch here. finishImport then drops the ones that were imported
    // (they leave the picker), so only the failed ones stay selected.
    if (failedIds.size === 0 && errorCount > 0) continue;
    doneIds.push(...batch.filter((id) => !failedIds.has(id)));
  }

  if (!run.error) {
    const counts = [{ label: IMPORTED_LABEL, value: imported }];
    if (failed > 0) counts.push({ label: NOT_IMPORTED_LABEL, value: failed });
    return {
      type: failed > 0 ? "warning" : "success",
      text: failed > 0 ? IMPORT_PARTLY_FAILED_MESSAGE : IMPORT_FINISHED_MESSAGE,
      counts,
      doneIds,
    };
  }

  const stop = classifyStop(run.error, RUN_CODES.importInterrupted);
  if (stop.kind === "interrupted") {
    // The interrupted batch imported some objects before it stopped; which
    // ones is unknown, so its ids stay selected (a retry skips them).
    const partial = stop.error.response?.data?.imported;
    if (typeof partial === "number") imported += partial;
  }
  const counts = [{ label: IMPORTED_BEFORE_STOP_LABEL, value: imported }];
  if (failed > 0) counts.push({ label: NOT_IMPORTED_LABEL, value: failed });
  return {
    type: "error",
    text:
      stop.kind === "interrupted"
        ? IMPORT_INTERRUPTED_MESSAGE
        : stop.kind === "sync_running"
          ? SYNC_RUNNING_MESSAGE
          : getApiErrorReason(stop.error) || stop.error?.message || IMPORT_FAILED_MESSAGE,
    counts,
    doneIds,
  };
}

interface RemoveResponse {
  removed?: number;
  /** Links whose project is not in this organization; only the link was deleted. */
  unlinked?: number;
  /** Ids the server did not remove (no longer flagged, or not found). */
  skipped_ids?: number[];
}

/** Remove the use cases `ids` in batches through `send` (POST /use-cases/remove-missing). */
export async function removeInBatches(
  ids: number[],
  send: (batch: number[]) => Promise<RemoveResponse>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary<number>> {
  const run = await runInBatches(ids, send, onProgress);
  let removed = 0;
  let unlinked = 0;
  let skipped = 0;
  const doneIds: number[] = [];
  for (const { batch, result } of run.done) {
    removed += result?.removed ?? 0;
    unlinked += result?.unlinked ?? 0;
    const skippedIds = new Set(result?.skipped_ids ?? []);
    skipped += skippedIds.size;
    // Skipped ids stay selected; only what the server handled leaves.
    doneIds.push(...batch.filter((id) => !skippedIds.has(id)));
  }
  const extraCounts = [
    ...(unlinked > 0 ? [{ label: UNLINKED_LABEL, value: unlinked }] : []),
    ...(skipped > 0 ? [{ label: SKIPPED_LABEL, value: skipped }] : []),
  ];
  if (!run.error) {
    return {
      type: skipped > 0 ? "warning" : "success",
      text: skipped > 0 ? REMOVAL_PARTLY_SKIPPED_MESSAGE : REMOVAL_FINISHED_MESSAGE,
      counts: [{ label: REMOVED_LABEL, value: removed }, ...extraCounts],
      doneIds,
    };
  }
  const stop = classifyStop(run.error, RUN_CODES.removalInterrupted);
  const text =
    stop.kind === "interrupted"
      ? removed + unlinked > 0
        ? REMOVAL_INTERRUPTED_PARTIAL_MESSAGE
        : stop.error.response?.data?.message || REMOVAL_INTERRUPTED_MESSAGE
      : stop.kind === "sync_running"
        ? SYNC_RUNNING_MESSAGE
        : getApiErrorReason(stop.error) || stop.error?.message || REMOVAL_FAILED_MESSAGE;
  return {
    type: "error",
    text,
    counts: [{ label: REMOVED_BEFORE_STOP_LABEL, value: removed }, ...extraCounts],
    doneIds,
  };
}

/** A panel message: text plus labelled counts. */
export interface PanelMessage {
  type: "success" | "warning" | "error";
  text: string;
  counts?: MessageCount[];
}

/** The summary as a panel message. */
export function summaryMessage<T>(summary: BatchSummary<T>): PanelMessage {
  return { type: summary.type, text: summary.text, counts: summary.counts };
}

/** The selection without the ids a run handled; unsent and failed ids stay. */
export function deselectDone<T>(selected: Set<T>, doneIds: T[]): Set<T> {
  const done = new Set(doneIds);
  return new Set([...selected].filter((id) => !done.has(id)));
}

/**
 * The panel's state after an import, from the latest state, the summary and
 * the freshly loaded imported use cases (not the ones the import started
 * with). Imported objects leave the picker; the selection is then derived
 * from the objects that remain: an id stays selected only if it is still in
 * the picker and was not handled. So nothing selected is ever invisible, by
 * construction, including the ids of a batch kept whole (errors without ids,
 * or interrupted part-way) that did get imported. The handler applies this
 * once, after reloading, so no reload can clear the outcome.
 */
export function finishImport<O extends { id: string }>(
  state: { objects: O[]; selected: Set<string> },
  summary: BatchSummary<string>,
  importedObjectIds: Set<string> | null,
): { objects: O[]; selected: Set<string>; message: PanelMessage } {
  const imported = importedObjectIds ?? new Set<string>();
  const objects = state.objects.filter((obj) => !imported.has(obj.id));
  const shown = new Set(objects.map((obj) => obj.id));
  const notHandled = deselectDone(state.selected, summary.doneIds);
  return {
    objects,
    selected: new Set([...notHandled].filter((id) => shown.has(id))),
    message: summaryMessage(summary),
  };
}
