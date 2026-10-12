# Extension sync engine: design

**Date:** 2026-10-12
**Status:** design approved in chat (2026-10-12); this spec is the written version
**Branch:** `feat/extension-sync-engine`
**Related:** `docs/technical/infrastructure/extensions.md` ("Scheduled sync"), the Jira incident sync research (local research note, not in the repo)

## Goal

Move the run lifecycle that Jira Assets built for itself (claim, heartbeat, abandoned-run detection, history, schedule, "Sync now", status) into one engine that any extension can use. Jira Assets moves onto it first, and users must see no change. The Jira incident sync is built on it next, and MLflow and Azure AI Foundry can gain scheduled sync later by implementing the provider contract.

Success means:

- Jira Assets works exactly as before, on the engine.
- A new extension gets scheduled and on-demand runs, history and status by implementing one provider interface and registering it. It writes no claim, heartbeat, history or scheduler code of its own.

## Decisions (approved)

1. **Scope: per-org runs only**, both scheduled and on-demand. Webhook handling and per-record push jobs, which the incident sync needs, stay inside that extension as ordinary BullMQ jobs. They need no claim, heartbeat or history.
2. **One claim per (extension, organization) covers every exclusive operation** of that extension, not only syncs. Jira Assets' `import`, `remove_missing` and single use-case delete take the same claim as its syncs today and must keep doing so.
3. **Two shared tables:**
   - `extension_sync_runs` replaces `jira_assets_sync_history`.
   - `extension_sync_settings` holds the schedule.
   Extension-specific configuration stays in each extension's own tables.
4. **Real statuses:** `started`, `completed`, `failed`, `abandoned` and `skipped`. Today "abandoned" and "skipped" are `failed` rows told apart by their message text.
5. **TIMESTAMPTZ** for every timestamp in the new tables.
6. **One tick job and one per-org run job** for all extensions.
7. **Failure backoff** applies to scheduled runs only. There is no auto-disable.
8. **Generic API routes** under `/api/extensions/:key/sync…`. The existing Jira Assets sync routes stay for one release as thin aliases, marked deprecated.
9. **Shared UI:** an `ExtensionSyncPanel` component and a `useExtensionSync(key)` hook. The Jira Assets panel switches to them with no visible change.
10. **Not in this work:**
    - moving MLflow and Azure AI Foundry over;
    - webhooks;
    - per-record push jobs;
    - moving Jira's token off the older CBC encryption (`createSecureValue`) to AES-256-GCM (`encryption.utils.ts`), which needs its own PR before the incident sync shares the Jira connection.

## Current state (develop c5d8f439b)

- **Jira Assets** (`Servers/extensions/jira-assets/`):
  - `claimSyncRun` takes `pg_advisory_xact_lock(hashtext('jira_assets_sync'), orgId)`, closes a `started` row whose heartbeat is older than 15 minutes (`SYNC_STALE_AFTER_MINUTES`) as failed with `ABANDONED_RUN_MESSAGE`, throws `JiraSyncInProgressError` if a live run remains, and inserts a `started` row with a UUID `run_token`.
  - `touchHeartbeat` runs every 25 objects and on every page. It matches id, token and `status='started'`, and throws `RunSupersededError` when the claim is lost. Finalizing matches id and token too.
  - `runQueuedSync` claims at pickup. If a run is live, a manual job writes a closed failed row (`SKIPPED_RUN_MESSAGE`, no token), and a scheduled job writes nothing.
  - Due rule: `last_run = GREATEST(config.last_sync_at, MAX(started_at) of manual/scheduled rows with a token)`. A run is due when `sync_interval_hours` has elapsed since `last_run`.
  - Jobs: the check job `jira_assets_scheduled_sync_check` runs every 5 minutes, and the per-org job `jira_assets_sync_run` uses jobId `jira-assets-sync-<orgId>`. Both are on the `automation-actions` queue.
  - Routes: `POST /sync` (202 with `{ jobId, previousRunId }`), `GET /sync/status`, `GET /sync/history`, `PATCH /config/sync`.
  - The UI polls `/sync/status` every 3 seconds. `runOutcome.ts` switches on `latest_run.code`.
