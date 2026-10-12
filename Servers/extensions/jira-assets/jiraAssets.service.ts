import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import { encryptText, decryptText } from "../../tools/createSecureValue";
import { JiraAssetsClient, JiraObject, JiraUpstreamError } from "./jira.client";
import { transformAttributes } from "./jira.constants";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { EXTERNAL_SYNC_DEADLINE_MS } from "../../utils/outboundFetch.utils";
import { enqueueJiraAssetsManualSync } from "../../services/automations/automationProducer";
import { SQL_NOW_UTC, sqlWithinLastMinutes } from "../scheduledSync.utils";

const fileName = "jiraAssets.service.ts";

/**
 * DB-facing helpers for the jira-assets extension.
 *
 * Encryption note: the `api_token` submitted through /config is encrypted
 * with AES-256-CBC via `encryptText`/`decryptText` (see
 * Servers/tools/createSecureValue.ts). The `jira_assets_config` table
 * stores `api_token_encrypted` + `api_token_iv` for that pair. The
 * original plugin used base64 "encryption" — this port replaces it with
 * proper crypto to match the standard the slack_webhooks table already
 * uses in core.
 */

export interface JiraAssetsConfig {
  jira_base_url?: string;
  workspace_id?: string;
  email?: string;
  api_token?: string;
  deployment_type?: "cloud" | "datacenter";
  selected_schema_id?: string | null;
  selected_object_type_id?: string | null;
  sync_enabled?: boolean;
  sync_interval_hours?: number;
}

export interface JiraAssetsConfigRow {
  id: number;
  jira_base_url: string;
  workspace_id: string;
  email: string;
  deployment_type: string;
  selected_schema_id: string | null;
  selected_object_type_id: string | null;
  sync_enabled: boolean;
  sync_interval_hours: number;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  has_api_token: boolean;
}

export interface JiraSyncResult {
  success: boolean;
  objectsFetched: number;
  objectsCreated: number;
  objectsUpdated: number;
  /** Use cases (native projects) removed because their object is gone from Jira. */
  objectsDeleted: number;
  /** Link rows with no project whose object is gone from Jira; the link row was removed. */
  linksRemoved: number;
  /** Linked objects not returned by Jira that were kept (scheduled run, or deletes skipped). */
  objectsMissingInJira: number;
  missingInJiraIds: string[];
  /** Why a manual sync kept objects missing in Jira instead of removing them. */
  deletesSkippedReason?: string;
  syncedAt: string;
  status: string;
}

export type SyncRunType = "manual" | "scheduled" | "import";

/** Bounds for `sync_interval_hours`; mirrors jira_assets_config_sync_interval_range_chk. */
export const SYNC_INTERVAL_MIN_HOURS = 1;
export const SYNC_INTERVAL_MAX_HOURS = 168;
const DEFAULT_SYNC_INTERVAL_HOURS = 24;

/**
 * A `started` history row with no heartbeat (heartbeat_at, else started_at)
 * for this many minutes is treated as abandoned (worker crash, deploy
 * mid-sync) and closed as failed, so it cannot block every later sync for the
 * organization. A live run touches heartbeat_at per fetched page and every
 * HEARTBEAT_EVERY_OBJECTS objects. All comparisons are done in SQL.
 */
export const SYNC_STALE_AFTER_MINUTES = 15;
export const HEARTBEAT_EVERY_OBJECTS = 25;

/** SQL: this history row (alias `h`) has a heartbeat inside the stale window. */
export const SQL_RUN_IS_LIVE = sqlWithinLastMinutes(
  "COALESCE(h.heartbeat_at, h.started_at)",
  SYNC_STALE_AFTER_MINUTES,
);

/** Thrown when a sync or import is already running for the organization. */
export class JiraSyncInProgressError extends Error {
  constructor() {
    super("A Jira Assets sync is already running for this organization");
    this.name = "JiraSyncInProgressError";
  }
}

/** No Jira connection saved for the organization (404). */
export class JiraNotConfiguredError extends Error {
  constructor(message = "Jira Assets is not configured. Save the connection first.") {
    super(message);
    this.name = "JiraNotConfiguredError";
  }
}

/**
 * This run's history row is no longer `started` (another claim closed it as
 * abandoned). The run stops at once and writes nothing more.
 */
export class RunSupersededError extends Error {
  constructor(historyId: number) {
    super(`Jira Assets run ${historyId} was closed by another run; stopping`);
    this.name = "RunSupersededError";
  }
}

/** Thrown for bad input; the controller maps it to 400. */
export class JiraConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraConfigValidationError";
  }
}

/**
 * Validate `sync_interval_hours` from a request body. Missing → default (24).
 * Accepts numeric strings because the UI select can hand back a string.
 */
