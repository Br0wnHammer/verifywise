# Data retention — design

**Date:** 2026-10-11
**Status:** design approved in chat; this spec awaits review
**Customer item:** 12. Retention — "How long are logs kept, and is the
retention period configurable?" Current answer: Partially.

## Goal

An Admin can see and set how long every kind of log is kept, in one place,
and audit records stop being "kept forever, not configurable" without
breaking the audit ledger's tamper evidence.

## Decisions (approved)

1. Audit records default to **keep indefinitely**. Nothing is deleted until an
   Admin picks a period.
2. Periods for audit records: indefinitely, 1, 2, 3, 5, 7, 10 years. The floor
   is 1 year (EU AI Act Art. 19(1) and 26(6) require at least six months for
   high-risk system logs).
3. **One** setting covers all audit records: audit ledger, event log, the 17
   change history tables, AI Advisor action log, file access logs. The ledger
   mirrors the event log and change history, so separate periods would leave
   one copy deleted and the other kept.
4. AI Gateway guardrail and spend logs get a "Delete automatically" switch,
   **off by default**, so shipping this deletes nothing on its own.
5. File access logs are included under audit records.
6. AI Advisor conversations are out of scope (chats, not logs; the unenforced
   30-day constant in `Servers/advisor/memory/memoryConfig.ts:19` is a separate
   product decision).
7. A new **Settings → Data retention** tab (Admin only) lists every kind of
   record in one table.

## Current state (verified on develop ba7bf9059)

| Records | Setting today | Deletion today |
|---|---|---|
| Audit ledger (`audit_ledger`) | none | never; a trigger rejects every DELETE except the organization cascade |
| Event log (`event_logs`) | none | never |
| Change history (17 tables, `Servers/config/changeHistory.config.ts`) | none | only via entity FK cascade where one exists |
| AI Advisor action log (`ai_action_audit_log`) | none | never |
| File access logs (`file_access_logs`) | none | never |
| AI Gateway guardrail logs | `ai_gateway_guardrail_settings.log_retention_days` (default 90), AI Gateway → Settings | manual "Purge old logs" button; no confirmation, errors swallowed |
| AI Gateway spend logs | reads `spend_log_retention_days`, a column that does not exist; silently 90 days | manual purge |
| Agent Control tool-call logs and approvals | `mcp_audit_retention_days` env (default 30), deployment-wide | daily job `mcp_audit_cleanup` |
| Model risk management metrics | `mrm_org_settings.retention_months` (default 25, min 13) | daily job `mrm_retention_prune` |
| Evidence files | per-file `retention_policy` + org default (`file_org_settings`) | daily `file_expiry_sweep` notifies and optionally archives; never deletes |
| Server logs (self-hosted) | hard-coded 14 days (`Servers/utils/logger/fileLogger.ts`) | winston daily rotation |

## Design

### 1. Audit records setting

- New column `feature_settings.audit_retention_months INT NULL`
  (`NULL` = keep indefinitely), `CHECK (audit_retention_months IN (12, 24, 36, 60, 84, 120))`.
- Saving upserts the `feature_settings` row (the read path already tolerates
  a missing row; the update path does not).
- Read and written through new Data retention endpoints (section 5), Admin
  only (`authorize("organization.admin")`, same as file org settings).
- A change writes an audit ledger `event_log` entry: "Audit record retention
  changed from X to Y".

### 2. Audit ledger: pruning without breaking verification

**Checkpoint table** `audit_ledger_retention_checkpoints`:
`id BIGSERIAL, organization_id INT NOT NULL REFERENCES organizations ON DELETE CASCADE,
pruned_through_id BIGINT NOT NULL, anchor_hash CHAR(64) NOT NULL,
cutoff TIMESTAMPTZ NOT NULL, rows_deleted INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()`.
Append-only: UPDATE and DELETE are rejected by triggers (except the
organization cascade, as for the ledger). It is the permanent record of every
prune. Registered in the tenant-isolation and RLS registries.

**Prune of one org** (one transaction per batch):

1. Take `pg_advisory_xact_lock(9001, orgId)`, the lock every append takes, so
   no append is in flight.
2. Bound: `B = MIN(id) WHERE organization_id = :org AND occurred_at >= :cutoff`,
   and never above the newest id (the newest entry is always kept, so the
   chain is never empty and the next append still links to a real row).
   Deletable rows are `id < B`. Using id order rather than `occurred_at`
   matters: `occurred_at` is `NOW()` at transaction start, so it is not
   strictly monotonic with id.
3. Take the oldest batch of deletable rows (up to 10,000; one checkpoint row
   per batch, so a large batch keeps the checkpoint table small). Let `L` be
   the highest id in the batch. Insert a checkpoint
   `(pruned_through_id = L, anchor_hash = entry_hash of L)`.
4. `SET LOCAL verifywise.ledger_retention = 'on'`, then delete ids
   `<= L` for the org.
5. Commit. Repeat until nothing is deletable or the per-run cap is hit.

**Delete trigger** (new migration, replaces `audit_ledger_prevent_delete`):
allow when the organization no longer exists (unchanged), or when
`current_setting('verifywise.ledger_retention', true) = 'on'` and
`OLD.id <= ` the org's latest checkpoint `pruned_through_id`. Every other
delete is still rejected. This guards against mistakes, not against someone
with full database access.

**Verification:** `verifyChain` reads the org's latest checkpoint. With one,
it starts with `prevHash = anchor_hash` and requires the first remaining row
to have `id > pruned_through_id`; without one, it starts from `GENESIS_HASH`
as today. The result gains `prunedThrough?: { id, cutoff }`, and the Audit
ledger page shows "Records before <date> removed by retention policy".

### 3. Other audit tables