- **MLflow and Azure AI Foundry:** manual "Sync" buttons only. No history, claim or schedule.
- **Tenant isolation:** the Jira tables are on the audit allow-list (`Servers/scripts/auditTenantIsolationCoverage.ts`), not in the registry.

## Design

### 1. Tables (new migration)

`extension_sync_settings`, one row per organization and extension that has a schedule:

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| organization_id | INT NOT NULL → organizations ON DELETE CASCADE | |
| extension_key | VARCHAR(64) NOT NULL | `extensions.key` |
| enabled | BOOLEAN NOT NULL DEFAULT false | scheduled sync on or off |
| interval_hours | INT NOT NULL DEFAULT 24, CHECK 1..168 | |
| consecutive_failures | INT NOT NULL DEFAULT 0 | scheduled failures since the last success |
| next_due_at | TIMESTAMPTZ NULL | null means due when the interval has elapsed since the last run |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| | UNIQUE (organization_id, extension_key) | |

`extension_sync_runs`, one row per claimed run or recorded skip:

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| organization_id | INT NOT NULL → organizations ON DELETE CASCADE | |
| extension_key | VARCHAR(64) NOT NULL | |
| kind | VARCHAR(32) NOT NULL | a kind the provider declares, for example `manual`, `scheduled`, `import` or `remove_missing` |
| status | VARCHAR(16) NOT NULL CHECK IN (`started`,`completed`,`failed`,`abandoned`,`skipped`) | |
| code | VARCHAR(64) NULL | machine code for the outcome (`skipped_run_live`, a provider code, …) |
| counts | JSONB NOT NULL DEFAULT '{}' | provider-defined, for example `{fetched, created, updated, deleted}` |
| message | TEXT NULL | human-readable summary or error |
| run_token | VARCHAR(64) NULL | null on skipped rows |
| triggered_by | INT NULL → users ON DELETE SET NULL | null for scheduled runs |
| started_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| heartbeat_at | TIMESTAMPTZ NULL | |
| completed_at | TIMESTAMPTZ NULL | |

Indexes:

- `(organization_id, extension_key, started_at DESC)` for history and status.
- A partial unique index on `(organization_id, extension_key) WHERE status = 'started'`, so the database itself refuses a second live run, behind the advisory lock.

Both tables are registered in `Servers/tests/integration/tenant-isolation/tenantIsolation.registry.ts` with real coverage. They are not added to the audit allow-list.

### 2. Moving Jira Assets data (same migration)

- Copy `jira_assets_config.sync_enabled` and `sync_interval_hours` into `extension_sync_settings` with `extension_key = 'jira-assets'`.
- Copy `jira_assets_sync_history` into `extension_sync_runs`. Naive UTC timestamps become `AT TIME ZONE 'UTC'`, and the status is mapped:
  - `started` → `started`. A row still in flight during the deploy keeps its token, so the abandoned-run rule closes it as usual.
  - `completed` → `completed`.
  - `failed` with `error_message = ABANDONED_RUN_MESSAGE` → `abandoned`.
  - `failed` with `SKIPPED_RUN_MESSAGE` → `skipped`, with code `skipped_run_live`.
  - Every other `failed` row → `failed`.
  - The counts move into the `counts` JSONB, and `error_message` moves into `message`.
- `jira_assets_config.last_sync_*`, `sync_enabled` and `sync_interval_hours` stay in place but are no longer written. A later migration, after one release, drops them along with `jira_assets_sync_history`.
- `down()` drops the two new tables. The old columns and table are untouched, so a rollback restores the old behaviour, minus any runs made since.

### 3. Engine module: `Servers/extensions/syncEngine/`

