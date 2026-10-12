import { Request, Response } from "express";
import { STATUS_CODE } from "../../utils/statusCode.utils";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { translateError } from "../../utils/i18n.utils";
import { logFailure, logProcessing, logSuccess } from "../../utils/logger/logHelper";
import { JiraAssetsClient, JiraUpstreamError } from "./jira.client";
import {
  BackgroundJobsUnavailableError,
  hasPendingJiraAssetsSyncJob,
} from "../../services/automations/automationProducer";
import { VW_AI_SYSTEM_ATTRIBUTES, transformAttributes } from "./jira.constants";
import {
  clientFromConfig,
  deleteUseCaseByProjectId,
  getCustomFrameworksProgress,
  getPublicConfig,
  getSyncHistory,
  getSyncStatus,
  getUseCaseByProjectId,
  importObjects,
  JIRA_RUN_CODES,
  JiraAssetsConfig,
  JiraConfigValidationError,
  JiraImportInterruptedError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  listUseCases,
  loadFullConfig,
  removeMissingUseCases,
  RunSupersededError,
  saveConfig,
  startManualSync,
  updateSelection,
  updateSyncSettings,
} from "./jiraAssets.service";

const fileName = "jiraAssets.ctrl.ts";

function orgId(req: Request): number {
  return (req as any).organizationId;
}
function uid(req: Request): number {
  return (req as any).userId;
}
function stringParam(req: Request, name: string): string {
  const raw = req.params[name];
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}
function intParam(req: Request, name: string): number {
  return parseInt(stringParam(req, name), 10);
}