export function parseSyncIntervalHours(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SYNC_INTERVAL_HOURS;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < SYNC_INTERVAL_MIN_HOURS ||
    value > SYNC_INTERVAL_MAX_HOURS
  ) {
    throw new JiraConfigValidationError(
      `Sync interval must be a whole number of hours between ${SYNC_INTERVAL_MIN_HOURS} and ${SYNC_INTERVAL_MAX_HOURS}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

export async function getPublicConfig(organizationId: number): Promise<JiraAssetsConfigRow | null> {
  const rows = (await sequelize.query(
    `SELECT id, jira_base_url, workspace_id, email, deployment_type,
            selected_schema_id, selected_object_type_id,
            sync_enabled, sync_interval_hours,
            last_sync_at, last_sync_status, last_sync_message,
            CASE WHEN api_token_encrypted IS NOT NULL AND api_token_encrypted <> ''
                 THEN TRUE ELSE FALSE END AS has_api_token
       FROM jira_assets_config
      WHERE organization_id = :organizationId
      LIMIT 1;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as JiraAssetsConfigRow[];
  return rows[0] ?? null;
}

/**
 * Load config + decrypt api_token in one shot. Used by every route handler
 * that needs to talk to JIRA. Returns null when no config row exists.
 */
export async function loadFullConfig(organizationId: number): Promise<JiraAssetsConfig | null> {
  const rows = (await sequelize.query(
    `SELECT * FROM jira_assets_config WHERE organization_id = :organizationId LIMIT 1;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as any[];
  const row = rows[0];
  if (!row) return null;
  let apiToken: string | undefined;
  if (row.api_token_encrypted && row.api_token_iv) {
    const result = decryptText({ value: row.api_token_encrypted, iv: row.api_token_iv });
    if (!result.success) {
      throw new Error(`Failed to decrypt jira_assets api token: ${result.error}`);
    }
    apiToken = result.data;
  }
  return {
    jira_base_url: row.jira_base_url,
    workspace_id: row.workspace_id,
    email: row.email,
    api_token: apiToken,
    deployment_type: row.deployment_type ?? "cloud",
    selected_schema_id: row.selected_schema_id,
    selected_object_type_id: row.selected_object_type_id,
    sync_enabled: row.sync_enabled,
    sync_interval_hours: row.sync_interval_hours,
  };
}

/**
 * Upsert config for the caller org. `api_token` in `body` is optional on
 * update — omit it to keep the previously-stored value (matches the
 * password-preservation semantics of the extensions registry).
 */
export async function saveConfig(
  organizationId: number,
  userId: number,
  body: JiraAssetsConfig,
): Promise<void> {
  const existing = (await sequelize.query(
    `SELECT id, api_token_encrypted FROM jira_assets_config
      WHERE organization_id = :organizationId LIMIT 1;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as Array<{ id: number; api_token_encrypted: string | null }>;
  const row = existing[0];
  const hasExistingToken = !!(row && row.api_token_encrypted);

  if (!body.jira_base_url) throw new JiraConfigValidationError("JIRA Base URL is required");
  if (!body.workspace_id) throw new JiraConfigValidationError("Workspace ID is required");
  if (!body.email) throw new JiraConfigValidationError("Email is required");
  if (!body.api_token && !hasExistingToken) {
    throw new JiraConfigValidationError("API Token is required");
  }
  if (body.sync_enabled !== undefined && typeof body.sync_enabled !== "boolean") {
    throw new JiraConfigValidationError("sync_enabled must be true or false");
  }
  const syncIntervalHours = parseSyncIntervalHours(body.sync_interval_hours);

  const commonReplacements = {
    organizationId,
    jiraBaseUrl: body.jira_base_url,
    workspaceId: body.workspace_id,
    email: body.email,
    deploymentType: body.deployment_type ?? "cloud",
    selectedSchemaId: body.selected_schema_id ?? null,
    selectedObjectTypeId: body.selected_object_type_id ?? null,
    syncEnabled: body.sync_enabled ?? false,
    syncIntervalHours,
    userId,
  };

  if (row) {
    if (body.api_token) {
      const { value, iv } = encryptText(body.api_token);
      await sequelize.query(
        `UPDATE jira_assets_config
            SET jira_base_url = :jiraBaseUrl, workspace_id = :workspaceId, email = :email,
                api_token_encrypted = :apiTokenEncrypted, api_token_iv = :apiTokenIv,
                deployment_type = :deploymentType,
                selected_schema_id = :selectedSchemaId,
                selected_object_type_id = :selectedObjectTypeId,
                sync_enabled = :syncEnabled, sync_interval_hours = :syncIntervalHours,
                updated_by = :userId, updated_at = NOW()
          WHERE id = :id AND organization_id = :organizationId;`,
        {
          replacements: {
            ...commonReplacements,
            apiTokenEncrypted: value,
            apiTokenIv: iv,
            id: row.id,
          },
        },
      );
    } else {
      await sequelize.query(
        `UPDATE jira_assets_config
            SET jira_base_url = :jiraBaseUrl, workspace_id = :workspaceId, email = :email,
                deployment_type = :deploymentType,
                selected_schema_id = :selectedSchemaId,
                selected_object_type_id = :selectedObjectTypeId,
                sync_enabled = :syncEnabled, sync_interval_hours = :syncIntervalHours,
                updated_by = :userId, updated_at = NOW()
          WHERE id = :id AND organization_id = :organizationId;`,
        { replacements: { ...commonReplacements, id: row.id } },
      );
    }
  } else {
    const { value, iv } = encryptText(body.api_token as string);
    await sequelize.query(
      `INSERT INTO jira_assets_config
         (organization_id, jira_base_url, workspace_id, email,
          api_token_encrypted, api_token_iv, deployment_type,
          selected_schema_id, selected_object_type_id,
          sync_enabled, sync_interval_hours, created_by)
       VALUES (:organizationId, :jiraBaseUrl, :workspaceId, :email,
               :apiTokenEncrypted, :apiTokenIv, :deploymentType,
               :selectedSchemaId, :selectedObjectTypeId,
               :syncEnabled, :syncIntervalHours, :userId);`,
      {
        replacements: {
          ...commonReplacements,
          apiTokenEncrypted: value,
          apiTokenIv: iv,
        },
      },
    );
  }
}

/**
 * Change only the automatic-sync settings. Connection fields, the token and
 * the schema/object type are left untouched, so a half-edited connection form
 * in the panel is never saved by toggling sync. At least one field required.
 */
export async function updateSyncSettings(
  organizationId: number,
  userId: number,
  body: { sync_enabled?: unknown; sync_interval_hours?: unknown },
): Promise<{ sync_enabled: boolean; sync_interval_hours: number }> {
  const hasEnabled = body?.sync_enabled !== undefined;
  const hasInterval = body?.sync_interval_hours !== undefined;
  if (!hasEnabled && !hasInterval) {
    throw new JiraConfigValidationError("Provide sync_enabled or sync_interval_hours");
  }
  if (hasEnabled && typeof body.sync_enabled !== "boolean") {
    throw new JiraConfigValidationError("sync_enabled must be true or false");
  }
  const interval = hasInterval ? parseSyncIntervalHours(body.sync_interval_hours) : null;

  const [rows] = (await sequelize.query(
    `UPDATE jira_assets_config
        SET sync_enabled = COALESCE(:syncEnabled, sync_enabled),
            sync_interval_hours = COALESCE(:syncIntervalHours, sync_interval_hours),
            updated_by = :userId, updated_at = NOW()
      WHERE organization_id = :organizationId
      RETURNING sync_enabled, sync_interval_hours;`,
    {
      replacements: {
        syncEnabled: hasEnabled ? body.sync_enabled : null,
        syncIntervalHours: interval,
        userId,
        organizationId,
      },
    },
  )) as unknown as [Array<{ sync_enabled: boolean; sync_interval_hours: number }>, unknown];
  if (!rows || rows.length === 0) throw new JiraNotConfiguredError();
  return rows[0];
}

const JIRA_ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;

function parseSelectionId(raw: unknown, field: string): string | null {
  if (raw === null || raw === "") return null;
  const value = typeof raw === "number" ? String(raw) : raw;
  if (typeof value !== "string" || !JIRA_ID_PATTERN.test(value)) {
    throw new JiraConfigValidationError(`${field} must be a Jira id or empty`);
  }
  return value;
}

/**
 * Change only the selected schema and/or object type. A field left out of
 * the body is kept; null or "" clears it. Nothing else in the config is
 * touched.
 */
export async function updateSelection(
  organizationId: number,
  userId: number,
  body: { selected_schema_id?: unknown; selected_object_type_id?: unknown },
): Promise<{ selected_schema_id: string | null; selected_object_type_id: string | null }> {
  const setSchema = body?.selected_schema_id !== undefined;
  const setObjectType = body?.selected_object_type_id !== undefined;
  if (!setSchema && !setObjectType) {
    throw new JiraConfigValidationError("Provide selected_schema_id or selected_object_type_id");
  }
  const schemaId = setSchema
    ? parseSelectionId(body.selected_schema_id, "selected_schema_id")
    : null;
  const objectTypeId = setObjectType
    ? parseSelectionId(body.selected_object_type_id, "selected_object_type_id")
    : null;

  const [rows] = (await sequelize.query(
    `UPDATE jira_assets_config
        SET selected_schema_id = CASE WHEN :setSchema THEN :schemaId ELSE selected_schema_id END,
            selected_object_type_id =
              CASE WHEN :setObjectType THEN :objectTypeId ELSE selected_object_type_id END,
            updated_by = :userId, updated_at = NOW()
      WHERE organization_id = :organizationId
      RETURNING selected_schema_id, selected_object_type_id;`,
    {
      replacements: {
        setSchema,
        schemaId,
        setObjectType,
        objectTypeId,
        userId,
        organizationId,
      },
    },
  )) as unknown as [
    Array<{ selected_schema_id: string | null; selected_object_type_id: string | null }>,
    unknown,
  ];
  if (!rows || rows.length === 0) throw new JiraNotConfiguredError();
  return rows[0];
}

// ---------------------------------------------------------------------------
// Client builder
// ---------------------------------------------------------------------------

export function clientFromConfig(config: JiraAssetsConfig): JiraAssetsClient {
  if (!config.jira_base_url || !config.workspace_id || !config.email || !config.api_token) {
    throw new JiraNotConfiguredError("Jira connection is not fully configured");
  }
  return new JiraAssetsClient(
    config.jira_base_url,
    config.workspace_id,
    config.email,
    config.api_token,
    config.deployment_type ?? "cloud",
  );
}

// ---------------------------------------------------------------------------
// Shared sync building blocks
// ---------------------------------------------------------------------------

async function nextUcId(organizationId: number, transaction?: Transaction): Promise<string> {
  const rows = (await sequelize.query(
    `SELECT nextval('verifywise.jira_use_case_uc_id_seq') AS seq;`,
    { type: QueryTypes.SELECT, transaction },
  )) as Array<{ seq: string }>;
  return `UC-J${organizationId}-${rows[0].seq}`;
}

/** Message for any thrown value; never empty. */
export function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message) return message;
  if (err !== undefined && err !== null) {
    const text = String(err);
    if (text) return text;
  }
  return "Unknown error";
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string }; original?: { code?: string } };
  return (
    e?.name === "SequelizeUniqueConstraintError" ||
    e?.parent?.code === "23505" ||
    e?.original?.code === "23505"
  );
}