```ts
interface SyncProvider {
  key: string;                          // extensions.key
  kinds: readonly string[];             // every exclusive operation
  scheduledKind?: string;               // the kind the tick enqueues; no schedule if absent
  dueKinds?: readonly string[];         // kinds that count as "last run" for the due rule; default [scheduledKind, "manual"]
  readiness(orgId: number): Promise<{ ready: true } | { ready: false; reason: string }>;
  run(ctx: RunContext): Promise<RunResult>;
}

interface RunContext {
  orgId: number;
  runId: number;
  kind: string;
  payload: unknown;
  triggeredBy: number | null;
  heartbeat(): Promise<void>;                  // throws RunSupersededError when the claim is lost
  assertOwned(t: Transaction): Promise<void>;  // FOR SHARE on the run row inside the caller's transaction
  signal: AbortSignal;                         // aborted at the run deadline
}

interface RunResult { counts: Record<string, number>; message?: string; code?: string }
```

- **Registry:** `registerSyncProvider(provider)` is called from each extension's module index. A lookup for an unknown key throws.
- **`claimRun(key, orgId, kind, triggeredBy)`:** in one transaction:
  - take `pg_advisory_xact_lock(hashtext('ext_sync:' || key), orgId)`;
  - close stale `started` rows (heartbeat or start older than `STALE_AFTER_MINUTES = 15`) as `abandoned`;
  - throw `SyncInProgressError` if a live run remains;
  - otherwise insert a `started` row with a UUID token and return `{ runId, token }`.
- **`runClaimed(...)`:** calls `provider.run(ctx)`, then finalizes on id and token:
  - completed, with counts, message and code;
  - or failed, with the message and the error's code, if any.

  A lost claim (`RunSupersededError`) writes nothing more.
- **Exclusive operations outside syncs:** Jira's import, remove and delete go through `withClaim(key, orgId, kind, fn)`, so they claim, run and finalize the same way and appear in the history with their own kind.
- **Schedule bookkeeping after a scheduled run:** a success resets `consecutive_failures` to 0 and sets `next_due_at = null`. A failure increments `consecutive_failures` and sets `next_due_at = now() + max(interval, min(2^(n-1) hours, 24 hours))`. Manual runs never change either column, except that a manual success also resets the failures.
- **Due query** (one query across all orgs, run by the tick):
  - settings `enabled`, joined to `extensions` and `extension_enablements` (`enabled = TRUE`);
  - due when `next_due_at <= now()`, or `next_due_at` is null and the interval has elapsed since the newest run of a `dueKinds` kind with a non-null token;
  - and no live run.

  `readiness` is checked per due org. A run that isn't ready records nothing; the reason goes to the debug log, as today.

### 4. Jobs

- **`extension_sync_tick`:** every 5 minutes (`upsertJobScheduler`, non-obliterating, registered after the obliterating schedulers in `Servers/jobs/producer.ts`). It replaces `jira_assets_scheduled_sync_check`, whose scheduler is removed on startup.
- **`extension_sync_run`:** payload `{ key, orgId, kind, triggeredBy, payload }`, jobId `ext-sync-<key>-<orgId>`, `attempts: 1`, removed on complete and on fail. Enqueueing keeps today's rules: a 5-second queue timeout (`BackgroundJobsUnavailableError` → 503), and `queued: false` when a job is already pending.
- **Worker:** at pickup it claims the run. If a run is already live, a manual job records a `skipped` row (code `skipped_run_live`, no token), and a scheduled job records nothing. That matches today.

### 5. API (`Servers/routes/extensionSync.route.ts`)

All routes use `authenticateJWT` and a key-aware `requireExtensionEnabled`. Writes also need `authorize("extension.admin")`. Unknown keys and keys without a sync provider return 404.

- `POST /api/extensions/:key/sync`: on-demand run of the `manual` kind. Returns 202 `{ jobId, previousRunId }`, 409 if a run is live, 400 if not ready (with the reason) and 503 if the queue is unavailable.
- `GET /api/extensions/:key/sync/status`: `{ enabled, interval_hours, consecutive_failures, next_due_at, running, queued, latest_run }`. `latest_run` has `{ id, kind, status, code, counts, message, started_at, completed_at, is_live }`.
- `GET /api/extensions/:key/sync/history?limit=` (default 20, max 100).
- `PATCH /api/extensions/:key/sync/settings` with `{ enabled?, interval_hours? }`. Validated 1–168, and the change goes into the audit ledger like other admin settings.
- **Old Jira routes** (`/api/extensions/jira-assets/sync`, `/sync/status`, `/sync/history`, `/config/sync`): kept for one release, calling the engine and mapping the response to the old shape (`last_sync_*`, `sync_enabled`, `sync_interval_hours`, `latest_run.sync_type`, `objects_*`, `error_message`). They are marked deprecated in swagger.