`event_logs` (`timestamp`), the 17 change history tables (`changed_at`, plus
the two AI Gateway-owned `ai_gateway_endpoint_change_history` and
`ai_gateway_guardrail_change_history`), `ai_action_audit_log` (`created_at`)
and `file_access_logs` (`access_date`): batched deletes
`WHERE organization_id = :org AND <ts> < :cutoff`, oldest first, 10,000 per
batch. The table list comes from one constant; the change history list is
derived from `changeHistory.config.ts` so a new entity type is covered
automatically. Indexes on `(organization_id, <ts>)` are added where missing.

### 4. Daily job

`data_retention_prune`, cron `30 3 * * *` (03:00, 04:00 and 04:30 are taken),
registered in `automationProducer.ts` like `mrm_retention_prune`, with the
worker branch and an action module modeled on `mrmRetentionPrune.ts`.

- Organization by organization, try/catch per org; capped per run (500
  batches per table); the remainder goes to the next day.
- Each org's work runs in a transaction with `SET LOCAL app.current_org`, so
  it still works when row-level security enforcement is on. (The existing
  MRM prune does not do this; out of scope here, noted.)
- After an org's audit records are pruned and at least one row was deleted,
  append one ledger entry: "Retention removed N audit records before <date>".
- AI Gateway: for orgs with "Delete automatically" on, the job calls a new
  internal gateway endpoint that purges guardrail and spend logs with each
  org's own periods and returns per-org counts.
- Every run writes a row per org and record type to `data_retention_runs`
  (`organization_id`, `record_type`, `ran_at`, `cutoff`, `deleted_count`,
  `status`, `error`), which the Data retention tab reads for "Last cleanup".
  The existing MRM prune and Agent Control cleanup also record their runs
  there (Agent Control as deployment-wide, `organization_id NULL`).

### 5. Settings → Data retention tab

Admin only (the same gate as the Audit ledger tab). One table:

| Column | Content |
|---|---|
| Records | name and one-line description |
| Kept for | current period |
| Automatic deletion | Yes / No / Archived, not deleted (evidence) |
| Last cleanup | date and count from `data_retention_runs`, or "—" |
| | Edit, or "Set by deployment: <ENV_VAR>" |

Rows: audit records; AI Gateway guardrail logs; AI Gateway spend logs; Agent
Control tool-call logs and approvals; model risk management metrics; evidence
files (org default); server logs.

- **Editable here:** audit records, AI Gateway guardrail and spend logs
  (period and "Delete automatically"), model risk management metrics,
  evidence file default. Each row saves through its feature's existing
  endpoint (or the new one for audit records); nothing is stored twice.
  Existing pages keep their own controls.
- **Read only:** Agent Control and server logs, showing the value and the
  env var. The backend reports the server-log value; the gateway reports its
  `mcp_audit_retention_days` through an internal config endpoint.
- **Shortening the audit records period** opens a confirmation (StandardModal)
  with the number of records the next cleanup will delete (a count query) and
  a link to Export CSV on the Audit ledger page.
- Backend: `GET /api/data-retention` returns every row in one response;
  `PUT /api/data-retention/audit-records` sets the audit period.
  AI Gateway, MRM and file settings are written through their existing APIs.

### 6. AI Gateway changes (Alembic `a0011`)

- Add `spend_log_retention_days INT NOT NULL DEFAULT 90` (the column the
  spend purge already reads) and `auto_purge_enabled BOOLEAN NOT NULL DEFAULT false`
  to `ai_gateway_guardrail_settings`.
- Settings read/write include both; `POST /internal/retention/purge` purges
  for every org with `auto_purge_enabled`, returning
  `[{ organization_id, guardrail_deleted, spend_deleted }]`.
- AI Gateway → Settings: "Purge old logs" gets a confirmation and shows the
  deleted count or the error; a "Delete automatically" toggle and a spend log
  period field are added.

### 7. Server logs

`LOG_RETENTION_DAYS` env (default 14, minimum 1) replaces the hard-coded
`maxFiles: "14d"`; documented in `.env.example` and the deployment guide.

## Errors and edge cases

- The job never throws out of one org into another; failures are recorded
  in `data_retention_runs` with `status = 'failed'`.
- An org with the ledger switched off still has its other audit tables pruned.
- Changing the period back to indefinitely stops pruning; deleted records are
  gone (the confirmation says so).
- Verify chain on a pruned ledger with a tampered checkpoint or a tampered
  first row reports `compromised`.
- Concurrent appends during a prune wait on the advisory lock (same as two
  appends today).

## Testing

- Unit: cutoff/bound selection (non-monotonic `occurred_at`, newest row kept,
  empty ledger), batch loop and cap, per-org isolation, run recording.
- Real DB integration (the ledger trigger cannot be mocked): prune then
  `verifyChain` is `intact`; a delete without the flag is rejected; a delete
  above the checkpoint is rejected; checkpoint UPDATE/DELETE rejected;
  appends after a prune link correctly.
- Controller: Admin only, validation of allowed periods, upsert of a missing
  `feature_settings` row, ledger entry on change.
- AI Gateway pytest: new columns, internal purge only touches orgs with the
  switch on.
- Client: Data retention tab rows, read-only rows, confirmation on
  shortening, purge button confirmation and result.
- i18n de/fr/es for every new string.

## Out of scope

AI Advisor conversations; legal hold; per-type audit periods; moving existing
module settings; RLS context in the existing MRM prune.

## Noted, not fixed here

`PUT /api/mrm/settings` has no role check: any signed-in user can change
model risk management retention (`Servers/routes/mrm.route.ts:111`). The
Data retention tab writes through it, so the tab itself is Admin only, but
the endpoint stays open until decided.
