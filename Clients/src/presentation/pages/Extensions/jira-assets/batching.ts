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
export const SKIPPED_GONE_LABEL = "Skipped, no longer missing or no longer there:";
export const SKIPPED_SHARED_LABEL = "Skipped, project also used by another use case:";
export const SKIPPED_CHANGED_LABEL = "Skipped, changed during the removal:";
export const REMOVAL_PARTLY_SKIPPED_MESSAGE =
  "Removal finished. Some use cases were not removed because they are no longer missing in Jira or no longer exist.";
export const REMOVAL_KEPT_MESSAGE =
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

/** Why the server did not remove a requested use case (jiraAssets.service RemovalSkipReason). */
export type RemovalSkipReason = "no_longer_missing" | "not_found" | "changed" | "has_live_links";

interface RemoveResponse {
  /** Use cases (projects) deleted. */
  removed?: number;
  /** Links whose project is not in this organization; only the link was deleted. */
  unlinked?: number;
  skipped_items?: Array<{ id: number; reason: RemovalSkipReason }>;
}

/**
 * Skips that settle the id: it is no longer missing (a sync found it) or no
 * longer there, so it leaves the "Missing in Jira" list on reload. The other
 * reasons leave it flagged, so it stays selected for another try.
 */
const SETTLING_SKIPS = new Set<RemovalSkipReason>(["no_longer_missing", "not_found"]);

/** Remove the use cases `ids` in batches through `send` (POST /use-cases/remove-missing). */
export async function removeInBatches(
  ids: number[],
  send: (batch: number[]) => Promise<RemoveResponse>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary<number>> {
  const run = await runInBatches(ids, send, onProgress);
  let removed = 0;
  let unlinked = 0;
  const skips: Record<"gone" | "shared" | "changed", number> = { gone: 0, shared: 0, changed: 0 };
  const doneIds: number[] = [];
  for (const { batch, result } of run.done) {
    removed += result?.removed ?? 0;
    unlinked += result?.unlinked ?? 0;
    const kept = new Set<number>();
    for (const { id, reason } of result?.skipped_items ?? []) {
      if (SETTLING_SKIPS.has(reason)) skips.gone++;
      else {
        kept.add(id);
        if (reason === "has_live_links") skips.shared++;
        else skips.changed++;
      }
    }
    doneIds.push(...batch.filter((id) => !kept.has(id)));
  }
  const extraCounts: MessageCount[] = [
    ...(unlinked > 0 ? [{ label: UNLINKED_LABEL, value: unlinked }] : []),
    ...(skips.gone > 0 ? [{ label: SKIPPED_GONE_LABEL, value: skips.gone }] : []),
    ...(skips.shared > 0 ? [{ label: SKIPPED_SHARED_LABEL, value: skips.shared }] : []),
    ...(skips.changed > 0 ? [{ label: SKIPPED_CHANGED_LABEL, value: skips.changed }] : []),
  ];
  if (!run.error) {
    const keptAny = skips.shared + skips.changed > 0;
    return {
      type: keptAny || skips.gone > 0 ? "warning" : "success",
      text: keptAny
        ? REMOVAL_KEPT_MESSAGE
        : skips.gone > 0
          ? REMOVAL_PARTLY_SKIPPED_MESSAGE
          : REMOVAL_FINISHED_MESSAGE,
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
        : // A failed delete names the use case in the 500 body's reason.
          getApiErrorReason(stop.error) || stop.error?.message || REMOVAL_FAILED_MESSAGE;
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

/** Picker objects without those now imported (from a fresh /use-cases load). */
export function withoutImported<O extends { id: string }>(
  objects: O[],
  importedObjectIds: Set<string> | null,
): O[] {
  if (!importedObjectIds) return objects;
  const next = objects.filter((obj) => !importedObjectIds.has(obj.id));
  return next.length === objects.length ? objects : next;
}

/**
 * The picker after a "Load more" page arrives: the page is appended without
 * duplicates and without objects already imported. `importedObjectIds` is
 * read when the page arrives (not when it was requested), so a page that
 * lands after an import never brings the just-imported objects back.
 */
export function appendPage<O extends { id: string }>(
  prev: O[],
  page: O[],
  importedObjectIds: Set<string>,
): O[] {
  const seen = new Set(prev.map((obj) => obj.id));
  return [...prev, ...page.filter((obj) => !seen.has(obj.id) && !importedObjectIds.has(obj.id))];
}

/**
 * The selection restricted to the objects shown in the picker. The panel
 * derives its effective selection with this at render, so a selected id is
 * never invisible, not even for one frame: this is the one place the
 * selection is derived from the objects. Returns the same set when nothing
 * changes.
 */
export function keepShown<O extends { id: string }>(selected: Set<string>, objects: O[]) {
  const shown = new Set(objects.map((obj) => obj.id));
  const next = new Set([...selected].filter((id) => shown.has(id)));
  return next.size === selected.size ? selected : next;
}

/**
 * How the panel's state changes after an import, as state updaters applied
 * to the latest state (so a "Load more" or a toggle made during the import is
 * kept), from the summary and the freshly loaded imported use cases (not the
 * ones the import started with): imported objects leave the picker and
 * handled ids leave the selection. keepShown (at render) restricts the
 * selection to what the picker still shows, so imported ids of a batch kept whole
 * (errors without ids, or interrupted part-way) leave it too. The handler
 * applies this once, after reloading, so no reload can clear the outcome.
 */
export function finishImport<O extends { id: string }>(
  summary: BatchSummary<string>,
  importedObjectIds: Set<string> | null,
): {
  objects: (prev: O[]) => O[];
  selected: (prev: Set<string>) => Set<string>;
  message: PanelMessage;
} {
  return {
    objects: (prev) => withoutImported(prev, importedObjectIds),
    selected: (prev) => deselectDone(prev, summary.doneIds),
    message: summaryMessage(summary),
  };
}