/** Who and where, for logProcessing / logSuccess / logFailure. */
function logContext(req: Request, functionName: string) {
  return { functionName, fileName, userId: uid(req), organizationId: orgId(req) };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function requireClient(organizationId: number): Promise<JiraAssetsClient> {
  const config = await loadFullConfig(organizationId);
  if (!config?.jira_base_url || !config.workspace_id || !config.email) {
    throw new JiraNotConfiguredError();
  }
  return clientFromConfig(config);
}

/**
 * Map a service error to a response. 4xx bodies carry the reason in `data`,
 * 5xx in `error` (STATUS_CODE shapes) — the panel reads both through
 * getApiErrorReason, as the MLflow tab does.
 *
 * - JiraConfigValidationError → 400
 * - JiraNotConfiguredError → 404
 * - JiraSyncInProgressError → 409
 * - JiraImportInterruptedError → 409 with { message, code: "import_interrupted", imported, skipped }
 * - JiraUpstreamError (Jira response, timeout, DNS/TLS) → 502
 * - BackgroundJobsUnavailableError (queue did not answer) → 503
 * - anything else → 500, logged
 */
function sendError(req: Request, res: Response, err: unknown, functionName: string) {
  if (err instanceof JiraConfigValidationError) {
    return res.status(400).json(STATUS_CODE[400](err.message));
  }
  if (err instanceof JiraNotConfiguredError) {
    return res.status(404).json(STATUS_CODE[404](err.message));
  }
  if (err instanceof JiraSyncInProgressError) {
    return res.status(409).json(STATUS_CODE[409](err.message));
  }
  if (err instanceof JiraImportInterruptedError) {
    return res.status(409).json(
      STATUS_CODE[409]({
        message: err.message,
        code: JIRA_RUN_CODES.importInterrupted,
        imported: err.imported,
        skipped: err.skipped,
      }),
    );
  }
  if (err instanceof JiraUpstreamError) {
    return res.status(502).json(STATUS_CODE[502](err.message));
  }
  if (err instanceof BackgroundJobsUnavailableError) {
    return res.status(503).json(STATUS_CODE[503](err.message));
  }
  logStructured("error", `jira ${functionName} failed`, functionName, fileName);
  logger.error(`❌ Error in jira ${functionName}:`, err);
  return res.status(500).json(STATUS_CODE[500](translateError(req, err)));
}

// ---- Config ------------------------------------------------------------

export async function getConfig(req: Request, res: Response): Promise<any> {
  try {
    const config = await getPublicConfig(orgId(req));
    return res.status(200).json(STATUS_CODE[200](config));
  } catch (err) {
    logStructured("error", "jira getConfig failed", "getConfig", fileName);
    logger.error("❌ Error in jira getConfig:", err);
    return res.status(500).json(STATUS_CODE[500](translateError(req, err)));
  }
}

export async function postConfig(req: Request, res: Response): Promise<any> {
  try {
    await saveConfig(orgId(req), uid(req), req.body as JiraAssetsConfig);
    return res
      .status(200)
      .json(STATUS_CODE[200]({ success: true, message: "Configuration saved successfully" }));
  } catch (err) {
    return sendError(req, res, err, "postConfig");
  }
}

/**
 * PATCH /config/sync — only `sync_enabled` and/or `sync_interval_hours`.
 * Used by the panel's auto-save so it never re-sends connection fields.
 */
export async function patchSyncSettings(req: Request, res: Response): Promise<any> {
  const ctx = logContext(req, "patchSyncSettings");
  logProcessing({ ...ctx, description: "updating Jira Assets sync settings" });
  try {
    const settings = await updateSyncSettings(orgId(req), uid(req), req.body ?? {});
    await logSuccess({
      ...ctx,
      eventType: "Update",
      description: `Updated Jira Assets sync settings (enabled: ${settings.sync_enabled}, every ${settings.sync_interval_hours} h)`,
    });
    return res.status(200).json(STATUS_CODE[200](settings));
  } catch (err) {
    await logFailure({
      ...ctx,
      eventType: "Update",
      description: "Failed to update Jira Assets sync settings",
      error: asError(err),
    });
    return sendError(req, res, err, "patchSyncSettings");
  }
}

/**
 * PATCH /config/selection — only `selected_schema_id` and/or
 * `selected_object_type_id`. Used when the panel's schema or object-type
 * pickers change, so nothing else in the config is re-sent.
 */
export async function patchSelection(req: Request, res: Response): Promise<any> {
  const ctx = logContext(req, "patchSelection");
  logProcessing({ ...ctx, description: "updating Jira Assets schema and object type selection" });
  try {
    const selection = await updateSelection(orgId(req), uid(req), req.body ?? {});
    await logSuccess({
      ...ctx,
      eventType: "Update",
      description: `Updated Jira Assets selection (schema ${selection.selected_schema_id ?? "none"}, object type ${selection.selected_object_type_id ?? "none"})`,
    });
    return res.status(200).json(STATUS_CODE[200](selection));
  } catch (err) {
    await logFailure({
      ...ctx,
      eventType: "Update",
      description: "Failed to update Jira Assets selection",
      error: asError(err),
    });
    return sendError(req, res, err, "patchSelection");
  }
}

// ---- Test connection ---------------------------------------------------
//
// Serviced by the generic POST /api/extensions/:key/test-connection route
// (controllers/extension.ctrl.ts → TEST_CONNECTION_DISPATCH["jira-assets"]).
// The dispatch entry reuses `clientFromConfig` + `loadFullConfig` from the
// service module, so there is no logic in this controller for it.

// ---- Static VW attribute list -----------------------------------------

export async function getVwAttributes(_req: Request, res: Response): Promise<any> {
  return res.status(200).json(STATUS_CODE[200](VW_AI_SYSTEM_ATTRIBUTES));
}

// ---- Schema / object-type / attribute discovery ------------------------

export async function getSchemas(req: Request, res: Response): Promise<any> {
  try {
    const client = await requireClient(orgId(req));
    const schemas = await client.getSchemas();
    return res.status(200).json(STATUS_CODE[200](schemas));
  } catch (err) {
    return sendError(req, res, err, "getSchemas");
  }
}

export async function getObjectTypes(req: Request, res: Response): Promise<any> {
  try {
    const client = await requireClient(orgId(req));
    const objectTypes = await client.getObjectTypes(stringParam(req, "schemaId"));
    return res.status(200).json(STATUS_CODE[200](objectTypes));
  } catch (err) {
    return sendError(req, res, err, "getObjectTypes");
  }
}

export async function getAttributes(req: Request, res: Response): Promise<any> {
  try {
    const client = await requireClient(orgId(req));
    const attributes = await client.getAttributes(stringParam(req, "objectTypeId"));
    return res.status(200).json(STATUS_CODE[200](attributes));
  } catch (err) {
    return sendError(req, res, err, "getAttributes");
  }
}

/**
 * Objects for the import picker: one page of up to PICKER_MAX_RESULTS from
 * `?startAt=` (default 0), never the full paginated walk that sync uses.
 * Returns `{ objects, hasMore, nextStartAt }` so the panel can say more exist
 * and offer "Load more".
 */
export async function getObjects(req: Request, res: Response): Promise<any> {
  try {
    const client = await requireClient(orgId(req));
    const startAt = Math.max(0, parseInt(String(req.query?.startAt ?? "0"), 10) || 0);
    const page = await client.getObjectsPage(stringParam(req, "objectTypeId"), startAt);
    const transformed = page.objects.map((obj) => ({
      id: obj.id,
      key: obj.objectKey,
      name: obj.label,
      attributes: transformAttributes(obj.attributes, (obj as any)._attrIdToName || {}),
      created: obj.created,
      updated: obj.updated,
    }));
    return res.status(200).json(
      STATUS_CODE[200]({
        objects: transformed,
        hasMore: page.hasMore,
        nextStartAt: page.nextStartAt,
      }),
    );
  } catch (err) {
    return sendError(req, res, err, "getObjects");
  }
}

// ---- Import / sync -----------------------------------------------------

export async function postImport(req: Request, res: Response): Promise<any> {
  try {
    const objectIds = (req.body?.object_ids ?? []) as string[];
    const result = await importObjects(orgId(req), uid(req), objectIds);
    return res.status(200).json(STATUS_CODE[200](result));
  } catch (err) {
    return sendError(req, res, err, "postImport");
  }
}

/**
 * POST /sync — "Sync now". Checks the config (404 / 400), refuses with 409 if
 * a run is live or a sync job for the org is already waiting, and otherwise
 * queues the job: 202 with `{ jobId, previousRunId }`. Nothing is claimed
 * here; the worker claims the run when it picks the job up. `previousRunId`
 * is the newest manual or scheduled run before this request. The outcome,
 * including the reason for a failure, is recorded on the history row and the
 * config; the panel polls GET /sync/status (`queued`, `running`,
 * `latest_run`, `last_sync_*`) until a run newer than `previousRunId` ends.
 */
export async function postSync(req: Request, res: Response): Promise<any> {
  try {
    const started = await startManualSync(orgId(req), uid(req));
    return res.status(202).json(STATUS_CODE[202](started));
  } catch (err) {
    return sendError(req, res, err, "postSync");
  }
}

/**
 * GET /sync/status — last-sync fields, `running`, `latest_run` (with
 * `is_live`), plus `queued`: whether a sync job for the org is waiting in the
 * queue. If the queue does not answer, `queued` is null rather than failing
 * the whole response.
 */
export async function getSyncStatusCtrl(req: Request, res: Response): Promise<any> {
  try {
    const status = await getSyncStatus(orgId(req));
    let queued: boolean | null = null;
    try {
      queued = await hasPendingJiraAssetsSyncJob(orgId(req));
    } catch (err) {
      logger.warn(`jira sync status: queue state unavailable: ${(err as Error).message}`);
    }
    return res.status(200).json(STATUS_CODE[200](status ? { ...status, queued } : status));
  } catch (err) {
    return sendError(req, res, err, "getSyncStatus");
  }
}

export async function getSyncHistoryCtrl(req: Request, res: Response): Promise<any> {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);
    const history = await getSyncHistory(orgId(req), limit);
    return res.status(200).json(STATUS_CODE[200](history));
  } catch (err: any) {
    return res.status(500).json(STATUS_CODE[500](err.message));
  }
}

