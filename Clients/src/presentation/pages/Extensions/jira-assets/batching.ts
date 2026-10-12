/**
 * Import and missing-use-case removal send at most BATCH_SIZE ids per request
 * (the server's IMPORT_MAX_OBJECTS / REMOVE_MISSING_MAX_IDS). A bigger
 * selection is sent as sequential batches; the first error stops the rest.
 *
 * Messages are static sentences with the counts kept apart, so the DOM
 * translation layer can translate them.
 */
import { getApiErrorReason } from "../../../../application/utils/apiErrorReason";
import {
  isImportInterrupted,
  removalConflictText,
  RUN_CODES,
  SYNC_RUNNING_MESSAGE,
} from "./runOutcome";

/** Most ids one request may carry; matches the server limit. */
export const BATCH_SIZE = 100;

export interface BatchProgress {
  /** 1-based position of the first item in the batch being sent. */
  from: number;
  /** 1-based position of its last item. */
  to: number;
  total: number;
}

export interface BatchRun<R> {
  results: R[];
  /** Items in the batches that succeeded. */
  processed: number;
  /** The error that stopped the run, if any. */
  error?: unknown;
}

/** Send `items` in batches of `size`, one request at a time, stopping at the first error. */
export async function runInBatches<T, R>(
  items: T[],
  send: (batch: T[]) => Promise<R>,
  onProgress?: (progress: BatchProgress) => void,
  size: number = BATCH_SIZE,
): Promise<BatchRun<R>> {
  const results: R[] = [];
  let processed = 0;
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    onProgress?.({ from: start + 1, to: start + batch.length, total: items.length });
    try {
      results.push(await send(batch));
    } catch (error) {
      return { results, processed, error };
    }
    processed += batch.length;
  }
  return { results, processed };
}

/** What the panel shows when a batched run ends. */
export interface BatchSummary {
  type: "success" | "error";
  text: string;
  /** A count shown after the text, with its own label. */
  count?: { label: string; value: number };
  /** True when the server reported a running sync (409). */
  syncRunning: boolean;
}

export const IMPORT_FINISHED_MESSAGE = "Import finished.";
export const IMPORTED_LABEL = "Objects imported:";
export const IMPORTED_BEFORE_STOP_LABEL = "Objects imported before it stopped:";
export const IMPORT_INTERRUPTED_MESSAGE =
  "The import was interrupted because another sync took over.";
export const IMPORT_FAILED_MESSAGE = "The import failed.";

export const REMOVAL_FINISHED_MESSAGE = "Missing use cases removed.";
export const REMOVED_LABEL = "Use cases removed:";
export const REMOVED_BEFORE_STOP_LABEL = "Use cases removed before it stopped:";
export const REMOVAL_FAILED_MESSAGE = "Failed to remove use cases";
/** An interrupted batch after earlier batches removed some ("nothing was removed" would mislead). */
export const REMOVAL_INTERRUPTED_PARTIAL_MESSAGE =
  "The removal was interrupted before it finished. Try again for the rest.";

interface ImportResponse {
  success?: boolean;
  imported?: number;
  error?: string;
}

/** Import `ids` in batches through `send` (POST /import with one batch). */
export async function importInBatches(
  ids: string[],
  send: (batch: string[]) => Promise<ImportResponse>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary> {
  // A response without success is a failure too; stop there.
  const run = await runInBatches(
    ids,
    async (batch) => {
      const response = await send(batch);
      if (!response?.success) throw new Error(response?.error || IMPORT_FAILED_MESSAGE);
      return response;
    },
    onProgress,
  );
  let imported = run.results.reduce((sum, r) => sum + (r.imported ?? 0), 0);
  if (!run.error) {
    return {
      type: "success",
      text: IMPORT_FINISHED_MESSAGE,
      count: { label: IMPORTED_LABEL, value: imported },
      syncRunning: false,
    };
  }
  const error = run.error as { status?: number; message?: string; response?: { data?: any } };
  let text: string;
  if (isImportInterrupted(error)) {
    // The interrupted batch imported some objects before it stopped.
    const partial = error.response?.data?.imported;
    if (typeof partial === "number") imported += partial;
    text = IMPORT_INTERRUPTED_MESSAGE;
  } else if (error?.status === 409) {
    text = SYNC_RUNNING_MESSAGE;
  } else {
    text = getApiErrorReason(error) || error?.message || IMPORT_FAILED_MESSAGE;
  }
  return {
    type: "error",
    text,
    count: { label: IMPORTED_BEFORE_STOP_LABEL, value: imported },
    syncRunning: error?.status === 409 && !isImportInterrupted(error),
  };
}

/** Remove the use cases `ids` in batches through `send` (POST /use-cases/remove-missing). */
export async function removeInBatches(
  ids: number[],
  send: (batch: number[]) => Promise<{ removed?: number }>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary> {
  const run = await runInBatches(ids, send, onProgress);
  const removed = run.results.reduce((sum, r) => sum + (r?.removed ?? 0), 0);
  if (!run.error) {
    return {
      type: "success",
      text: REMOVAL_FINISHED_MESSAGE,
      count: { label: REMOVED_LABEL, value: removed },
      syncRunning: false,
    };
  }
  const error = run.error as { status?: number; message?: string; response?: { data?: any } };
  const code = error?.status === 409 ? error.response?.data?.code : undefined;
  const interrupted = code === RUN_CODES.removalInterrupted;
  return {
    type: "error",
    text:
      interrupted && removed > 0
        ? REMOVAL_INTERRUPTED_PARTIAL_MESSAGE
        : (removalConflictText(error) ??
          (getApiErrorReason(error) || error?.message || REMOVAL_FAILED_MESSAGE)),
    count: { label: REMOVED_BEFORE_STOP_LABEL, value: removed },
    syncRunning: error?.status === 409 && !interrupted,
  };
}
