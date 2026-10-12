/**
 * How the Jira Assets panel reads run outcomes. It switches on the
 * machine-readable `code` the server sends (jiraAssets.service
 * JIRA_RUN_CODES), never on message text.
 */
export const RUN_CODES = {
  abandoned: "abandoned",
  importInterrupted: "import_interrupted",
  removalInterrupted: "removal_interrupted",
} as const;

export const SYNC_RUNNING_MESSAGE = "A sync is already running. Try again when it finishes.";
/** Shown if a removal lost its claim and the 409 body carries no message. */
export const REMOVAL_INTERRUPTED_MESSAGE =
  "The removal was interrupted; nothing was removed. Try again.";

interface ApiErrorLike {
  status?: number;
  response?: { data?: unknown };
}

function conflictCode(error: unknown): string | null {
  const e = error as ApiErrorLike | null | undefined;
  if (e?.status !== 409) return null;
  const code = (e.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** 409 import_interrupted: the import stopped part-way, with counts in the body. */
export function isImportInterrupted(error: unknown): boolean {
  return conflictCode(error) === RUN_CODES.importInterrupted;
}

/**
 * Text for a 409 from "Remove selected use cases": the interrupted-removal
 * message for code removal_interrupted, otherwise "a sync is running".
 * Returns null for anything that is not a 409.
 */
export function removalConflictText(error: unknown): string | null {
  if ((error as ApiErrorLike | null | undefined)?.status !== 409) return null;
  if (conflictCode(error) !== RUN_CODES.removalInterrupted) return SYNC_RUNNING_MESSAGE;
  const message = ((error as ApiErrorLike).response?.data as { message?: unknown })?.message;
  return typeof message === "string" && message ? message : REMOVAL_INTERRUPTED_MESSAGE;
}

/** A run the server closed because it stopped heart-beating. */
export function isAbandonedRun(run: { code?: string | null } | null | undefined): boolean {
  return run?.code === RUN_CODES.abandoned;
}