// ---- Use cases ---------------------------------------------------------

export async function listUseCasesCtrl(req: Request, res: Response): Promise<any> {
  try {
    const useCases = await listUseCases(orgId(req));
    return res.status(200).json(STATUS_CODE[200](useCases));
  } catch (err: any) {
    return res.status(500).json(STATUS_CODE[500](err.message));
  }
}

export async function getUseCaseCtrl(req: Request, res: Response): Promise<any> {
  try {
    const useCase = await getUseCaseByProjectId(intParam(req, "id"), orgId(req));
    if (!useCase) {
      return res.status(404).json(STATUS_CODE[404](req.t!("Use case not found")));
    }
    return res.status(200).json(STATUS_CODE[200](useCase));
  } catch (err: any) {
    return res.status(500).json(STATUS_CODE[500](err.message));
  }
}

export const REMOVAL_INTERRUPTED_MESSAGE =
  "The removal was interrupted; nothing was removed. Try again.";

/**
 * POST /use-cases/remove-missing — delete the use cases the admin chose from
 * the "Missing in Jira" list (`{ use_case_ids: number[] }`). Only ids still
 * flagged as missing are removed; returns `{ removed, skipped }`. 409 while a
 * sync or import is running, or `{ message, code: "removal_interrupted" }`
 * when the removal lost its claim (nothing was removed).
 */
