import { Request, Response } from "express";
import { STATUS_CODE } from "../../utils/statusCode.utils";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { translateError } from "../../utils/i18n.utils";
import { JiraAssetsClient, JiraUpstreamError } from "./jira.client";
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
  JiraAssetsConfig,
  JiraConfigValidationError,
  JiraImportInterruptedError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  listUseCases,
  loadFullConfig,
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
 * - JiraImportInterruptedError → 409 with { message, imported, skipped }
 * - JiraUpstreamError (Jira response, timeout, DNS/TLS) → 502
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
    return res
      .status(409)
      .json(
        STATUS_CODE[409]({ message: err.message, imported: err.imported, skipped: err.skipped }),
      );
  }
  if (err instanceof JiraUpstreamError) {
    return res.status(502).json(STATUS_CODE[502](err.message));
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
  try {
    const settings = await updateSyncSettings(orgId(req), uid(req), req.body ?? {});
    return res.status(200).json(STATUS_CODE[200](settings));
  } catch (err) {
    return sendError(req, res, err, "patchSyncSettings");
  }
}

/**
 * PATCH /config/selection — only `selected_schema_id` and/or
 * `selected_object_type_id`. Used when the panel's schema or object-type
 * pickers change, so nothing else in the config is re-sent.
 */
export async function patchSelection(req: Request, res: Response): Promise<any> {
  try {
    const selection = await updateSelection(orgId(req), uid(req), req.body ?? {});
    return res.status(200).json(STATUS_CODE[200](selection));
  } catch (err) {
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
 * POST /sync — "Sync now". Checks the config (404 / 400), claims the run
 * (409 if a sync or import is running) and queues it for the worker: 202 with
 * `{ historyId }`. The outcome, including the reason for a failure, is
 * recorded on the history row and the config; the panel polls GET
 * /sync/status (`running`, `latest_run`, `last_sync_*`) to show it.
 */
export async function postSync(req: Request, res: Response): Promise<any> {
  try {
    const started = await startManualSync(orgId(req), uid(req));
    return res.status(202).json(STATUS_CODE[202](started));
  } catch (err) {
    return sendError(req, res, err, "postSync");
  }
}

export async function getSyncStatusCtrl(req: Request, res: Response): Promise<any> {
  try {
    // Number(), not parseInt: "12abc" or "1.5" must be rejected, not truncated.
    const rawId = req.query?.historyId;
    const historyId = rawId === undefined ? null : Number(rawId);
    if (historyId !== null && (!Number.isInteger(historyId) || historyId <= 0)) {
      return res.status(400).json(STATUS_CODE[400]("historyId must be a positive integer"));
    }
    const status = await getSyncStatus(orgId(req), historyId);
    return res.status(200).json(STATUS_CODE[200](status));
  } catch (err: any) {
    return res.status(500).json(STATUS_CODE[500](err.message));
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

export async function deleteUseCaseCtrl(req: Request, res: Response): Promise<any> {
  try {
    await deleteUseCaseByProjectId(intParam(req, "id"), orgId(req));
    return res.status(200).json(STATUS_CODE[200]({ success: true }));
  } catch (err: any) {
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