interface DescribedObject {
  jiraObjectId: string;
  name: string;
  goal: string;
  data: Record<string, unknown>;
}

function describeObject(
  jiraObj: JiraObject,
  attrIdToName: Record<string, string>,
): DescribedObject {
  const transformedAttrs = transformAttributes(jiraObj.attributes || [], attrIdToName);
  const name = jiraObj.label || transformedAttrs["Name"] || `JIRA-${jiraObj.objectKey}`;
  const description =
    transformedAttrs["Description / Purpose"] || transformedAttrs["Description"] || "";
  return {
    jiraObjectId: String(jiraObj.id),
    name,
    goal: description || "Imported from JIRA Assets",
    data: {
      id: jiraObj.id,
      objectKey: jiraObj.objectKey,
      label: jiraObj.label,
      objectType: jiraObj.objectType,
      attributes: transformedAttrs,
      created: jiraObj.created,
      updated: jiraObj.updated,
    },
  };
}

/**
 * Create the native project and its jira_assets_use_cases link in one
 * transaction, so a failure can't leave a project without a link (or the
 * reverse). Returns "exists" if the object is already linked (unique
 * violation on organization_id + jira_object_id) instead of throwing.
 */
async function createLinkedUseCase(
  organizationId: number,
  ownerId: number | null,
  obj: DescribedObject,
  now: Date,
): Promise<"created" | "exists"> {
  try {
    await sequelize.transaction(async (transaction) => {
      const ucId = await nextUcId(organizationId, transaction);
      const projectRows = (await sequelize.query(
        `INSERT INTO projects
           (organization_id, uc_id, project_title, owner, start_date, goal,
            geography, last_updated, created_at, _source, is_organizational)
         VALUES (:organizationId, :ucId, :title, :owner, :now, :goal,
                 1, :now, :now, 'jira-assets', FALSE)
         RETURNING id;`,
        {
          replacements: {
            organizationId,
            ucId,
            title: obj.name,
            owner: ownerId ?? null,
            goal: obj.goal,
            now,
          },
          type: QueryTypes.INSERT,
          transaction,
        },
      )) as unknown as [Array<{ id: number }>, number];
      const projectId = (projectRows[0] as any)[0].id;

      await sequelize.query(
        `INSERT INTO jira_assets_use_cases
           (organization_id, jira_object_id, project_id, data, last_synced_at, sync_status)
         VALUES (:organizationId, :jiraObjectId, :projectId, CAST(:data AS JSONB), :now, 'synced');`,
        {
          replacements: {
            organizationId,
            jiraObjectId: obj.jiraObjectId,
            projectId,
            data: JSON.stringify(obj.data),
            now,
          },
          transaction,
        },
      );
    });
    return "created";
  } catch (err) {
    if (isUniqueViolation(err)) return "exists";
    throw err;
  }
}