### 6. UI

- **`useExtensionSync(key)`** (`Clients/src/application/hooks/`) holds the status query, the settings mutation and "Sync now", plus the polling logic moved from the Jira panel: every 3 seconds, up to 20 minutes, stopping after 3 idle polls with nothing queued, nothing running and no newer run.
- **`ExtensionSyncPanel`** (`Clients/src/presentation/components/ExtensionSyncPanel/`):
  - the scheduled-sync toggle;
  - the interval field;
  - the "Sync now" button (`CustomizableButton`);
  - the status line: last run, "running…", or "failing since …" when `consecutive_failures > 0`;
  - the last 5 runs.

  All copy is sentence case, with de/fr/es translations.
- **Jira Assets panel:** replaces its sync section with `<ExtensionSyncPanel extensionKey="jira-assets" />`. `runOutcome.ts` reads the new `status` and `code`, so a skipped or abandoned run looks the same as today.

### 7. Jira Assets on the engine

- A `jiraAssetsSyncProvider` declares:
  - kinds `manual`, `scheduled`, `import`, `remove_missing` and `delete_use_case`;
  - `scheduledKind: "scheduled"`;
  - `dueKinds: ["scheduled", "manual"]`;
  - `readiness`: an object type is selected and use cases exist, as `evaluateScheduledSync` checks today;
  - `run`: today's `runClaimedSync` body, using `ctx.heartbeat()` and `ctx.assertOwned()` in place of `touchHeartbeat` and `assertRunOwned`.
- Import, remove-missing and single delete use `withClaim`. Their locking (projects before links) and the rule that only fully selected projects are deleted do not change.
- The Jira-specific claim, heartbeat, finalize, scheduler, check job and per-org job are removed once the provider is in place.
- `SQL_NOW_UTC` and the naive-UTC helpers in `Servers/extensions/scheduledSync.utils.ts` are no longer used by the engine. Keep them only if something else uses them.

## Errors and edge cases

- **Run in flight during deploy:** its row moves with its token. If the old worker finishes, its finalize targets the old table and is lost. The migrated row then goes stale and is closed as `abandoned` after 15 minutes. That is acceptable, and the release note says so.
- **Two ticks at once:** the advisory lock and the partial unique index make the second claim fail. The skipped scheduled run records nothing.
- **Extension disabled while a run is queued:** the worker checks enablement at pickup and records nothing.
- **Provider throws without a code:** the run is `failed`, `message` is `error.message` truncated to 2,000 characters, and `code` is null.
- **Clock skew:** every timestamp is written by the database (`now()`).
- **Organization deleted:** both tables cascade.

## Testing

- **Engine unit tests:**
  - claim, stale close and live conflict;
  - heartbeat and superseded runs;
  - finalize with the right and the wrong token;
  - the backoff formula;
  - the due query, through a SQL-shape test plus a throwaway Postgres check;
  - the skip rules at pickup.
- **Migration:** a throwaway Postgres check of the history and status mapping, the settings copy, `down()`, then `up()` again.
- **Jira provider:** the existing Jira Assets suites keep passing, adapted to the engine. New tests cover import, remove and delete taking the shared claim, and history kinds.
- **API:** route tests for each endpoint, the old-route aliases (response shape) and the permission gates.
- **Tenant isolation:** registry entries and their tests.
- **Client:**
  - `useExtensionSync` polling;
  - the `ExtensionSyncPanel` states (idle, running, failing, skipped, abandoned);
  - the Jira panel renders the shared panel.

## Out of scope

- MLflow and Azure AI Foundry providers.
- Webhooks and per-record push jobs (the incident sync).
- Moving Jira's token from CBC to AES-256-GCM.
- Dropping the old Jira table and columns (a follow-up migration after one release).
- Auto-disabling a schedule after repeated failures.
