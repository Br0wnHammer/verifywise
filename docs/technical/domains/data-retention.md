# Data retention

Admins see and set how long each kind of record is kept in **Settings → Data retention**. Audit records default to **keep indefinitely**, and AI Gateway automatic deletion is **off by default**, so nothing is deleted until an Admin opts in. Design: `docs/superpowers/specs/2026-10-11-data-retention-design.md`.

## What is configurable

| Records | Where it is set | Deleted by |
|---|---|---|
| Audit records (audit ledger, event log, change history tables, AI Advisor action log, file access logs) | `data_retention_settings.audit_retention_months` | `data_retention_prune` |
| AI Gateway guardrail logs | `ai_gateway_guardrail_settings.log_retention_days` | gateway purge (manual button, or the daily job when `auto_purge_enabled`) |
| AI Gateway spend logs | `ai_gateway_guardrail_settings.spend_log_retention_days` | same |
| Agent Control logs | `mcp_audit_retention_days` env (deployment-wide, read only in the tab) | daily job `mcp_audit_cleanup` (calls the gateway) |
| Model risk metrics | `mrm_org_settings.retention_months` | `mrm_retention_prune` |
| Evidence files | org default in `file_org_settings`, per-file `retention_policy` | never deleted (archived) |
| Shadow AI events, daily rollups, alert history | Shadow AI settings | `shadowAiAggregation.service.ts` |
| Server logs | `LOG_RETENTION_DAYS` env (default 14), see [CONFIGURATION_REFERENCE.md](../../deployment/CONFIGURATION_REFERENCE.md) | winston daily rotation |

Each row saves through its feature's existing endpoint; only audit records use the new one. The tab is shown with the Audit ledger tab (`Clients/src/presentation/pages/SettingsPage/index.tsx`).

## Audit records setting

- Periods: keep indefinitely (`NULL`, default), 1, 2, 3, 5, 7, 10 years, stored as months 12, 24, 36, 60, 84, 120. The table CHECK and the controller both reject anything else (400).
- Table `data_retention_settings` (one row per org; a missing row means keep indefinitely).
- A change appends an `event_log` entry to the audit ledger. Shortening the period opens a confirmation in the UI showing how many records the next cleanup will delete.