/**
 * Atomically record the start of a sync or import for the organization, or
 * refuse if one is already running. Manual syncs, scheduled syncs and imports
 * all come through here, so they never overlap for the same organization.
 *
 * A transaction-scoped advisory lock keyed on the organization serialises the
 * check-then-insert (two READ COMMITTED transactions could otherwise both see
 * "nothing running" and both insert). The lock is released at commit, before
 * any Jira call, so it is held for milliseconds — the long-running guard is
 * the `started` history row itself. A `started` row whose heartbeat (else
 * start) is older than SYNC_STALE_AFTER_MINUTES is closed as failed first, so
 * an abandoned run cannot block forever. Times are compared in SQL.
 *
 * Returns the new history row id. Throws JiraSyncInProgressError on overlap.
 */
export async function claimSyncRun(
  organizationId: number,
  syncType: SyncRunType,
  triggeredBy: number | null,
): Promise<number> {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtext('jira_assets_sync'), :organizationId);`,
      { replacements: { organizationId }, type: QueryTypes.SELECT, transaction },
    );

    await sequelize.query(
      `UPDATE jira_assets_sync_history h
          SET status = 'failed', completed_at = ${SQL_NOW_UTC},
              error_message = 'Sync stopped responding and was marked as abandoned'
        WHERE h.organization_id = :organizationId
          AND h.status = 'started'
          AND NOT ${SQL_RUN_IS_LIVE};`,
      { replacements: { organizationId }, transaction },
    );

    const running = (await sequelize.query(
      `SELECT id FROM jira_assets_sync_history
        WHERE organization_id = :organizationId AND status = 'started'
        LIMIT 1;`,
      { replacements: { organizationId }, type: QueryTypes.SELECT, transaction },
    )) as Array<{ id: number }>;
    if (running.length > 0) throw new JiraSyncInProgressError();

    const historyRows = (await sequelize.query(
      `INSERT INTO jira_assets_sync_history
         (organization_id, sync_type, status, started_at, heartbeat_at, triggered_by)
       VALUES (:organizationId, :syncType, 'started', ${SQL_NOW_UTC}, ${SQL_NOW_UTC}, :triggeredBy)
       RETURNING id;`,
      {
        replacements: { organizationId, syncType, triggeredBy },
        type: QueryTypes.INSERT,
        transaction,
      },
    )) as unknown as [Array<{ id: number }>, number];
    return (historyRows[0] as any)[0].id as number;
  });
}

/**
 * Mark the run as alive. Throws RunSupersededError when the row is no longer
 * `started` (another claim closed it as abandoned): the caller must stop and
 * write nothing more. A database error is logged and tolerated — a missed
 * heartbeat must not fail an otherwise healthy run.
 */
export async function touchHeartbeat(historyId: number, organizationId: number): Promise<void> {
  let rows: Array<{ id: number }>;
  try {
    [rows] = (await sequelize.query(
      `UPDATE jira_assets_sync_history
          SET heartbeat_at = ${SQL_NOW_UTC}
        WHERE id = :id AND organization_id = :organizationId AND status = 'started'
        RETURNING id;`,
      { replacements: { id: historyId, organizationId } },
    )) as unknown as [Array<{ id: number }>, unknown];
  } catch (err) {
    logger.error(`Jira Assets heartbeat failed for run ${historyId}:`, err);
    return;
  }
  if (!rows || rows.length === 0) throw new RunSupersededError(historyId);
}

/**
 * Close a run as failed. The config's last_sync_* fields are updated too
 * (unless `updateConfig` is false, as for imports) so the panel shows the
 * error and the scheduler's interval acts as backoff — but only if this run
 * still owned its row. Never throws: it runs in catch blocks, where a second
 * exception would hide the first.
 */
export async function finalizeFailure(
  historyId: number,
  organizationId: number,
  err: unknown,
  updateConfig = true,
): Promise<string> {
  const message = errorMessage(err);
  try {
    const [rows] = (await sequelize.query(
      `UPDATE jira_assets_sync_history
          SET status = 'failed', error_message = :message, completed_at = ${SQL_NOW_UTC}
        WHERE id = :id AND organization_id = :organizationId AND status = 'started'
        RETURNING id;`,
      { replacements: { message, id: historyId, organizationId } },
    )) as unknown as [Array<{ id: number }>, unknown];
    if (!rows || rows.length === 0) {
      logger.warn(`Jira Assets run ${historyId} was already closed; failure not recorded`);
      return message;
    }
    if (updateConfig) {
      await sequelize.query(
        `UPDATE jira_assets_config
            SET last_sync_at = ${SQL_NOW_UTC}, last_sync_status = 'failed',
                last_sync_message = :message, updated_at = NOW()
          WHERE organization_id = :organizationId;`,
        { replacements: { message, organizationId } },
      );
    }
  } catch (finalizeErr) {
    logStructured(
      "error",
      `Jira Assets run ${historyId} could not be marked failed`,
      "finalizeFailure",
      fileName,
    );
    logger.error(`Jira Assets finalizeFailure for run ${historyId} failed:`, finalizeErr);
  }
  return message;
}

interface RunCounts {
  objectsFetched: number;
  objectsCreated: number;
  objectsUpdated: number;
  objectsDeleted: number;
}

/**
 * Close a run as completed. Only touches its own row while it is still
 * `started`; if it no longer owns the row, the config is left alone too and
 * RunSupersededError is thrown.
 */
async function finalizeSuccess(
  historyId: number,
  organizationId: number,
  counts: RunCounts,
  note: string | null,
  updateConfig: boolean,
): Promise<void> {
  const [rows] = (await sequelize.query(
    `UPDATE jira_assets_sync_history
        SET status = 'completed',
            objects_fetched = :objectsFetched,
            objects_created = :objectsCreated,
            objects_updated = :objectsUpdated,
            objects_deleted = :objectsDeleted,
            error_message = :note,
            completed_at = ${SQL_NOW_UTC}
      WHERE id = :id AND organization_id = :organizationId AND status = 'started'
      RETURNING id;`,
    { replacements: { ...counts, note, id: historyId, organizationId } },
  )) as unknown as [Array<{ id: number }>, unknown];
  if (!rows || rows.length === 0) throw new RunSupersededError(historyId);
  if (updateConfig) {
    await sequelize.query(
      `UPDATE jira_assets_config
          SET last_sync_at = ${SQL_NOW_UTC}, last_sync_status = 'success',
              last_sync_message = :note, updated_at = NOW()
        WHERE organization_id = :organizationId;`,
      { replacements: { note, organizationId } },
    );
  }
}

function failedResult(status: string): JiraSyncResult {
  return {
    success: false,
    objectsFetched: 0,
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    linksRemoved: 0,
    objectsMissingInJira: 0,
    missingInJiraIds: [],
    syncedAt: new Date().toISOString(),
    status,
  };
}

const MISSING_IDS_IN_NOTE = 20;

function missingNote(ids: string[], reason: string): string {
  const shown = ids.slice(0, MISSING_IDS_IN_NOTE).join(", ");
  const more =
    ids.length > MISSING_IDS_IN_NOTE ? ` and ${ids.length - MISSING_IDS_IN_NOTE} more` : "";
  return `${ids.length} linked object(s) missing in Jira were kept (${reason}): ${shown}${more}`;
}

// ---------------------------------------------------------------------------
// Import selected objects (creates native projects + JIRA link rows)
// ---------------------------------------------------------------------------

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors?: string[];
}

/**
 * Import the selected objects. Takes the same per-org claim as sync (history
 * row with sync_type 'import'), so an import and a sync never overlap. Import
 * results and failures are recorded on that history row only — never on the
 * config's last_sync_* fields, which belong to syncs and drive the scheduler.
 */
export async function importObjects(
  organizationId: number,
  userId: number,
  objectIds: string[],
): Promise<ImportResult> {
  if (!Array.isArray(objectIds) || objectIds.length === 0) {
    throw new JiraConfigValidationError("No objects selected for import");
  }
  if (!(await getPublicConfig(organizationId))) throw new JiraNotConfiguredError();

  const historyId = await claimSyncRun(organizationId, "import", userId);

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  try {
    const config = await loadFullConfig(organizationId);
    if (!config) throw new JiraNotConfiguredError();
    const client = clientFromConfig(config);

    // ID→name mapping so JIRA attribute IDs resolve to human names.
    const attrIdToName: Record<string, string> = {};
    if (config.selected_object_type_id) {
      const defs = await client.getAttributes(config.selected_object_type_id);
      for (const attr of defs) attrIdToName[attr.id] = attr.name;
    }

    const now = new Date();
    for (const [index, objectId] of objectIds.entries()) {
      try {
        const existing = (await sequelize.query(
          `SELECT id FROM jira_assets_use_cases
            WHERE jira_object_id = :objectId AND organization_id = :organizationId;`,
          { replacements: { objectId: String(objectId), organizationId }, type: QueryTypes.SELECT },
        )) as Array<{ id: number }>;
        if (existing.length > 0) {
          skipped++;
          continue;
        }
        const jiraObj = await client.getObjectById(objectId);
        const outcome = await createLinkedUseCase(
          organizationId,
          userId ?? null,
          describeObject(jiraObj, attrIdToName),
          now,
        );
        if (outcome === "created") imported++;
        else skipped++;
      } catch (err) {
        errors.push(`Failed to import ${objectId}: ${errorMessage(err)}`);
      }
      if ((index + 1) % HEARTBEAT_EVERY_OBJECTS === 0) {
        await touchHeartbeat(historyId, organizationId);
      }
    }

    await finalizeSuccess(
      historyId,
      organizationId,
      {
        objectsFetched: objectIds.length,
        objectsCreated: imported,
        objectsUpdated: 0,
        objectsDeleted: 0,
      },
      errors.length > 0 ? `${errors.length} object(s) failed to import` : null,
      false,
    );
  } catch (err) {
    if (!(err instanceof RunSupersededError)) {
      await finalizeFailure(historyId, organizationId, err, false);
    }
    throw err;
  }

  return { success: true, imported, skipped, errors: errors.length > 0 ? errors : undefined };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Start a manual sync for the "Sync now" button: check the config, claim the
 * run, and hand it to the automation worker (`jira_assets_manual_sync`). The
 * HTTP request returns at once (202), so a long sync never runs into the
 * browser's request timeout; the panel polls GET /sync/status.
 */
export async function startManualSync(
  organizationId: number,
  userId: number,
): Promise<{ historyId: number }> {
  const config = await getPublicConfig(organizationId);
  if (!config) throw new JiraNotConfiguredError();
  if (!config.selected_object_type_id) {
    throw new JiraConfigValidationError("Select an object type before syncing");
  }
  const historyId = await claimSyncRun(organizationId, "manual", userId);
  try {
    await enqueueJiraAssetsManualSync({ organizationId, historyId, triggeredBy: userId });
  } catch (err) {
    await finalizeFailure(historyId, organizationId, err);
    throw err;
  }
  return { historyId };
}

/** Claim and run a sync in-process (the scheduler's path). */
export async function syncObjects(
  organizationId: number,
  triggeredBy: number | null,
  syncType: "manual" | "scheduled",
): Promise<JiraSyncResult> {
  const historyId = await claimSyncRun(organizationId, syncType, triggeredBy);
  return runClaimedSync(organizationId, historyId, triggeredBy, syncType);
}

/**
 * Run a sync whose history row has already been claimed.
 *
 * - **Scheduled** (`syncType = "scheduled"`) is refresh-only: it updates
 *   projects and links that already exist. It never creates a use case and
 *   never deletes one. Linked objects Jira no longer returns are counted and
 *   listed as missing in the result, the history row and the log.
 * - **Manual** also creates use cases for new objects of the selected type
 *   (owned by the user who started it) and removes ones that disappeared
 *   upstream — but only when the fetch can be trusted. Deletes are skipped if
 *   the fetch was incomplete, if any link was imported from a different object
 *   type, or if any link's type is unknown. If Jira returns no objects while
 *   links exist, the run fails without changes.
 *
 * Every failure (missing config, token decrypt, client construction, Jira and
 * network errors, the fetch deadline) is recorded on the history row and the
 * config by finalizeFailure. If another claim closed this run as abandoned,
 * the run stops at the next heartbeat and writes nothing more.
 */
export async function runClaimedSync(
  organizationId: number,
  historyId: number,
  triggeredBy: number | null,
  syncType: "manual" | "scheduled",
): Promise<JiraSyncResult> {
  const refreshOnly = syncType === "scheduled";

  try {
    // Also confirms this run still owns its row (it may have waited in the queue).
    await touchHeartbeat(historyId, organizationId);
    const config = await loadFullConfig(organizationId);
    if (!config) throw new JiraNotConfiguredError();
    const objectTypeId = config.selected_object_type_id;
    if (!objectTypeId) throw new JiraConfigValidationError("No object type selected for sync");
    const client = clientFromConfig(config);

    const fetched = await client.getAllObjects(objectTypeId, {
      deadline: AbortSignal.timeout(EXTERNAL_SYNC_DEADLINE_MS),
      onPage: () => touchHeartbeat(historyId, organizationId),
    });
    if (fetched.stoppedReason === "deadline") {
      throw new JiraUpstreamError(
        `Jira did not return every object within ${EXTERNAL_SYNC_DEADLINE_MS / 1000} seconds, so nothing was changed`,
      );
    }
    const { objects: jiraObjects, complete } = fetched;
    const objectsFetched = jiraObjects.length;

    const existingRows = (await sequelize.query(
      `SELECT jira_object_id, project_id, data
         FROM jira_assets_use_cases
        WHERE organization_id = :organizationId;`,
      { replacements: { organizationId }, type: QueryTypes.SELECT },
    )) as Array<{ jira_object_id: string; project_id: number | null; data: any }>;

    if (objectsFetched === 0 && existingRows.length > 0) {
      throw new Error(
        "Jira returned no objects for the selected object type, so nothing was changed. Check the object type and the account's access.",
      );
    }

    const existingMap = new Map(existingRows.map((r) => [r.jira_object_id, r]));
    const linkedTypeIds = existingRows.map((r) => {
      const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      const id = data?.objectType?.id;
      return id === undefined || id === null || id === "" ? null : String(id);
    });

    let objectsCreated = 0;
    let objectsUpdated = 0;
    let objectsDeleted = 0;
    let linksRemoved = 0;
    const now = new Date();

    for (const [index, jiraObj] of jiraObjects.entries()) {
      const obj = describeObject(jiraObj, (jiraObj as any)._attrIdToName || {});
      const existing = existingMap.get(obj.jiraObjectId);

      if (!existing) {
        if (!refreshOnly) {
          const outcome = await createLinkedUseCase(organizationId, triggeredBy, obj, now);
          if (outcome === "created") objectsCreated++;
        }
      } else {
        await sequelize.transaction(async (transaction) => {
          if (existing.project_id !== null) {
            await sequelize.query(
              `UPDATE projects
                  SET project_title = :title, goal = :goal, last_updated = :now
                WHERE id = :projectId AND organization_id = :organizationId;`,
              {
                replacements: {
                  title: obj.name,
                  goal: obj.goal,
                  now,
                  projectId: existing.project_id,
                  organizationId,
                },
                transaction,
              },
            );
          }
          await sequelize.query(
            `UPDATE jira_assets_use_cases
                SET data = CAST(:data AS JSONB),
                    last_synced_at = :now,
                    sync_status = 'synced',
                    updated_at = NOW()
              WHERE jira_object_id = :jiraObjectId AND organization_id = :organizationId;`,
            {
              replacements: {
                data: JSON.stringify(obj.data),
                now,
                jiraObjectId: obj.jiraObjectId,
                organizationId,
              },
              transaction,
            },
          );
        });
        objectsUpdated++;
      }
      existingMap.delete(obj.jiraObjectId);
      if ((index + 1) % HEARTBEAT_EVERY_OBJECTS === 0) {
        await touchHeartbeat(historyId, organizationId);
      }
    }

    // Whatever is left in existingMap was not returned by Jira.
    const missingIds = Array.from(existingMap.keys());
    let deletesSkippedReason: string | undefined;
    if (missingIds.length > 0 && !refreshOnly) {
      if (!complete) {
        deletesSkippedReason =
          "Jira did not confirm the last page of results, so missing objects were not removed";
      } else if (linkedTypeIds.some((id) => id === null)) {
        deletesSkippedReason =
          "skipped: type unknown — some use cases have no recorded object type, so missing objects were not removed";
      } else if (linkedTypeIds.some((id) => id !== String(objectTypeId))) {
        deletesSkippedReason =
          "some use cases were imported from a different object type, so missing objects were not removed";
      }
    }

    let note: string | null = null;
    if (missingIds.length > 0 && (refreshOnly || deletesSkippedReason)) {
      note = missingNote(
        missingIds,
        refreshOnly ? "automatic sync never removes use cases" : (deletesSkippedReason as string),
      );
      logStructured("processing", `Jira Assets run ${historyId}: ${note}`, "syncObjects", fileName);
    } else if (missingIds.length > 0) {
      // Manual sync with a trustworthy fetch. Confirm we still own the run
      // before the only destructive step.
      await touchHeartbeat(historyId, organizationId);
      for (const [jiraObjectId, record] of existingMap) {
        if (record.project_id !== null) {
          // The jira_assets_use_cases row cascades via FK.
          const [deleted] = (await sequelize.query(
            `DELETE FROM projects
              WHERE id = :projectId AND organization_id = :organizationId
              RETURNING id;`,
            { replacements: { projectId: record.project_id, organizationId } },
          )) as unknown as [Array<{ id: number }>, unknown];
          if (deleted && deleted.length > 0) objectsDeleted++;
        } else {
          // A link with no project: nothing to remove but the link itself.
          const [removed] = (await sequelize.query(
            `DELETE FROM jira_assets_use_cases
              WHERE jira_object_id = :jiraObjectId AND organization_id = :organizationId
                AND project_id IS NULL
              RETURNING id;`,
            { replacements: { jiraObjectId, organizationId } },
          )) as unknown as [Array<{ id: number }>, unknown];
          if (removed && removed.length > 0) linksRemoved++;
        }
      }
    }

    await finalizeSuccess(
      historyId,
      organizationId,
      { objectsFetched, objectsCreated, objectsUpdated, objectsDeleted },
      note,
      true,
    );

    const keptMissing = note ? missingIds : [];
    return {
      success: true,
      objectsFetched,
      objectsCreated,
      objectsUpdated,
      objectsDeleted,
      linksRemoved,
      objectsMissingInJira: keptMissing.length,
      missingInJiraIds: keptMissing,
      deletesSkippedReason,
      syncedAt: new Date().toISOString(),
      status: "success",
    };
  } catch (err) {
    if (err instanceof RunSupersededError) {
      // Another claim already closed this row; write nothing more.
      logger.warn(err.message);
      return failedResult(`failed: ${err.message}`);
    }
    const message = await finalizeFailure(historyId, organizationId, err);
    return failedResult(`failed: ${message}`);
  }
}

/**
 * Worker entry for `jira_assets_manual_sync`. Fails closed on a malformed
 * payload (tenant-isolation runbook §4.3): the claimed row then goes stale
 * and is closed by the next claim.
 */
export async function runQueuedManualSync(data: unknown): Promise<JiraSyncResult> {
  const payload = data as { organizationId?: unknown; historyId?: unknown; triggeredBy?: unknown };
  const organizationId = Number(payload?.organizationId);
  const historyId = Number(payload?.historyId);
  const triggeredBy = payload?.triggeredBy === null ? null : Number(payload?.triggeredBy);
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error("jira_assets_manual_sync: organizationId missing or invalid");
  }
  if (!Number.isInteger(historyId) || historyId <= 0) {
    throw new Error("jira_assets_manual_sync: historyId missing or invalid");
  }
  if (triggeredBy !== null && (!Number.isInteger(triggeredBy) || triggeredBy <= 0)) {
    throw new Error("jira_assets_manual_sync: triggeredBy invalid");
  }
  return runClaimedSync(organizationId, historyId, triggeredBy, "manual");
}

// ---------------------------------------------------------------------------
// Use-case reads / delete
// ---------------------------------------------------------------------------

export async function listUseCases(organizationId: number): Promise<any[]> {
  return (await sequelize.query(
    `SELECT j.*, p.uc_id, p.project_title AS name
       FROM jira_assets_use_cases j
  LEFT JOIN projects p ON j.project_id = p.id AND p.organization_id = :organizationId
      WHERE j.organization_id = :organizationId
      ORDER BY j.created_at DESC;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as any[];
}

