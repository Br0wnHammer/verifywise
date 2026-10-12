/**
 * PUT /api/ai-gateway/guardrails/settings, handled before the generic AI
 * Gateway proxy so retention changes leave a trace in the audit ledger.
 *
 * The request is forwarded unchanged with the caller's own organization, user
 * and role; the gateway still enforces admin-only access and validation, and
 * its status and body are returned as they are, errors included.
 */

import { Request, Response } from "express";
import { AiGatewayError, aiGatewayRequest } from "../utils/aiGatewayInternal.utils";
import { appendToAuditLedger } from "../utils/auditLedger.utils";
import { logFailure } from "../utils/logger/logHelper";
import logger from "../utils/logger/fileLogger";

const FILE_NAME = "aiGatewaySettings.ctrl.ts";
const SETTINGS_PATH = "/internal/guardrails/settings";

/** The gateway's values for an organization that has not saved its own settings. */
const GATEWAY_DEFAULTS = {
  log_retention_days: 90,
  spend_log_retention_days: 90,
  auto_purge_enabled: false,
};

type RetentionKey = keyof typeof GATEWAY_DEFAULTS;

const RETENTION_LABELS: Record<RetentionKey, string> = {
  log_retention_days: "guardrail log retention",
  spend_log_retention_days: "spend log retention",
  auto_purge_enabled: "automatic deletion",
};

function formatValue(key: RetentionKey, value: unknown): string {
  if (value === undefined || value === null) return "unknown";
  if (key === "auto_purge_enabled") return value ? "on" : "off";
  return `${value} days`;
}

/** Describe each retention value that differs between two settings objects. */
export function describeRetentionChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string[] {
  const changes: string[] = [];
  for (const key of Object.keys(RETENTION_LABELS) as RetentionKey[]) {
    if (!(key in after)) continue;
    const oldValue = before ? (before[key] ?? GATEWAY_DEFAULTS[key]) : undefined;
    if (oldValue === after[key]) continue;
    changes.push(
      `${RETENTION_LABELS[key]} from ${formatValue(key, oldValue)} to ${formatValue(key, after[key])}`,
    );
  }
  return changes;
}

export async function updateGuardrailSettings(req: Request, res: Response): Promise<any> {
  const fn = "updateGuardrailSettings";
  const tenant = {
    organizationId: req.organizationId!,
    role: req.role,
    userId: req.userId,
  };

  let before: Record<string, unknown> | null = null;
  try {
    const current = await aiGatewayRequest("GET", SETTINGS_PATH, tenant);
    before = current?.settings ?? {};
  } catch (error) {
    // The update still goes through; the ledger entry will say "unknown".
    logger.warn(
      `AI Gateway request ${SETTINGS_PATH} failed: ${(error as Error)?.message ?? error}`,
    );
  }

  let updated: any;
  try {
    updated = await aiGatewayRequest("PUT", SETTINGS_PATH, { ...tenant, body: req.body ?? {} });
  } catch (error) {
    if (error instanceof AiGatewayError) {
      return typeof error.body === "string"
        ? res.status(error.status).send(error.body)
        : res.status(error.status).json(error.body);
    }
    logger.error(`AI Gateway request ${SETTINGS_PATH} failed:`, error);
    return res.status(502).json({
      error: "AI Gateway proxy error",
      message: (error as Error)?.message || "Unknown error",
    });
  }

  const changes = describeRetentionChanges(before, updated?.settings ?? {});
  if (changes.length > 0) {
    const description = `AI Gateway retention changed: ${changes.join("; ")}`;
    try {
      await appendToAuditLedger({
        organizationId: req.organizationId!,
        entryType: "event_log",
        userId: req.userId ?? null,
        eventType: "Update",
        entityType: "data_retention",
        description,
      });
    } catch (ledgerError) {
      // The settings are saved, so the request still succeeds, but the missing
      // ledger entry must leave a trace.
      await logFailure({
        eventType: "Update",
        description: `${description} but the audit ledger entry could not be written (organization ${req.organizationId}): ${(ledgerError as Error)?.message ?? ledgerError}`,
        functionName: fn,
        fileName: FILE_NAME,
        userId: req.userId!,
        organizationId: req.organizationId,
        error: ledgerError as Error,
      });
    }
  }

  return res.status(200).json(updated);
}