export async function removeMissingCtrl(req: Request, res: Response): Promise<any> {
  const ctx = logContext(req, "removeMissingCtrl");
  const requested = Array.isArray(req.body?.use_case_ids) ? req.body.use_case_ids.length : 0;
  logProcessing({
    ...ctx,
    description: `removing ${requested} use case(s) flagged as missing in Jira`,
  });
  try {
    const result = await removeMissingUseCases(orgId(req), uid(req), req.body?.use_case_ids);
    await logSuccess({
      ...ctx,
      eventType: "Delete",
      description: `Removed ${result.removed} use case(s) missing in Jira (${result.skipped} skipped)`,
    });
    return res.status(200).json(STATUS_CODE[200](result));
  } catch (err) {
    await logFailure({
      ...ctx,
      eventType: "Delete",
      description: "Failed to remove use cases missing in Jira",
      error: asError(err),
    });
    // The removal lost its claim before finishing; its transaction rolled back.
    if (err instanceof RunSupersededError) {
      return res.status(409).json(
        STATUS_CODE[409]({
          message: REMOVAL_INTERRUPTED_MESSAGE,
          code: JIRA_RUN_CODES.removalInterrupted,
        }),
      );
    }
    return sendError(req, res, err, "removeMissing");
  }
}

export async function deleteUseCaseCtrl(req: Request, res: Response): Promise<any> {
  const ctx = logContext(req, "deleteUseCaseCtrl");
  const projectId = intParam(req, "id");
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json(STATUS_CODE[400]("Invalid use case id"));
  }
  logProcessing({ ...ctx, description: `deleting Jira Assets use case project ${projectId}` });
  try {
    await deleteUseCaseByProjectId(projectId, orgId(req), uid(req) ?? null);
    await logSuccess({
      ...ctx,
      eventType: "Delete",
      description: `Deleted Jira Assets use case project ${projectId}`,
    });
    return res.status(200).json(STATUS_CODE[200]({ success: true }));
  } catch (err: any) {
    await logFailure({
      ...ctx,
      eventType: "Delete",
      description: `Failed to delete Jira Assets use case project ${projectId}`,
      error: asError(err),
    });
    return res.status(500).json(STATUS_CODE[500](err.message));
  }
}

// ---- Custom frameworks progress ---------------------------------------

export async function getCustomFrameworksProgressCtrl(req: Request, res: Response): Promise<any> {
  try {
    const progress = await getCustomFrameworksProgress(intParam(req, "projectId"), orgId(req));
    return res.status(200).json(STATUS_CODE[200](progress));
  } catch (err: any) {
    return res.status(500).json(STATUS_CODE[500](err.message));
  }
}