export async function getUseCaseByProjectId(
  projectId: number,
  organizationId: number,
): Promise<any | null> {
  const rows = (await sequelize.query(
    `SELECT * FROM jira_assets_use_cases
      WHERE project_id = :projectId AND organization_id = :organizationId;`,
    { replacements: { projectId, organizationId }, type: QueryTypes.SELECT },
  )) as any[];
  const uc = rows[0];
  if (!uc) return null;
  const data = typeof uc.data === "string" ? JSON.parse(uc.data) : uc.data;

  const projects = (await sequelize.query(
    `SELECT * FROM projects WHERE id = :projectId AND organization_id = :organizationId;`,
    { replacements: { projectId, organizationId }, type: QueryTypes.SELECT },
  )) as any[];
  const nativeProject = projects[0] || {};

  const frameworks = (await sequelize.query(
    `SELECT pf.id, pf.framework_id, pf.id AS project_framework_id
       FROM projects_frameworks pf
      WHERE pf.project_id = :projectId AND pf.organization_id = :organizationId;`,
    { replacements: { projectId, organizationId }, type: QueryTypes.SELECT },
  )) as any[];

  return {
    id: uc.project_id,
    uc_id: nativeProject.uc_id ?? uc.uc_id,
    project_title: nativeProject.project_title ?? data?.label ?? data?.attributes?.Name ?? uc.uc_id,
    owner: nativeProject.owner ?? null,
    members: [],
    start_date: nativeProject.start_date ?? data?.created ?? uc.created_at,
    ai_risk_classification: nativeProject.ai_risk_classification ?? null,
    type_of_high_risk_role: nativeProject.type_of_high_risk_role ?? null,
    goal: nativeProject.goal ?? data?.attributes?.Description ?? data?.attributes?.Purpose ?? "",
    last_updated: nativeProject.last_updated ?? data?.updated ?? uc.updated_at,
    last_updated_by: nativeProject.last_updated_by ?? null,
    is_organizational: nativeProject.is_organizational ?? false,
    framework: frameworks,
    monitored_regulations_and_standards: [],
    _source: "jira-assets",
    _jira_use_case_id: uc.id,
    _jira_data: data,
    _sync_status: uc.sync_status,
  };
}