API (all `authorize("organization.admin")`, `Servers/routes/dataRetention.route.ts`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/data-retention` | every row of the tab in one response; AI Gateway rows show as unavailable if the gateway is unreachable |
| GET | `/api/data-retention/audit-records/preview?months=N` | number of records a period would delete |
| PUT | `/api/data-retention/audit-records` | set the audit period |

## Admin-only rule

Only Admins change organization-wide periods, checked on the server. Non-Admins get 403 "Only admins can change retention periods". `PUT /api/mrm/settings` returns 403 when the body contains `retention_months` and the caller is not an Admin or SuperAdmin; alert settings in the same endpoint are unchanged. AI Gateway settings use `require_admin`; file org default and Shadow AI settings were already Admin only. Per-file evidence retention (`retention_policy`, `expiry_date`) keeps today's permissions: project members and the file's owner.

Every retention change leaves a ledger entry (`entity_type` `data_retention`, `event_type` `Update`): the audit period (`PUT /api/data-retention/audit-records`), the MRM metric period (`updateMrmSettingsHandler`, only when `retention_months` actually changes) and the AI Gateway periods. For the gateway, Express handles `PUT /api/ai-gateway/guardrails/settings` itself (`controllers/aiGatewaySettings.ctrl.ts`, registered before the proxy in `routes/aiGateway.route.ts`): it reads the current settings, forwards the PUT with the caller's org, user and role, returns the gateway's status and body unchanged (errors included), and appends one entry when `log_retention_days`, `spend_log_retention_days` or `auto_purge_enabled` changed. A failed append is logged and never fails the request.

## Daily job

`data_retention_prune`, cron `30 3 * * *` (`automationProducer.ts`), action `services/automations/actions/dataRetentionPrune.ts`.

- Runs org by org; one org's failure is logged and does not stop the others. An org with no audit period is skipped.
- Deletes in batches of 10,000 (`RETENTION_BATCH_SIZE`), at most 500 batches per table per org per run (`RETENTION_MAX_BATCHES`); a capped run continues the next day.
- Order per org: audit ledger, then each table in `AUDIT_RECORD_TABLES` (`utils/dataRetention.utils.ts`: `event_logs`, the change history tables, `ai_action_audit_log`, `file_access_logs`) with `WHERE organization_id = :org AND <timestamp> < :cutoff`. A failing table is recorded and the rest continue.
- Every transaction calls `set_config('app.current_org', :orgId, true)`.
- If anything was deleted, one ledger entry is appended: "Retention removed N audit records before <date>".
- Each run writes a row to `data_retention_runs` (`record_type`, `cutoff`, `deleted_count`, `status` of `success`, `capped` or `failed`, `error`); the tab reads it for "Last cleanup". The MRM prune and the Shadow AI cleanup also record runs there.
- After the audit work the job calls the AI Gateway (below).

## Audit ledger pruning and why verification still holds

The ledger is a per-org hash chain: each row's `prev_hash` is the previous row's `entry_hash`. Deleting rows from the middle would break it, so pruning only removes the oldest prefix.

`pruneAuditLedgerBatch` (`utils/auditLedgerRetention.utils.ts`), one transaction per batch:

1. Takes `pg_advisory_xact_lock(9001, orgId)`, the lock every append takes, so no append is in flight.
2. Bounds the delete by id, not by timestamp (`occurred_at` is not strictly monotonic with id): deletable rows are those below the smallest id still inside the retention period. If every row is old, the bound is the newest id, so the newest entry is always kept and the next append still links to a real row.
3. Inserts a row in `audit_ledger_retention_checkpoints` with `pruned_through_id` (last deleted id) and `anchor_hash` (that row's `entry_hash`).
4. Sets `verifywise.ledger_retention = 'on'` and deletes ids up to the checkpoint.

The delete trigger (migration `20261011150100`) allows a delete only when the org no longer exists (cascade), or when all of these hold: the flag is on; a checkpoint for the org was written in the same transaction (`created_txid = txid_current()`); `OLD.id <= pruned_through_id`; `OLD.occurred_at < cutoff`; and the cutoff is at least 12 months old, the shortest period an Admin can pick. Everything else raises. This guards against mistakes, not against someone with full database access.

The checkpoint table is append-only: triggers reject UPDATE and DELETE except on organization cascade. The migration's `down()` refuses to run once any checkpoint exists, because dropping the table would lose the prune record and make every pruned ledger fail verification.

`verifyChain` (`utils/auditLedger.utils.ts`) opens one `REPEATABLE READ` read-only transaction, reads the latest checkpoint, and walks the chain by keyset paging inside that snapshot. With a checkpoint it first checks that no row with `id <= pruned_through_id` remains (a legitimate prune deletes them all, so a leftover row means a forged checkpoint hid a deletion from the middle, reported as `compromised` at that row), then starts from `prevHash = anchor_hash`; without one it starts from the genesis hash. So the remaining rows are still checked end to end: the first row must link to the recorded hash of the last deleted row, and every later row must link to its predecessor. Editing a remaining row, or changing the anchor, breaks the match and reports `compromised`. The single snapshot means a prune committing during verification cannot move the anchor under the walk. The result carries `prunedThrough: { id, cutoff }`, and the Audit ledger page shows "Records before <date> removed by retention policy".

What verification cannot prove is the content of deleted rows. The checkpoints record that a prune happened and up to which row, and the self-audit ledger entry records how many rows were removed.

## AI Gateway

Alembic `a0011_retention.py`, on `ai_gateway_guardrail_settings`:

- `spend_log_retention_days INTEGER NOT NULL DEFAULT 90` (CHECK >= 1). The spend purge already read this column, which did not exist before.
- `auto_purge_enabled BOOLEAN NOT NULL DEFAULT false`.
- Indexes `(organization_id, changed_at)` on both gateway change history tables.

`upsert_guardrail_settings` (`AIGateway/src/crud/guardrails.py`) is now a partial update: an existing row changes only the keys present in the request, a new row takes defaults for the rest. Saving one value from the Data retention tab no longer resets the others.

Internal endpoints (internal key auth only, `AIGateway/src/routers/retention.py`):

- `GET /internal/retention/config` returns `{ mcp_audit_retention_days }`.
- `POST /internal/retention/purge` purges guardrail and spend logs for every org with `auto_purge_enabled`, using that org's own periods, up to 500 batches of 1,000 rows per log type per org (the manual purge keeps 50), and returns `{ results: [{ organization_id, guardrail_deleted, guardrail_capped, spend_deleted, spend_capped, guardrail_error?, spend_error? }] }`. Each log type is purged and reported on its own, so one failing does not mark the other failed; `*_capped` means the last allowed batch was full.

The Node job calls the purge endpoint after the audit work with a 5-minute timeout (`GATEWAY_PURGE_TIMEOUT_MS`) and records a run per org for `ai_gateway_guardrail_logs` and `ai_gateway_spend_logs` with status `success`, `capped` or `failed` per type. If the call itself fails, every org with `auto_purge_enabled` (read from `ai_gateway_guardrail_settings`, skipped if the table does not exist) gets a `failed` run for both types. A gateway failure is logged and never fails the job.

The Data retention tab asks for confirmation before a gateway save that turns automatic deletion on, or shortens a period while it is on.

## Tests

Real-DB: `Servers/tests/integration/audit-ledger-retention.test.ts` (prune then verify, trigger rejections, checkpoint immutability) and `tenant-isolation/data-retention.isolation.test.ts`. Unit tests sit beside the utils, controller and job; gateway tests are in `AIGateway/tests/test_retention.py`.
