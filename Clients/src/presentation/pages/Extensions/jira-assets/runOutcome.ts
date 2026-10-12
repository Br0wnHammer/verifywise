/**
 * How the Jira Assets panel reads run outcomes. It switches on the
 * machine-readable `code` the server sends (jiraAssets.service
 * JIRA_RUN_CODES), never on message text. 409s from import and removal are
 * classified in batching.ts (classifyStop).
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

/** A run the server closed because it stopped heart-beating. */
export function isAbandonedRun(run: { code?: string | null } | null | undefined): boolean {
  return run?.code === RUN_CODES.abandoned;
}