export async function deleteUseCaseByProjectId(
  projectId: number,
  organizationId: number,
): Promise<void> {
  // Cascade deletes the jira_assets_use_cases row via FK.
  await sequelize.query(
    `DELETE FROM projects WHERE id = :projectId AND organization_id = :organizationId;`,
    { replacements: { projectId, organizationId } },
  );
}

// ---------------------------------------------------------------------------
// Sync status + history
// ---------------------------------------------------------------------------

/**
 * Last-sync fields plus, computed in SQL, whether a sync or import is running
 * now (`running`) and the latest manual or scheduled run (`latest_run`). The
 * panel polls this after "Sync now" (which returns 202 and runs in the
 * worker) until `running` is false.
 */
export async function getSyncStatus(organizationId: number): Promise<any | null> {
  const rows = (await sequelize.query(
    `SELECT c.last_sync_at, c.last_sync_status, c.last_sync_message,
            c.sync_enabled, c.sync_interval_hours,
            EXISTS (SELECT 1
                      FROM jira_assets_sync_history h
                     WHERE h.organization_id = :organizationId
                       AND h.status = 'started'
                       AND ${SQL_RUN_IS_LIVE}) AS running,
            (SELECT row_to_json(r)
               FROM (SELECT id, sync_type, status, objects_fetched, objects_created,
                            objects_updated, objects_deleted, error_message,
                            started_at, completed_at
                       FROM jira_assets_sync_history
                      WHERE organization_id = :organizationId
                        AND sync_type IN ('manual', 'scheduled')
                      ORDER BY started_at DESC, id DESC
                      LIMIT 1) r) AS latest_run
       FROM jira_assets_config c
      WHERE c.organization_id = :organizationId
      LIMIT 1;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as any[];
  return rows[0] ?? null;
}

export async function getSyncHistory(organizationId: number, limit: number): Promise<any[]> {
  return (await sequelize.query(
    `SELECT * FROM jira_assets_sync_history
      WHERE organization_id = :organizationId
      ORDER BY started_at DESC LIMIT :limit;`,
    { replacements: { organizationId, limit }, type: QueryTypes.SELECT },
  )) as any[];
}

// ---------------------------------------------------------------------------
// Custom-frameworks progress (used by JIRA use-case Overview UI)
// ---------------------------------------------------------------------------

export async function getCustomFrameworksProgress(
  projectId: number,
  organizationId: number,
): Promise<Array<Record<string, unknown>>> {
  const tables = (await sequelize.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'verifywise' AND table_name = 'custom_frameworks' LIMIT 1;`,
    { type: QueryTypes.SELECT },
  )) as Array<{ table_name: string }>;
  if (tables.length === 0) return [];

  const frameworks = (await sequelize.query(
    `SELECT cf.id, cf.name, cf.plugin_key, cf.hierarchy_type,
            cfp.id AS project_framework_id
       FROM custom_frameworks cf
       JOIN custom_framework_projects cfp
         ON cf.id = cfp.framework_id
        AND cfp.organization_id = :organizationId
      WHERE cfp.project_id = :projectId AND cf.organization_id = :organizationId
      ORDER BY cf.name;`,
    { replacements: { projectId, organizationId }, type: QueryTypes.SELECT },
  )) as Array<{
    id: number;
    name: string;
    plugin_key: string | null;
    hierarchy_type: string;
    project_framework_id: number;
  }>;

  const results: Array<Record<string, unknown>> = [];
  for (const fw of frameworks) {
    let total = 0;
    let completed = 0;
    try {
      if (fw.hierarchy_type === "three_level") {
        const stats = (await sequelize.query(
          `SELECT COUNT(*)::int AS total,
                  SUM(CASE WHEN l3.status = 'Implemented' THEN 1 ELSE 0 END)::int AS completed
             FROM custom_framework_level3_impl l3
             JOIN custom_framework_level2_impl l2
               ON l3.level2_impl_id = l2.id AND l2.organization_id = :organizationId
            WHERE l2.project_framework_id = :projectFrameworkId
              AND l3.organization_id = :organizationId;`,
          {
            replacements: {
              projectFrameworkId: fw.project_framework_id,
              organizationId,
            },
            type: QueryTypes.SELECT,
          },
        )) as Array<{ total: number; completed: number }>;
        total = stats[0]?.total ?? 0;
        completed = stats[0]?.completed ?? 0;
      } else {
        const stats = (await sequelize.query(
          `SELECT COUNT(*)::int AS total,
                  SUM(CASE WHEN status = 'Implemented' THEN 1 ELSE 0 END)::int AS completed
             FROM custom_framework_level2_impl
            WHERE project_framework_id = :projectFrameworkId
              AND organization_id = :organizationId;`,
          {
            replacements: {
              projectFrameworkId: fw.project_framework_id,
              organizationId,
            },
            type: QueryTypes.SELECT,
          },
        )) as Array<{ total: number; completed: number }>;
        total = stats[0]?.total ?? 0;
        completed = stats[0]?.completed ?? 0;
      }
    } catch (err: any) {
      // Progress query is best-effort — an oddly-shaped framework shouldn't
      // 500 the whole endpoint.
      console.error(`[jira-assets] progress query failed for '${fw.name}': ${err.message}`);
    }
    results.push({
      framework_id: fw.id,
      name: fw.name,
      plugin_key: fw.plugin_key,
      total,
      completed,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    });
  }
  return results;
}
