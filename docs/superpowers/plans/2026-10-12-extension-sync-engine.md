# Extension sync engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Jira Assets' run lifecycle (claim, heartbeat, abandoned-run detection, history, schedule, "Sync now", status) into one sync engine any extension can use, and run Jira Assets on it with no user-visible change except a "Failing since <date>" line.

**Architecture:** A new module `Servers/extensions/sync-engine/` owns two shared tables (`extension_sync_runs`, `extension_sync_settings`), the per-(extension, org) claim, a `RunContext` handed to providers, schedule bookkeeping with failure backoff, one 5-minute tick job and one per-org run job, and generic routes under `/api/extensions/:key/runs…` and `/:key/schedule`. Jira Assets becomes the first `SyncProvider`: its sync body, import, remove-missing and single delete run under engine claims, and its old routes keep their exact response shapes on top of the engine. The client gets a `useExtensionSync(key)` hook and an `ExtensionSyncPanel` that the Jira Assets page renders in place of its own sync section.

**Tech Stack:** Node 22, Express 4, TypeScript, Sequelize 6 raw SQL on PostgreSQL, BullMQ (`automation-actions` queue), Jest + supertest; React 19, MUI 7, React Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-12-extension-sync-engine-design.md`

## Global Constraints

- Every timestamp column in `extension_sync_runs` and `extension_sync_settings` is `TIMESTAMPTZ`; the database writes every timestamp with `now()`.
- `interval_hours` is a whole number from 1 to 168 (CHECK in the table, 400 at the API).
- `STALE_AFTER_MINUTES = 15`: a `started` run with no heartbeat (else start) for 15 minutes is closed as `abandoned` with code `abandoned`.
- The tick job `extension_sync_tick` runs every 5 minutes (`*/5 * * * *`) via `upsertJobScheduler`, non-obliterating, registered after the obliterating schedulers.
- The per-org run job is `extension_sync_run` with jobId `ext-sync-<key>-<orgId>`, `attempts: 1`, `removeOnComplete: true`, `removeOnFail: true`.
- Provider keys match `/^[a-z0-9-]+$/` (the `extensions.key` rule), checked by `registerSyncProvider`.
- Run statuses are exactly `started`, `completed`, `failed`, `abandoned`, `skipped`; run messages are truncated to 2,000 characters.
- Backoff applies to scheduled runs only: `backoff(n)` = 0 for n = 0, otherwise `LEAST(2^(n-1), 24)` hours; due when `now() >= last_run + GREATEST(interval_hours, backoff)`.
- Migration DDL uses the `verifywise.` prefix and runs inside one transaction; `down()` drops only the two new tables.
- Application SQL uses unqualified table names and filters every tenant-scoped query by `organization_id` (the due query is the one documented cross-org system query).
- Never run the sequelize CLI; create migration files by hand.
- UI text is sentence case; every new user-facing string gets de, fr and es entries in `Clients/src/i18n/translations.ts`.
- Use house components: `CustomizableButton` (`text=` or `children`, never `label=`), `Toggle`, `Select`, `Field` from `Clients/src/presentation/components`.
- Border `#d0d5dd`, radius 4px, 30px control height on desktop, spacing as pixel strings (`gap: "8px"`), never MUI numeric multipliers.
- No `console.log` in app code (scripts write with `process.stdout.write`).
- Gates run from the package directory: `cd Servers && npm run build && npm run format-check && npm run test`; `cd Clients && npm run typecheck && npm run i18n:audit:strict && npm run format-check`.
- Server tests: `cd Servers && npx jest -i <explicit paths>` (never `--testPathPatterns` with words that appear in the worktree path). Client tests: `cd Clients && npx vitest run <paths>`.
- Commit messages are `type(scope): description` with a body; never mention AI tools.

## Review Focus

1. **"Sync now" left mid-poll** (the admin navigates away while a run is going): polling must stop at once with no further status requests or state updates, and coming back must show the running state from the server. Test: Task 9, "stops polling when the panel unmounts".
2. **An interval outside the panel's presets** (for example 72 h saved through the API): the panel must show "Every 72 hours" and keep it, not render a blank select that resets the value on the next save. Test: Task 10, "shows an interval that is not a preset".
3. **A long failure streak** (`consecutive_failures` in the hundreds or thousands): the tick's due query must not overflow (`power(2, n)` overflows Postgres `float8` near n = 1024 and would fail the tick for every org); backoff caps at 24 h. Tests: Task 3, the SQL-shape test and the throwaway-Postgres check with `consecutive_failures = 2000`.
4. **A provider that throws a non-`Error` value or an error with an empty message** (`throw "boom"`, `throw undefined`, `new Error("")`): the run must still close as `failed` with a usable message (the string itself, "Error" for an empty `Error`, "Unknown error" for `undefined`/`null`), not sit `started` for 15 minutes. Test: Task 2, "closes the run as failed for a thrown non-Error value".
5. **Malformed query and body values on the generic API** (`?limit=-5`, `?limit=abc`, `?limit=5000`, `interval_hours: null`, `""`, `"12.5"`, and the numeric string `"12"` the old panel sent): bad values return the default list or 400, never a 500, and `"12"` is accepted as 12. Tests: Task 5, "parses limit defensively" and "validates the schedule body".

---

## File Structure

**Created (server)**

| File | Responsibility |
|---|---|
| `Servers/database/migrations/20261012200000-extension-sync-engine.js` | The two tables, Jira data copy with kept ids, sequence, partial unique index; `down()` drops the new tables |
| `Servers/scripts/lib/throwawayPostgres.js` | Starts a temporary Postgres cluster (initdb + pg_ctl, TCP only) for checks, always cleans up |
| `Servers/scripts/checkExtensionSyncMigration.js` | Throwaway-Postgres check of the migration: mapping, ids, sequence, settings, index, `down()`, `up()` again |
| `Servers/scripts/checkExtensionSyncEngineSql.js` | Throwaway-Postgres check of the due query, the backoff formula and the ownership fragment |
| `Servers/extensions/sync-engine/types.ts` | `SyncProvider`, `RunContext`, `RunResult`, `Readiness`, statuses and engine constants |
| `Servers/extensions/sync-engine/errors.ts` | Engine errors, `errorMessage`, `errorCode`, `truncateMessage`, `isUniqueViolation` |
| `Servers/extensions/sync-engine/registry.ts` | `registerSyncProvider`, lookups, `statusKinds` |
| `Servers/extensions/sync-engine/sql.ts` | Pure SQL fragments: liveness, ownership, backoff, due query; `backoffHours` mirror |
| `Servers/extensions/sync-engine/claim.ts` | `claimRun`, `EngineRunContext`, `runClaimed`, `withClaim`, `failRun`, `recordSkippedRun` |
| `Servers/extensions/sync-engine/schedule.ts` | Schedule parse/read/save, failure bookkeeping, `findDueRuns` |
| `Servers/extensions/sync-engine/status.ts` | `hasLiveRun`, `latestStatusRunId`, `getRunStatus`, `listRuns`, `parseRunsLimit` |
| `Servers/extensions/sync-engine/jobs.ts` | Tick, per-org run job with pickup skip, legacy job-name routing, `startManualRun` |
| `Servers/extensions/sync-engine/providers.ts` | The list of registered providers (`registerAllSyncProviders`) |
| `Servers/extensions/sync-engine/__tests__/*.test.ts` | Engine unit tests (registry, sql, claim, schedule, jobs, status, route) |
| `Servers/controllers/extensionRuns.ctrl.ts` | Handlers for the generic routes and the "only sync providers" pass-through |
| `Servers/routes/extensionRuns.route.ts` | `POST /:key/runs`, `GET /:key/runs/status`, `GET /:key/runs`, `PATCH /:key/schedule` |
| `Servers/extensions/jira-assets/jiraAssets.syncProvider.ts` | The Jira Assets `SyncProvider` object |
| `Servers/tests/integration/tenant-isolation/extensionRuns.isolation.test.ts` | Hand-written isolation test for the `:key` routes and both tables |

**Modified (server)**

| File | Change |
|---|---|
| `Servers/scripts/snapshotExtensionsData.js` | Snapshot the two new tables |
| `Servers/services/automations/automationProducer.ts` | `addSingletonJob`, `extensionSyncJobId`, `hasPendingExtensionSyncJob`, `enqueueExtensionSyncRun`, `scheduleExtensionSyncTick`; Jira queue helpers removed |
| `Servers/services/automations/automationWorker.ts` | Engine jobs (and the old Jira job names) dispatched to `handleExtensionSyncJob` |
| `Servers/jobs/producer.ts` | Register the tick; drop the Jira check |
| `Servers/middleware/requireExtensionEnabled.middleware.ts` | `requireExtensionEnabledFromParam` |
| `Servers/app.ts` | Mount the generic router under `/api/extensions` next to the catalog router |
| `Servers/extensions/jira-assets/jiraAssets.service.ts` | Run body on `RunContext`, import/remove/delete via `withClaim`, readiness, legacy status/history/config on the engine; old claim code removed |
| `Servers/extensions/jira-assets/jiraAssets.ctrl.ts` | Engine errors, engine manual run, engine queue state, legacy limit parsing |
| `Servers/extensions/jira-assets/jiraAssets.scheduler.ts` | Deleted |
| `Servers/extensions/scheduledSync.utils.ts` | Trimmed to `SQL_NOW_UTC` (still used for `missing_in_jira_since`) |
| `Servers/extensions/jira-assets/__tests__/*` | Adapted to the engine; scheduler test deleted |
| `Servers/tests/integration/tenant-isolation/tenantIsolation.registry.ts` | Registry entry for both tables |
| `Servers/scripts/auditTenantIsolationCoverage.ts` | `jira_assets_sync_history` justification updated (no longer written) |
| `Servers/swagger.yaml`, `docs/api-docs/src/config/endpoints.ts` | Generic routes documented; old Jira sync routes deprecated |

**Created / modified (client)**

| File | Responsibility |
|---|---|
| `Clients/src/application/repository/extensionSync.repository.ts` | Calls and types for the generic routes |
| `Clients/src/application/hooks/useExtensionSync.ts` | Status query, schedule saves, "Sync now" polling (`decidePoll`) |
| `Clients/src/application/utils/extensionRunOutcome.ts` | `isAbandonedRun`, `isSkippedRun`, `SYNC_RUNNING_MESSAGE` from status and code |
| `Clients/src/presentation/components/ExtensionSyncPanel/index.tsx` | The shared sync section (toggle, interval, Sync now, last sync, failing since, outcomes) |
| `Clients/src/presentation/pages/Extensions/jira-assets/runOutcome.ts` | Re-exports the shared readers; keeps Jira import/removal codes |
| `Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.tsx` | Renders `ExtensionSyncPanel`; its own sync code removed |
| `Clients/src/i18n/translations.ts` | de/fr/es for the new strings |

**Docs:** `docs/technical/infrastructure/extensions.md`, `docs/technical/infrastructure/automations.md`.

**Interim note for executors:** tasks land in order on one branch. Between Task 6 and Task 7 the old Jira status and config routes still read the old table, so the panel's poll is stale until Task 7. Do not deploy mid-plan.

---

### Task 1: Migration, data copy and throwaway-Postgres check

**Files:**
- Create: `Servers/database/migrations/20261012200000-extension-sync-engine.js`
- Create: `Servers/scripts/lib/throwawayPostgres.js`
- Create: `Servers/scripts/checkExtensionSyncMigration.js`
- Modify: `Servers/scripts/snapshotExtensionsData.js:30-45` (`DATA_TABLES`)

**Interfaces:**
- Consumes: the existing `verifywise.jira_assets_config` (`sync_enabled`, `sync_interval_hours`) and `verifywise.jira_assets_sync_history` (all columns incl. `heartbeat_at`, `run_token`).
- Produces:
  - Table `extension_sync_settings(id, organization_id, extension_key, enabled, interval_hours, consecutive_failures, failing_since, updated_at)`, unique `(organization_id, extension_key)`.
  - Table `extension_sync_runs(id, organization_id, extension_key, kind, status, code, counts, message, run_token, triggered_by, started_at, heartbeat_at, completed_at)`, index `idx_extension_sync_runs_recent`, partial unique index `uq_extension_sync_runs_one_started`.
  - `withThrowawayPostgres(fn: ({ client: pg.Client, sequelize: Sequelize }) => Promise<void>): Promise<void>` from `Servers/scripts/lib/throwawayPostgres.js` (Task 3 reuses it).

Before starting: `ls Servers/database/migrations | tail -3` must show `20261012142910-data-retention-runs-error-code.js` as the newest file. If a newer migration exists, use `date +%Y%m%d%H%M%S` for the timestamp and rename every reference to the file in this plan.

- [ ] **Step 1: Write the throwaway Postgres helper**

Create `Servers/scripts/lib/throwawayPostgres.js`:

```js
/* eslint-disable */
"use strict";

/**
 * A throwaway PostgreSQL cluster for one-off checks. It runs initdb into a
 * temporary directory, starts the server on a free TCP port with no Unix
 * socket (so long temp paths are fine), hands the caller a pg Client and a
 * Sequelize instance, then stops the server and deletes the directory. It
 * never touches the dev database.
 *
 * Needs `initdb` and `pg_ctl` on PATH. Set CHECK_PG_BIN to their directory if
 * they are elsewhere (for example /opt/homebrew/opt/postgresql@16/bin).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { Client } = require("pg");
const { Sequelize } = require("sequelize");

function bin(name) {
  return process.env.CHECK_PG_BIN ? path.join(process.env.CHECK_PG_BIN, name) : name;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(config) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const client = new Client(config);
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("The throwaway Postgres did not start");
}

/**
 * Run `fn({ client, sequelize })` against a fresh cluster. The `postgres`
 * database gets a `verifywise` schema, and new sessions use it first on the
 * search_path, so unqualified application SQL resolves as it does in the app.
 */
async function withThrowawayPostgres(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vw-pg-"));
  const dataDir = path.join(dir, "data");
  const port = await freePort();
  execFileSync(bin("initdb"), ["-D", dataDir, "-U", "postgres", "-A", "trust"], {
    stdio: "ignore",
  });
  execFileSync(
    bin("pg_ctl"),
    [
      "-D",
      dataDir,
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
      "-l",
      path.join(dir, "log"),
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  const config = { host: "127.0.0.1", port, user: "postgres", database: "postgres" };
  let client;
  let sequelize;
  try {
    await waitForServer(config);
    client = new Client(config);
    await client.connect();
    await client.query(
      "CREATE SCHEMA verifywise; ALTER DATABASE postgres SET search_path TO verifywise, public;",
    );
    await client.query("SET search_path TO verifywise, public;");
    sequelize = new Sequelize("postgres", "postgres", "", {
      host: "127.0.0.1",
      port,
      dialect: "postgres",
      logging: false,
    });
    await fn({ client, sequelize });
  } finally {
    if (sequelize) await sequelize.close();
    if (client) await client.end();
    try {
      execFileSync(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        stdio: "ignore",
      });
    } catch {
      // Already stopped.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { withThrowawayPostgres };
```

- [ ] **Step 2: Write the failing migration check**

Create `Servers/scripts/checkExtensionSyncMigration.js`:

```js
#!/usr/bin/env node
/* eslint-disable */
"use strict";

/**
 * Checks 20261012200000-extension-sync-engine.js on a throwaway Postgres: the
 * Jira Assets history status mapping (several `started` rows per org and
 * null-token rows included), kept ids and the sequence, the settings copy,
 * the partial unique index, down(), and up() again.
 *
 * Run: cd Servers && node scripts/checkExtensionSyncMigration.js
 */
const assert = require("assert/strict");
const { withThrowawayPostgres } = require("./lib/throwawayPostgres");
const migration = require("../database/migrations/20261012200000-extension-sync-engine");

const ABANDONED = "Sync stopped responding and was marked as abandoned";
const SKIPPED = "Another sync or import was running, so this sync did not start.";

// The pre-engine tables, reduced to the columns the migration reads.
const BASE_SCHEMA = `
  CREATE TABLE verifywise.organizations (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE verifywise.users (id SERIAL PRIMARY KEY, email TEXT);
  CREATE TABLE verifywise.jira_assets_config (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
    sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    sync_interval_hours INTEGER NOT NULL DEFAULT 24
  );
  CREATE TABLE verifywise.jira_assets_sync_history (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
    sync_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    objects_fetched INTEGER NOT NULL DEFAULT 0,
    objects_created INTEGER NOT NULL DEFAULT 0,
    objects_updated INTEGER NOT NULL DEFAULT 0,
    objects_deleted INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    triggered_by INTEGER REFERENCES verifywise.users(id) ON DELETE SET NULL,
    heartbeat_at TIMESTAMP,
    run_token VARCHAR(64)
  );
`;

// Naive UTC wall-clock, as the old code wrote it.
const ago = (minutes) => `(NOW() AT TIME ZONE 'UTC') - interval '${minutes} minutes'`;

// id, org, sync_type, status, [fetched, created, updated, deleted], error_message,
// started (minutes ago), completed (minutes ago or null), heartbeat (minutes ago or null), token
const HISTORY = [
  [10, 1, "manual", "completed", [5, 2, 1, 0], "note", 120, 118, 119, "t10"],
  [11, 1, "scheduled", "failed", [0, 0, 0, 0], ABANDONED, 100, 80, 99, "t11"],
  [12, 1, "manual", "failed", [0, 0, 0, 0], SKIPPED, 90, 90, null, null],
  [13, 1, "scheduled", "failed", [0, 0, 0, 0], "Jira returned 500", 70, 69, 69, "t13"],
  // Two `started` rows in org 1: only the newest live one with a token stays started.
  [14, 1, "import", "started", [0, 0, 0, 0], null, 6, null, 1, "t14"],
  [15, 1, "manual", "started", [0, 0, 0, 0], null, 5, null, 0, "t15"],
  // Org 2: the newest row with a token is stale; the newest row overall has no token.
  [20, 2, "scheduled", "started", [0, 0, 0, 0], null, 40, null, 30, "t20"],
  [21, 2, "manual", "started", [0, 0, 0, 0], null, 2, null, 1, null],
];

async function seed(client) {
  await client.query(`
    INSERT INTO verifywise.organizations (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c');
    INSERT INTO verifywise.users (id, email) VALUES (8, 'u@example.com');
    INSERT INTO verifywise.jira_assets_config (organization_id, sync_enabled, sync_interval_hours)
    VALUES (1, TRUE, 24), (2, FALSE, 1), (3, TRUE, 6);
  `);
  for (const [id, org, type, status, counts, message, started, completed, heartbeat, token] of HISTORY) {
    await client.query(
      `INSERT INTO verifywise.jira_assets_sync_history
         (id, organization_id, sync_type, status, objects_fetched, objects_created,
          objects_updated, objects_deleted, error_message, started_at, completed_at,
          heartbeat_at, triggered_by, run_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${ago(started)},
               ${completed === null ? "NULL" : ago(completed)},
               ${heartbeat === null ? "NULL" : ago(heartbeat)}, 8, $10)`,
      [id, org, type, status, ...counts, message, token],
    );
  }
  await client.query(
    `SELECT setval(pg_get_serial_sequence('verifywise.jira_assets_sync_history', 'id'), 21)`,
  );
}

async function assertCopied(client) {
  const { rows } = await client.query(
    `SELECT id, kind, status, code, counts, message, run_token, triggered_by,
            completed_at IS NOT NULL AS closed
       FROM verifywise.extension_sync_runs ORDER BY id`,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [10, 11, 12, 13, 14, 15, 20, 21],
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId[10], {
    id: 10,
    kind: "manual",
    status: "completed",
    code: null,
    counts: { fetched: 5, created: 2, updated: 1, deleted: 0 },
    message: "note",
    run_token: "t10",
    triggered_by: 8,
    closed: true,
  });
  assert.equal(byId[11].status, "abandoned");
  assert.equal(byId[11].code, "abandoned");
  assert.equal(byId[11].message, ABANDONED);
  assert.equal(byId[12].status, "skipped");
  assert.equal(byId[12].code, "skipped");
  assert.equal(byId[12].run_token, null);
  assert.equal(byId[13].status, "failed");
  assert.equal(byId[13].code, null);
  assert.equal(byId[13].message, "Jira returned 500");
  for (const id of [14, 20, 21]) {
    assert.equal(byId[id].status, "abandoned", `row ${id}`);
    assert.equal(byId[id].code, "abandoned", `row ${id}`);
    assert.equal(byId[id].message, ABANDONED, `row ${id}`);
    assert.equal(byId[id].closed, true, `row ${id}`);
  }
  assert.equal(byId[15].status, "started");
  assert.equal(byId[15].closed, false);
  assert.equal(byId[15].run_token, "t15");

  const { rows: [time] } = await client.query(
    `SELECT r.started_at = (h.started_at AT TIME ZONE 'UTC') AS same
       FROM verifywise.extension_sync_runs r
       JOIN verifywise.jira_assets_sync_history h ON h.id = r.id
      WHERE r.id = 10`,
  );
  assert.equal(time.same, true);

  const { rows: settings } = await client.query(
    `SELECT organization_id, extension_key, enabled, interval_hours, consecutive_failures,
            failing_since
       FROM verifywise.extension_sync_settings ORDER BY organization_id`,
  );
  assert.deepEqual(settings, [
    { organization_id: 1, extension_key: "jira-assets", enabled: true, interval_hours: 24, consecutive_failures: 0, failing_since: null },
    { organization_id: 2, extension_key: "jira-assets", enabled: false, interval_hours: 1, consecutive_failures: 0, failing_since: null },
    { organization_id: 3, extension_key: "jira-assets", enabled: true, interval_hours: 6, consecutive_failures: 0, failing_since: null },
  ]);

  const { rows: [index] } = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'verifywise' AND indexname = 'uq_extension_sync_runs_one_started'`,
  );
  assert.match(index.indexdef, /UNIQUE INDEX .* WHERE \(\(status\)::text = 'started'::text\)/);

  const { rows: [next] } = await client.query(
    `INSERT INTO verifywise.extension_sync_runs
       (organization_id, extension_key, kind, status, completed_at)
     VALUES (3, 'jira-assets', 'manual', 'skipped', now()) RETURNING id`,
  );
  assert.equal(next.id, 22);

  await assert.rejects(
    client.query(
      `INSERT INTO verifywise.extension_sync_runs
         (organization_id, extension_key, kind, status, run_token)
       VALUES (1, 'jira-assets', 'manual', 'started', 'second')`,
    ),
    (err) => err.code === "23505",
  );
}

async function main() {
  await withThrowawayPostgres(async ({ client, sequelize }) => {
    await client.query(BASE_SCHEMA);
    await seed(client);
    const queryInterface = { sequelize };

    await migration.up(queryInterface);
    await assertCopied(client);

    await migration.down(queryInterface);
    const { rows: [gone] } = await client.query(
      `SELECT to_regclass('verifywise.extension_sync_runs') AS runs,
              to_regclass('verifywise.extension_sync_settings') AS settings,
              (SELECT COUNT(*)::int FROM verifywise.jira_assets_sync_history) AS old_rows`,
    );
    assert.deepEqual(gone, { runs: null, settings: null, old_rows: 8 });

    await migration.up(queryInterface);
    await assertCopied(client);
  });
  process.stdout.write("extension sync migration: all checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Run the check to verify it fails**

Run: `cd Servers && node scripts/checkExtensionSyncMigration.js`
Expected: FAIL with `Cannot find module '../database/migrations/20261012200000-extension-sync-engine'`. (If it fails with `spawnSync initdb ENOENT` instead, set `CHECK_PG_BIN` to the directory holding `initdb` and `pg_ctl` and rerun.)

- [ ] **Step 4: Write the migration**

Create `Servers/database/migrations/20261012200000-extension-sync-engine.js`:

```js
"use strict";

/**
 * Extension sync engine: shared run history and schedule tables, with the
 * Jira Assets data copied in.
 *
 * - `extension_sync_settings`: one row per organization and extension with a
 *   schedule (enabled, interval, failure streak).
 * - `extension_sync_runs`: one row per claimed run or recorded skip, for every
 *   extension on the engine. Replaces `jira_assets_sync_history`.
 *
 * Jira Assets' schedule and history are copied in, keeping history ids so
 * `previousRunId` stays comparable. Old naive-UTC timestamps become
 * TIMESTAMPTZ with `AT TIME ZONE 'UTC'`. Of the old `started` rows, only the
 * newest live one with a token per org stays `started`; the rest are closed as
 * `abandoned`, so the partial unique index (created after the copy) cannot
 * fail. The old table and the old `jira_assets_config.sync_*` and
 * `last_sync_*` columns stay in place, no longer written; a follow-up
 * migration drops them after one release. down() drops only the new tables.
 */

const ABANDONED_RUN_MESSAGE = "Sync stopped responding and was marked as abandoned";
const SKIPPED_RUN_MESSAGE = "Another sync or import was running, so this sync did not start.";
const STALE_AFTER_MINUTES = 15;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql, replacements) =>
        queryInterface.sequelize.query(sql, { transaction, replacements });

      await run(`
        CREATE TABLE IF NOT EXISTS verifywise.extension_sync_settings (
          id                   SERIAL PRIMARY KEY,
          organization_id      INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
          extension_key        VARCHAR(64) NOT NULL,
          enabled              BOOLEAN NOT NULL DEFAULT FALSE,
          interval_hours       INTEGER NOT NULL DEFAULT 24,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          failing_since        TIMESTAMPTZ NULL,
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT extension_sync_settings_org_key_unique UNIQUE (organization_id, extension_key),
          CONSTRAINT extension_sync_settings_interval_range_chk
            CHECK (interval_hours >= 1 AND interval_hours <= 168),
          CONSTRAINT extension_sync_settings_failures_nonneg_chk CHECK (consecutive_failures >= 0),
          CONSTRAINT extension_sync_settings_key_format_chk CHECK (extension_key ~ '^[a-z0-9-]+$')
        );
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS verifywise.extension_sync_runs (
          id              SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
          extension_key   VARCHAR(64) NOT NULL,
          kind            VARCHAR(32) NOT NULL,
          status          VARCHAR(16) NOT NULL,
          code            VARCHAR(64),
          counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
          message         TEXT,
          run_token       VARCHAR(64),
          triggered_by    INTEGER REFERENCES verifywise.users(id) ON DELETE SET NULL,
          started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          heartbeat_at    TIMESTAMPTZ,
          completed_at    TIMESTAMPTZ,
          CONSTRAINT extension_sync_runs_status_chk
            CHECK (status IN ('started', 'completed', 'failed', 'abandoned', 'skipped')),
          CONSTRAINT extension_sync_runs_completed_at_consistency_chk
            CHECK ((status = 'started') = (completed_at IS NULL)),
          CONSTRAINT extension_sync_runs_started_has_token_chk
            CHECK (status <> 'started' OR run_token IS NOT NULL),
          CONSTRAINT extension_sync_runs_counts_is_object_chk CHECK (jsonb_typeof(counts) = 'object'),
          CONSTRAINT extension_sync_runs_key_format_chk CHECK (extension_key ~ '^[a-z0-9-]+$')
        );
        CREATE INDEX IF NOT EXISTS idx_extension_sync_runs_recent
          ON verifywise.extension_sync_runs (organization_id, extension_key, started_at DESC);
      `);

      await run(`
        INSERT INTO verifywise.extension_sync_settings
          (organization_id, extension_key, enabled, interval_hours, updated_at)
        SELECT organization_id, 'jira-assets', sync_enabled, sync_interval_hours, now()
          FROM verifywise.jira_assets_config
        ON CONFLICT (organization_id, extension_key) DO NOTHING;
      `);

      await run(
        `
        INSERT INTO verifywise.extension_sync_runs
          (id, organization_id, extension_key, kind, status, code, counts, message,
           run_token, triggered_by, started_at, heartbeat_at, completed_at)
        SELECT m.id, m.organization_id, 'jira-assets', m.sync_type, m.new_status,
               CASE WHEN m.new_status IN ('abandoned', 'skipped') THEN m.new_status END,
               jsonb_build_object('fetched', m.objects_fetched, 'created', m.objects_created,
                                  'updated', m.objects_updated, 'deleted', m.objects_deleted),
               CASE WHEN m.status = 'started' AND m.new_status = 'abandoned'
                    THEN :abandoned ELSE m.error_message END,
               m.run_token, m.triggered_by,
               m.started_at AT TIME ZONE 'UTC',
               m.heartbeat_at AT TIME ZONE 'UTC',
               CASE WHEN m.status = 'started' AND m.new_status = 'abandoned' THEN now()
                    ELSE m.completed_at AT TIME ZONE 'UTC' END
          FROM (
            SELECT h.*,
                   CASE
                     WHEN h.status = 'completed' THEN 'completed'
                     WHEN h.status = 'failed' AND h.error_message = :abandoned THEN 'abandoned'
                     WHEN h.status = 'failed' AND h.error_message = :skipped THEN 'skipped'
                     WHEN h.status = 'failed' THEN 'failed'
                     WHEN h.id = keep.id
                      AND (COALESCE(h.heartbeat_at, h.started_at) AT TIME ZONE 'UTC')
                            >= now() - make_interval(mins => ${STALE_AFTER_MINUTES})
                       THEN 'started'
                     ELSE 'abandoned'
                   END AS new_status
              FROM verifywise.jira_assets_sync_history h
              LEFT JOIN (
                SELECT DISTINCT ON (organization_id) organization_id, id
                  FROM verifywise.jira_assets_sync_history
                 WHERE status = 'started' AND run_token IS NOT NULL
                 ORDER BY organization_id, started_at DESC, id DESC
              ) keep ON keep.organization_id = h.organization_id
          ) m
         ORDER BY m.id;
        `,
        { abandoned: ABANDONED_RUN_MESSAGE, skipped: SKIPPED_RUN_MESSAGE },
      );

      await run(`
        SELECT setval(
          pg_get_serial_sequence('verifywise.extension_sync_runs', 'id'),
          COALESCE((SELECT MAX(id) FROM verifywise.extension_sync_runs), 1),
          (SELECT COUNT(*) > 0 FROM verifywise.extension_sync_runs)
        );
      `);

      await run(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_extension_sync_runs_one_started
          ON verifywise.extension_sync_runs (organization_id, extension_key)
          WHERE status = 'started';
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DROP TABLE IF EXISTS verifywise.extension_sync_runs;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `DROP TABLE IF EXISTS verifywise.extension_sync_settings;`,
        { transaction },
      );
    });
  },
};
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `cd Servers && node scripts/checkExtensionSyncMigration.js`
Expected: PASS, printing `extension sync migration: all checks passed`.

- [ ] **Step 6: Snapshot the new tables too**

In `Servers/scripts/snapshotExtensionsData.js`, change the end of `DATA_TABLES` from

```js
  "jira_assets_sync_history",
  "slack_webhooks",
```

to

```js
  "jira_assets_sync_history",
  "extension_sync_settings",
  "extension_sync_runs",
  "slack_webhooks",
```

- [ ] **Step 7: Format and commit**

```bash
cd Servers && npx prettier --write database/migrations/20261012200000-extension-sync-engine.js scripts/lib/throwawayPostgres.js scripts/checkExtensionSyncMigration.js scripts/snapshotExtensionsData.js && node scripts/checkExtensionSyncMigration.js
cd .. && git add Servers/database/migrations/20261012200000-extension-sync-engine.js Servers/scripts/lib/throwawayPostgres.js Servers/scripts/checkExtensionSyncMigration.js Servers/scripts/snapshotExtensionsData.js
git commit -m "feat(sync-engine): shared run and schedule tables with the Jira Assets data copied in" -m "Adds extension_sync_runs and extension_sync_settings (TIMESTAMPTZ, one transaction, verifywise. DDL). Copies Jira Assets history keeping ids, maps abandoned/skipped rows to real statuses, keeps only the newest live started row per org, moves the sequence, then adds the one-started-run partial unique index. down() drops only the new tables.

scripts/checkExtensionSyncMigration.js verifies the mapping, ids, sequence, settings, index, down() and up() again on a throwaway Postgres (scripts/lib/throwawayPostgres.js)."
```

---

### Task 2: Engine core: registry, claim, run context, runClaimed, withClaim, errors

**Files:**
- Create: `Servers/extensions/sync-engine/types.ts`
- Create: `Servers/extensions/sync-engine/errors.ts`
- Create: `Servers/extensions/sync-engine/registry.ts`
- Create: `Servers/extensions/sync-engine/sql.ts`
- Create: `Servers/extensions/sync-engine/claim.ts`
- Test: `Servers/extensions/sync-engine/__tests__/registry.test.ts`
- Test: `Servers/extensions/sync-engine/__tests__/sql.test.ts`
- Test: `Servers/extensions/sync-engine/__tests__/claim.test.ts`

**Interfaces:**
- Consumes: the tables from Task 1; `sequelize` from `Servers/database/db`; `logger`, `logStructured` from `Servers/utils/logger/fileLogger`.
- Produces:
  - `types.ts`: `EXTENSION_KEY_PATTERN`, `STALE_AFTER_MINUTES = 15`, `MESSAGE_MAX_LENGTH = 2000`, `DEFAULT_RUN_DEADLINE_MS = 600000`, `BACKOFF_CAP_HOURS = 24`, `ABANDONED_RUN_MESSAGE`, `SKIPPED_RUN_MESSAGE`, `RUN_STATUSES`, `type RunStatus`, `type Readiness`, `interface RunResult`, `interface RunContext`, `interface SyncProvider`.
  - `errors.ts`: `SyncInProgressError(message?)`, `RunSupersededError(runId)`, `UnknownSyncProviderError(key)`, `SyncNotReadyError(status: 400 | 404, reason)`, `SyncValidationError(message)`, `errorMessage(err: unknown): string`, `errorCode(err: unknown): string | null`, `truncateMessage(message: string): string`, `isUniqueViolation(err: unknown): boolean`.
  - `registry.ts`: `registerSyncProvider(provider: SyncProvider): void`, `getSyncProvider(key: string): SyncProvider`, `findSyncProvider(key: string): SyncProvider | undefined`, `listSyncProviders(): SyncProvider[]`, `statusKinds(provider: SyncProvider): string[]`, `__resetSyncProvidersForTests(): void`.
  - `sql.ts`: `sqlRunIsLive(alias: string): string`, `sqlLiveRunExists(keyExpr: string, orgExpr: string): string`, `interface OwnedRunRef { runId; orgId; token }`, `sqlOwnsRunFragment(run: OwnedRunRef, alias?: string): string`.
  - `claim.ts`: `interface ClaimedRun { runId; token; orgId; key; kind; triggeredBy }`, `claimRun(key, orgId, kind, triggeredBy): Promise<ClaimedRun>`, `class EngineRunContext implements RunContext` (adds `provider`, `settled`, `markSettled(t?)`, `dispose()`, `ref()`), `createRunContext(provider, run, payload): EngineRunContext`, `failRun(ctx, err): Promise<void>`, `runClaimed(provider, ctx): Promise<void>`, `interface WithClaimOptions { payload?; releaseOn? }`, `withClaim<T>(key, orgId, kind, triggeredBy, fn, options?): Promise<T>`, `recordSkippedRun(key, orgId, kind, triggeredBy): Promise<void>`.

- [ ] **Step 1: Write the failing registry and SQL tests**

Create `Servers/extensions/sync-engine/__tests__/registry.test.ts`:

```ts
import {
  __resetSyncProvidersForTests,
  findSyncProvider,
  getSyncProvider,
  listSyncProviders,
  registerSyncProvider,
  statusKinds,
} from "../registry";
import { UnknownSyncProviderError } from "../errors";
import type { SyncProvider } from "../types";

const make = (overrides: Partial<SyncProvider> = {}): SyncProvider => ({
  key: "demo-ext",
  kinds: ["manual", "scheduled"],
  scheduledKind: "scheduled",
  readiness: async () => ({ ready: true }),
  run: async () => ({ counts: {} }),
  ...overrides,
});

beforeEach(() => __resetSyncProvidersForTests());

describe("registerSyncProvider", () => {
  it.each(["Jira", "jira_assets", "", "a b", "../x"])("rejects the key %p", (key) => {
    expect(() => registerSyncProvider(make({ key }))).toThrow("Invalid sync provider key");
  });

  it("requires a manual kind", () => {
    expect(() => registerSyncProvider(make({ kinds: ["scheduled"] }))).toThrow(
      'must declare the "manual" kind',
    );
  });

  it("requires the scheduled kind to be one of its kinds", () => {
    expect(() => registerSyncProvider(make({ scheduledKind: "nightly" }))).toThrow(
      'scheduledKind "nightly" is not one of its kinds',
    );
  });

  it("rejects a second, different provider for the same key", () => {
    const first = make();
    registerSyncProvider(first);
    expect(() => registerSyncProvider(first)).not.toThrow();
    expect(() => registerSyncProvider(make())).toThrow("already registered");
    expect(listSyncProviders()).toEqual([first]);
  });
});

describe("lookups", () => {
  it("throws for an unknown key on get, and returns undefined on find", () => {
    expect(() => getSyncProvider("nope")).toThrow(UnknownSyncProviderError);
    expect(findSyncProvider("nope")).toBeUndefined();
  });

  it("status kinds are the scheduled kind and manual", () => {
    expect(statusKinds(make())).toEqual(["scheduled", "manual"]);
    expect(statusKinds(make({ scheduledKind: undefined }))).toEqual(["manual"]);
  });
});
```

Create `Servers/extensions/sync-engine/__tests__/sql.test.ts`:

```ts
import { sqlLiveRunExists, sqlOwnsRunFragment, sqlRunIsLive } from "../sql";

const TOKEN = "00000000-0000-4000-8000-000000000091";

describe("sql fragments", () => {
  it("decides liveness from the heartbeat, else the start, over 15 minutes", () => {
    expect(sqlRunIsLive("r")).toBe(
      "(COALESCE(r.heartbeat_at, r.started_at) >= now() - make_interval(mins => 15))",
    );
    expect(sqlLiveRunExists(":key", ":orgId")).toContain("live.extension_key = :key");
  });

  it("proves ownership of one started row under a share lock", () => {
    const sql = sqlOwnsRunFragment({ runId: 91, orgId: 5, token: TOKEN });
    expect(sql).toContain("own.id = 91");
    expect(sql).toContain("own.organization_id = 5");
    expect(sql).toContain(`own.run_token = '${TOKEN}'`);
    expect(sql).toContain("own.status = 'started'");
    expect(sql).toContain("FOR SHARE");
  });

  it.each([
    [{ runId: 0, orgId: 5, token: TOKEN }, "own"],
    [{ runId: 91, orgId: 1.5, token: TOKEN }, "own"],
    [{ runId: 91, orgId: 5, token: "x' OR '1'='1" }, "own"],
    [{ runId: 91, orgId: 5, token: TOKEN }, "own; DROP"],
  ])("refuses unsafe input %p / %p", (run, alias) => {
    expect(() => sqlOwnsRunFragment(run, alias)).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/registry.test.ts extensions/sync-engine/__tests__/sql.test.ts`
Expected: FAIL with `Cannot find module '../registry'` and `Cannot find module '../sql'`.

- [ ] **Step 3: Write `types.ts`, `errors.ts`, `registry.ts` and `sql.ts`**

Create `Servers/extensions/sync-engine/types.ts`:

```ts
import type { Transaction } from "sequelize";

/** Keys of sync providers; the same rule as extensions.key. */
export const EXTENSION_KEY_PATTERN = /^[a-z0-9-]+$/;
/** A `started` run with no heartbeat (else start) for this long is abandoned. */
export const STALE_AFTER_MINUTES = 15;
/** Run messages are cut to this many characters. */
export const MESSAGE_MAX_LENGTH = 2000;
/** A run's `signal` aborts after this long unless the provider sets runDeadlineMs. */
export const DEFAULT_RUN_DEADLINE_MS = 10 * 60 * 1000;
/** Backoff for failing scheduled runs never exceeds this many hours. */
export const BACKOFF_CAP_HOURS = 24;

/** `message` of a run closed because it stopped heart-beating. */
export const ABANDONED_RUN_MESSAGE = "Sync stopped responding and was marked as abandoned";
/** `message` of a manual run the worker skipped because another run held the claim. */
export const SKIPPED_RUN_MESSAGE =
  "Another sync or import was running, so this sync did not start.";

export const RUN_STATUSES = ["started", "completed", "failed", "abandoned", "skipped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type Readiness = { ready: true } | { ready: false; status: 400 | 404; reason: string };

export interface RunResult {
  /** Provider-defined counters; non-finite values are dropped. */
  counts: Record<string, number>;
  message?: string | null;
  code?: string | null;
}

/** What a provider gets for one claimed run. */
export interface RunContext {
  orgId: number;
  runId: number;
  kind: string;
  payload: unknown;
  triggeredBy: number | null;
  /** Throws RunSupersededError when the claim is lost. */
  heartbeat(): Promise<void>;
  /** SQL boolean proving this run still owns its row (share-locks it); for provider writes. */
  sqlOwnsRun(alias?: string): string;
  /** FOR SHARE on the run row inside the caller's transaction; RunSupersededError if lost. */
  assertOwned(t: Transaction): Promise<void>;
  /** Close as completed; inside the caller's transaction when given. */
  finalize(result: RunResult, t?: Transaction): Promise<void>;
  /** Delete a claim that did nothing, so it leaves no history row. */
  release(t?: Transaction): Promise<void>;
  /** Aborted at the run deadline. */
  signal: AbortSignal;
}

export interface SyncProvider {
  /** extensions.key; must match EXTENSION_KEY_PATTERN. */
  key: string;
  /** Every exclusive operation of the extension; must include "manual". */
  kinds: readonly string[];
  /** The kind the tick enqueues; no schedule if absent. */
  scheduledKind?: string;
  /** Deadline for `ctx.signal`; DEFAULT_RUN_DEADLINE_MS when absent. */
  runDeadlineMs?: number;
  readiness(orgId: number, kind: string): Promise<Readiness>;
  /** Refuses schedule changes (PATCH /:key/schedule) with its status; allowed when absent. */
  canSchedule?(orgId: number): Promise<Readiness>;
  /** Return a result for the engine to finalize, or void after finalizing itself. */
  run(ctx: RunContext): Promise<RunResult | void>;
}
```

Create `Servers/extensions/sync-engine/errors.ts`:

```ts
import { MESSAGE_MAX_LENGTH } from "./types";

/** A run of this extension is live for the organization, or a job is already waiting. */
export class SyncInProgressError extends Error {
  constructor(message = "A sync is already running for this extension") {
    super(message);
    this.name = "SyncInProgressError";
  }
}

/** The run's row is no longer its own `started` row; the run stops and writes nothing more. */
export class RunSupersededError extends Error {
  constructor(public readonly runId: number) {
    super(`Run ${runId} was closed by another run; stopping`);
    this.name = "RunSupersededError";
  }
}

export class UnknownSyncProviderError extends Error {
  constructor(public readonly key: string) {
    super(`No sync provider is registered for "${key}"`);
    this.name = "UnknownSyncProviderError";
  }
}

/** A provider's readiness refused the run; the route answers with `status` and the reason. */
export class SyncNotReadyError extends Error {
  constructor(
    public readonly status: 400 | 404,
    reason: string,
  ) {
    super(reason);
    this.name = "SyncNotReadyError";
  }
}

/** Bad input to an engine route (400). */
export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncValidationError";
  }
}

/**
 * Message for any thrown value; never empty. Moved unchanged from
 * jiraAssets.service.ts (`errorMessage`, lines 525-534), which re-exports it.
 */
export function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message) return message;
  if (err !== undefined && err !== null) {
    const text = String(err);
    if (text) return text;
  }
  return "Unknown error";
}

/** The error's string `code` (Node and Postgres errors carry one), or null. */
export function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 && code.length <= 64 ? code : null;
}

export function truncateMessage(message: string): string {
  return message.length > MESSAGE_MAX_LENGTH ? message.slice(0, MESSAGE_MAX_LENGTH) : message;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string }; original?: { code?: string } };
  return (
    e?.name === "SequelizeUniqueConstraintError" ||
    e?.parent?.code === "23505" ||
    e?.original?.code === "23505"
  );
}
```

Create `Servers/extensions/sync-engine/registry.ts`:

```ts
import { UnknownSyncProviderError } from "./errors";
import { EXTENSION_KEY_PATTERN, SyncProvider } from "./types";

const providers = new Map<string, SyncProvider>();

/** Register an extension's provider. Called once per process (API and worker). */
export function registerSyncProvider(provider: SyncProvider): void {
  if (!EXTENSION_KEY_PATTERN.test(provider.key)) {
    throw new Error(`Invalid sync provider key "${provider.key}"`);
  }
  if (!provider.kinds.includes("manual")) {
    throw new Error(`Sync provider ${provider.key} must declare the "manual" kind`);
  }
  if (provider.scheduledKind && !provider.kinds.includes(provider.scheduledKind)) {
    throw new Error(
      `Sync provider ${provider.key}: scheduledKind "${provider.scheduledKind}" is not one of its kinds`,
    );
  }
  const existing = providers.get(provider.key);
  if (existing && existing !== provider) {
    throw new Error(`A sync provider for ${provider.key} is already registered`);
  }
  providers.set(provider.key, provider);
}

export function getSyncProvider(key: string): SyncProvider {
  const provider = providers.get(key);
  if (!provider) throw new UnknownSyncProviderError(key);
  return provider;
}

export function findSyncProvider(key: string): SyncProvider | undefined {
  return providers.get(key);
}

export function listSyncProviders(): SyncProvider[] {
  return [...providers.values()];
}

/** Kinds that count as "last run" for the due rule and as latest_run / previousRunId. */
export function statusKinds(provider: SyncProvider): string[] {
  return provider.scheduledKind ? [provider.scheduledKind, "manual"] : ["manual"];
}

export function __resetSyncProvidersForTests(): void {
  providers.clear();
}
```

Create `Servers/extensions/sync-engine/sql.ts`:

```ts
/**
 * Pure SQL fragments for the sync engine. No database import, so the
 * throwaway-Postgres check scripts can load this file with ts-node. Only
 * trusted expressions (column names, bind parameters) are interpolated;
 * sqlOwnsRunFragment validates its values before inlining them.
 */
import { STALE_AFTER_MINUTES } from "./types";

const ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

function assertAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) throw new Error(`Invalid SQL alias "${alias}"`);
}

/** SQL: run row `alias` has a heartbeat (else start) inside the stale window. */
export function sqlRunIsLive(alias: string): string {
  assertAlias(alias);
  return `(COALESCE(${alias}.heartbeat_at, ${alias}.started_at) >= now() - make_interval(mins => ${STALE_AFTER_MINUTES}))`;
}

/** SQL: a live `started` run exists for extension `keyExpr` in org `orgExpr`. */
export function sqlLiveRunExists(keyExpr: string, orgExpr: string): string {
  return `EXISTS (SELECT 1 FROM extension_sync_runs live
                   WHERE live.organization_id = ${orgExpr} AND live.extension_key = ${keyExpr}
                     AND live.status = 'started' AND ${sqlRunIsLive("live")})`;
}

export interface OwnedRunRef {
  runId: number;
  orgId: number;
  token: string;
}

/**
 * SQL boolean: the run still owns its `started` row. FOR SHARE holds the row
 * until the statement's transaction ends, so a claim closing it as abandoned
 * must wait: writes guarded by this cannot land after the claim was lost.
 */
export function sqlOwnsRunFragment(run: OwnedRunRef, alias = "own"): string {
  assertAlias(alias);
  if (
    !Number.isInteger(run.runId) ||
    run.runId <= 0 ||
    !Number.isInteger(run.orgId) ||
    run.orgId <= 0 ||
    !TOKEN_PATTERN.test(run.token)
  ) {
    throw new Error("Invalid run reference");
  }
  return `EXISTS (SELECT 1 FROM extension_sync_runs ${alias}
                   WHERE ${alias}.id = ${run.runId} AND ${alias}.organization_id = ${run.orgId}
                     AND ${alias}.run_token = '${run.token}' AND ${alias}.status = 'started'
                   FOR SHARE)`;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/registry.test.ts extensions/sync-engine/__tests__/sql.test.ts`
Expected: PASS (every test in both files).

- [ ] **Step 5: Write the failing claim tests**

Create `Servers/extensions/sync-engine/__tests__/claim.test.ts`:

```ts
jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));

import { sequelize } from "../../../database/db";
import {
  ClaimedRun,
  claimRun,
  createRunContext,
  recordSkippedRun,
  runClaimed,
  withClaim,
} from "../claim";
import { RunSupersededError, SyncInProgressError } from "../errors";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../registry";
import { ABANDONED_RUN_MESSAGE, SKIPPED_RUN_MESSAGE, SyncProvider } from "../types";

const mockQuery = sequelize.query as jest.Mock;
const mockTransaction = sequelize.transaction as unknown as jest.Mock;
const commitHooks: Array<() => void> = [];
const TX = { id: "tx", afterCommit: (fn: () => void) => commitHooks.push(fn) };
const TOKEN = "00000000-0000-4000-8000-000000000091";
const STARTED_AT = new Date("2026-10-12T10:00:00Z");

const mockRun = jest.fn();
const provider: SyncProvider = {
  key: "demo-ext",
  kinds: ["manual", "scheduled", "import"],
  scheduledKind: "scheduled",
  runDeadlineMs: 1000,
  readiness: async () => ({ ready: true }),
  run: (ctx) => mockRun(ctx),
};
const RUN: ClaimedRun = {
  runId: 91,
  token: TOKEN,
  orgId: 5,
  key: "demo-ext",
  kind: "manual",
  triggeredBy: 8,
};

interface Db {
  live?: Array<{ id: number }>;
  owned?: boolean;
  insertError?: unknown;
  closed?: Array<{ kind: string; started_at: Date }>;
}

/** Route sequelize.query by SQL text, so tests read as scenarios. */
function fakeDb({ live = [], owned = true, insertError, closed = [] }: Db = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) return [{}];
    if (sql.includes("SET status = 'abandoned'")) return [closed, {}];
    if (sql.includes("FOR SHARE")) return owned ? [{ id: 91 }] : [];
    if (sql.includes("SELECT id FROM extension_sync_runs")) return live;
    if (sql.includes("'skipped', 'skipped'")) return [[], 1];
    if (sql.includes("INSERT INTO extension_sync_runs")) {
      if (insertError) throw insertError;
      return [[{ id: 91 }], 1];
    }
    if (sql.includes("SET heartbeat_at")) return [owned ? [{ id: 91 }] : [], {}];
    if (sql.includes("SET status = 'completed'")) return [owned ? [{ id: 91 }] : [], {}];
    if (sql.includes("SET status = 'failed'")) {
      return [owned ? [{ started_at: STARTED_AT }] : [], {}];
    }
    return [[], {}];
  });
}

const calls = (fragment: string) =>
  mockQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider(provider);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockRun.mockReset();
  commitHooks.length = 0;
  mockTransaction.mockReset();
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const result = await cb(TX);
    commitHooks.splice(0).forEach((fn) => fn());
    return result;
  });
});

describe("claimRun", () => {
  it("serialises on an advisory lock keyed by extension and org", async () => {
    fakeDb();
    await claimRun("demo-ext", 5, "manual", 8);
    const [lockSql, lock] = calls("pg_advisory_xact_lock")[0];
    expect(lockSql).toContain("hashtext('ext_sync:' || :key)");
    expect(lock.replacements).toEqual({ key: "demo-ext", orgId: 5 });
  });

  it("closes stale started rows as abandoned, deciding staleness in SQL", async () => {
    fakeDb();
    await claimRun("demo-ext", 5, "manual", 8);
    const [sql, options] = calls("SET status = 'abandoned'")[0];
    expect(sql).toContain("code = 'abandoned'");
    expect(sql).toContain("NOT (COALESCE(r.heartbeat_at, r.started_at)");
    expect(options.replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      message: ABANDONED_RUN_MESSAGE,
    });
    expect(options.transaction).toBe(TX);
  });

  it("inserts a started row with a fresh UUID token", async () => {
    fakeDb();
    const a = await claimRun("demo-ext", 5, "manual", 8);
    const b = await claimRun("demo-ext", 5, "manual", 8);
    expect(a).toMatchObject({ runId: 91, orgId: 5, key: "demo-ext", kind: "manual", triggeredBy: 8 });
    expect(a.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.token).not.toBe(b.token);
    const [, insert] = calls("INSERT INTO extension_sync_runs")[0];
    expect(insert.replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      kind: "manual",
      token: a.token,
      triggeredBy: 8,
    });
  });

  it("refuses with SyncInProgressError while a live run remains, inserting nothing", async () => {
    fakeDb({ live: [{ id: 12 }] });
    await expect(claimRun("demo-ext", 5, "manual", 8)).rejects.toBeInstanceOf(
      SyncInProgressError,
    );
    expect(calls("INSERT INTO extension_sync_runs")).toHaveLength(0);
  });

  it("turns a unique violation on the started index into SyncInProgressError", async () => {
    fakeDb({ insertError: Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }) });
    await expect(claimRun("demo-ext", 5, "manual", 8)).rejects.toBeInstanceOf(
      SyncInProgressError,
    );
  });

  it("rejects a kind the provider does not declare, before any SQL", async () => {
    await expect(claimRun("demo-ext", 5, "remove_missing", 8)).rejects.toThrow(
      '"remove_missing" is not a run kind of demo-ext',
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("RunContext", () => {
  it("heartbeat matches id, org, extension, token and started", async () => {
    fakeDb();
    const ctx = createRunContext(provider, RUN, null);
    await ctx.heartbeat();
    const [sql, options] = calls("SET heartbeat_at")[0];
    expect(sql).toContain("run_token = :token AND status = 'started'");
    expect(options.replacements).toEqual({ runId: 91, orgId: 5, key: "demo-ext", token: TOKEN });
    ctx.dispose();
  });

  it("heartbeat throws RunSupersededError once the claim is lost", async () => {
    fakeDb({ owned: false });
    const ctx = createRunContext(provider, RUN, null);
    await expect(ctx.heartbeat()).rejects.toBeInstanceOf(RunSupersededError);
    ctx.dispose();
  });

  it("sqlOwnsRun share-locks this run's own row", () => {
    const ctx = createRunContext(provider, RUN, null);
    const sql = ctx.sqlOwnsRun();
    expect(sql).toContain("own.id = 91");
    expect(sql).toContain(`own.run_token = '${TOKEN}'`);
    expect(sql).toContain("FOR SHARE");
    expect(ctx.sqlOwnsRun("mine")).toContain("mine.id = 91");
    ctx.dispose();
  });

  it("assertOwned share-locks the row inside the caller's transaction", async () => {
    fakeDb();
    const ctx = createRunContext(provider, RUN, null);
    await ctx.assertOwned(TX as never);
    expect(calls("FOR SHARE")[0][1].transaction).toBe(TX);
    fakeDb({ owned: false });
    await expect(ctx.assertOwned(TX as never)).rejects.toBeInstanceOf(RunSupersededError);
    ctx.dispose();
  });

  it("finalize outside a transaction records counts, message and code, then settles", async () => {
    fakeDb();
    const ctx = createRunContext(provider, RUN, null);
    await ctx.finalize({ counts: { fetched: 3, bad: Number.NaN }, message: "x".repeat(2500), code: "partial" });
    const [, options] = calls("SET status = 'completed'")[0];
    expect(JSON.parse(options.replacements.counts)).toEqual({ fetched: 3 });
    expect(options.replacements.message).toHaveLength(2000);
    expect(options.replacements.code).toBe("partial");
    expect(ctx.settled).toBe(true);
    ctx.dispose();
  });

  it("finalize with a lost claim (wrong token) writes nothing and throws", async () => {
    fakeDb({ owned: false });
    const ctx = createRunContext(provider, RUN, null);
    await expect(ctx.finalize({ counts: {} })).rejects.toBeInstanceOf(RunSupersededError);
    expect(ctx.settled).toBe(false);
    ctx.dispose();
  });

  it("finalize inside a transaction settles only when it commits", async () => {
    fakeDb();
    const ctx = createRunContext(provider, RUN, null);
    await ctx.finalize({ counts: {} }, TX as never);
    expect(calls("SET status = 'completed'")[0][1].transaction).toBe(TX);
    expect(ctx.settled).toBe(false);
    commitHooks.splice(0).forEach((fn) => fn());
    expect(ctx.settled).toBe(true);
    ctx.dispose();
  });

  it("release deletes only this started row and never throws outside a transaction", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const ctx = createRunContext(provider, RUN, null);
    await expect(ctx.release()).resolves.toBeUndefined();
    expect(ctx.settled).toBe(false);
    mockQuery.mockReset();
    fakeDb();
    await ctx.release();
    const [sql, options] = calls("DELETE FROM extension_sync_runs")[0];
    expect(sql).toContain("run_token = :token AND status = 'started'");
    expect(options.replacements).toEqual({ runId: 91, orgId: 5, key: "demo-ext", token: TOKEN });
    expect(ctx.settled).toBe(true);
    ctx.dispose();
  });

  it("aborts its signal at the provider's run deadline", () => {
    jest.useFakeTimers();
    try {
      const ctx = createRunContext(provider, RUN, null);
      expect(ctx.signal.aborted).toBe(false);
      jest.advanceTimersByTime(1000);
      expect(ctx.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("runClaimed", () => {
  const ctxFor = (kind = "manual") => createRunContext(provider, { ...RUN, kind }, null);

  it("finalizes the result the provider returns", async () => {
    fakeDb();
    mockRun.mockResolvedValue({ counts: { fetched: 2 }, message: "ok" });
    await runClaimed(provider, ctxFor());
    expect(calls("SET status = 'completed'")).toHaveLength(1);
    expect(calls("SET status = 'failed'")).toHaveLength(0);
  });

  it("records a thrown error as failed, truncated, with its code", async () => {
    fakeDb();
    mockRun.mockRejectedValue(Object.assign(new Error("y".repeat(2100)), { code: "ECONNRESET" }));
    await runClaimed(provider, ctxFor());
    const [sql, options] = calls("SET status = 'failed'")[0];
    expect(sql).toContain("run_token = :token AND status = 'started'");
    expect(options.replacements.message).toHaveLength(2000);
    expect(options.replacements.code).toBe("ECONNRESET");
  });

  it("stores a null code when the error has none", async () => {
    fakeDb();
    mockRun.mockRejectedValue(new Error("boom"));
    await runClaimed(provider, ctxFor());
    const [, options] = calls("SET status = 'failed'")[0];
    expect(options.replacements).toMatchObject({ message: "boom", code: null });
  });

  it.each([
    ["a string", "boom", "boom"],
    ["undefined", undefined, "Unknown error"],
    ["an empty Error", new Error(""), "Error"],
    ["null", null, "Unknown error"],
  ])("closes the run as failed for a thrown non-Error value (%s)", async (_label, thrown, expected) => {
    fakeDb();
    mockRun.mockImplementation(async () => {
      throw thrown;
    });
    await runClaimed(provider, ctxFor());
    expect(calls("SET status = 'failed'")[0][1].replacements.message).toBe(expected);
  });

  it("writes nothing when the run was superseded", async () => {
    fakeDb();
    mockRun.mockRejectedValue(new RunSupersededError(91));
    await runClaimed(provider, ctxFor());
    expect(calls("SET status = 'failed'")).toHaveLength(0);
    expect(calls("SET status = 'completed'")).toHaveLength(0);
  });

  it("writes nothing more when the provider finalized itself", async () => {
    fakeDb();
    mockRun.mockImplementation(async (ctx) => {
      await ctx.finalize({ counts: {} });
    });
    await runClaimed(provider, ctxFor());
    expect(calls("SET status = 'completed'")).toHaveLength(1);
    expect(calls("SET status = 'failed'")).toHaveLength(0);
  });

  it("fails a run whose provider returned nothing and did not finalize", async () => {
    fakeDb();
    mockRun.mockResolvedValue(undefined);
    await runClaimed(provider, ctxFor());
    expect(calls("SET status = 'failed'")[0][1].replacements.message).toBe(
      "demo-ext manual run returned no result",
    );
  });

  it("never throws when recording the failure fails", async () => {
    mockRun.mockRejectedValue(new Error("boom"));
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(runClaimed(provider, ctxFor())).resolves.toBeUndefined();
  });
});

describe("withClaim", () => {
  it("claims, runs fn and finalizes its result", async () => {
    fakeDb();
    const value = await withClaim("demo-ext", 5, "import", 8, async () => ({
      value: 42,
      result: { counts: { created: 1 } },
    }));
    expect(value).toBe(42);
    expect(calls("INSERT INTO extension_sync_runs")[0][1].replacements).toMatchObject({
      kind: "import",
      triggeredBy: 8,
    });
    expect(calls("SET status = 'completed'")).toHaveLength(1);
  });

  it("releases a claim that produced no result", async () => {
    fakeDb();
    await expect(
      withClaim("demo-ext", 5, "import", 8, async () => ({ value: "none" })),
    ).resolves.toBe("none");
    expect(calls("DELETE FROM extension_sync_runs")).toHaveLength(1);
    expect(calls("SET status = 'completed'")).toHaveLength(0);
  });

  it("closes the run as failed and rethrows on an error", async () => {
    fakeDb();
    await expect(
      withClaim("demo-ext", 5, "import", 8, async () => {
        throw new Error("Jira down");
      }),
    ).rejects.toThrow("Jira down");
    expect(calls("SET status = 'failed'")).toHaveLength(1);
  });

  it("releases instead of failing when releaseOn matches", async () => {
    class NothingToDo extends Error {}
    fakeDb();
    await expect(
      withClaim(
        "demo-ext",
        5,
        "import",
        8,
        async () => {
          throw new NothingToDo("none");
        },
        { releaseOn: (err) => err instanceof NothingToDo },
      ),
    ).rejects.toBeInstanceOf(NothingToDo);
    expect(calls("DELETE FROM extension_sync_runs")).toHaveLength(1);
    expect(calls("SET status = 'failed'")).toHaveLength(0);
  });

  it("writes nothing on a superseded run and rethrows", async () => {
    fakeDb();
    await expect(
      withClaim("demo-ext", 5, "import", 8, async () => {
        throw new RunSupersededError(91);
      }),
    ).rejects.toBeInstanceOf(RunSupersededError);
    expect(calls("SET status = 'failed'")).toHaveLength(0);
    expect(calls("DELETE FROM extension_sync_runs")).toHaveLength(0);
  });

  it("leaves a run finalized inside a committed transaction alone", async () => {
    fakeDb();
    const value = await withClaim("demo-ext", 5, "import", 8, async (ctx) => {
      await sequelize.transaction(async (t) => ctx.finalize({ counts: { deleted: 2 } }, t));
      return { value: "done" };
    });
    expect(value).toBe("done");
    expect(calls("SET status = 'completed'")).toHaveLength(1);
    expect(calls("DELETE FROM extension_sync_runs")).toHaveLength(0);
    expect(calls("SET status = 'failed'")).toHaveLength(0);
  });

  it("fails the run when the transaction that finalized it rolled back", async () => {
    fakeDb();
    let n = 0;
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      n += 1;
      const result = await cb(TX);
      if (n === 2) {
        commitHooks.length = 0;
        throw new Error("commit failed");
      }
      commitHooks.splice(0).forEach((fn) => fn());
      return result;
    });
    await expect(
      withClaim("demo-ext", 5, "import", 8, async (ctx) => {
        await sequelize.transaction(async (t) => ctx.finalize({ counts: {} }, t));
        return { value: 1 };
      }),
    ).rejects.toThrow("commit failed");
    expect(calls("SET status = 'failed'")).toHaveLength(1);
  });
});

describe("recordSkippedRun", () => {
  it("records a closed skipped row with no token", async () => {
    fakeDb();
    await recordSkippedRun("demo-ext", 5, "manual", 8);
    const [sql, options] = calls("INSERT INTO extension_sync_runs")[0];
    expect(sql).toContain("'skipped', 'skipped'");
    expect(sql).not.toContain("run_token");
    expect(options.replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      kind: "manual",
      triggeredBy: 8,
      message: SKIPPED_RUN_MESSAGE,
    });
  });

  it("never throws", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(recordSkippedRun("demo-ext", 5, "manual", 8)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/claim.test.ts`
Expected: FAIL with `Cannot find module '../claim'`.

- [ ] **Step 7: Write `claim.ts`**

Create `Servers/extensions/sync-engine/claim.ts`:

```ts
import { randomUUID } from "crypto";
import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import {
  RunSupersededError,
  SyncInProgressError,
  errorCode,
  errorMessage,
  isUniqueViolation,
  truncateMessage,
} from "./errors";
import { getSyncProvider } from "./registry";
import { sqlOwnsRunFragment, sqlRunIsLive } from "./sql";
import {
  ABANDONED_RUN_MESSAGE,
  DEFAULT_RUN_DEADLINE_MS,
  RunContext,
  RunResult,
  SKIPPED_RUN_MESSAGE,
  SyncProvider,
} from "./types";

const fileName = "claim.ts";

/** A claimed run: its row and the random token only this run holds. */
export interface ClaimedRun {
  runId: number;
  token: string;
  orgId: number;
  key: string;
  kind: string;
  triggeredBy: number | null;
}

/** Close the org's stale `started` rows of this extension as abandoned. */
async function closeStaleRuns(
  provider: SyncProvider,
  orgId: number,
  transaction: Transaction,
): Promise<Array<{ kind: string; started_at: Date }>> {
  const [closed] = (await sequelize.query(
    `UPDATE extension_sync_runs r
        SET status = 'abandoned', code = 'abandoned', message = :message, completed_at = now()
      WHERE r.organization_id = :orgId AND r.extension_key = :key
        AND r.status = 'started' AND NOT ${sqlRunIsLive("r")}
      RETURNING r.kind, r.started_at;`,
    { replacements: { orgId, key: provider.key, message: ABANDONED_RUN_MESSAGE }, transaction },
  )) as unknown as [Array<{ kind: string; started_at: Date }>, unknown];
  return closed ?? [];
}

/**
 * Atomically record the start of a run, or refuse with SyncInProgressError if
 * one of this extension is live for the org. One claim per (extension, org)
 * covers every exclusive operation the provider declares. The transaction's
 * advisory lock serialises the check-then-insert; the long-running guard is
 * the `started` row (and its partial unique index). Stale rows are closed as
 * abandoned first. The row gets a random token that every later ownership
 * check matches.
 */
export async function claimRun(
  key: string,
  orgId: number,
  kind: string,
  triggeredBy: number | null,
): Promise<ClaimedRun> {
  const provider = getSyncProvider(key);
  if (!provider.kinds.includes(kind)) throw new Error(`"${kind}" is not a run kind of ${key}`);
  const token = randomUUID();
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext('ext_sync:' || :key), :orgId);`, {
      replacements: { key, orgId },
      type: QueryTypes.SELECT,
      transaction,
    });
    await closeStaleRuns(provider, orgId, transaction);
    const running = (await sequelize.query(
      `SELECT id FROM extension_sync_runs
        WHERE organization_id = :orgId AND extension_key = :key AND status = 'started'
        LIMIT 1;`,
      { replacements: { orgId, key }, type: QueryTypes.SELECT, transaction },
    )) as Array<{ id: number }>;
    if (running.length > 0) throw new SyncInProgressError();
    try {
      const inserted = (await sequelize.query(
        `INSERT INTO extension_sync_runs
           (organization_id, extension_key, kind, status, run_token, triggered_by,
            started_at, heartbeat_at)
         VALUES (:orgId, :key, :kind, 'started', :token, :triggeredBy, now(), now())
         RETURNING id;`,
        {
          replacements: { orgId, key, kind, token, triggeredBy },
          type: QueryTypes.INSERT,
          transaction,
        },
      )) as unknown as [Array<{ id: number }>, number];
      return { runId: inserted[0][0].id, token, orgId, key, kind, triggeredBy };
    } catch (err) {
      if (isUniqueViolation(err)) throw new SyncInProgressError();
      throw err;
    }
  });
}

function cleanCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(counts ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

/** The engine's RunContext. Every write matches id, org, extension, token and `started`. */
export class EngineRunContext implements RunContext {
  readonly orgId: number;
  readonly runId: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly triggeredBy: number | null;
  readonly signal: AbortSignal;
  private settledFlag = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    readonly provider: SyncProvider,
    private readonly run: ClaimedRun,
    payload: unknown,
  ) {
    this.orgId = run.orgId;
    this.runId = run.runId;
    this.kind = run.kind;
    this.triggeredBy = run.triggeredBy;
    this.payload = payload;
    const controller = new AbortController();
    this.timer = setTimeout(
      () => controller.abort(new Error(`${run.key} run ${run.runId} reached its deadline`)),
      provider.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS,
    );
    this.timer.unref();
    this.signal = controller.signal;
  }

  /** True once this run's row is closed or released (after commit when written in a transaction). */
  get settled(): boolean {
    return this.settledFlag;
  }

  markSettled(transaction?: Transaction): void {
    if (transaction) {
      transaction.afterCommit(() => {
        this.settledFlag = true;
      });
    } else {
      this.settledFlag = true;
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  /** Bind parameters identifying this run in every ownership check. */
  ref(): { runId: number; orgId: number; key: string; token: string } {
    return {
      runId: this.run.runId,
      orgId: this.run.orgId,
      key: this.run.key,
      token: this.run.token,
    };
  }

  async heartbeat(): Promise<void> {
    const [rows] = (await sequelize.query(
      `UPDATE extension_sync_runs SET heartbeat_at = now()
        WHERE id = :runId AND organization_id = :orgId AND extension_key = :key
          AND run_token = :token AND status = 'started'
        RETURNING id;`,
      { replacements: this.ref() },
    )) as unknown as [Array<{ id: number }>, unknown];
    if (!rows || rows.length === 0) throw new RunSupersededError(this.runId);
  }

  sqlOwnsRun(alias = "own"): string {
    return sqlOwnsRunFragment(
      { runId: this.run.runId, orgId: this.run.orgId, token: this.run.token },
      alias,
    );
  }

  async assertOwned(transaction: Transaction): Promise<void> {
    const rows = (await sequelize.query(
      `SELECT id FROM extension_sync_runs
        WHERE id = :runId AND organization_id = :orgId AND extension_key = :key
          AND run_token = :token AND status = 'started'
        FOR SHARE;`,
      { replacements: this.ref(), type: QueryTypes.SELECT, transaction },
    )) as Array<{ id: number }>;
    if (rows.length === 0) throw new RunSupersededError(this.runId);
  }

  async finalize(result: RunResult, transaction?: Transaction): Promise<void> {
    const [rows] = (await sequelize.query(
      `UPDATE extension_sync_runs
          SET status = 'completed', counts = CAST(:counts AS JSONB), message = :message,
              code = :code, completed_at = now()
        WHERE id = :runId AND organization_id = :orgId AND extension_key = :key
          AND run_token = :token AND status = 'started'
        RETURNING id;`,
      {
        replacements: {
          ...this.ref(),
          counts: JSON.stringify(cleanCounts(result.counts)),
          message: result.message ? truncateMessage(result.message) : null,
          code: result.code ?? null,
        },
        transaction,
      },
    )) as unknown as [Array<{ id: number }>, unknown];
    if (!rows || rows.length === 0) throw new RunSupersededError(this.runId);
    this.markSettled(transaction);
  }

  async release(transaction?: Transaction): Promise<void> {
    const remove = () =>
      sequelize.query(
        `DELETE FROM extension_sync_runs
          WHERE id = :runId AND organization_id = :orgId AND extension_key = :key
            AND run_token = :token AND status = 'started';`,
        { replacements: this.ref(), transaction },
      );
    if (transaction) {
      await remove();
      this.markSettled(transaction);
      return;
    }
    try {
      await remove();
      this.markSettled();
    } catch (err) {
      // The row stays `started` and is closed as abandoned after the stale window.
      logger.error(`Extension sync: could not release run ${this.runId}:`, err);
    }
  }
}

export function createRunContext(
  provider: SyncProvider,
  run: ClaimedRun,
  payload: unknown,
): EngineRunContext {
  return new EngineRunContext(provider, run, payload);
}

/**
 * Close a run as failed with the error's message (cut to 2,000 characters)
 * and code. Only touches the run's own `started` row. Never throws: it runs in
 * catch blocks, where a second exception would hide the first.
 */
export async function failRun(ctx: EngineRunContext, err: unknown): Promise<void> {
  const message = truncateMessage(errorMessage(err));
  try {
    const closed = await sequelize.transaction(async (transaction) => {
      const [rows] = (await sequelize.query(
        `UPDATE extension_sync_runs
            SET status = 'failed', message = :message, code = :code, completed_at = now()
          WHERE id = :runId AND organization_id = :orgId AND extension_key = :key
            AND run_token = :token AND status = 'started'
          RETURNING started_at;`,
        { replacements: { ...ctx.ref(), message, code: errorCode(err) }, transaction },
      )) as unknown as [Array<{ started_at: Date }>, unknown];
      return rows?.[0] ?? null;
    });
    if (!closed) {
      logger.warn(`Extension sync run ${ctx.runId} was already closed; failure not recorded`);
      return;
    }
    ctx.markSettled();
  } catch (finalizeErr) {
    logStructured(
      "error",
      `Extension sync run ${ctx.runId} could not be marked failed`,
      "failRun",
      fileName,
    );
    logger.error(`Extension sync failRun for run ${ctx.runId} failed:`, finalizeErr);
  }
}

/**
 * Run a claimed run to the end. A returned result is finalized; a provider that
 * finalized itself returns void. A thrown error closes the run as failed; a
 * lost claim (RunSupersededError) writes nothing. Never throws.
 */
export async function runClaimed(provider: SyncProvider, ctx: EngineRunContext): Promise<void> {
  try {
    const result = await provider.run(ctx);
    if (!ctx.settled) {
      if (result) await ctx.finalize(result);
      else await failRun(ctx, new Error(`${provider.key} ${ctx.kind} run returned no result`));
    }
  } catch (err) {
    if (err instanceof RunSupersededError) {
      logger.warn(err.message);
      return;
    }
    await failRun(ctx, err);
  } finally {
    ctx.dispose();
  }
}

export interface WithClaimOptions {
  payload?: unknown;
  /** Errors that mean "nothing was done": the claim is released instead of failed. */
  releaseOn?: (err: unknown) => boolean;
}

/**
 * An exclusive operation outside a sync (an import, a removal) under the same
 * per-(extension, org) claim. `fn` gets the run's context and returns its
 * value plus, optionally, a result. If `fn` did not finalize or release the
 * run itself, a result is finalized and no result releases the claim. A thrown
 * error closes the run as failed (or releases it, per `releaseOn`) and is
 * rethrown; RunSupersededError writes nothing. A provider that needs rollback
 * safety calls ctx.finalize(result, t) or ctx.release(t) inside its own data
 * transaction.
 */
export async function withClaim<T>(
  key: string,
  orgId: number,
  kind: string,
  triggeredBy: number | null,
  fn: (ctx: RunContext) => Promise<{ value: T; result?: RunResult }>,
  options: WithClaimOptions = {},
): Promise<T> {
  const provider = getSyncProvider(key);
  const run = await claimRun(key, orgId, kind, triggeredBy);
  const ctx = createRunContext(provider, run, options.payload ?? null);
  try {
    const { value, result } = await fn(ctx);
    if (!ctx.settled) {
      if (result) await ctx.finalize(result);
      else await ctx.release();
    }
    return value;
  } catch (err) {
    if (!(err instanceof RunSupersededError) && !ctx.settled) {
      if (options.releaseOn?.(err)) await ctx.release();
      else await failRun(ctx, err);
    }
    throw err;
  } finally {
    ctx.dispose();
  }
}

/**
 * A closed `skipped` row saying a manual run did not start because another run
 * held the claim. No token, so it never counts as a run for the schedule.
 * Never throws.
 */
export async function recordSkippedRun(
  key: string,
  orgId: number,
  kind: string,
  triggeredBy: number | null,
): Promise<void> {
  try {
    await sequelize.query(
      `INSERT INTO extension_sync_runs
         (organization_id, extension_key, kind, status, code, message, triggered_by,
          started_at, completed_at)
       VALUES (:orgId, :key, :kind, 'skipped', 'skipped', :message, :triggeredBy, now(), now());`,
      { replacements: { orgId, key, kind, triggeredBy, message: SKIPPED_RUN_MESSAGE } },
    );
  } catch (err) {
    logger.error(`Extension sync: could not record a skipped ${key} run for org ${orgId}:`, err);
  }
}
```

- [ ] **Step 8: Run all engine tests to verify they pass**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/registry.test.ts extensions/sync-engine/__tests__/sql.test.ts extensions/sync-engine/__tests__/claim.test.ts`
Expected: PASS (all tests in the three files).

- [ ] **Step 9: Build, format and commit**

```bash
cd Servers && npx prettier --write extensions/sync-engine && npm run build
cd .. && git add Servers/extensions/sync-engine
git commit -m "feat(sync-engine): provider registry, run claim and run context" -m "claimRun takes pg_advisory_xact_lock(hashtext('ext_sync:' || key), orgId), closes stale started rows as abandoned (15 minutes), refuses a live run with SyncInProgressError and inserts a started row with a UUID token. EngineRunContext gives providers heartbeat, sqlOwnsRun (FOR SHARE fragment), assertOwned, finalize and release (inside a caller transaction when given) and a deadline signal. runClaimed and withClaim finalize, fail (message cut to 2,000 characters, error code kept) or release; a superseded run writes nothing."
```

---

### Task 3: Schedule bookkeeping, due query and backoff

**Files:**
- Create: `Servers/extensions/sync-engine/schedule.ts`
- Create: `Servers/scripts/checkExtensionSyncEngineSql.js`
- Modify: `Servers/extensions/sync-engine/sql.ts` (append backoff and the due query; change the `types` import)
- Modify: `Servers/extensions/sync-engine/claim.ts` (`claimRun`, `EngineRunContext.finalize`, `failRun`)
- Test: `Servers/extensions/sync-engine/__tests__/schedule.test.ts`
- Test: `Servers/extensions/sync-engine/__tests__/claim.test.ts` (new `describe("schedule bookkeeping")`)

**Interfaces:**
- Consumes: `statusKinds`, `SyncProvider`, `SyncValidationError`, `sqlLiveRunExists` from Task 2; `withThrowawayPostgres` from Task 1.
- Produces:
  - `sql.ts`: `backoffHours(consecutiveFailures: number): number`, `sqlBackoffHours(alias: string): string`, `DUE_RUNS_SQL: string` (binds `:key`, `:statusKinds`).
  - `schedule.ts`: `INTERVAL_MIN_HOURS = 1`, `INTERVAL_MAX_HOURS = 168`, `DEFAULT_INTERVAL_HOURS = 24`, `INTERVAL_MESSAGE`, `interface ScheduleView { enabled; interval_hours; consecutive_failures; failing_since: Date | null }`, `interface SchedulePatch { enabled?: boolean; intervalHours?: number }`, `parseIntervalHours(raw: unknown): number`, `parseSchedulePatch(body: unknown): SchedulePatch`, `getSchedule(key, orgId): Promise<ScheduleView | null>`, `saveSchedule(key, orgId, patch): Promise<ScheduleView>`, `recordFailureForSchedule(key, orgId, startedAt: Date, t?): Promise<void>`, `resetScheduleFailures(key, orgId, t?): Promise<void>`, `findDueRuns(provider): Promise<Array<{ organization_id: number }>>`.

- [ ] **Step 1: Write the failing schedule tests**

Create `Servers/extensions/sync-engine/__tests__/schedule.test.ts`:

```ts
jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));

import { sequelize } from "../../../database/db";
import { SyncValidationError } from "../errors";
import {
  findDueRuns,
  getSchedule,
  parseIntervalHours,
  parseSchedulePatch,
  recordFailureForSchedule,
  resetScheduleFailures,
  saveSchedule,
} from "../schedule";
import { backoffHours, DUE_RUNS_SQL } from "../sql";
import type { SyncProvider } from "../types";

const mockQuery = sequelize.query as jest.Mock;
const TX = { id: "tx" };
const provider: SyncProvider = {
  key: "demo-ext",
  kinds: ["manual", "scheduled"],
  scheduledKind: "scheduled",
  readiness: async () => ({ ready: true }),
  run: async () => ({ counts: {} }),
};

beforeEach(() => mockQuery.mockReset());

describe("parseIntervalHours", () => {
  it("accepts whole hours from 1 to 168, as numbers or numeric strings", () => {
    expect(parseIntervalHours(1)).toBe(1);
    expect(parseIntervalHours(168)).toBe(168);
    expect(parseIntervalHours(" 12 ")).toBe(12);
  });

  it.each([0, 169, -5, 1.5, "12.5", "abc", "", null, undefined, true, {}])("rejects %p", (raw) => {
    expect(() => parseIntervalHours(raw)).toThrow(SyncValidationError);
  });
});

describe("parseSchedulePatch", () => {
  it("keeps only the fields that were sent", () => {
    expect(parseSchedulePatch({ enabled: true })).toEqual({ enabled: true, intervalHours: undefined });
    expect(parseSchedulePatch({ interval_hours: "6" })).toEqual({ enabled: undefined, intervalHours: 6 });
  });

  it.each([[{}], [undefined], [{ enabled: "yes" }], [{ interval_hours: null }]])(
    "rejects %p",
    (body) => {
      expect(() => parseSchedulePatch(body)).toThrow(SyncValidationError);
    },
  );
});

describe("schedule rows", () => {
  it("reads the org's row for the extension", async () => {
    mockQuery.mockResolvedValue([
      { enabled: true, interval_hours: 6, consecutive_failures: 0, failing_since: null },
    ]);
    await expect(getSchedule("demo-ext", 5)).resolves.toEqual({
      enabled: true,
      interval_hours: 6,
      consecutive_failures: 0,
      failing_since: null,
    });
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("WHERE organization_id = :orgId AND extension_key = :key");
    expect(options.replacements).toEqual({ orgId: 5, key: "demo-ext" });
  });

  it("returns null when the org has no schedule yet", async () => {
    mockQuery.mockResolvedValue([]);
    await expect(getSchedule("demo-ext", 5)).resolves.toBeNull();
  });

  it("upserts only the fields given, with defaults for a new row", async () => {
    mockQuery.mockResolvedValue([
      [{ enabled: true, interval_hours: 24, consecutive_failures: 0, failing_since: null }],
      1,
    ]);
    await saveSchedule("demo-ext", 5, { enabled: true });
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (organization_id, extension_key) DO UPDATE");
    expect(sql).toContain("COALESCE(:enabled, extension_sync_settings.enabled)");
    expect(sql).toContain("COALESCE(:intervalHours, extension_sync_settings.interval_hours)");
    expect(options.replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      enabled: true,
      intervalHours: null,
      defaultInterval: 24,
    });
  });

  it("starts a failure streak at the failed run's start and counts it up", async () => {
    mockQuery.mockResolvedValue([[], 0]);
    const startedAt = new Date("2026-10-12T10:00:00Z");
    await recordFailureForSchedule("demo-ext", 5, startedAt, TX as never);
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("consecutive_failures = consecutive_failures + 1");
    expect(sql).toContain("failing_since = COALESCE(failing_since, :startedAt)");
    expect(options).toMatchObject({ replacements: { orgId: 5, key: "demo-ext", startedAt }, transaction: TX });
  });

  it("clears the streak", async () => {
    mockQuery.mockResolvedValue([[], 0]);
    await resetScheduleFailures("demo-ext", 5);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("SET consecutive_failures = 0, failing_since = NULL");
  });
});

describe("backoff and the due query", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 4],
    [4, 8],
    [5, 16],
    [6, 24],
    [7, 24],
    [2000, 24],
  ])("backs off %p failures by %p hours", (failures, hours) => {
    expect(backoffHours(failures)).toBe(hours);
  });

  it("decides everything in one SQL statement", () => {
    expect(DUE_RUNS_SQL).toContain("ee.enabled = TRUE");
    expect(DUE_RUNS_SQL).toContain("s.enabled = TRUE");
    expect(DUE_RUNS_SQL).toContain("r.kind IN (:statusKinds) AND r.run_token IS NOT NULL");
    expect(DUE_RUNS_SQL).toContain("NOT EXISTS (SELECT 1 FROM extension_sync_runs live");
    expect(DUE_RUNS_SQL).toContain("GREATEST(s.interval_hours,");
    // The exponent is clamped, so a long failure streak cannot overflow power().
    expect(DUE_RUNS_SQL).toContain("power(2, LEAST(s.consecutive_failures, 6) - 1)");
  });

  it("asks for one extension's due orgs with its status kinds", async () => {
    mockQuery.mockResolvedValue([{ organization_id: 5 }]);
    await expect(findDueRuns(provider)).resolves.toEqual([{ organization_id: 5 }]);
    expect(mockQuery.mock.calls[0][1].replacements).toEqual({
      key: "demo-ext",
      statusKinds: ["scheduled", "manual"],
    });
  });

  it("has nothing due for a provider without a schedule", async () => {
    await expect(findDueRuns({ ...provider, scheduledKind: undefined })).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing bookkeeping tests**

Append to `Servers/extensions/sync-engine/__tests__/claim.test.ts`:

```ts
describe("schedule bookkeeping", () => {
  const streakUps = () => calls("consecutive_failures = consecutive_failures + 1");
  const resets = () => calls("SET consecutive_failures = 0");

  it("counts an abandoned scheduled run as a scheduled failure", async () => {
    fakeDb({
      closed: [
        { kind: "scheduled", started_at: STARTED_AT },
        { kind: "import", started_at: STARTED_AT },
      ],
    });
    await claimRun("demo-ext", 5, "manual", 8);
    expect(streakUps()).toHaveLength(1);
    expect(streakUps()[0][1]).toMatchObject({
      replacements: { key: "demo-ext", orgId: 5, startedAt: STARTED_AT },
      transaction: TX,
    });
  });

  it("counts a failed scheduled run, not a failed manual one", async () => {
    fakeDb();
    mockRun.mockRejectedValue(new Error("boom"));
    await runClaimed(provider, createRunContext(provider, { ...RUN, kind: "scheduled" }, null));
    expect(streakUps()).toHaveLength(1);
    await runClaimed(provider, createRunContext(provider, RUN, null));
    expect(streakUps()).toHaveLength(1);
  });

  it("resets the streak on a completed manual or scheduled run, not on an import", async () => {
    fakeDb();
    for (const kind of ["manual", "scheduled", "import"]) {
      const ctx = createRunContext(provider, { ...RUN, kind }, null);
      await ctx.finalize({ counts: {} });
      ctx.dispose();
    }
    expect(resets()).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/schedule.test.ts extensions/sync-engine/__tests__/claim.test.ts`
Expected: FAIL: `Cannot find module '../schedule'`, and in `claim.test.ts` the three bookkeeping tests fail (`expect(received).toHaveLength(1)`, received length 0).

- [ ] **Step 4: Add backoff and the due query to `sql.ts`**

In `Servers/extensions/sync-engine/sql.ts`, change the import line from

```ts
import { STALE_AFTER_MINUTES } from "./types";
```

to

```ts
import { BACKOFF_CAP_HOURS, STALE_AFTER_MINUTES } from "./types";
```

and append:

```ts
/**
 * Doubling stops at this exponent: 2^(6-1) = 32 h already exceeds the 24 h
 * cap, and an unclamped power(2, n) overflows Postgres float8 near n = 1024,
 * which would fail the tick for every organization.
 */
const BACKOFF_MAX_EXPONENT = 6;

/** Hours to wait after `n` consecutive scheduled failures: 0, 1, 2, 4, 8, 16, then 24. */
export function backoffHours(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  return Math.min(
    2 ** (Math.min(consecutiveFailures, BACKOFF_MAX_EXPONENT) - 1),
    BACKOFF_CAP_HOURS,
  );
}

/** SQL mirror of backoffHours for the settings row `alias`. */
export function sqlBackoffHours(alias: string): string {
  assertAlias(alias);
  return `(CASE WHEN ${alias}.consecutive_failures <= 0 THEN 0
                ELSE LEAST(power(2, LEAST(${alias}.consecutive_failures, ${BACKOFF_MAX_EXPONENT}) - 1), ${BACKOFF_CAP_HOURS})::int
           END)`;
}

/**
 * The tick's discovery query for one extension (:key): every org whose
 * schedule is on, whose extension is enabled (jobs bypass
 * requireExtensionEnabled, so the join is the enablement check), with no live
 * run, and whose due time has passed. `last_run` is the newest start of a
 * claimed run of a status kind (:statusKinds); skipped rows have no token and
 * never count. Due when there is no last run, or when
 * GREATEST(interval_hours, backoff) hours have passed since it. Nothing is
 * stored ahead of time, so an interval change applies on the next tick. This
 * system query spans organizations by design; every subquery is correlated on
 * the row's own organization_id.
 */
export const DUE_RUNS_SQL = `
  SELECT s.organization_id
    FROM extension_sync_settings s
    JOIN extensions e ON e.key = s.extension_key
    JOIN extension_enablements ee
      ON ee.extension_id = e.id
     AND ee.organization_id = s.organization_id
     AND ee.enabled = TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(r.started_at) AS last_run
        FROM extension_sync_runs r
       WHERE r.organization_id = s.organization_id AND r.extension_key = s.extension_key
         AND r.kind IN (:statusKinds) AND r.run_token IS NOT NULL
    ) lr ON TRUE
   WHERE s.extension_key = :key
     AND s.enabled = TRUE
     AND NOT ${sqlLiveRunExists("s.extension_key", "s.organization_id")}
     AND (lr.last_run IS NULL
          OR now() >= lr.last_run
                      + make_interval(hours => GREATEST(s.interval_hours, ${sqlBackoffHours("s")})))
   ORDER BY s.organization_id;`;
```

- [ ] **Step 5: Write `schedule.ts`**

Create `Servers/extensions/sync-engine/schedule.ts`:

```ts
import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import { SyncValidationError } from "./errors";
import { statusKinds } from "./registry";
import { DUE_RUNS_SQL } from "./sql";
import type { SyncProvider } from "./types";

export const INTERVAL_MIN_HOURS = 1;
export const INTERVAL_MAX_HOURS = 168;
export const DEFAULT_INTERVAL_HOURS = 24;
export const INTERVAL_MESSAGE = `Sync interval must be a whole number of hours between ${INTERVAL_MIN_HOURS} and ${INTERVAL_MAX_HOURS}`;

export interface ScheduleView {
  enabled: boolean;
  interval_hours: number;
  consecutive_failures: number;
  failing_since: Date | null;
}

export interface SchedulePatch {
  enabled?: boolean;
  intervalHours?: number;
}

/** A whole number of hours from 1 to 168; numeric strings are accepted (a select can hand one back). */
export function parseIntervalHours(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < INTERVAL_MIN_HOURS ||
    value > INTERVAL_MAX_HOURS
  ) {
    throw new SyncValidationError(INTERVAL_MESSAGE);
  }
  return value;
}

/** `{ enabled?, interval_hours? }` from a request body; at least one field. */
export function parseSchedulePatch(body: unknown): SchedulePatch {
  const b = (body ?? {}) as { enabled?: unknown; interval_hours?: unknown };
  const hasEnabled = b.enabled !== undefined;
  const hasInterval = b.interval_hours !== undefined;
  if (!hasEnabled && !hasInterval) {
    throw new SyncValidationError("Provide enabled or interval_hours");
  }
  if (hasEnabled && typeof b.enabled !== "boolean") {
    throw new SyncValidationError("enabled must be true or false");
  }
  return {
    enabled: hasEnabled ? (b.enabled as boolean) : undefined,
    intervalHours: hasInterval ? parseIntervalHours(b.interval_hours) : undefined,
  };
}

const SCHEDULE_COLUMNS = "enabled, interval_hours, consecutive_failures, failing_since";

export async function getSchedule(key: string, orgId: number): Promise<ScheduleView | null> {
  const rows = (await sequelize.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM extension_sync_settings
      WHERE organization_id = :orgId AND extension_key = :key
      LIMIT 1;`,
    { replacements: { orgId, key }, type: QueryTypes.SELECT },
  )) as ScheduleView[];
  return rows[0] ?? null;
}

/** Change the fields given; a new row starts disabled at 24 hours. */
export async function saveSchedule(
  key: string,
  orgId: number,
  patch: SchedulePatch,
): Promise<ScheduleView> {
  const [rows] = (await sequelize.query(
    `INSERT INTO extension_sync_settings (organization_id, extension_key, enabled, interval_hours)
     VALUES (:orgId, :key, COALESCE(:enabled, FALSE), COALESCE(:intervalHours, :defaultInterval))
     ON CONFLICT (organization_id, extension_key) DO UPDATE
        SET enabled = COALESCE(:enabled, extension_sync_settings.enabled),
            interval_hours = COALESCE(:intervalHours, extension_sync_settings.interval_hours),
            updated_at = now()
     RETURNING ${SCHEDULE_COLUMNS};`,
    {
      replacements: {
        orgId,
        key,
        enabled: patch.enabled ?? null,
        intervalHours: patch.intervalHours ?? null,
        defaultInterval: DEFAULT_INTERVAL_HOURS,
      },
    },
  )) as unknown as [ScheduleView[], unknown];
  return rows[0];
}

/**
 * A scheduled run failed or was abandoned: one more failure in the streak. The
 * first failure of a streak sets failing_since to that run's start.
 */
export async function recordFailureForSchedule(
  key: string,
  orgId: number,
  startedAt: Date,
  transaction?: Transaction,
): Promise<void> {
  await sequelize.query(
    `UPDATE extension_sync_settings
        SET consecutive_failures = consecutive_failures + 1,
            failing_since = COALESCE(failing_since, :startedAt),
            updated_at = now()
      WHERE organization_id = :orgId AND extension_key = :key;`,
    { replacements: { orgId, key, startedAt }, transaction },
  );
}

/** A manual or scheduled run completed: the streak is over. */
export async function resetScheduleFailures(
  key: string,
  orgId: number,
  transaction?: Transaction,
): Promise<void> {
  await sequelize.query(
    `UPDATE extension_sync_settings
        SET consecutive_failures = 0, failing_since = NULL, updated_at = now()
      WHERE organization_id = :orgId AND extension_key = :key
        AND (consecutive_failures <> 0 OR failing_since IS NOT NULL);`,
    { replacements: { orgId, key }, transaction },
  );
}

/** Orgs due for the provider's scheduled run (DUE_RUNS_SQL). */
export async function findDueRuns(
  provider: SyncProvider,
): Promise<Array<{ organization_id: number }>> {
  if (!provider.scheduledKind) return [];
  return (await sequelize.query(DUE_RUNS_SQL, {
    replacements: { key: provider.key, statusKinds: statusKinds(provider) },
    type: QueryTypes.SELECT,
  })) as Array<{ organization_id: number }>;
}
```

- [ ] **Step 6: Wire the bookkeeping into `claim.ts`**

In `Servers/extensions/sync-engine/claim.ts`:

1. Change `import { getSyncProvider } from "./registry";` to

```ts
import { getSyncProvider, statusKinds } from "./registry";
import { recordFailureForSchedule, resetScheduleFailures } from "./schedule";
```

2. In `claimRun`, replace `    await closeStaleRuns(provider, orgId, transaction);` with

```ts
    for (const closed of await closeStaleRuns(provider, orgId, transaction)) {
      // An abandoned scheduled run counts as a scheduled failure.
      if (closed.kind === provider.scheduledKind) {
        await recordFailureForSchedule(key, orgId, closed.started_at, transaction);
      }
    }
```

3. In `EngineRunContext.finalize`, replace

```ts
    if (!rows || rows.length === 0) throw new RunSupersededError(this.runId);
    this.markSettled(transaction);
  }
```

with

```ts
    if (!rows || rows.length === 0) throw new RunSupersededError(this.runId);
    if (statusKinds(this.provider).includes(this.kind)) {
      await resetScheduleFailures(this.provider.key, this.orgId, transaction);
    }
    this.markSettled(transaction);
  }
```

4. In `failRun`, replace

```ts
      )) as unknown as [Array<{ started_at: Date }>, unknown];
      return rows?.[0] ?? null;
    });
```

with

```ts
      )) as unknown as [Array<{ started_at: Date }>, unknown];
      const row = rows?.[0] ?? null;
      if (row && ctx.kind === ctx.provider.scheduledKind) {
        await recordFailureForSchedule(ctx.provider.key, ctx.orgId, row.started_at, transaction);
      }
      return row;
    });
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/schedule.test.ts extensions/sync-engine/__tests__/claim.test.ts extensions/sync-engine/__tests__/sql.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the throwaway-Postgres SQL check**

Create `Servers/scripts/checkExtensionSyncEngineSql.js`:

```js
#!/usr/bin/env node
/* eslint-disable */
"use strict";

/**
 * Checks the sync engine's SQL on a throwaway Postgres: the due query
 * (enabled extension and schedule, no live run, skipped rows ignored, backoff,
 * an interval change while backed off, no overflow on a long failure streak),
 * the backoff formula against its JS mirror, and the ownership fragment.
 *
 * Run: cd Servers && node scripts/checkExtensionSyncEngineSql.js
 */
require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs" } });
const assert = require("assert/strict");
const { QueryTypes } = require("sequelize");
const { withThrowawayPostgres } = require("./lib/throwawayPostgres");
const migration = require("../database/migrations/20261012200000-extension-sync-engine");
const {
  DUE_RUNS_SQL,
  backoffHours,
  sqlBackoffHours,
  sqlOwnsRunFragment,
} = require("../extensions/sync-engine/sql");

const KEY = "demo-ext";
const STATUS_KINDS = ["scheduled", "manual"];
const TOKEN = "00000000-0000-4000-8000-000000000001";

const BASE_SCHEMA = `
  CREATE TABLE verifywise.organizations (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE verifywise.users (id SERIAL PRIMARY KEY, email TEXT);
  CREATE TABLE verifywise.extensions (id SERIAL PRIMARY KEY, key VARCHAR(64) UNIQUE NOT NULL);
  CREATE TABLE verifywise.extension_enablements (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    extension_id INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (organization_id, extension_id)
  );
  CREATE TABLE verifywise.jira_assets_config (
    id SERIAL PRIMARY KEY, organization_id INTEGER NOT NULL,
    sync_enabled BOOLEAN NOT NULL DEFAULT FALSE, sync_interval_hours INTEGER NOT NULL DEFAULT 24
  );
  CREATE TABLE verifywise.jira_assets_sync_history (
    id SERIAL PRIMARY KEY, organization_id INTEGER NOT NULL, sync_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL, objects_fetched INTEGER NOT NULL DEFAULT 0,
    objects_created INTEGER NOT NULL DEFAULT 0, objects_updated INTEGER NOT NULL DEFAULT 0,
    objects_deleted INTEGER NOT NULL DEFAULT 0, error_message TEXT,
    started_at TIMESTAMP NOT NULL, completed_at TIMESTAMP, triggered_by INTEGER,
    heartbeat_at TIMESTAMP, run_token VARCHAR(64)
  );
`;

async function addRun(client, org, kind, status, minutesAgo, token, heartbeatMinutesAgo) {
  await client.query(
    `INSERT INTO verifywise.extension_sync_runs
       (organization_id, extension_key, kind, status, run_token, started_at, heartbeat_at, completed_at)
     VALUES ($1, $2, $3, $4, $5,
             now() - make_interval(mins => $6),
             ${heartbeatMinutesAgo === undefined ? "NULL" : `now() - make_interval(mins => ${heartbeatMinutesAgo})`},
             ${status === "started" ? "NULL" : "now() - make_interval(mins => $6) + interval '1 minute'"})`,
    [org, KEY, kind, status, token, minutesAgo],
  );
}

async function dueOrgs(sequelize) {
  const rows = await sequelize.query(DUE_RUNS_SQL, {
    replacements: { key: KEY, statusKinds: STATUS_KINDS },
    type: QueryTypes.SELECT,
  });
  return rows.map((row) => row.organization_id);
}

async function main() {
  await withThrowawayPostgres(async ({ client, sequelize }) => {
    await client.query(BASE_SCHEMA);
    await migration.up({ sequelize });
    await client.query(`
      INSERT INTO verifywise.organizations (id, name) SELECT g, 'org ' || g FROM generate_series(1, 9) g;
      INSERT INTO verifywise.extensions (id, key) VALUES (1, '${KEY}');
      INSERT INTO verifywise.extension_enablements (organization_id, extension_id, enabled)
      SELECT g, 1, g <> 6 FROM generate_series(1, 9) g;
      INSERT INTO verifywise.extension_sync_settings
        (organization_id, extension_key, enabled, interval_hours, consecutive_failures)
      VALUES (1, '${KEY}', TRUE, 1, 0),     -- never ran: due
             (2, '${KEY}', TRUE, 1, 0),     -- ran 2 h ago, 1 h interval: due
             (3, '${KEY}', TRUE, 1, 3),     -- 3 failures: 4 h backoff, ran 2 h ago: not due
             (4, '${KEY}', TRUE, 24, 2000), -- huge streak: capped at 24 h, no overflow: not due
             (5, '${KEY}', TRUE, 1, 0),     -- a live run: not due
             (6, '${KEY}', TRUE, 1, 0),     -- extension disabled: not due
             (7, '${KEY}', FALSE, 1, 0),    -- schedule off: not due
             (8, '${KEY}', TRUE, 1, 0),     -- claimed run 3 h ago, newer skip: due
             (9, '${KEY}', TRUE, 24, 2);    -- 24 h interval, ran 3 h ago: not due until changed
    `);
    await addRun(client, 2, "scheduled", "completed", 120, "t2");
    await addRun(client, 3, "scheduled", "failed", 120, "t3");
    await addRun(client, 4, "scheduled", "failed", 120, "t4");
    await addRun(client, 5, "manual", "completed", 120, "t5a");
    await addRun(client, 5, "scheduled", "started", 1, "t5b", 0);
    await addRun(client, 6, "scheduled", "completed", 120, "t6");
    await addRun(client, 8, "manual", "completed", 180, "t8");
    await addRun(client, 8, "manual", "skipped", 10, null);
    await addRun(client, 9, "scheduled", "failed", 180, "t9");

    assert.deepEqual(await dueOrgs(sequelize), [1, 2, 8]);

    // An interval change while backed off applies on the next tick: GREATEST(1, 2 h) <= 3 h.
    await client.query(
      `UPDATE verifywise.extension_sync_settings SET interval_hours = 1 WHERE organization_id = 9`,
    );
    assert.deepEqual(await dueOrgs(sequelize), [1, 2, 8, 9]);

    for (const failures of [0, 1, 2, 3, 4, 5, 6, 7, 50, 2000]) {
      const [row] = await sequelize.query(
        `SELECT ${sqlBackoffHours("s")} AS hours
           FROM (SELECT CAST(:failures AS INTEGER) AS consecutive_failures) s`,
        { replacements: { failures }, type: QueryTypes.SELECT },
      );
      assert.equal(row.hours, backoffHours(failures), `backoff for ${failures} failures`);
    }

    const { rows: [started] } = await client.query(
      `INSERT INTO verifywise.extension_sync_runs
         (organization_id, extension_key, kind, status, run_token, heartbeat_at)
       VALUES (1, '${KEY}', 'manual', 'started', '${TOKEN}', now()) RETURNING id`,
    );
    const owns = async (run) => {
      const { rows: [row] } = await client.query(`SELECT ${sqlOwnsRunFragment(run)} AS owned`);
      return row.owned;
    };
    assert.equal(await owns({ runId: started.id, orgId: 1, token: TOKEN }), true);
    assert.equal(
      await owns({ runId: started.id, orgId: 1, token: "00000000-0000-4000-8000-000000000002" }),
      false,
    );
    assert.equal(await owns({ runId: started.id, orgId: 2, token: TOKEN }), false);
  });
  process.stdout.write("extension sync engine SQL: all checks passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
```

- [ ] **Step 9: Run the check**

Run: `cd Servers && node scripts/checkExtensionSyncEngineSql.js`
Expected: PASS, printing `extension sync engine SQL: all checks passed`. A `value out of range: overflow` error here means the exponent clamp in `sqlBackoffHours` is missing.

- [ ] **Step 10: Build, format and commit**

```bash
cd Servers && npx prettier --write extensions/sync-engine scripts/checkExtensionSyncEngineSql.js && npm run build && node scripts/checkExtensionSyncMigration.js
cd .. && git add Servers/extensions/sync-engine Servers/scripts/checkExtensionSyncEngineSql.js
git commit -m "feat(sync-engine): schedule bookkeeping, failure backoff and the due query" -m "A failed or abandoned scheduled run adds to consecutive_failures (failing_since = the first failed run's start); any completed manual or scheduled run clears the streak. DUE_RUNS_SQL picks enabled schedules of enabled extensions with no live run once GREATEST(interval_hours, backoff) hours have passed since the newest claimed status-kind run; backoff is 0, 1, 2, 4, 8, 16, then 24 hours, with the exponent clamped so a long streak cannot overflow power().

scripts/checkExtensionSyncEngineSql.js checks the due query, the backoff mirror and the ownership fragment on a throwaway Postgres."
```

---

### Task 4: Jobs: queue helpers, tick, per-org run job, pickup skip, legacy routing

**Files:**
- Create: `Servers/extensions/sync-engine/status.ts`
- Create: `Servers/extensions/sync-engine/providers.ts`
- Create: `Servers/extensions/sync-engine/jobs.ts`
- Modify: `Servers/services/automations/automationProducer.ts:361-446` (Jira queue helpers → shared `addSingletonJob`; new engine helpers)
- Modify: `Servers/services/automations/automationWorker.ts:45-46` (import) and `:670-673` (dispatch)
- Modify: `Servers/jobs/producer.ts:5-32` (import) and `:74` (registration)
- Test: `Servers/extensions/sync-engine/__tests__/jobs.test.ts`
- Test: `Servers/extensions/sync-engine/__tests__/status.test.ts`
- Test: `Servers/services/automations/tests/automationProducer.spec.ts`

**Interfaces:**
- Consumes: `claimRun`, `createRunContext`, `runClaimed`, `recordSkippedRun` (Task 2); `findDueRuns` (Task 3); `getSyncProvider`, `listSyncProviders`, `statusKinds` (Task 2).
- Produces:
  - `automationProducer.ts`: `extensionSyncJobId(key: string, organizationId: number): string`, `interface ExtensionSyncJobData { key; orgId; kind; triggeredBy: number | null; payload: unknown }`, `hasPendingExtensionSyncJob(key, organizationId): Promise<boolean>`, `enqueueExtensionSyncRun(data): Promise<{ jobId: string; queued: boolean }>`, `scheduleExtensionSyncTick(): Promise<void>`.
  - `status.ts`: `hasLiveRun(key, orgId): Promise<boolean>`, `latestStatusRunId(key, orgId): Promise<number | null>`.
  - `providers.ts`: `SYNC_PROVIDERS: SyncProvider[]`, `registerAllSyncProviders(): void`.
  - `jobs.ts`: `EXTENSION_SYNC_TICK_JOB`, `EXTENSION_SYNC_RUN_JOB`, `LEGACY_JIRA_CHECK_JOB`, `LEGACY_JIRA_RUN_JOB`, `isExtensionSyncJob(name): boolean`, `interface TickSummary { candidates; queued; alreadyQueued; notReady; failed }`, `runExtensionSyncTick(): Promise<TickSummary>`, `parseRunJobData(data: unknown)`, `runExtensionSyncJob(data: unknown): Promise<"ran" | "skipped">`, `legacyJiraRunJobData(data: unknown): Record<string, unknown>`, `handleExtensionSyncJob(name: string, data: unknown): Promise<void>`, `startManualRun(key, orgId, userId): Promise<{ jobId: string; previousRunId: number | null }>`.

- [ ] **Step 1: Write the failing producer tests**

In `Servers/services/automations/tests/automationProducer.spec.ts`, add to the import list from `"../automationProducer"`:

```ts
  enqueueExtensionSyncRun,
  hasPendingExtensionSyncJob,
  extensionSyncJobId,
  scheduleExtensionSyncTick,
```

and add before the final `});` of the top-level `describe`:

```ts
  describe("extension sync engine jobs", () => {
    const mockGetJob = automationQueue.getJob as unknown as jest.Mock;
    const payload = {
      key: "jira-assets",
      orgId: 5,
      kind: "manual",
      triggeredBy: 8,
      payload: null,
    };

    beforeEach(() => {
      mockGetJob.mockReset();
      mockGetJob.mockResolvedValue(undefined);
    });

    it("fixes the job id per extension and org", () => {
      expect(extensionSyncJobId("jira-assets", 5)).toBe("ext-sync-jira-assets-5");
    });

    it("queues one attempt of extension_sync_run under that id, removed when done", async () => {
      await expect(enqueueExtensionSyncRun(payload)).resolves.toEqual({
        jobId: "ext-sync-jira-assets-5",
        queued: true,
      });
      expect(mockAdd).toHaveBeenCalledWith("extension_sync_run", payload, {
        jobId: "ext-sync-jira-assets-5",
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    });

    it("does not queue a second job while one is waiting", async () => {
      mockGetJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue("waiting") });
      await expect(enqueueExtensionSyncRun(payload)).resolves.toEqual({
        jobId: "ext-sync-jira-assets-5",
        queued: false,
      });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("reports a pending job for the extension and org", async () => {
      mockGetJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue("active") });
      await expect(hasPendingExtensionSyncJob("jira-assets", 5)).resolves.toBe(true);
      expect(mockGetJob).toHaveBeenCalledWith("ext-sync-jira-assets-5");
    });

    it("schedules the tick every 5 minutes without obliterating", async () => {
      await scheduleExtensionSyncTick();
      expect(mockObliterate).not.toHaveBeenCalled();
      expectSchedulerCall("extension_sync_tick", {}, "*/5 * * * *");
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Servers && npx jest -i services/automations/tests/automationProducer.spec.ts`
Expected: FAIL with `extensionSyncJobId is not a function` (and the other new names undefined).

- [ ] **Step 3: Add the engine queue helpers**

In `Servers/services/automations/automationProducer.ts`, replace the body of `enqueueJiraAssetsSyncRun` (lines 395-427, from `export async function enqueueJiraAssetsSyncRun(data: {` to its closing `}`) with:

```ts
export async function enqueueJiraAssetsSyncRun(data: {
  organizationId: number;
  triggeredBy: number | null;
  syncType: "manual" | "scheduled";
}): Promise<{ jobId: string; queued: boolean }> {
  return addSingletonJob(
    "jira_assets_sync_run",
    jiraAssetsSyncJobId(data.organizationId),
    data,
  );
}

/**
 * Add `name` under a fixed `jobId` unless one is already waiting or running
 * (`queued: false`). A finished job left behind is removed first, because
 * BullMQ ignores an add whose id still exists; if that removal fails, the job
 * is looked up again: gone, the add goes ahead; now waiting, `queued: false`;
 * still there and finished, a genuine queue failure. Throws
 * BackgroundJobsUnavailableError past QUEUE_CALL_TIMEOUT_MS.
 */
async function addSingletonJob(
  name: string,
  jobId: string,
  data: object,
): Promise<{ jobId: string; queued: boolean }> {
  return withQueueTimeout(async () => {
    const existing = await automationQueue.getJob(jobId);
    if (existing) {
      if (PENDING_JOB_STATES.has(await existing.getState())) return { jobId, queued: false };
      try {
        await existing.remove();
      } catch (err) {
        const again = await automationQueue.getJob(jobId);
        if (again) {
          if (PENDING_JOB_STATES.has(await again.getState())) return { jobId, queued: false };
          throw err;
        }
      }
    }
    await automationQueue.add(name, data, {
      jobId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    return { jobId, queued: true };
  });
}

/** One sync-engine job per extension and org at a time: the job id is fixed per pair. */
export function extensionSyncJobId(key: string, organizationId: number): string {
  return `ext-sync-${key}-${organizationId}`;
}

/** Payload of an `extension_sync_run` job. */
export interface ExtensionSyncJobData {
  key: string;
  orgId: number;
  kind: string;
  triggeredBy: number | null;
  payload: unknown;
}

/** True when a sync-engine job for the extension and org is waiting or running. */
export async function hasPendingExtensionSyncJob(
  key: string,
  organizationId: number,
): Promise<boolean> {
  return withQueueTimeout(async () => {
    const job = await automationQueue.getJob(extensionSyncJobId(key, organizationId));
    return !!job && PENDING_JOB_STATES.has(await job.getState());
  });
}

/**
 * Queue one sync-engine run for the worker, which claims it at pickup, so
 * time spent waiting never counts against its heartbeat. A double click or
 * overlapping ticks cannot queue two (`queued: false`). One attempt: a retry
 * is the next tick or click.
 */
export async function enqueueExtensionSyncRun(
  data: ExtensionSyncJobData,
): Promise<{ jobId: string; queued: boolean }> {
  return addSingletonJob("extension_sync_run", extensionSyncJobId(data.key, data.orgId), data);
}

/** The sync engine's tick: every 5 minutes, queue the due scheduled runs of every provider. */
export async function scheduleExtensionSyncTick() {
  logger.info("Adding extension sync tick job to the queue...");
  // No obliterate here: the scheduler upsert is idempotent by scheduler id.
  await automationQueue.upsertJobScheduler(
    "extension_sync_tick",
    { pattern: "*/5 * * * *" },
    {
      name: "extension_sync_tick",
      data: {},
      opts: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    },
  );
}
```

- [ ] **Step 4: Run the producer tests to verify they pass**

Run: `cd Servers && npx jest -i services/automations/tests/automationProducer.spec.ts`
Expected: PASS (the existing `enqueueJiraAssetsSyncRun` race tests still pass through `addSingletonJob`).

- [ ] **Step 5: Write the failing jobs and status tests**

Create `Servers/extensions/sync-engine/__tests__/status.test.ts`:

```ts
jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));

import { sequelize } from "../../../database/db";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../registry";
import { hasLiveRun, latestStatusRunId } from "../status";

const mockQuery = sequelize.query as jest.Mock;

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider({
    key: "demo-ext",
    kinds: ["manual", "scheduled", "import"],
    scheduledKind: "scheduled",
    readiness: async () => ({ ready: true }),
    run: async () => ({ counts: {} }),
  });
});
beforeEach(() => mockQuery.mockReset());

describe("live run and previous run", () => {
  it("checks liveness for one extension and org in SQL", async () => {
    mockQuery.mockResolvedValue([{ live: true }]);
    await expect(hasLiveRun("demo-ext", 5)).resolves.toBe(true);
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("live.extension_key = :key");
    expect(options.replacements).toEqual({ key: "demo-ext", orgId: 5 });
  });

  it("returns the newest run of a status kind, or null", async () => {
    mockQuery.mockResolvedValue([{ id: 40 }]);
    await expect(latestStatusRunId("demo-ext", 5)).resolves.toBe(40);
    expect(mockQuery.mock.calls[0][1].replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      kinds: ["scheduled", "manual"],
    });
    mockQuery.mockResolvedValue([]);
    await expect(latestStatusRunId("demo-ext", 5)).resolves.toBeNull();
  });
});
```

Create `Servers/extensions/sync-engine/__tests__/jobs.test.ts`:

```ts
jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../providers", () => ({ registerAllSyncProviders: jest.fn() }));
jest.mock("../../../services/automations/automationProducer", () => ({
  enqueueExtensionSyncRun: jest.fn(),
}));
jest.mock("../claim", () => ({
  claimRun: jest.fn(),
  createRunContext: jest.fn(() => ({ fake: "ctx" })),
  recordSkippedRun: jest.fn(),
  runClaimed: jest.fn(),
}));
jest.mock("../schedule", () => ({ findDueRuns: jest.fn() }));
jest.mock("../status", () => ({ hasLiveRun: jest.fn(), latestStatusRunId: jest.fn() }));

import { enqueueExtensionSyncRun } from "../../../services/automations/automationProducer";
import { claimRun, createRunContext, recordSkippedRun, runClaimed } from "../claim";
import { SyncInProgressError, SyncNotReadyError, UnknownSyncProviderError } from "../errors";
import {
  handleExtensionSyncJob,
  isExtensionSyncJob,
  runExtensionSyncJob,
  runExtensionSyncTick,
  startManualRun,
} from "../jobs";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../registry";
import { findDueRuns } from "../schedule";
import { hasLiveRun, latestStatusRunId } from "../status";
import type { SyncProvider } from "../types";

const mockReadiness = jest.fn();
const mockEnqueue = enqueueExtensionSyncRun as jest.Mock;
const mockClaim = claimRun as jest.Mock;
const mockFindDue = findDueRuns as jest.Mock;

const jira: SyncProvider = {
  key: "jira-assets",
  kinds: ["manual", "scheduled", "import"],
  scheduledKind: "scheduled",
  readiness: (orgId, kind) => mockReadiness(orgId, kind),
  run: async () => ({ counts: {} }),
};
const manualOnly: SyncProvider = {
  key: "manual-only",
  kinds: ["manual"],
  readiness: async () => ({ ready: true }),
  run: async () => ({ counts: {} }),
};
const CLAIMED = { runId: 91, token: "t", orgId: 5, key: "jira-assets", kind: "manual", triggeredBy: 8 };

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider(jira);
  registerSyncProvider(manualOnly);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReadiness.mockResolvedValue({ ready: true });
  mockEnqueue.mockResolvedValue({ jobId: "ext-sync-jira-assets-5", queued: true });
  mockClaim.mockResolvedValue(CLAIMED);
  mockFindDue.mockResolvedValue([]);
});

describe("runExtensionSyncTick", () => {
  it("queues one scheduled job per due and ready org", async () => {
    mockFindDue.mockResolvedValue([{ organization_id: 5 }, { organization_id: 6 }]);
    mockReadiness.mockImplementation(async (orgId: number) =>
      orgId === 6 ? { ready: false, status: 400, reason: "No use cases" } : { ready: true },
    );

    await expect(runExtensionSyncTick()).resolves.toEqual({
      candidates: 2,
      queued: 1,
      alreadyQueued: 0,
      notReady: 1,
      failed: 0,
    });
    expect(mockFindDue).toHaveBeenCalledTimes(1);
    expect(mockReadiness).toHaveBeenCalledWith(5, "scheduled");
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith({
      key: "jira-assets",
      orgId: 5,
      kind: "scheduled",
      triggeredBy: null,
      payload: null,
    });
    expect(recordSkippedRun).not.toHaveBeenCalled();
  });

  it("counts a job that is already waiting, and keeps going after one org fails", async () => {
    mockFindDue.mockResolvedValue([{ organization_id: 5 }, { organization_id: 6 }, { organization_id: 7 }]);
    mockEnqueue
      .mockResolvedValueOnce({ jobId: "ext-sync-jira-assets-5", queued: false })
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce({ jobId: "ext-sync-jira-assets-7", queued: true });

    await expect(runExtensionSyncTick()).resolves.toEqual({
      candidates: 3,
      queued: 1,
      alreadyQueued: 1,
      notReady: 0,
      failed: 1,
    });
  });
});

describe("runExtensionSyncJob", () => {
  it("claims at pickup and runs the claimed run", async () => {
    await expect(
      runExtensionSyncJob({ key: "jira-assets", orgId: 5, kind: "manual", triggeredBy: 8, payload: { x: 1 } }),
    ).resolves.toBe("ran");
    expect(mockClaim).toHaveBeenCalledWith("jira-assets", 5, "manual", 8);
    expect(createRunContext).toHaveBeenCalledWith(jira, CLAIMED, { x: 1 });
    expect(runClaimed).toHaveBeenCalledWith(jira, { fake: "ctx" });
    // Enablement and readiness are not checked at pickup.
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  it("records a skipped row for a manual job when another run is live", async () => {
    mockClaim.mockRejectedValue(new SyncInProgressError());
    await expect(
      runExtensionSyncJob({ key: "jira-assets", orgId: 5, kind: "manual", triggeredBy: 8 }),
    ).resolves.toBe("skipped");
    expect(recordSkippedRun).toHaveBeenCalledWith("jira-assets", 5, "manual", 8);
    expect(runClaimed).not.toHaveBeenCalled();
  });

  it("skips a scheduled job quietly when another run is live", async () => {
    mockClaim.mockRejectedValue(new SyncInProgressError());
    await expect(
      runExtensionSyncJob({ key: "jira-assets", orgId: 5, kind: "scheduled", triggeredBy: null }),
    ).resolves.toBe("skipped");
    expect(recordSkippedRun).not.toHaveBeenCalled();
  });

  it.each([
    [{ orgId: 5, kind: "manual" }],
    [{ key: "Bad Key", orgId: 5, kind: "manual" }],
    [{ key: "jira-assets", orgId: 0, kind: "manual" }],
    [{ key: "jira-assets", orgId: "x", kind: "manual" }],
    [{ key: "jira-assets", orgId: 5, kind: "import" }],
    [{ key: "jira-assets", orgId: 5 }],
    [null],
  ])("fails closed on the payload %p, before claiming", async (data) => {
    await expect(runExtensionSyncJob(data)).rejects.toThrow("extension_sync_run");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("fails a job for a key with no registered provider, claiming nothing", async () => {
    await expect(
      runExtensionSyncJob({ key: "gone-ext", orgId: 5, kind: "manual" }),
    ).rejects.toBeInstanceOf(UnknownSyncProviderError);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("falls back to no user for an invalid triggeredBy", async () => {
    await runExtensionSyncJob({ key: "jira-assets", orgId: 5, kind: "manual", triggeredBy: "nobody" });
    expect(mockClaim).toHaveBeenCalledWith("jira-assets", 5, "manual", null);
  });
});

describe("job names", () => {
  it("knows the engine's jobs and the old Jira names", () => {
    for (const name of [
      "extension_sync_tick",
      "extension_sync_run",
      "jira_assets_scheduled_sync_check",
      "jira_assets_sync_run",
    ]) {
      expect(isExtensionSyncJob(name)).toBe(true);
    }
    expect(isExtensionSyncJob("risk_link_recompute")).toBe(false);
  });

  it("routes the old Jira run job to the engine", async () => {
    await handleExtensionSyncJob("jira_assets_sync_run", {
      organizationId: 5,
      triggeredBy: 8,
      syncType: "manual",
    });
    expect(mockClaim).toHaveBeenCalledWith("jira-assets", 5, "manual", 8);
  });

  it("routes the old Jira check job and the tick to the tick", async () => {
    await handleExtensionSyncJob("jira_assets_scheduled_sync_check", {});
    await handleExtensionSyncJob("extension_sync_tick", {});
    expect(mockFindDue).toHaveBeenCalledTimes(2);
  });

  it("refuses a name that is not a sync job", async () => {
    await expect(handleExtensionSyncJob("send_email", {})).rejects.toThrow(
      "Not an extension sync job: send_email",
    );
  });
});

describe("startManualRun", () => {
  it("checks readiness and liveness, then queues the manual run", async () => {
    (hasLiveRun as jest.Mock).mockResolvedValue(false);
    (latestStatusRunId as jest.Mock).mockResolvedValue(40);

    await expect(startManualRun("jira-assets", 5, 8)).resolves.toEqual({
      jobId: "ext-sync-jira-assets-5",
      previousRunId: 40,
    });
    expect(mockReadiness).toHaveBeenCalledWith(5, "manual");
    expect(mockEnqueue).toHaveBeenCalledWith({
      key: "jira-assets",
      orgId: 5,
      kind: "manual",
      triggeredBy: 8,
      payload: null,
    });
  });

  it("refuses with the provider's status and reason when not ready", async () => {
    mockReadiness.mockResolvedValue({ ready: false, status: 404, reason: "Not configured" });
    const err = await startManualRun("jira-assets", 5, 8).catch((e) => e);
    expect(err).toBeInstanceOf(SyncNotReadyError);
    expect(err).toMatchObject({ status: 404, message: "Not configured" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("refuses while a run is live or a job is already waiting", async () => {
    (hasLiveRun as jest.Mock).mockResolvedValue(true);
    await expect(startManualRun("jira-assets", 5, 8)).rejects.toBeInstanceOf(SyncInProgressError);
    (hasLiveRun as jest.Mock).mockResolvedValue(false);
    mockEnqueue.mockResolvedValue({ jobId: "ext-sync-jira-assets-5", queued: false });
    await expect(startManualRun("jira-assets", 5, 8)).rejects.toBeInstanceOf(SyncInProgressError);
  });

  it("rejects a key with no provider", async () => {
    await expect(startManualRun("nope", 5, 8)).rejects.toBeInstanceOf(UnknownSyncProviderError);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/jobs.test.ts extensions/sync-engine/__tests__/status.test.ts`
Expected: FAIL with `Cannot find module '../jobs'` and `Cannot find module '../status'`.

- [ ] **Step 7: Write `status.ts`, `providers.ts` and `jobs.ts`**

Create `Servers/extensions/sync-engine/status.ts`:

```ts
import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { getSyncProvider, statusKinds } from "./registry";
import { sqlLiveRunExists } from "./sql";

/** A live `started` run of this extension exists for the org. */
export async function hasLiveRun(key: string, orgId: number): Promise<boolean> {
  const rows = (await sequelize.query(`SELECT ${sqlLiveRunExists(":key", ":orgId")} AS live;`, {
    replacements: { key, orgId },
    type: QueryTypes.SELECT,
  })) as Array<{ live: boolean }>;
  return !!rows[0]?.live;
}

/** Id of the newest run of a status kind, so a client can tell when a newer one finishes. */
export async function latestStatusRunId(key: string, orgId: number): Promise<number | null> {
  const kinds = statusKinds(getSyncProvider(key));
  const rows = (await sequelize.query(
    `SELECT id FROM extension_sync_runs
      WHERE organization_id = :orgId AND extension_key = :key AND kind IN (:kinds)
      ORDER BY started_at DESC, id DESC
      LIMIT 1;`,
    { replacements: { orgId, key, kinds }, type: QueryTypes.SELECT },
  )) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}
```

Create `Servers/extensions/sync-engine/providers.ts`:

```ts
import { registerSyncProvider } from "./registry";
import type { SyncProvider } from "./types";

/** Every extension that runs on the sync engine. */
export const SYNC_PROVIDERS: SyncProvider[] = [];

let registered = false;

/** Register every provider once per process; the API router and the worker's jobs both call it. */
export function registerAllSyncProviders(): void {
  if (registered) return;
  registered = true;
  for (const provider of SYNC_PROVIDERS) registerSyncProvider(provider);
}
```

Create `Servers/extensions/sync-engine/jobs.ts`:

```ts
import logger, { logStructured } from "../../utils/logger/fileLogger";
import {
  type ExtensionSyncJobData,
  enqueueExtensionSyncRun,
} from "../../services/automations/automationProducer";
import { claimRun, createRunContext, recordSkippedRun, runClaimed } from "./claim";
import { SyncInProgressError, SyncNotReadyError } from "./errors";
import { registerAllSyncProviders } from "./providers";
import { getSyncProvider, listSyncProviders } from "./registry";
import { findDueRuns } from "./schedule";
import { hasLiveRun, latestStatusRunId } from "./status";
import { EXTENSION_KEY_PATTERN, SyncProvider } from "./types";

registerAllSyncProviders();

const fileName = "jobs.ts";

export const EXTENSION_SYNC_TICK_JOB = "extension_sync_tick";
export const EXTENSION_SYNC_RUN_JOB = "extension_sync_run";
/** Pre-engine Jira Assets job names, accepted for one release so queued jobs still run. */
export const LEGACY_JIRA_CHECK_JOB = "jira_assets_scheduled_sync_check";
export const LEGACY_JIRA_RUN_JOB = "jira_assets_sync_run";

const JOB_NAMES = new Set([
  EXTENSION_SYNC_TICK_JOB,
  EXTENSION_SYNC_RUN_JOB,
  LEGACY_JIRA_CHECK_JOB,
  LEGACY_JIRA_RUN_JOB,
]);

export function isExtensionSyncJob(name: string): boolean {
  return JOB_NAMES.has(name);
}

export interface TickSummary {
  candidates: number;
  queued: number;
  alreadyQueued: number;
  notReady: number;
  failed: number;
}

/**
 * The 5-minute tick. For each provider with a schedule, one SQL query finds
 * the due orgs; each due org that is ready gets one queued run (the worker
 * claims it at pickup). A not-ready org records and logs nothing. An error for
 * one org is logged and the loop moves on.
 */
export async function runExtensionSyncTick(): Promise<TickSummary> {
  const summary: TickSummary = { candidates: 0, queued: 0, alreadyQueued: 0, notReady: 0, failed: 0 };
  for (const provider of listSyncProviders()) {
    const kind = provider.scheduledKind;
    if (!kind) continue;
    let due: Array<{ organization_id: number }>;
    try {
      due = await findDueRuns(provider);
    } catch (error) {
      summary.failed++;
      logStructured("error", `Due query failed for ${provider.key}`, "runExtensionSyncTick", fileName);
      logger.error(`Extension sync tick: due query failed for ${provider.key}:`, error);
      continue;
    }
    summary.candidates += due.length;
    for (const row of due) {
      const orgId = Number(row.organization_id);
      if (!Number.isInteger(orgId) || orgId <= 0) continue;
      try {
        const readiness = await provider.readiness(orgId, kind);
        if (!readiness.ready) {
          summary.notReady++;
          continue;
        }
        const { jobId, queued } = await enqueueExtensionSyncRun({
          key: provider.key,
          orgId,
          kind,
          triggeredBy: null,
          payload: null,
        });
        if (!queued) {
          summary.alreadyQueued++;
          continue;
        }
        summary.queued++;
        logger.info(`Extension sync ${provider.key} org ${orgId}: queued job ${jobId}`);
      } catch (error) {
        summary.failed++;
        logStructured(
          "error",
          `Scheduled ${provider.key} run could not be queued for org ${orgId}`,
          "runExtensionSyncTick",
          fileName,
        );
        logger.error(`Extension sync tick: ${provider.key} org ${orgId} failed:`, error);
      }
    }
  }
  return summary;
}

/**
 * Validate an `extension_sync_run` payload. Fails closed without a valid key,
 * org or kind (only "manual" and the provider's scheduled kind are queued),
 * because guessing could turn a refresh-only run into one that creates.
 * Nothing is claimed yet, so there is no row to close. An invalid triggeredBy
 * only loses attribution.
 */
export function parseRunJobData(data: unknown): {
  provider: SyncProvider;
  orgId: number;
  kind: string;
  triggeredBy: number | null;
  payload: unknown;
} {
  const d = (data ?? {}) as Partial<Record<keyof ExtensionSyncJobData, unknown>>;
  if (typeof d.key !== "string" || !EXTENSION_KEY_PATTERN.test(d.key)) {
    throw new Error("extension_sync_run: key missing or invalid");
  }
  const orgId = Number(d.orgId);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error("extension_sync_run: orgId missing or invalid");
  }
  const provider = getSyncProvider(d.key);
  const kind = d.kind;
  if (typeof kind !== "string" || (kind !== "manual" && kind !== provider.scheduledKind)) {
    throw new Error("extension_sync_run: kind missing or invalid");
  }
  let triggeredBy: number | null = Number(d.triggeredBy);
  if (!Number.isInteger(triggeredBy) || triggeredBy <= 0) {
    if (d.triggeredBy !== null && d.triggeredBy !== undefined) {
      logger.warn(`extension_sync_run ${d.key} org ${orgId}: invalid triggeredBy, using none`);
    }
    triggeredBy = null;
  }
  return { provider, orgId, kind, triggeredBy, payload: d.payload ?? null };
}

/**
 * Worker entry for `extension_sync_run`. The run is claimed here, at pickup.
 * If another run holds the claim, a manual job records a `skipped` row (a user
 * is waiting on "Sync now") and a scheduled job records nothing. Enablement is
 * not checked at pickup.
 */
export async function runExtensionSyncJob(data: unknown): Promise<"ran" | "skipped"> {
  const job = parseRunJobData(data);
  const { key } = job.provider;
  let run;
  try {
    run = await claimRun(key, job.orgId, job.kind, job.triggeredBy);
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      logger.info(`extension_sync_run ${key} org ${job.orgId}: skipped, another run is live`);
      if (job.kind === "manual") {
        await recordSkippedRun(key, job.orgId, job.kind, job.triggeredBy);
      }
      return "skipped";
    }
    throw err;
  }
  await runClaimed(job.provider, createRunContext(job.provider, run, job.payload));
  return "ran";
}

/** An old `jira_assets_sync_run` payload as an `extension_sync_run` payload. */
export function legacyJiraRunJobData(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as { organizationId?: unknown; triggeredBy?: unknown; syncType?: unknown };
  return {
    key: "jira-assets",
    orgId: d.organizationId,
    kind: d.syncType,
    triggeredBy: d.triggeredBy ?? null,
    payload: null,
  };
}

/** One worker entry for every sync-engine job name, old Jira names included. */
export async function handleExtensionSyncJob(name: string, data: unknown): Promise<void> {
  switch (name) {
    case EXTENSION_SYNC_TICK_JOB:
    case LEGACY_JIRA_CHECK_JOB:
      await runExtensionSyncTick();
      return;
    case EXTENSION_SYNC_RUN_JOB:
      await runExtensionSyncJob(data);
      return;
    case LEGACY_JIRA_RUN_JOB:
      await runExtensionSyncJob(legacyJiraRunJobData(data));
      return;
    default:
      throw new Error(`Not an extension sync job: ${name}`);
  }
}

/**
 * "Sync now": readiness (the provider's status and reason), 409 if a run is
 * live or a job is already waiting, otherwise queue the run. `previousRunId`
 * is the newest status-kind run before this request; a client waits for a
 * newer one to finish.
 */
export async function startManualRun(
  key: string,
  orgId: number,
  userId: number,
): Promise<{ jobId: string; previousRunId: number | null }> {
  const provider = getSyncProvider(key);
  const readiness = await provider.readiness(orgId, "manual");
  if (!readiness.ready) throw new SyncNotReadyError(readiness.status, readiness.reason);
  if (await hasLiveRun(key, orgId)) throw new SyncInProgressError();
  const previousRunId = await latestStatusRunId(key, orgId);
  const { jobId, queued } = await enqueueExtensionSyncRun({
    key,
    orgId,
    kind: "manual",
    triggeredBy: userId,
    payload: null,
  });
  if (!queued) throw new SyncInProgressError();
  return { jobId, previousRunId };
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/jobs.test.ts extensions/sync-engine/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 9: Dispatch the engine's jobs in the worker and register the tick**

In `Servers/services/automations/automationWorker.ts`, after line 46 (`import { runQueuedSync } from "../../extensions/jira-assets/jiraAssets.service";`) add:

```ts
import { handleExtensionSyncJob, isExtensionSyncJob } from "../../extensions/sync-engine/jobs";
```

and replace

```ts
        } else if (name === "jira_assets_sync_run") {
          await runQueuedSync(job.data);
        } else if (name === "ai_gateway_budget_reset") {
```

with

```ts
        } else if (name === "jira_assets_sync_run") {
          await runQueuedSync(job.data);
        } else if (isExtensionSyncJob(name)) {
          await handleExtensionSyncJob(name, job.data);
        } else if (name === "ai_gateway_budget_reset") {
```

(The two Jira branches above still take the old names until Task 6 deletes them.)

In `Servers/jobs/producer.ts`, add `scheduleExtensionSyncTick,` to the import list after `scheduleJiraAssetsScheduledSyncCheck,`, and after line 74 add:

```ts
  await safeSchedule("extension-sync-tick", scheduleExtensionSyncTick); // non-obliterating — safe to run after the obliterating schedulers
```

- [ ] **Step 10: Build, run the touched suites, format and commit**

```bash
cd Servers && npx prettier --write extensions/sync-engine services/automations/automationProducer.ts services/automations/automationWorker.ts services/automations/tests/automationProducer.spec.ts jobs/producer.ts && npm run build
npx jest -i extensions/sync-engine/__tests__ services/automations/tests/automationProducer.spec.ts
cd .. && git add Servers/extensions/sync-engine Servers/services/automations Servers/jobs/producer.ts
git commit -m "feat(sync-engine): tick and per-org run jobs" -m "extension_sync_tick (every 5 minutes, non-obliterating) queues one extension_sync_run per due, ready org under jobId ext-sync-<key>-<orgId> (one attempt, removed on complete and fail). The run job validates its payload, claims at pickup, records a skipped row for a manual job that finds a live run and nothing for a scheduled one, and does not check enablement. handleExtensionSyncJob also accepts the old jira_assets_* job names for one release. startManualRun keeps the 409/503 rules of Jira's Sync now. The Jira queue helper now shares addSingletonJob."
```

---

### Task 5: Generic API routes

**Files:**
- Modify: `Servers/extensions/sync-engine/status.ts` (append run views, `getRunStatus`, `listRuns`, `parseRunsLimit`)
- Modify: `Servers/middleware/requireExtensionEnabled.middleware.ts:26-65`
- Create: `Servers/controllers/extensionRuns.ctrl.ts`
- Create: `Servers/routes/extensionRuns.route.ts`
- Modify: `Servers/app.ts:57` (import) and `:319-328` (mount and comment)
- Test: `Servers/extensions/sync-engine/__tests__/status.test.ts` (append)
- Test: `Servers/middleware/__tests__/requireExtensionEnabled.middleware.test.ts` (append)
- Test: `Servers/extensions/sync-engine/__tests__/extensionRuns.route.test.ts`

**Interfaces:**
- Consumes: `startManualRun` (Task 4), `hasPendingExtensionSyncJob`, `BackgroundJobsUnavailableError` (producer), `getSchedule`, `parseSchedulePatch`, `saveSchedule`, `ScheduleView` (Task 3), `findSyncProvider`, `getSyncProvider`, `statusKinds`, engine errors (Task 2).
- Produces:
  - `status.ts`: `RUNS_DEFAULT_LIMIT = 20`, `RUNS_MAX_LIMIT = 200`, `parseRunsLimit(raw: unknown): number`, `interface RunView { id; kind; status: RunStatus; code; counts; message; started_at: string; completed_at: string | null; is_live: boolean }`, `interface RunStatusView { schedule: ScheduleView | null; running: boolean; latest_run: RunView | null; last_finished_run: RunView | null }`, `getRunStatus(key, orgId): Promise<RunStatusView>`, `interface RunListRow { id; kind; status; code; counts; message; triggered_by: number | null; started_at: Date; heartbeat_at: Date | null; completed_at: Date | null }`, `listRuns(key, orgId, limit): Promise<RunListRow[]>`.
  - Middleware: `requireExtensionEnabledFromParam(param?: string)`.
  - Controller: `onlySyncProviderKeys`, `postRunCtrl`, `getRunStatusCtrl`, `getRunsCtrl`, `patchScheduleCtrl`.
  - HTTP: `POST /api/extensions/:key/runs` → 202 `{ jobId, previousRunId }` | 400/404 (readiness) | 409 | 503; `GET /api/extensions/:key/runs/status` → `{ schedule, running, queued, latest_run, last_finished_run }`; `GET /api/extensions/:key/runs?limit=` (default 20, max 200); `PATCH /api/extensions/:key/schedule` `{ enabled?, interval_hours? }` → the schedule view.

`last_finished_run` is an addition to the spec's status shape: the newest `completed` or `failed` run of a status kind, which the shared panel needs to reproduce the old "Last sync" line (skips and abandoned runs never replace it, as today).

- [ ] **Step 1: Write the failing status, middleware and route tests**

Append to `Servers/extensions/sync-engine/__tests__/status.test.ts` (and extend its import to `import { getRunStatus, hasLiveRun, latestStatusRunId, listRuns, parseRunsLimit } from "../status";`):

```ts
describe("parseRunsLimit", () => {
  it.each([
    [undefined, 20],
    ["7", 7],
    [" 7 ", 7],
    ["500", 200],
    ["0", 20],
    ["-5", 20],
    ["abc", 20],
    ["7.5", 20],
    [["9", "10"], 9],
    [12, 12],
  ])("parses limit defensively: %p gives %p", (raw, expected) => {
    expect(parseRunsLimit(raw)).toBe(expected);
  });
});

describe("getRunStatus and listRuns", () => {
  it("returns the schedule, liveness, the latest status-kind run and the last finished one", async () => {
    const latest = { id: 41, kind: "manual", status: "skipped", is_live: false };
    const finished = { id: 40, kind: "scheduled", status: "completed", is_live: false };
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes("FROM extension_sync_settings")
        ? [{ enabled: true, interval_hours: 6, consecutive_failures: 2, failing_since: null }]
        : [{ running: false, latest_run: latest, last_finished_run: finished }],
    );

    await expect(getRunStatus("demo-ext", 5)).resolves.toEqual({
      schedule: { enabled: true, interval_hours: 6, consecutive_failures: 2, failing_since: null },
      running: false,
      latest_run: latest,
      last_finished_run: finished,
    });
    const [sql, options] = mockQuery.mock.calls.find(([s]) => String(s).includes("AS latest_run"))!;
    expect(sql).toContain("r.kind IN (:kinds)");
    expect(sql).toContain("AND r.status IN ('completed', 'failed')");
    expect(sql).toContain("ORDER BY r.completed_at DESC, r.id DESC");
    expect(options.replacements).toEqual({ key: "demo-ext", orgId: 5, kinds: ["scheduled", "manual"] });
  });

  it("lists the org's runs of the extension, newest first, without tokens", async () => {
    mockQuery.mockResolvedValue([{ id: 41 }]);
    await expect(listRuns("demo-ext", 5, 20)).resolves.toEqual([{ id: 41 }]);
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("run_token");
    expect(sql).toContain("ORDER BY r.started_at DESC, r.id DESC");
    expect(options.replacements).toEqual({ orgId: 5, key: "demo-ext", limit: 20 });
  });
});
```

Append to `Servers/middleware/__tests__/requireExtensionEnabled.middleware.test.ts`, inside the top-level `describe`:

```ts
  it("takes the key from a route parameter when asked to", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireExtensionEnabledFromParam } = require("../requireExtensionEnabled.middleware");
    mockFindByKey.mockResolvedValue({ id: 31 });
    mockFindByExtensionId.mockResolvedValue({ enabled: true });
    const mw = requireExtensionEnabledFromParam("key");
    const req = { ...makeReq(7), params: { key: "param-ext" } } as unknown as Request;
    const res = makeRes() as Response;
    const next = jest.fn();

    await mw(req, res, next);

    expect(mockFindByKey).toHaveBeenCalledWith("param-ext");
    expect(mockFindByExtensionId).toHaveBeenCalledWith(31, 7);
    expect(next).toHaveBeenCalled();
  });
```

Create `Servers/extensions/sync-engine/__tests__/extensionRuns.route.test.ts`:

```ts
import request from "supertest";
import express from "express";
import { BUILTIN_ROLE_PERMISSIONS } from "../../../config/rolePermissions.config";

jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../../../utils/rolePermissions.utils", () => ({
  roleHasPermission: async (_orgId: number | null, role: string, key: string) =>
    BUILTIN_ROLE_PERMISSIONS[role]?.has(key as never) ?? false,
}));
jest.mock("../../../middleware/auth.middleware", () => ({
  __esModule: true,
  default: (req: any, _res: any, next: any) => {
    req.userId = 9;
    req.organizationId = 42;
    req.role = req.headers["x-test-role"] || "Admin";
    req.t = (key: string) => key;
    next();
  },
}));
jest.mock("../../../middleware/requireExtensionEnabled.middleware", () => ({
  requireExtensionEnabledFromParam: () => (req: any, res: any, next: any) =>
    req.headers["x-test-disabled"] ? res.status(403).json({ message: "Forbidden" }) : next(),
}));
jest.mock("../providers", () => ({ registerAllSyncProviders: jest.fn() }));
jest.mock("../jobs", () => ({ startManualRun: jest.fn() }));
jest.mock("../status", () => ({
  ...jest.requireActual("../status"),
  getRunStatus: jest.fn(),
  listRuns: jest.fn(),
}));
jest.mock("../schedule", () => ({
  ...jest.requireActual("../schedule"),
  saveSchedule: jest.fn(),
}));
jest.mock("../../../services/automations/automationProducer", () => {
  class BackgroundJobsUnavailableError extends Error {}
  return { BackgroundJobsUnavailableError, hasPendingExtensionSyncJob: jest.fn() };
});
jest.mock("../../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn(),
  logSuccess: jest.fn(),
  logFailure: jest.fn(),
}));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../../../utils/i18n.utils", () => ({
  translateError: jest.fn(() => "Something went wrong"),
}));

import extensionRunsRoutes from "../../../routes/extensionRuns.route";
import {
  BackgroundJobsUnavailableError,
  hasPendingExtensionSyncJob,
} from "../../../services/automations/automationProducer";
import { logSuccess } from "../../../utils/logger/logHelper";
import { SyncInProgressError, SyncNotReadyError } from "../errors";
import { startManualRun } from "../jobs";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../registry";
import { saveSchedule } from "../schedule";
import { getRunStatus, listRuns } from "../status";

const mockCanSchedule = jest.fn();
const mockStart = startManualRun as jest.Mock;
const mockSave = saveSchedule as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/extensions", extensionRunsRoutes);
// Stands in for the per-extension routers mounted after the generic one.
app.use("/api/extensions", (_req, res) => {
  res.status(299).json({ fellThrough: true });
});

const SCHEDULE = { enabled: true, interval_hours: 12, consecutive_failures: 0, failing_since: null };

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider({
    key: "demo-ext",
    kinds: ["manual", "scheduled"],
    scheduledKind: "scheduled",
    readiness: async () => ({ ready: true }),
    canSchedule: (orgId) => mockCanSchedule(orgId),
    run: async () => ({ counts: {} }),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCanSchedule.mockResolvedValue({ ready: true });
  mockSave.mockResolvedValue(SCHEDULE);
});

describe("keys without a sync provider", () => {
  it.each([
    ["post", "/api/extensions/mlflow/runs"],
    ["get", "/api/extensions/mlflow/runs/status"],
    ["get", "/api/extensions/mlflow/runs"],
    ["patch", "/api/extensions/mlflow/schedule"],
  ])("fall through %s %s to the next router", async (method, path) => {
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(299);
  });
});

describe("POST /:key/runs", () => {
  it("queues a manual run: 202 with the job id and the run seen before", async () => {
    mockStart.mockResolvedValue({ jobId: "ext-sync-demo-ext-42", previousRunId: 40 });
    const res = await request(app).post("/api/extensions/demo-ext/runs");
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ jobId: "ext-sync-demo-ext-42", previousRunId: 40 });
    expect(mockStart).toHaveBeenCalledWith("demo-ext", 42, 9);
  });

  it.each([
    [new SyncNotReadyError(404, "Not configured"), 404, "Not configured"],
    [new SyncNotReadyError(400, "Pick a type"), 400, "Pick a type"],
    [new SyncInProgressError(), 409, "A sync is already running for this extension"],
  ])("maps %p to %p", async (err, status, reason) => {
    mockStart.mockRejectedValue(err);
    const res = await request(app).post("/api/extensions/demo-ext/runs");
    expect(res.status).toBe(status);
    expect(res.body.data).toBe(reason);
  });

  it("is 503 when the queue does not answer", async () => {
    mockStart.mockRejectedValue(new BackgroundJobsUnavailableError("Background jobs are unavailable"));
    expect((await request(app).post("/api/extensions/demo-ext/runs")).status).toBe(503);
  });

  it("needs extension.admin and the extension enabled", async () => {
    expect((await request(app).post("/api/extensions/demo-ext/runs").set("x-test-role", "Editor")).status).toBe(403);
    expect((await request(app).post("/api/extensions/demo-ext/runs").set("x-test-disabled", "1")).status).toBe(403);
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("GET /:key/runs/status", () => {
  it("adds whether a job is queued, and null when the queue does not answer", async () => {
    (getRunStatus as jest.Mock).mockResolvedValue({
      schedule: null,
      running: false,
      latest_run: null,
      last_finished_run: null,
    });
    (hasPendingExtensionSyncJob as jest.Mock).mockResolvedValueOnce(true);
    let res = await request(app).get("/api/extensions/demo-ext/runs/status").set("x-test-role", "Auditor");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      schedule: null,
      running: false,
      queued: true,
      latest_run: null,
      last_finished_run: null,
    });
    expect(getRunStatus).toHaveBeenCalledWith("demo-ext", 42);

    (hasPendingExtensionSyncJob as jest.Mock).mockRejectedValueOnce(new Error("redis down"));
    res = await request(app).get("/api/extensions/demo-ext/runs/status");
    expect(res.body.data.queued).toBeNull();
  });
});

describe("GET /:key/runs", () => {
  it.each([
    ["", 20],
    ["?limit=7", 7],
    ["?limit=-5", 20],
    ["?limit=abc", 20],
    ["?limit=5000", 200],
  ])("parses limit defensively: %p lists %p", async (query, limit) => {
    (listRuns as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get(`/api/extensions/demo-ext/runs${query}`);
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith("demo-ext", 42, limit);
  });
});

describe("PATCH /:key/schedule", () => {
  it("saves the fields sent, accepting a numeric string, and logs the change", async () => {
    const res = await request(app).patch("/api/extensions/demo-ext/schedule").send({ interval_hours: "12" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(SCHEDULE);
    expect(mockSave).toHaveBeenCalledWith("demo-ext", 42, { enabled: undefined, intervalHours: 12 });
    expect(logSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "Update",
        description: "Updated the demo-ext sync schedule (enabled: true, every 12 h)",
      }),
    );
  });

  it.each([
    [{}],
    [{ enabled: "yes" }],
    [{ interval_hours: null }],
    [{ interval_hours: "" }],
    [{ interval_hours: "12.5" }],
    [{ interval_hours: 0 }],
    [{ interval_hours: 169 }],
  ])("validates the schedule body: %p is 400", async (body) => {
    const res = await request(app).patch("/api/extensions/demo-ext/schedule").send(body);
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("lets the provider refuse with its status", async () => {
    mockCanSchedule.mockResolvedValue({ ready: false, status: 404, reason: "Not configured" });
    const res = await request(app).patch("/api/extensions/demo-ext/schedule").send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.data).toBe("Not configured");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("needs extension.admin", async () => {
    const res = await request(app)
      .patch("/api/extensions/demo-ext/schedule")
      .set("x-test-role", "Editor")
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/status.test.ts middleware/__tests__/requireExtensionEnabled.middleware.test.ts extensions/sync-engine/__tests__/extensionRuns.route.test.ts`
Expected: FAIL: `parseRunsLimit is not a function`, `requireExtensionEnabledFromParam is not a function`, and `Cannot find module '../../../routes/extensionRuns.route'`.

- [ ] **Step 3: Append the run views to `status.ts`**

In `Servers/extensions/sync-engine/status.ts`, change the imports to

```ts
import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { getSyncProvider, statusKinds } from "./registry";
import { getSchedule, type ScheduleView } from "./schedule";
import { sqlLiveRunExists, sqlRunIsLive } from "./sql";
import type { RunStatus } from "./types";
```

and append:

```ts
export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT = 200;

/** `?limit=`: a whole number of at least 1, capped at 200; anything else is 20. */
export function parseRunsLimit(raw: unknown): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value =
    typeof first === "string" && /^\d+$/.test(first.trim())
      ? Number(first.trim())
      : typeof first === "number"
        ? first
        : Number.NaN;
  if (!Number.isInteger(value) || value < 1) return RUNS_DEFAULT_LIMIT;
  return Math.min(value, RUNS_MAX_LIMIT);
}

/** A run as the status route reports it (built by row_to_json, so timestamps are strings). */
export interface RunView {
  id: number;
  kind: string;
  status: RunStatus;
  code: string | null;
  counts: Record<string, number>;
  message: string | null;
  started_at: string;
  completed_at: string | null;
  is_live: boolean;
}

export interface RunStatusView {
  schedule: ScheduleView | null;
  running: boolean;
  /** Newest run of a status kind, whatever its status. */
  latest_run: RunView | null;
  /** Newest completed or failed run of a status kind (skips and abandoned runs never count). */
  last_finished_run: RunView | null;
}

const RUN_VIEW_COLUMNS = `r.id, r.kind, r.status, r.code, r.counts, r.message, r.started_at,
         r.completed_at, (r.status = 'started' AND ${sqlRunIsLive("r")}) AS is_live`;

export async function getRunStatus(key: string, orgId: number): Promise<RunStatusView> {
  const kinds = statusKinds(getSyncProvider(key));
  const [schedule, rows] = await Promise.all([
    getSchedule(key, orgId),
    sequelize.query(
      `SELECT ${sqlLiveRunExists(":key", ":orgId")} AS running,
              (SELECT row_to_json(x) FROM (
                 SELECT ${RUN_VIEW_COLUMNS}
                   FROM extension_sync_runs r
                  WHERE r.organization_id = :orgId AND r.extension_key = :key
                    AND r.kind IN (:kinds)
                  ORDER BY r.started_at DESC, r.id DESC
                  LIMIT 1) x) AS latest_run,
              (SELECT row_to_json(x) FROM (
                 SELECT ${RUN_VIEW_COLUMNS}
                   FROM extension_sync_runs r
                  WHERE r.organization_id = :orgId AND r.extension_key = :key
                    AND r.kind IN (:kinds) AND r.status IN ('completed', 'failed')
                  ORDER BY r.completed_at DESC, r.id DESC
                  LIMIT 1) x) AS last_finished_run;`,
      { replacements: { key, orgId, kinds }, type: QueryTypes.SELECT },
    ) as unknown as Promise<
      Array<{ running: boolean; latest_run: RunView | null; last_finished_run: RunView | null }>
    >,
  ]);
  const row = rows[0];
  return {
    schedule,
    running: !!row?.running,
    latest_run: row?.latest_run ?? null,
    last_finished_run: row?.last_finished_run ?? null,
  };
}

export interface RunListRow {
  id: number;
  kind: string;
  status: RunStatus;
  code: string | null;
  counts: Record<string, number>;
  message: string | null;
  triggered_by: number | null;
  started_at: Date;
  heartbeat_at: Date | null;
  completed_at: Date | null;
}

/** Every run of the extension for the org, newest first. Tokens are never returned. */
export async function listRuns(key: string, orgId: number, limit: number): Promise<RunListRow[]> {
  return (await sequelize.query(
    `SELECT r.id, r.kind, r.status, r.code, r.counts, r.message, r.triggered_by,
            r.started_at, r.heartbeat_at, r.completed_at
       FROM extension_sync_runs r
      WHERE r.organization_id = :orgId AND r.extension_key = :key
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT :limit;`,
    { replacements: { orgId, key, limit }, type: QueryTypes.SELECT },
  )) as RunListRow[];
}
```

- [ ] **Step 4: Make the enablement gate key-aware**

Replace `Servers/middleware/requireExtensionEnabled.middleware.ts` lines 26-65 (the whole `requireExtensionEnabled` function) with:

```ts
async function checkEnabled(
  extensionKey: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const organizationId = (req as any).organizationId;
  if (!organizationId) {
    res.status(401).json(STATUS_CODE[401](req.t!("User not authenticated")));
    return;
  }

  try {
    const extensionId = await resolveExtensionId(extensionKey);
    if (extensionId === null) {
      res
        .status(404)
        .json(STATUS_CODE[404](`Extension '${sanitizeForLog(extensionKey)}' not found in catalog`));
      return;
    }

    const enablement = await ExtensionEnablementModel.findByExtensionId(
      extensionId,
      organizationId,
    );
    if (!enablement || !enablement.enabled) {
      res
        .status(403)
        .json(
          STATUS_CODE[403](
            `Extension '${sanitizeForLog(extensionKey)}' is not enabled for this organization`,
          ),
        );
      return;
    }

    next();
  } catch (err) {
    res.status(500).json(STATUS_CODE[500]((err as Error).message));
  }
}

export function requireExtensionEnabled(extensionKey: string) {
  return (req: Request, res: Response, next: NextFunction): Promise<void> =>
    checkEnabled(extensionKey, req, res, next);
}

/** The same gate with the key taken from a route parameter (for example /:key/runs). */
export function requireExtensionEnabledFromParam(param = "key") {
  return (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.params[param];
    const key = Array.isArray(raw) ? String(raw[0]) : String(raw ?? "");
    return checkEnabled(key, req, res, next);
  };
}
```

- [ ] **Step 5: Write the controller and the router, and mount it**

Create `Servers/controllers/extensionRuns.ctrl.ts`:

```ts
import { NextFunction, Request, Response } from "express";
import { STATUS_CODE } from "../utils/statusCode.utils";
import logger, { logStructured } from "../utils/logger/fileLogger";
import { translateError } from "../utils/i18n.utils";
import { logFailure, logProcessing, logSuccess } from "../utils/logger/logHelper";
import {
  BackgroundJobsUnavailableError,
  hasPendingExtensionSyncJob,
} from "../services/automations/automationProducer";
import {
  SyncInProgressError,
  SyncNotReadyError,
  SyncValidationError,
} from "../extensions/sync-engine/errors";
import { startManualRun } from "../extensions/sync-engine/jobs";
import { findSyncProvider, getSyncProvider } from "../extensions/sync-engine/registry";
import { parseSchedulePatch, saveSchedule } from "../extensions/sync-engine/schedule";
import { getRunStatus, listRuns, parseRunsLimit } from "../extensions/sync-engine/status";

const fileName = "extensionRuns.ctrl.ts";

function keyParam(req: Request): string {
  const raw = req.params.key;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}
function orgId(req: Request): number {
  return (req as any).organizationId;
}
function uid(req: Request): number {
  return (req as any).userId;
}

/**
 * The generic routes exist only for extensions with a sync provider. Any other
 * key passes the request on (next("route")), so these routes never shadow the
 * per-extension routers mounted after this one.
 */
export function onlySyncProviderKeys(req: Request, _res: Response, next: NextFunction): void {
  if (findSyncProvider(keyParam(req))) next();
  else next("route");
}

function isExpectedError(err: unknown): boolean {
  return (
    err instanceof SyncNotReadyError ||
    err instanceof SyncValidationError ||
    err instanceof SyncInProgressError
  );
}

/**
 * - SyncNotReadyError → its status (400 or 404) with the provider's reason
 * - SyncValidationError → 400
 * - SyncInProgressError → 409
 * - BackgroundJobsUnavailableError → 503
 * - anything else → 500, logged
 */
function sendSyncError(req: Request, res: Response, err: unknown, functionName: string) {
  if (err instanceof SyncNotReadyError) {
    return res.status(err.status).json(STATUS_CODE[err.status](err.message));
  }
  if (err instanceof SyncValidationError) {
    return res.status(400).json(STATUS_CODE[400](err.message));
  }
  if (err instanceof SyncInProgressError) {
    return res.status(409).json(STATUS_CODE[409](err.message));
  }
  if (err instanceof BackgroundJobsUnavailableError) {
    return res.status(503).json(STATUS_CODE[503](err.message));
  }
  logStructured("error", `extension runs ${functionName} failed`, functionName, fileName);
  logger.error(`Error in extension runs ${functionName}:`, err);
  return res.status(500).json(STATUS_CODE[500](translateError(req, err)));
}

/** POST /:key/runs — start a manual run in the background (202 { jobId, previousRunId }). */
export async function postRunCtrl(req: Request, res: Response): Promise<any> {
  try {
    const started = await startManualRun(keyParam(req), orgId(req), uid(req));
    return res.status(202).json(STATUS_CODE[202](started));
  } catch (err) {
    return sendSyncError(req, res, err, "postRunCtrl");
  }
}

/** GET /:key/runs/status — schedule, running, latest_run, last_finished_run and queued (null if the queue does not answer). */
export async function getRunStatusCtrl(req: Request, res: Response): Promise<any> {
  const key = keyParam(req);
  try {
    const status = await getRunStatus(key, orgId(req));
    let queued: boolean | null = null;
    try {
      queued = await hasPendingExtensionSyncJob(key, orgId(req));
    } catch (err) {
      logger.warn(`extension runs status: queue state unavailable: ${(err as Error).message}`);
    }
    return res.status(200).json(STATUS_CODE[200]({ ...status, queued }));
  } catch (err) {
    return sendSyncError(req, res, err, "getRunStatusCtrl");
  }
}

/** GET /:key/runs?limit= — the org's runs of the extension, newest first (default 20, max 200). */
export async function getRunsCtrl(req: Request, res: Response): Promise<any> {
  try {
    const runs = await listRuns(keyParam(req), orgId(req), parseRunsLimit(req.query.limit));
    return res.status(200).json(STATUS_CODE[200](runs));
  } catch (err) {
    return sendSyncError(req, res, err, "getRunsCtrl");
  }
}

/** PATCH /:key/schedule — `{ enabled?, interval_hours? }`; the provider may refuse. Event-logged. */
export async function patchScheduleCtrl(req: Request, res: Response): Promise<any> {
  const key = keyParam(req);
  const ctx = {
    functionName: "patchScheduleCtrl",
    fileName,
    userId: uid(req),
    organizationId: orgId(req),
  };
  logProcessing({ ...ctx, description: `updating the ${key} sync schedule` });
  try {
    const patch = parseSchedulePatch(req.body);
    const provider = getSyncProvider(key);
    if (provider.canSchedule) {
      const allowed = await provider.canSchedule(orgId(req));
      if (!allowed.ready) throw new SyncNotReadyError(allowed.status, allowed.reason);
    }
    const schedule = await saveSchedule(key, orgId(req), patch);
    await logSuccess({
      ...ctx,
      eventType: "Update",
      description: `Updated the ${key} sync schedule (enabled: ${schedule.enabled}, every ${schedule.interval_hours} h)`,
    });
    return res.status(200).json(STATUS_CODE[200](schedule));
  } catch (err) {
    if (!isExpectedError(err)) {
      await logFailure({
        ...ctx,
        eventType: "Update",
        description: `Failed to update the ${key} sync schedule`,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return sendSyncError(req, res, err, "patchScheduleCtrl");
  }
}
```

Create `Servers/routes/extensionRuns.route.ts`:

```ts
import express from "express";
import authenticateJWT from "../middleware/auth.middleware";
import authorize from "../middleware/accessControl.middleware";
import { requireExtensionEnabledFromParam } from "../middleware/requireExtensionEnabled.middleware";
import {
  getRunStatusCtrl,
  getRunsCtrl,
  onlySyncProviderKeys,
  patchScheduleCtrl,
  postRunCtrl,
} from "../controllers/extensionRuns.ctrl";
import { registerAllSyncProviders } from "../extensions/sync-engine/providers";

registerAllSyncProviders();

/**
 * Sync engine routes, mounted at /api/extensions next to the catalog router.
 * Each starts with onlySyncProviderKeys, so a key without a sync provider
 * falls through to the per-extension routers. Writes need extension.admin.
 */
const router = express.Router();
const extensionEnabled = requireExtensionEnabledFromParam("key");

router.post(
  "/:key/runs",
  onlySyncProviderKeys,
  authenticateJWT,
  extensionEnabled,
  authorize("extension.admin"),
  postRunCtrl,
);
router.get("/:key/runs/status", onlySyncProviderKeys, authenticateJWT, extensionEnabled, getRunStatusCtrl);
router.get("/:key/runs", onlySyncProviderKeys, authenticateJWT, extensionEnabled, getRunsCtrl);
router.patch(
  "/:key/schedule",
  onlySyncProviderKeys,
  authenticateJWT,
  extensionEnabled,
  authorize("extension.admin"),
  patchScheduleCtrl,
);

export default router;
```

In `Servers/app.ts`, after `import extensionRoutes from "./routes/extension.route";` (line 57) add:

```ts
import extensionRunsRoutes from "./routes/extensionRuns.route";
```

and replace

```ts
  // /:key/disable, /:key/configuration; none collide with per-extension
  // sub-paths (which all use multi-segment paths like /oauth/workspaces,
  // /models, /config, /import, /sync, /use-cases, etc.).
  app.use("/api/extensions", extensionRoutes);
```

with

```ts
  // /:key/disable, /:key/configuration; none collide with per-extension
  // sub-paths (which all use multi-segment paths like /oauth/workspaces,
  // /models, /config, /import, /sync, /use-cases, etc.).
  app.use("/api/extensions", extensionRoutes);
  // Sync engine routes (/:key/runs, /:key/runs/status, /:key/schedule). A key
  // without a sync provider falls through to the per-extension routers below.
  app.use("/api/extensions", extensionRunsRoutes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd Servers && npx jest -i extensions/sync-engine/__tests__/status.test.ts middleware/__tests__/requireExtensionEnabled.middleware.test.ts extensions/sync-engine/__tests__/extensionRuns.route.test.ts`
Expected: PASS.

- [ ] **Step 7: Build, format and commit**

```bash
cd Servers && npx prettier --write extensions/sync-engine controllers/extensionRuns.ctrl.ts routes/extensionRuns.route.ts middleware/requireExtensionEnabled.middleware.ts middleware/__tests__/requireExtensionEnabled.middleware.test.ts app.ts && npm run build
cd .. && git add Servers/extensions/sync-engine Servers/controllers/extensionRuns.ctrl.ts Servers/routes/extensionRuns.route.ts Servers/middleware Servers/app.ts
git commit -m "feat(sync-engine): generic runs and schedule routes" -m "POST /api/extensions/:key/runs (202, readiness 400/404, 409, 503), GET /:key/runs/status (schedule, running, queued, latest_run, last_finished_run), GET /:key/runs?limit= (default 20, max 200, bad values fall back to 20) and PATCH /:key/schedule (1-168, event-logged, the provider may refuse). All use authenticateJWT and a key-aware requireExtensionEnabled; writes need extension.admin. A key with no sync provider passes through to the per-extension routers."
```

---

### Task 6: Jira Assets provider: readiness, run body on the context, claims through the engine

**Files:**
- Create: `Servers/extensions/jira-assets/jiraAssets.syncProvider.ts`
- Modify: `Servers/extensions/sync-engine/providers.ts` (register Jira)
- Modify: `Servers/extensions/jira-assets/jiraAssets.service.ts` (line ranges below, from develop `c5d8f439b`)
- Modify: `Servers/extensions/jira-assets/jiraAssets.ctrl.ts:12-37,60-70,103-137`
- Delete: `Servers/extensions/jira-assets/jiraAssets.scheduler.ts`, `Servers/extensions/jira-assets/__tests__/jiraAssets.scheduler.test.ts`
- Modify: `Servers/extensions/scheduledSync.utils.ts:31-38` (drop `sqlIntervalElapsed`, only the scheduler used it)
- Modify: `Servers/services/automations/automationWorker.ts:45-46,670-673`
- Modify: `Servers/services/automations/automationProducer.ts` (`scheduleJiraAssetsScheduledSyncCheck` removed; `scheduleExtensionSyncTick` retires it)
- Modify: `Servers/jobs/producer.ts:30,74`
- Test: `Servers/extensions/jira-assets/__tests__/jiraAssets.service.test.ts`, `Servers/extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts`, `Servers/services/automations/tests/automationProducer.spec.ts`

**Interfaces:**
- Consumes: `withClaim`, `createRunContext`, `runClaimed` (Task 2), `RunContext`, `RunResult`, `Readiness`, `ABANDONED_RUN_MESSAGE`, `SKIPPED_RUN_MESSAGE`, `RunSupersededError`, `SyncInProgressError`, `errorMessage`, `isUniqueViolation` (Task 2), `handleExtensionSyncJob`, `isExtensionSyncJob`, `SYNC_PROVIDERS` (Task 4).
- Produces (from `jiraAssets.service.ts`): `JIRA_ASSETS_KEY = "jira-assets"`, `JIRA_RUN_KINDS`, `JIRA_NOT_CONFIGURED_MESSAGE`, `JIRA_SYNC_IN_PROGRESS_MESSAGE`, `jiraReadiness(orgId, kind): Promise<Readiness>`, `jiraCanSchedule(orgId): Promise<Readiness>`, `runJiraSync(ctx: RunContext): Promise<RunResult>` with counts `{ fetched, created, updated, deleted, missing, newly_missing }`; re-exports `RunSupersededError`, `errorMessage`, `ABANDONED_RUN_MESSAGE`, `SKIPPED_RUN_MESSAGE`. `jiraAssetsSyncProvider: SyncProvider` from `jiraAssets.syncProvider.ts`.
- Removed: `claimSyncRun`, `touchHeartbeat`, `finalizeFailure`, `finalizeSuccess`, `assertRunOwned`, `releaseClaim`, `recordSkippedRun`, `runQueuedSync`, `startScheduledSync`, `runClaimedSync`, `RunRef`, `SyncRunType`, `JiraSyncResult`, `failedResult`, `SQL_RUN_STILL_OWNED`, the Jira scheduler, `scheduleJiraAssetsScheduledSyncCheck`, `sqlIntervalElapsed`.

Jira readiness per kind:
- `manual`: 404 `JIRA_NOT_CONFIGURED_MESSAGE` without a config; 400 "Select an object type before syncing" without an object type (existing use cases are not needed; the first manual sync creates them).
- `scheduled`: not ready without a config (404), without an object type (400 "No object type selected for sync") or without use cases (400 "No imported use cases to refresh"); the tick records and logs nothing for these.
- `import`: 404 without a config (the check `importObjects` makes today).
- `remove_missing`: always ready (removal and single delete check nothing about the config today).

- [ ] **Step 1: Point the Jira service tests at the engine**

In `Servers/extensions/jira-assets/__tests__/jiraAssets.service.test.ts`:

1. Replace the import block from `"../jiraAssets.service"` (lines 1-31) with:

```ts
import {
  ABANDONED_RUN_MESSAGE,
  deleteUseCaseByProjectId,
  IMPORT_MAX_OBJECTS,
  errorMessage,
  getSyncStatus,
  importObjects,
  JiraConfigValidationError,
  JiraImportInterruptedError,
  JiraNotConfiguredError,
  jiraReadiness,
  JiraSyncInProgressError,
  JiraUseCaseDeleteFailedError,
  JiraUseCaseNotFoundError,
  parseSyncIntervalHours,
  removeMissingUseCases,
  REMOVAL_SKIP_REASONS,
  runJiraSync,
  saveConfig,
  startManualSync,
  SKIPPED_RUN_MESSAGE,
  SQL_RUN_IS_LIVE,
  RunSupersededError,
  updateSelection,
  updateSyncSettings,
} from "../jiraAssets.service";
import { jiraAssetsSyncProvider } from "../jiraAssets.syncProvider";
import { createRunContext, runClaimed } from "../../sync-engine/claim";
import { SyncInProgressError } from "../../sync-engine/errors";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../../sync-engine/registry";
```

2. Replace

```ts
const FAKE_TX = { id: "tx" };
const RUN: RunRef = { historyId: 77, token: "tok-77" };
```

with

```ts
// afterCommit runs at once: the mocked transaction always commits.
const FAKE_TX = { id: "tx", afterCommit: (fn: () => void) => fn() };
const TOKEN = "00000000-0000-4000-8000-000000000077";
/** What the run's ownership fragment inlines; present in every guarded write. */
const OWNS = `own.run_token = '${TOKEN}'`;

/** A claimed Jira run, as the engine hands it to the provider. */
const ctxFor = (kind: "manual" | "scheduled" = "manual", triggeredBy: number | null = 8) =>
  createRunContext(
    jiraAssetsSyncProvider,
    { runId: 77, token: TOKEN, orgId: 5, key: "jira-assets", kind, triggeredBy },
    null,
  );

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider(jiraAssetsSyncProvider);
});
```

3. Replace the whole `fakeDb` function (lines 160-249, from `/** Route sequelize.query by SQL text` to its closing `}`) with:

```ts
/** Route sequelize.query by SQL text, so tests read as scenarios, not call orders. */
function fakeDb({
  config = CONFIG_ROW,
  existing = [],
  running = [],
  heartbeat = [{ id: 77 }],
  owned = [{ id: 77 }],
  linkExists = true,
  linkedProject = [{ id: 11 }],
  foreignProjects = [],
  ownRow = [{ id: 77 }],
  flagged = [],
  stillFlagged = [],
  otherLinks = [],
  live = false,
  latestRunId = 40,
}: FakeDb = {}) {
  mockQuery.mockImplementation(async (sql: string, opts: any = {}) => {
    // Guarded writes carry the ownership fragment (FOR SHARE), so match them first.
    if (sql.includes("WITH link AS")) {
      const isOwned = owned.length > 0;
      return [{ owned: isOwned, links: isOwned && linkExists ? 1 : 0 }];
    }
    if (sql.includes("SET missing_in_jira_since = (NOW()")) return [flagged, {}];
    if (sql.includes("FOR SHARE")) return owned;
    if (sql.includes("AS has_use_cases")) {
      return config
        ? [{ has_object_type: !!config.selected_object_type_id, has_use_cases: existing.length > 0 }]
        : [];
    }
    if (sql.includes("WHERE project_id = :projectId")) return linkedProject;
    if (sql.includes("SELECT id FROM projects")) {
      return (opts.replacements?.projectIds ?? [])
        .filter((id: number) => !foreignProjects.includes(id))
        .map((id: number) => ({ id }));
    }
    if (sql.includes("SET heartbeat_at")) return [heartbeat, {}];
    if (sql.includes("pg_advisory_xact_lock")) return [{}];
    if (sql.includes("SET status = 'abandoned'")) return [[], 0];
    if (sql.includes("ORDER BY started_at DESC, id DESC LIMIT 1")) {
      return latestRunId === null ? [] : [{ id: latestRunId }];
    }
    if (sql.includes("SELECT id FROM extension_sync_runs")) return running;
    if (sql.includes("INSERT INTO extension_sync_runs")) return [[{ id: 77 }], 1];
    if (sql.includes("AS live")) return [{ live }];
    if (sql.includes("SELECT id, jira_base_url")) return config ? [config] : [];
    if (sql.includes("SELECT * FROM jira_assets_config")) return config ? [config] : [];
    if (sql.includes("SELECT jira_object_id, project_id")) return existing;
    if (sql.includes("SELECT id, project_id, missing_in_jira_since FROM jira_assets_use_cases")) {
      const r = opts.replacements ?? {};
      const match = sql.includes("AND project_id IN (:lockedProjects)")
        ? (row: { project_id: number | null }) =>
            row.project_id !== null && r.lockedProjects.includes(row.project_id)
        : sql.includes("AND project_id IN (:ids)")
          ? (row: { project_id: number | null }) => r.ids.includes(row.project_id)
          : (row: { id: number }) => r.ids.includes(row.id);
      return [...stillFlagged, ...otherLinks]
        .filter((row: any) => match(row))
        .map((row) => ({
          id: row.id,
          project_id: row.project_id,
          missing_in_jira_since: row.missing === false ? null : "2026-01-01",
        }))
        .sort((a, b) => a.id - b.id);
    }
    if (sql.includes("COUNT(DISTINCT project_id)")) {
      const ids: number[] = opts.replacements?.ids ?? [];
      const projects = new Set(
        [...stillFlagged, ...otherLinks].filter((r) => ids.includes(r.id)).map((r) => r.project_id),
      );
      return [{ projects: projects.size }];
    }
    if (sql.includes("SELECT p.project_title")) {
      return [{ title: "Credit model", object_key: "AI-11" }];
    }
    if (sql.includes("SELECT id, project_id FROM jira_assets_use_cases")) {
      return stillFlagged.map((r) => ({ id: r.id, project_id: r.project_id }));
    }
    if (sql.includes("SELECT id FROM jira_assets_use_cases")) return [];
    if (sql.includes("nextval")) return [{ seq: "9" }];
    if (sql.includes("INSERT INTO projects")) return [[{ id: 500 }], 1];
    if (sql.includes("SET status = 'completed'")) return [ownRow, {}];
    if (sql.includes("SET status = 'failed'")) {
      return [ownRow.map(() => ({ started_at: new Date("2026-10-12T10:00:00Z") })), {}];
    }
    if (sql.includes("DELETE FROM jira_assets_use_cases")) {
      return [(opts.replacements?.linkIds ?? []).map((id: number) => ({ id })), {}];
    }
    return [[], {}];
  });
}
```

4. Delete these describe blocks: `describe("claimSyncRun (overlap guard + run token)"` (lines 271-315), `describe("touchHeartbeat"` (317-339), `describe("runQueuedSync (worker claims at pickup)"` (649-708), and inside `describe("startManualSync (Sync now queues a job)"` the test `it("scheduled: queues a refresh-only job with no user"` (638-647). In `describe("finalizeFailure"` (1195-1244) delete the four `it(...)` tests and rename the describe to `describe("errorMessage"`, keeping the `it.each([...])("falls back to a usable message for %p"` table unchanged.

5. Replace `describe("runClaimedSync — never deletes, flags missing objects"` (lines 341-589) with:

```ts
describe("runJiraSync — never deletes, flags missing objects", () => {
  const run = (kind: "manual" | "scheduled" = "manual", triggeredBy: number | null = 8) => {
    const ctx = ctxFor(kind, triggeredBy);
    return runJiraSync(ctx).finally(() => ctx.dispose());
  };

  it("scheduled: updates linked use cases, clears their flag, creates nothing", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")]);

    const result = await run("scheduled", null);

    expect(result.counts).toMatchObject({ updated: 1, created: 0, deleted: 0 });
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("missing_in_jira_since = NULL")).toHaveLength(1);
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("flags linked objects missing from a complete walk, keeping the earliest date", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102), link("4", null)], flagged: [{ id: 2 }] });
    clientReturning([jiraObject("1")], true);

    const result = await run();

    expect(result.counts).toMatchObject({ missing: 2, newly_missing: 1, deleted: 0 });
    expect(result.message).toContain("flagged as missing (nothing was removed): 2, 4.");
    const [flagSql, flagOptions] = sqlCalls("SET missing_in_jira_since = (NOW()")[0];
    expect(flagSql).toContain("AND missing_in_jira_since IS NULL");
    expect(flagSql).toContain("data->'objectType'->>'id' = :objectTypeId");
    expect(flagSql).toContain(OWNS);
    expect(flagSql).toContain("FOR SHARE");
    expect(flagOptions.replacements).toEqual({
      organizationId: 5,
      missingIds: ["2", "4"],
      objectTypeId: "42",
    });
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("never flags links from another object type (type switched A → B)", async () => {
    // Links imported from type "7" (A); the config now walks type "42" (B).
    fakeDb({ existing: [link("a1", 201, "7"), link("a2", 202, "7"), link("b1", 101)] });
    clientReturning([jiraObject("b1")], true);

    const result = await run();

    expect(result.counts.missing).toBe(0);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    expect(result.message).toContain(
      "2 use case(s) from another or an unknown object type were left as they were",
    );
  });

  it("flags only same-type links when types are mixed; unknown types are left alone", async () => {
    fakeDb({
      existing: [link("1", 101), link("2", 102), link("a1", 201, "7"), link("u1", 301, null)],
      flagged: [{ id: 2 }],
    });
    clientReturning([jiraObject("1")], true);

    const result = await run();

    expect(result.counts.missing).toBe(1);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")[0][1].replacements.missingIds).toEqual([
      "2",
    ]);
  });

  it("clears a seen object's flag only while the run owns its claim", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")], true);

    await run();

    const [clearSql] = sqlCalls("missing_in_jira_since = NULL")[0];
    // Once in the link update's WHERE, once in the `owned` column.
    expect(clearSql.split(OWNS)).toHaveLength(3);
    expect(clearSql).toContain("FOR SHARE");
  });

  it("sets no flags after an incomplete walk, but still clears flags for objects it saw", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1")], false);

    const result = await run();

    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    expect(sqlCalls("missing_in_jira_since = NULL")).toHaveLength(1);
    expect(result.message).toContain("did not confirm it returned every object");
  });

  it("sets no flags when Jira returns no objects at all", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([], true);

    const result = await run();

    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    expect(result.message).toContain("returned no objects");
  });

  it("manual: creates new objects owned by the user, in one owned transaction", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    const result = await run();

    expect(result.counts.created).toBe(1);
    const [, projectInsert] = sqlCalls("INSERT INTO projects")[0];
    expect(projectInsert.replacements.owner).toBe(8);
    expect(projectInsert.transaction).toBe(FAKE_TX);
    expect(sqlCalls("INSERT INTO jira_assets_use_cases")[0][1].transaction).toBe(FAKE_TX);
    expect(sqlCalls("FOR SHARE").some(([, o]) => o?.transaction === FAKE_TX)).toBe(true);
  });

  it("walks Jira under the run's deadline signal and heartbeats per page", async () => {
    fakeDb();
    const getAllObjects = clientReturning([]);
    const ctx = ctxFor();

    await runJiraSync(ctx);

    expect(getAllObjects.mock.calls[0][1].deadline).toBe(ctx.signal);
    expect(sqlCalls("SET heartbeat_at")).toHaveLength(1);
    ctx.dispose();
  });

  it("fails without changing anything when the fetch deadline is hit", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")], false, "deadline");

    await expect(run()).rejects.toThrow("did not return every object within 10 minutes");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
  });

  it("writes nothing more once it has lost its claim mid-way", async () => {
    fakeDb({ existing: [link("1", 101)], heartbeat: [] });
    clientReturning([jiraObject("1")]);

    await expect(run()).rejects.toBeInstanceOf(RunSupersededError);
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
    expect(sqlCalls("SET status = 'failed'")).toHaveLength(0);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("updates each linked object in one statement that locks and checks the claim", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1"), jiraObject("2")]);

    const result = await run();

    expect(result.counts.updated).toBe(2);
    // One round trip per object: no separate ownership query or transaction.
    const updates = sqlCalls("WITH link AS");
    expect(updates).toHaveLength(2);
    expect(mockTransaction).not.toHaveBeenCalled();
    const [sql, options] = updates[0];
    expect(sql).toContain("UPDATE jira_assets_use_cases");
    expect(sql).toContain("UPDATE projects p");
    expect(sql).toContain("FROM link");
    expect(sql).toContain(OWNS);
    expect(options.replacements).toMatchObject({ jiraObjectId: "1", title: "System 1", organizationId: 5 });
    expect(options.replacements).not.toHaveProperty("historyId");
  });

  it("does not count an object whose link row was deleted since the walk began", async () => {
    fakeDb({ existing: [link("1", 101)], linkExists: false });
    clientReturning([jiraObject("1")]);

    const result = await run();

    expect(result.counts.updated).toBe(0);
  });

  it("stops at the next object, writing nothing, once another claim closed the run", async () => {
    // Heartbeats would still pass here; the per-object check is what stops it.
    fakeDb({ existing: [link("1", 101), link("2", 102)], owned: [] });
    clientReturning([jiraObject("1"), jiraObject("2"), jiraObject("3")]);

    await expect(run()).rejects.toBeInstanceOf(RunSupersededError);
    expect(sqlCalls("WITH link AS")).toHaveLength(1);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
  });

  it("manual: does not create a use case once the run lost its claim", async () => {
    fakeDb({ existing: [], owned: [] });
    clientReturning([jiraObject("3")]);

    await expect(run()).rejects.toBeInstanceOf(RunSupersededError);
    expect(sqlCalls("nextval")).toHaveLength(0);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
  });

  it("stops when a heartbeat hits a database error", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, opts: unknown) => {
      if (sql.includes("SET heartbeat_at")) throw new Error("db hiccup");
      return base(sql, opts);
    });

    await expect(run()).rejects.toThrow("db hiccup");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
  });

  it("throws a token decrypt failure for the engine to record", async () => {
    fakeDb({ existing: [link("1", 101)] });
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    await expect(run("scheduled", null)).rejects.toThrow("bad key");
  });
});

describe("runJiraSync through the engine", () => {
  it("declares Jira's kinds, its scheduled kind and its walk deadline", () => {
    expect(jiraAssetsSyncProvider).toMatchObject({
      key: "jira-assets",
      kinds: ["manual", "scheduled", "import", "remove_missing"],
      scheduledKind: "scheduled",
      runDeadlineMs: 600_000,
    });
  });

  it("records a failure on the run row only, never on the config, and counts it for the schedule", async () => {
    fakeDb({ existing: [link("1", 101)] });
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    await runClaimed(jiraAssetsSyncProvider, ctxFor("scheduled", null));

    const [, failed] = sqlCalls("SET status = 'failed'")[0];
    expect(failed.replacements).toMatchObject({ runId: 77, orgId: 5, key: "jira-assets", token: TOKEN });
    expect(failed.replacements.message).toContain("bad key");
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
    expect(sqlCalls("consecutive_failures = consecutive_failures + 1")).toHaveLength(1);
  });

  it("finalizes the counts and note of a successful run", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")], true);

    await runClaimed(jiraAssetsSyncProvider, ctxFor());

    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(JSON.parse(completed.replacements.counts)).toEqual({
      fetched: 1,
      created: 0,
      updated: 1,
      deleted: 0,
      missing: 0,
      newly_missing: 0,
    });
  });
});

describe("jiraReadiness", () => {
  it("manual: 404 without a config, 400 without an object type, no use cases needed", async () => {
    fakeDb({ config: null });
    await expect(jiraReadiness(5, "manual")).resolves.toEqual({
      ready: false,
      status: 404,
      reason: "Jira Assets is not configured. Save the connection first.",
    });
    fakeDb({ config: { ...CONFIG_ROW, selected_object_type_id: null } });
    await expect(jiraReadiness(5, "manual")).resolves.toEqual({
      ready: false,
      status: 400,
      reason: "Select an object type before syncing",
    });
    fakeDb({ existing: [] });
    await expect(jiraReadiness(5, "manual")).resolves.toEqual({ ready: true });
  });

  it("scheduled: not ready without an object type or without use cases", async () => {
    fakeDb({ existing: [] });
    await expect(jiraReadiness(5, "scheduled")).resolves.toMatchObject({
      ready: false,
      reason: "No imported use cases to refresh",
    });
    fakeDb({ config: { ...CONFIG_ROW, selected_object_type_id: null }, existing: [link("1", 101)] });
    await expect(jiraReadiness(5, "scheduled")).resolves.toMatchObject({
      ready: false,
      reason: "No object type selected for sync",
    });
    fakeDb({ existing: [link("1", 101)] });
    await expect(jiraReadiness(5, "scheduled")).resolves.toEqual({ ready: true });
  });

  it("import needs a config; remove_missing needs nothing", async () => {
    fakeDb({ config: null });
    await expect(jiraReadiness(5, "import")).resolves.toMatchObject({ ready: false, status: 404 });
    await expect(jiraReadiness(5, "remove_missing")).resolves.toEqual({ ready: true });
  });
});
```

6. In the remaining `removeMissingUseCases`, `deleteUseCaseByProjectId` and `importObjects` describes, apply exactly these substitutions (every occurrence):

| Old text | New text |
|---|---|
| `sqlCalls("INSERT INTO jira_assets_sync_history")` | `sqlCalls("INSERT INTO extension_sync_runs")` |
| `.toMatchObject({ syncType: "remove_missing", triggeredBy: 8 })` | `.toMatchObject({ key: "jira-assets", kind: "remove_missing", triggeredBy: 8 })` |
| `.toMatchObject({ syncType: "import", triggeredBy: 8 })` | `.toMatchObject({ key: "jira-assets", kind: "import", triggeredBy: 8 })` |
| `sqlCalls("SET status = 'failed', error_message")` | `sqlCalls("SET status = 'failed'")` |
| `sqlCalls("DELETE FROM jira_assets_sync_history")` | `sqlCalls("DELETE FROM extension_sync_runs")` |
| `expect(completed.replacements).toMatchObject({ objectsDeleted: 1 });` | `expect(JSON.parse(completed.replacements.counts)).toMatchObject({ deleted: 1 });` |
| `completed.replacements.note` | `completed.replacements.message` |
| `.rejects.toBeInstanceOf(JiraSyncInProgressError)` in `removeMissingUseCases` ("cannot run while a sync is running"), `deleteUseCaseByProjectId` ("is 409 while a sync, import or removal runs") and `importObjects` ("takes the same claim as sync") | `.rejects.toBeInstanceOf(SyncInProgressError)` |
| `expect(release.replacements).toMatchObject({ id: 77, organizationId: 5 });` | `expect(release.replacements).toMatchObject({ runId: 77, orgId: 5, key: "jira-assets" });` |

(`startManualSync` keeps its `JiraSyncInProgressError` expectations until Task 7.)

- [ ] **Step 2: Add the controller and producer tests**

In `Servers/extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts`, add `JIRA_SYNC_IN_PROGRESS_MESSAGE: "A Jira Assets sync is already running for this organization",` to the object returned by the `jest.mock("../jiraAssets.service", ...)` factory, add `import { SyncInProgressError } from "../../sync-engine/errors";` after the other imports, and add inside `describe("POST /import"`:

```ts
  it("returns 409 with the Jira message when the engine claim is taken", async () => {
    (importObjects as jest.Mock).mockRejectedValue(new SyncInProgressError());
    const res = mockRes();

    await postImport({ ...req, body: { object_ids: ["1"] } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].data).toBe(
      "A Jira Assets sync is already running for this organization",
    );
  });
```

In `Servers/services/automations/tests/automationProducer.spec.ts`: in the `bullmq` mock add `const mockRemoveJobScheduler = jest.fn().mockResolvedValue(true);` and `removeJobScheduler: mockRemoveJobScheduler,` to the queue object; remove `scheduleJiraAssetsScheduledSyncCheck,` from the import list; delete `describe("scheduleJiraAssetsScheduledSyncCheck"` (lines 342-349); and inside `describe("extension sync engine jobs"` add:

```ts
    it("retires the old Jira check scheduler before scheduling the tick", async () => {
      const remove = automationQueue.removeJobScheduler as unknown as jest.Mock;
      await scheduleExtensionSyncTick();
      expect(remove).toHaveBeenCalledWith("jira_assets_scheduled_sync_check");
    });

    it("still schedules the tick when retiring the old scheduler fails", async () => {
      const remove = automationQueue.removeJobScheduler as unknown as jest.Mock;
      remove.mockRejectedValueOnce(new Error("redis hiccup"));
      await scheduleExtensionSyncTick();
      expectSchedulerCall("extension_sync_tick", {}, "*/5 * * * *");
    });
```

Delete `Servers/extensions/jira-assets/__tests__/jiraAssets.scheduler.test.ts`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd Servers && npx jest -i extensions/jira-assets/__tests__/jiraAssets.service.test.ts extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts services/automations/tests/automationProducer.spec.ts`
Expected: FAIL: `Cannot find module '../jiraAssets.syncProvider'`, the ctrl 409 test gets 500, and the producer test `removeJobScheduler` was not called.

- [ ] **Step 4: Rework `jiraAssets.service.ts`**

Apply these edits from the bottom of the file up, so the line numbers (develop `c5d8f439b`) stay valid:

1. **Lines 1686-1753** (`recordSkippedRun` and `runQueuedSync`, with their doc comments): delete.

2. **Lines 1470-1684** (doc comment and `runClaimedSync`): replace with:

```ts
/**
 * The Jira Assets run body: the provider's `run` for a manual or scheduled run
 * the engine has already claimed. Syncs never delete anything.
 *
 * - **Scheduled** (`ctx.kind = "scheduled"`) is refresh-only: it updates
 *   projects and links that already exist and creates nothing.
 * - **Manual** also creates use cases for new objects of the selected type,
 *   owned by the user who started it (`ctx.triggeredBy`).
 *
 * Both flag linked objects Jira no longer returns: `missing_in_jira_since` is
 * set (keeping the earliest date), but only when the walk was complete and
 * returned at least one object. An incomplete or empty walk sets no flags.
 * Every object Jira returns has its flag cleared, complete walk or not.
 * Admins remove flagged use cases explicitly (removeMissingUseCases).
 *
 * The engine records the outcome: it finalizes the returned counts and note,
 * and a thrown error (missing config, token decrypt, client construction, Jira
 * and network errors, the walk deadline `ctx.signal`) closes the run as
 * failed. Every write is guarded by the run's claim; once it is lost the run
 * stops with RunSupersededError and writes nothing more.
 */
export async function runJiraSync(ctx: RunContext): Promise<RunResult> {
  const organizationId = ctx.orgId;
  const refreshOnly = ctx.kind === "scheduled";

  const config = await loadFullConfig(organizationId);
  if (!config) throw new JiraNotConfiguredError();
  const objectTypeId = config.selected_object_type_id;
  if (!objectTypeId) throw new JiraConfigValidationError("No object type selected for sync");
  const client = clientFromConfig(config);

  const fetched = await client.getAllObjects(objectTypeId, {
    deadline: ctx.signal,
    onPage: () => ctx.heartbeat(),
  });
  if (fetched.stoppedReason === "deadline") {
    throw new JiraUpstreamError(
      `Jira did not return every object within ${WORKER_SYNC_DEADLINE_MS / 60000} minutes, so nothing was changed`,
    );
  }
  const { objects: jiraObjects, complete } = fetched;
  const objectsFetched = jiraObjects.length;

  const existingRows = (await sequelize.query(
    `SELECT jira_object_id, project_id, data->'objectType'->>'id' AS object_type_id
       FROM jira_assets_use_cases
      WHERE organization_id = :organizationId;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as Array<{
    jira_object_id: string;
    project_id: number | null;
    object_type_id: string | null;
  }>;
  const existingMap = new Map(existingRows.map((r) => [r.jira_object_id, r]));

  let objectsCreated = 0;
  let objectsUpdated = 0;
  const now = new Date();

  for (const [index, jiraObj] of jiraObjects.entries()) {
    const obj = describeObject(jiraObj, (jiraObj as any)._attrIdToName || {});
    const existing = existingMap.get(obj.jiraObjectId);

    if (!existing) {
      if (!refreshOnly) {
        const outcome = await createLinkedUseCase(ctx, organizationId, ctx.triggeredBy, obj, now);
        if (outcome === "created") objectsCreated++;
      }
    } else {
      // One statement: the link update (clearing any missing flag) and the
      // project update run only while this run owns its claim. sqlOwnsRun
      // share-locks the run's row, so a claim closing it must wait for this
      // statement; nothing lands after the run lost its claim. `owned`
      // reports the same check.
      const [outcome] = (await sequelize.query(
        `WITH link AS (
           UPDATE jira_assets_use_cases
              SET data = CAST(:data AS JSONB),
                  last_synced_at = :now,
                  sync_status = 'synced',
                  missing_in_jira_since = NULL,
                  updated_at = NOW()
            WHERE jira_object_id = :jiraObjectId AND organization_id = :organizationId
              AND ${ctx.sqlOwnsRun()}
            RETURNING project_id
         ), proj AS (
           UPDATE projects p
              SET project_title = :title, goal = :goal, last_updated = :now
             FROM link
            WHERE p.id = link.project_id AND p.organization_id = :organizationId
         )
         -- proj is a data-modifying CTE: it runs even though nothing reads it.
         -- A link whose project row is gone has nothing to update; it
         -- cannot happen in practice (the link cascades with its project).
         SELECT ${ctx.sqlOwnsRun()} AS owned,
                (SELECT COUNT(*) FROM link)::int AS links;`,
        {
          replacements: {
            data: JSON.stringify(obj.data),
            now,
            title: obj.name,
            goal: obj.goal,
            jiraObjectId: obj.jiraObjectId,
            organizationId,
          },
          type: QueryTypes.SELECT,
        },
      )) as Array<{ owned: boolean; links: number }>;
      if (!outcome || !outcome.owned) throw new RunSupersededError(ctx.runId);
      // Owned but no link row: it was deleted since the walk began; skip it.
      if (outcome.links > 0) objectsUpdated++;
    }
    existingMap.delete(obj.jiraObjectId);
    if ((index + 1) % HEARTBEAT_EVERY_OBJECTS === 0) {
      await ctx.heartbeat();
    }
  }

  // Whatever is left in existingMap was not returned by Jira. Only links
  // imported from the object type just walked can be judged missing; links
  // from another or an unknown type are left exactly as they are.
  const missingIds = Array.from(existingMap.values())
    .filter((r) => r.object_type_id !== null && r.object_type_id === String(objectTypeId))
    .map((r) => r.jira_object_id);
  const otherTypeCount = existingMap.size - missingIds.length;
  let objectsNewlyMissing = 0;
  let note: string | null = null;
  const otherTypeNote =
    otherTypeCount > 0
      ? ` ${otherTypeCount} use case(s) from another or an unknown object type were left as they were.`
      : "";
  if (missingIds.length === 0 && otherTypeCount > 0) {
    note = otherTypeNote.trim();
  } else if (missingIds.length > 0) {
    if (complete && objectsFetched > 0) {
      await ctx.heartbeat();
      // Same type only (checked again in SQL), still unflagged, and only
      // while this run owns its claim.
      const [flagged] = (await sequelize.query(
        `UPDATE jira_assets_use_cases
            SET missing_in_jira_since = ${SQL_NOW_UTC}, updated_at = NOW()
          WHERE organization_id = :organizationId
            AND jira_object_id IN (:missingIds)
            AND data->'objectType'->>'id' = :objectTypeId
            AND missing_in_jira_since IS NULL
            AND ${ctx.sqlOwnsRun()}
          RETURNING id;`,
        {
          replacements: {
            organizationId,
            missingIds,
            objectTypeId: String(objectTypeId),
          },
        },
      )) as unknown as [Array<{ id: number }>, unknown];
      objectsNewlyMissing = flagged?.length ?? 0;
      note = `${missingIds.length} use case(s) not found in Jira are flagged as missing (nothing was removed): ${idList(missingIds)}.${otherTypeNote}`;
    } else {
      const why =
        objectsFetched === 0
          ? "Jira returned no objects for the selected object type"
          : "Jira did not confirm it returned every object";
      note = `${why}, so ${missingIds.length} use case(s) not seen this time were not flagged as missing: ${idList(missingIds)}.${otherTypeNote}`;
    }
    logStructured("processing", `Jira Assets run ${ctx.runId}: ${note}`, "runJiraSync", fileName);
  }

  return {
    counts: {
      fetched: objectsFetched,
      created: objectsCreated,
      updated: objectsUpdated,
      deleted: 0,
      missing: missingIds.length,
      newly_missing: objectsNewlyMissing,
    },
    message: note,
  };
}
```

3. **Lines 1459-1468** (doc comment and `startScheduledSync`): delete.

4. **Lines 1389-1406** (doc comment and `releaseClaim`): delete.

5. **`deleteUseCasesUnderClaim` (lines 1140-1387):**
   - In its doc comment, replace the sentence at lines 1177-1181 (`With \`requireAll\` (single delete), nothing handled is ... records objects_deleted = projects (use cases) deleted.`) with:

```ts
 * With `requireAll` (single delete), nothing handled is
 * JiraUseCaseNotFoundError: the transaction rolls back and the claim is
 * released (it never did anything). Other errors close the run as failed; a
 * lost claim (RunSupersededError) writes nothing more. The run records
 * counts.deleted = projects (use cases) deleted, finalized inside the data
 * transaction, so a lost claim rolls the deletes back.
```

   - Replace lines 1188-1190:

```ts
  const run = await claimSyncRun(organizationId, "remove_missing", userId);
  const matchColumn = target.by === "id" ? "id" : "project_id";
  try {
```

   with

```ts
  const matchColumn = target.by === "id" ? "id" : "project_id";
  return withClaim(
    JIRA_ASSETS_KEY,
    organizationId,
    "remove_missing",
    userId,
    async (ctx) => {
```

   - Replace line 1198 `      await assertRunOwned(run, organizationId, transaction);` with `      await ctx.assertOwned(transaction);`.
   - Replace lines 1359-1387 (from `      // Recorded in the same transaction` through the function's closing `}` on line 1387, which takes in the old `return outcome;` and the `catch` block that released or failed the claim) with:

```ts
      // Recorded in the same transaction: if this run lost its claim, the
      // deletes roll back with it.
      await ctx.finalize(
        {
          counts: {
            fetched: 0,
            created: 0,
            updated: 0,
            deleted: outcome.removedProjectIds.length,
          },
          message:
            outcome.unlinkedIds.length > 0
              ? `${outcome.unlinkedIds.length} link(s) with no project in this organization were cleaned up.`
              : null,
        },
        transaction,
      );
    });
    return { value: outcome };
    },
    {
      // Nothing was done: the claim is released, not recorded as a failed run.
      releaseOn: (err) =>
        err instanceof JiraUseCaseNotFoundError || err instanceof JiraConfigValidationError,
    },
  );
}
```

6. **`importObjects` (lines 902-1004, doc comment included):** replace with:

```ts
/**
 * Import the selected objects. Takes the same engine claim as syncs (kind
 * 'import'), so an import and a sync never overlap. The outcome is recorded on
 * the import's run only; imports never count as a sync for the schedule.
 */
export async function importObjects(
  organizationId: number,
  userId: number,
  objectIds: string[],
): Promise<ImportResult> {
  if (!Array.isArray(objectIds) || objectIds.length === 0) {
    throw new JiraConfigValidationError("No objects selected for import");
  }
  if (objectIds.length > IMPORT_MAX_OBJECTS) {
    throw new JiraConfigValidationError(
      `Select up to ${IMPORT_MAX_OBJECTS} objects per import. ${objectIds.length} were selected.`,
    );
  }
  throwIfNotReady(await jiraReadiness(organizationId, "import"));

  let imported = 0;
  let skipped = 0;
  try {
    return await withClaim(JIRA_ASSETS_KEY, organizationId, "import", userId, async (ctx) => {
      const errors: string[] = [];
      const failedIds: string[] = [];
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
            {
              replacements: { objectId: String(objectId), organizationId },
              type: QueryTypes.SELECT,
            },
          )) as Array<{ id: number }>;
          if (existing.length > 0) {
            skipped++;
          } else {
            const jiraObj = await client.getObjectById(objectId);
            const outcome = await createLinkedUseCase(
              ctx,
              organizationId,
              userId ?? null,
              describeObject(jiraObj, attrIdToName),
              now,
            );
            if (outcome === "created") imported++;
            else skipped++;
          }
        } catch (err) {
          // Lost the claim: stop now rather than record it as one failed object.
          if (err instanceof RunSupersededError) throw err;
          errors.push(`Failed to import ${objectId}: ${errorMessage(err)}`);
          failedIds.push(String(objectId));
        }
        // Skipped objects count too, so a run of already-linked ones still heartbeats.
        if ((index + 1) % HEARTBEAT_EVERY_OBJECTS === 0) {
          await ctx.heartbeat();
        }
      }

      return {
        value: {
          success: true,
          imported,
          skipped,
          errors: errors.length > 0 ? errors : undefined,
          failed_ids: failedIds.length > 0 ? failedIds : undefined,
        },
        result: {
          counts: { fetched: objectIds.length, created: imported, updated: 0, deleted: 0 },
          message: errors.length > 0 ? `${errors.length} object(s) failed to import` : null,
        },
      };
    });
  } catch (err) {
    if (err instanceof RunSupersededError) {
      // Another claim closed this import as abandoned. Report how far it got.
      throw new JiraImportInterruptedError(imported, skipped);
    }
    throw err;
  }
}
```

7. **Lines 666-879** (from `/**\n * SQL guard: the run (:historyId, :runToken)` through the end of `failedResult`, i.e. `SQL_RUN_STILL_OWNED`, `SKIPPED_RUN_MESSAGE`, `RunRef`, `claimSyncRun`, `touchHeartbeat`, `finalizeFailure`, `RunCounts`, `finalizeSuccess`, `failedResult`): delete. Keep `MISSING_IDS_IN_NOTE` and `idList` (line 880 on).

8. **`createLinkedUseCase` (lines 602-664):** in its doc comment replace `The transaction first proves \`run\` still owns its claim (RunSupersededError otherwise).` with `The transaction first proves the run still owns its claim (ctx.assertOwned; RunSupersededError otherwise).`; change the first parameter `run: RunRef,` (line 611) to `ctx: RunContext,`; change line 619 `      await assertRunOwned(run, organizationId, transaction);` to `      await ctx.assertOwned(transaction);`.

9. **Lines 576-600** (`assertRunOwned` and its doc comment): delete.

10. **Lines 525-544** (`errorMessage` and `isUniqueViolation`): delete (both now come from the engine).

11. **After `clientFromConfig` (after line 511)** insert:

```ts
// ---------------------------------------------------------------------------
// Readiness (sync engine)
// ---------------------------------------------------------------------------

const NOT_CONFIGURED: Readiness = { ready: false, status: 404, reason: JIRA_NOT_CONFIGURED_MESSAGE };

/**
 * Whether a run of `kind` can start for the org (the provider's readiness):
 * - manual: a config (404) and a selected object type (400); existing use
 *   cases are not needed, because the first manual sync creates them;
 * - scheduled: a config, an object type and at least one use case; the tick
 *   records and logs nothing for an org that is not ready;
 * - import: a config (404);
 * - remove_missing: always (removal and single delete check no config).
 */
export async function jiraReadiness(organizationId: number, kind: string): Promise<Readiness> {
  if (kind === "remove_missing") return { ready: true };
  if (kind === "scheduled") {
    const rows = (await sequelize.query(
      `SELECT (c.selected_object_type_id IS NOT NULL AND c.selected_object_type_id <> '')
                AS has_object_type,
              EXISTS (SELECT 1 FROM jira_assets_use_cases u
                       WHERE u.organization_id = c.organization_id) AS has_use_cases
         FROM jira_assets_config c
        WHERE c.organization_id = :organizationId
        LIMIT 1;`,
      { replacements: { organizationId }, type: QueryTypes.SELECT },
    )) as Array<{ has_object_type: boolean; has_use_cases: boolean }>;
    const row = rows[0];
    if (!row) return NOT_CONFIGURED;
    if (!row.has_object_type) {
      return { ready: false, status: 400, reason: "No object type selected for sync" };
    }
    if (!row.has_use_cases) {
      return { ready: false, status: 400, reason: "No imported use cases to refresh" };
    }
    return { ready: true };
  }
  const config = await getPublicConfig(organizationId);
  if (!config) return NOT_CONFIGURED;
  if (kind === "manual" && !config.selected_object_type_id) {
    return { ready: false, status: 400, reason: "Select an object type before syncing" };
  }
  return { ready: true };
}

/** Schedule changes need a saved connection (404 otherwise), as PATCH /config/sync always did. */
export async function jiraCanSchedule(organizationId: number): Promise<Readiness> {
  return (await getPublicConfig(organizationId)) ? { ready: true } : NOT_CONFIGURED;
}

function throwIfNotReady(readiness: Readiness): void {
  if (readiness.ready) return;
  if (readiness.status === 404) throw new JiraNotConfiguredError(readiness.reason);
  throw new JiraConfigValidationError(readiness.reason);
}
```

12. **Lines 143-152** (`RunSupersededError` class and doc comment): delete.

13. **Lines 127-141:** replace with

```ts
export const JIRA_NOT_CONFIGURED_MESSAGE =
  "Jira Assets is not configured. Save the connection first.";
export const JIRA_SYNC_IN_PROGRESS_MESSAGE =
  "A Jira Assets sync is already running for this organization";

/** Thrown when a sync or import is already running for the organization. */
export class JiraSyncInProgressError extends Error {
  constructor() {
    super(JIRA_SYNC_IN_PROGRESS_MESSAGE);
    this.name = "JiraSyncInProgressError";
  }
}

/** No Jira connection saved for the organization (404). */
export class JiraNotConfiguredError extends Error {
  constructor(message = JIRA_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "JiraNotConfiguredError";
  }
}
```

14. **Lines 109-110** (`ABANDONED_RUN_MESSAGE` and its comment): delete.

15. **Lines 61-75** (`JiraSyncResult` and `SyncRunType`): replace with

```ts
export const JIRA_ASSETS_KEY = "jira-assets";
/** Every exclusive Jira Assets operation runs under the engine claim as one of these kinds. */
export const JIRA_RUN_KINDS = ["manual", "scheduled", "import", "remove_missing"] as const;
```

16. **Lines 1-17** (imports): replace with

```ts
import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import { encryptText, decryptText } from "../../tools/createSecureValue";
import {
  JiraAssetsClient,
  JiraObject,
  JiraUpstreamError,
  MAX_PAGES,
  PAGE_SIZE,
  WORKER_SYNC_DEADLINE_MS,
} from "./jira.client";
import { transformAttributes } from "./jira.constants";
import { logStructured } from "../../utils/logger/fileLogger";
import { enqueueJiraAssetsSyncRun } from "../../services/automations/automationProducer";
import { SQL_NOW_UTC, sqlWithinLastMinutes } from "../scheduledSync.utils";
import { deleteProjectWithSideEffects } from "../../utils/projectDeletion.utils";
import { withClaim } from "../sync-engine/claim";
import { errorMessage, isUniqueViolation, RunSupersededError } from "../sync-engine/errors";
import { ABANDONED_RUN_MESSAGE, SKIPPED_RUN_MESSAGE } from "../sync-engine/types";
import type { Readiness, RunContext, RunResult } from "../sync-engine/types";

export { ABANDONED_RUN_MESSAGE, errorMessage, RunSupersededError, SKIPPED_RUN_MESSAGE };
```

- [ ] **Step 5: Add the provider and register it**

Create `Servers/extensions/jira-assets/jiraAssets.syncProvider.ts`:

```ts
import type { SyncProvider } from "../sync-engine/types";
import { WORKER_SYNC_DEADLINE_MS } from "./jira.client";
import {
  JIRA_ASSETS_KEY,
  JIRA_RUN_KINDS,
  jiraCanSchedule,
  jiraReadiness,
  runJiraSync,
} from "./jiraAssets.service";

/**
 * Jira Assets on the sync engine. One claim per org covers every exclusive
 * operation: manual and scheduled syncs, import, and removal (remove-missing
 * and the single use-case delete, both recorded as remove_missing).
 */
export const jiraAssetsSyncProvider: SyncProvider = {
  key: JIRA_ASSETS_KEY,
  kinds: JIRA_RUN_KINDS,
  scheduledKind: "scheduled",
  runDeadlineMs: WORKER_SYNC_DEADLINE_MS,
  readiness: jiraReadiness,
  canSchedule: jiraCanSchedule,
  run: runJiraSync,
};
```

In `Servers/extensions/sync-engine/providers.ts`, add `import { jiraAssetsSyncProvider } from "../jira-assets/jiraAssets.syncProvider";` and change `export const SYNC_PROVIDERS: SyncProvider[] = [];` to `export const SYNC_PROVIDERS: SyncProvider[] = [jiraAssetsSyncProvider];`.

- [ ] **Step 6: Map the engine's 409 in the Jira controller**

In `Servers/extensions/jira-assets/jiraAssets.ctrl.ts`:
- add `JIRA_SYNC_IN_PROGRESS_MESSAGE,` to the import list from `"./jiraAssets.service"`, and add `import { SyncInProgressError } from "../sync-engine/errors";` after it;
- in `isExpectedError` add `err instanceof SyncInProgressError ||` after `err instanceof JiraSyncInProgressError ||`;
- in `sendError`, after the `JiraSyncInProgressError` block, add:

```ts
  if (err instanceof SyncInProgressError) {
    // The engine's claim is per extension; keep Jira's own message and shape.
    return res.status(409).json(STATUS_CODE[409](JIRA_SYNC_IN_PROGRESS_MESSAGE));
  }
```

and add ` * - SyncInProgressError (engine claim taken) → 409 with JIRA_SYNC_IN_PROGRESS_MESSAGE` to its doc list after the `JiraSyncInProgressError → 409` line.

- [ ] **Step 7: Retire the Jira scheduler and route the old job names to the engine**

1. Delete `Servers/extensions/jira-assets/jiraAssets.scheduler.ts`.
2. In `Servers/extensions/scheduledSync.utils.ts`, delete lines 31-38 (`sqlIntervalElapsed` and its doc comment).
3. In `Servers/services/automations/automationWorker.ts`, delete lines 45-46 (the `runJiraAssetsScheduledSyncAllOrgs` and `runQueuedSync` imports) and delete these four lines:

```ts
        } else if (name === "jira_assets_scheduled_sync_check") {
          await runJiraAssetsScheduledSyncAllOrgs();
        } else if (name === "jira_assets_sync_run") {
          await runQueuedSync(job.data);
```

   The old names now reach `isExtensionSyncJob` → `handleExtensionSyncJob`, which routes them to the engine.
4. In `Servers/services/automations/automationProducer.ts`, delete `scheduleJiraAssetsScheduledSyncCheck` (lines 429-446), and in `scheduleExtensionSyncTick` insert before `await automationQueue.upsertJobScheduler(`:

```ts
  // The tick replaces the Jira-only check job. Its queued jobs still run (the
  // worker routes the old names to the engine) for one release.
  try {
    await automationQueue.removeJobScheduler("jira_assets_scheduled_sync_check");
  } catch (error) {
    logger.warn(`Could not remove the old Jira Assets check scheduler: ${(error as Error).message}`);
  }
```

5. In `Servers/jobs/producer.ts`, delete `scheduleJiraAssetsScheduledSyncCheck,` (line 30) and line 74 (`await safeSchedule("jira-assets-scheduled-sync-check", ...)`).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd Servers && npx jest -i extensions/jira-assets/__tests__ extensions/sync-engine/__tests__ services/automations/tests/automationProducer.spec.ts`
Expected: PASS. Then `grep -rn "claimSyncRun\|runQueuedSync\|runClaimedSync\|touchHeartbeat\|finalizeFailure\|jiraAssets.scheduler\|scheduleJiraAssetsScheduledSyncCheck\|sqlIntervalElapsed" Servers --include='*.ts' | grep -v node_modules` prints nothing.

- [ ] **Step 9: Build, format and commit**

```bash
cd Servers && npx prettier --write extensions services/automations jobs/producer.ts && npm run build
cd .. && git add -A Servers/extensions Servers/services/automations Servers/jobs/producer.ts
git commit -m "feat(jira-assets): run Jira Assets on the sync engine" -m "jiraAssetsSyncProvider declares the manual, scheduled, import and remove_missing kinds with readiness per kind. The sync body (runJiraSync) runs on the RunContext: ctx.heartbeat replaces touchHeartbeat, ctx.sqlOwnsRun replaces the history-table ownership fragments, and the engine records the outcome. Import, remove-missing and single delete take the engine claim through withClaim; removal and delete still finalize or release inside their data transaction, with the same lock order.

The Jira claim, heartbeat, finalize, scheduler, check job and run-job handler are gone. The worker routes the old jira_assets_* job names to the engine for one release, and the tick's registration retires the old check scheduler."
```

---

### Task 7: Old Jira Assets sync routes on the engine, with their exact shapes

**Files:**
- Modify: `Servers/extensions/jira-assets/jiraAssets.service.ts` (text anchors below; line numbers are from develop `c5d8f439b`)
- Modify: `Servers/extensions/jira-assets/jiraAssets.ctrl.ts` (imports, `isExpectedError`, `sendError`, `patchSyncSettings`, `postSync`, `getSyncStatusCtrl`, `getSyncHistoryCtrl`)
- Modify: `Servers/extensions/scheduledSync.utils.ts` (whole file)
- Modify: `Servers/services/automations/automationProducer.ts:360-394` (Jira queue helpers removed)
- Modify: `Servers/swagger.yaml` (four operations marked deprecated)
- Test: `Servers/extensions/jira-assets/__tests__/jiraAssets.service.test.ts`, `Servers/extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts`, `Servers/services/automations/tests/automationProducer.spec.ts`

**Interfaces:**
- Consumes: `startManualRun` (Task 4), `getRunStatus`, `listRuns`, `parseRunsLimit`, `RunView`, `RunListRow` (Task 5), `saveSchedule`, `parseIntervalHours` (Task 3), `SyncNotReadyError`, `SyncInProgressError`, `SyncValidationError` (Task 2), `jiraCanSchedule`, `throwIfNotReady`, `JIRA_ASSETS_KEY` (Task 6), `hasPendingExtensionSyncJob` (Task 4).
- Produces: `getPublicConfig` derives `sync_enabled`, `sync_interval_hours` and `last_sync_*` from the engine; `getSyncStatus(orgId): Promise<LegacySyncStatus | null>`; `getSyncHistory(orgId, limit): Promise<LegacySyncHistoryRow[]>`; `updateSyncSettings(orgId, body)` (the unused `userId` parameter is dropped); `toLegacyLatestRun(run: RunView)`, `toLegacyHistoryRow(run: RunListRow, orgId)`.
- Removed: `startManualSync`, `hasLiveRun`, `latestSyncRunId`, `sqlLiveRunExists`, `SQL_RUN_IS_LIVE`, `SYNC_STALE_AFTER_MINUTES`, `SYNC_INTERVAL_MIN_HOURS`, `SYNC_INTERVAL_MAX_HOURS`, `JiraSyncInProgressError`, `jiraAssetsSyncJobId`, `hasPendingJiraAssetsSyncJob`, `enqueueJiraAssetsSyncRun`, `sqlWithinLastMinutes`.

Old-shape mapping (spec section 5): `sync_type` = `kind`; `objects_*` from `counts`; `error_message` = `message`; `status`: `completed` → `completed`, `started` → `started`, `failed`/`abandoned`/`skipped` → `failed`; `code` `"abandoned"` or `"skipped"`, else null; `last_sync_*` from the newest finished manual or scheduled run whose status is `completed` or `failed` (`last_sync_at` = its `completed_at`, `last_sync_status` `'success'` or `'failed'`); `sync_enabled` and `sync_interval_hours` from `extension_sync_settings` (`false` and 24 without a row). History rows keep every old `SELECT *` column; `run_token` is always `null` because the token is now the engine's ownership secret and no client reads it. Timestamps are now TIMESTAMPTZ, so `latest_run` times carry an offset (`…+00:00`) instead of a bare UTC wall-clock string; keys and types are unchanged.

- [ ] **Step 1: Write the failing service tests**

In `Servers/extensions/jira-assets/__tests__/jiraAssets.service.test.ts`:

1. In the import list from `"../jiraAssets.service"`: remove `JiraSyncInProgressError`, `startManualSync` and `SQL_RUN_IS_LIVE`; add `getPublicConfig` and `getSyncHistory`. After the other imports add:

```ts
import * as engineSchedule from "../../sync-engine/schedule";
import * as engineStatus from "../../sync-engine/status";
import type { RunView } from "../../sync-engine/status";
```

2. Delete the `import { BackgroundJobsUnavailableError, enqueueJiraAssetsSyncRun } from "../../../services/automations/automationProducer";` block, the `jest.mock("../../../services/automations/automationProducer", ...)` block, `const mockEnqueue = enqueueJiraAssetsSyncRun as jest.Mock;`, and the `mockEnqueue.mockResolvedValue(...)` line in `beforeEach` (the service no longer queues anything).

3. In `fakeDb`, change `if (sql.includes("SELECT id, jira_base_url")) return config ? [config] : [];` to `if (sql.includes("SELECT c.id, c.jira_base_url")) return config ? [config] : [];`.

4. Delete `describe("startManualSync (Sync now queues a job)"` entirely (the engine's `startManualRun` tests and the controller tests cover it).

5. Replace `describe("getSyncStatus"` (lines 1364-1381) and `describe("updateSyncSettings (partial patch)"` (lines 1383-1419) with:

```ts
const runView = (over: Partial<RunView> = {}): RunView => ({
  id: 41,
  kind: "manual",
  status: "completed",
  code: null,
  counts: { fetched: 3, created: 1, updated: 2, deleted: 0 },
  message: null,
  started_at: "2026-10-12T10:00:00.000+00:00",
  completed_at: "2026-10-12T10:01:00.000+00:00",
  is_live: false,
  ...over,
});

describe("legacy GET /sync/status (getSyncStatus)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is null when Jira is not configured", async () => {
    fakeDb({ config: null });
    const spy = jest.spyOn(engineStatus, "getRunStatus");

    await expect(getSyncStatus(5)).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the old shape, with an abandoned run as a failed row coded abandoned", async () => {
    fakeDb({ config: { ...CONFIG_ROW, sync_enabled: true, sync_interval_hours: 6 } });
    jest.spyOn(engineStatus, "getRunStatus").mockResolvedValue({
      schedule: null,
      running: false,
      last_finished_run: null,
      latest_run: runView({ status: "abandoned", code: "abandoned", message: ABANDONED_RUN_MESSAGE }),
    });

    const status = await getSyncStatus(5);

    expect(Object.keys(status!).sort()).toEqual([
      "last_sync_at",
      "last_sync_message",
      "last_sync_status",
      "latest_run",
      "running",
      "sync_enabled",
      "sync_interval_hours",
    ]);
    expect(status!.latest_run).toEqual({
      id: 41,
      sync_type: "manual",
      status: "failed",
      objects_fetched: 3,
      objects_created: 1,
      objects_updated: 2,
      error_message: ABANDONED_RUN_MESSAGE,
      started_at: "2026-10-12T10:00:00.000+00:00",
      completed_at: "2026-10-12T10:01:00.000+00:00",
      is_live: false,
      code: "abandoned",
    });
    expect(status).toMatchObject({ sync_enabled: true, sync_interval_hours: 6, running: false });
    expect(engineStatus.getRunStatus).toHaveBeenCalledWith("jira-assets", 5);
  });

  it("reports a skipped run as a failed row coded skipped, and a completed one uncoded", async () => {
    fakeDb();
    const spy = jest.spyOn(engineStatus, "getRunStatus");
    spy.mockResolvedValueOnce({
      schedule: null,
      running: false,
      last_finished_run: null,
      latest_run: runView({ status: "skipped", code: "skipped", message: SKIPPED_RUN_MESSAGE, counts: {} }),
    });
    expect((await getSyncStatus(5))!.latest_run).toMatchObject({
      status: "failed",
      code: "skipped",
      error_message: SKIPPED_RUN_MESSAGE,
      objects_fetched: 0,
    });

    spy.mockResolvedValueOnce({ schedule: null, running: true, last_finished_run: null, latest_run: runView() });
    expect((await getSyncStatus(5))!.latest_run).toMatchObject({ status: "completed", code: null });
  });
});

describe("legacy GET /sync/history (getSyncHistory)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns rows in the old SELECT * shape, with no token", async () => {
    const at = new Date("2026-10-12T10:00:00Z");
    jest.spyOn(engineStatus, "listRuns").mockResolvedValue([
      { id: 42, kind: "remove_missing", status: "completed", code: null, counts: { deleted: 2 }, message: null, triggered_by: 8, started_at: at, heartbeat_at: at, completed_at: at },
      { id: 41, kind: "manual", status: "skipped", code: "skipped", counts: {}, message: SKIPPED_RUN_MESSAGE, triggered_by: 8, started_at: at, heartbeat_at: null, completed_at: at },
    ]);

    const rows = await getSyncHistory(5, 20);

    expect(engineStatus.listRuns).toHaveBeenCalledWith("jira-assets", 5, 20);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "completed_at",
      "error_message",
      "heartbeat_at",
      "id",
      "objects_created",
      "objects_deleted",
      "objects_fetched",
      "objects_updated",
      "organization_id",
      "run_token",
      "started_at",
      "status",
      "sync_type",
      "triggered_by",
    ]);
    expect(rows[0]).toMatchObject({
      organization_id: 5,
      sync_type: "remove_missing",
      status: "completed",
      objects_deleted: 2,
      run_token: null,
    });
    expect(rows[1]).toMatchObject({ status: "failed", error_message: SKIPPED_RUN_MESSAGE });
  });
});

describe("GET /config last_sync_* (getPublicConfig)", () => {
  it("derives the schedule and last_sync_* from the engine", async () => {
    mockQuery.mockResolvedValue([{ id: 1 }]);

    await getPublicConfig(5);

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("LEFT JOIN extension_sync_settings s");
    expect(sql).toContain("COALESCE(s.enabled, FALSE) AS sync_enabled");
    expect(sql).toContain("r.kind IN ('manual', 'scheduled') AND r.status IN ('completed', 'failed')");
    expect(sql).toContain("ORDER BY r.completed_at DESC, r.id DESC");
    expect(sql).toContain("WHEN 'completed' THEN 'success'");
    expect(sql).not.toMatch(/c\.last_sync_|c\.sync_enabled|c\.sync_interval_hours/);
    expect(options.replacements).toEqual({ organizationId: 5, key: "jira-assets", defaultInterval: 24 });
  });
});

describe("legacy PATCH /config/sync (updateSyncSettings)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("saves the fields sent in the engine schedule and answers in the old shape", async () => {
    fakeDb();
    const save = jest.spyOn(engineSchedule, "saveSchedule").mockResolvedValue({
      enabled: true,
      interval_hours: 24,
      consecutive_failures: 0,
      failing_since: null,
    });

    await expect(updateSyncSettings(5, { sync_enabled: true })).resolves.toEqual({
      sync_enabled: true,
      sync_interval_hours: 24,
    });
    expect(save).toHaveBeenCalledWith("jira-assets", 5, { enabled: true, intervalHours: undefined });
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("validates the input before touching the database", async () => {
    await expect(updateSyncSettings(5, { sync_interval_hours: 0 })).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    await expect(updateSyncSettings(5, {})).rejects.toBeInstanceOf(JiraConfigValidationError);
    await expect(updateSyncSettings(5, { sync_enabled: "on" })).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reports a missing config instead of creating a schedule", async () => {
    fakeDb({ config: null });
    const save = jest.spyOn(engineSchedule, "saveSchedule");

    await expect(updateSyncSettings(5, { sync_interval_hours: 6 })).rejects.toBeInstanceOf(
      JiraNotConfiguredError,
    );
    expect(save).not.toHaveBeenCalled();
  });
});
```

6. In `describe("saveConfig validation"`, replace the test `it("saves a valid interval"` with:

```ts
  it("writes the connection without sync columns and the schedule through the engine", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]).mockResolvedValue([]);
    const save = jest.spyOn(engineSchedule, "saveSchedule").mockResolvedValue({
      enabled: true,
      interval_hours: 6,
      consecutive_failures: 0,
      failing_since: null,
    });

    await saveConfig(5, 3, { ...base, sync_enabled: true, sync_interval_hours: 6 });

    const [updateSql, update] = mockQuery.mock.calls[1];
    expect(updateSql).not.toContain("sync_enabled");
    expect(update.replacements).not.toHaveProperty("syncEnabled");
    expect(save).toHaveBeenCalledWith("jira-assets", 5, { enabled: true, intervalHours: 6 });
    save.mockRestore();
  });

  it("leaves the schedule alone when the body has no sync fields", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]).mockResolvedValue([]);
    const save = jest.spyOn(engineSchedule, "saveSchedule");

    await saveConfig(5, 3, base);

    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
```

- [ ] **Step 2: Write the failing controller and producer tests**

In `Servers/extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts`:

1. At the top add:

```ts
jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../../sync-engine/jobs", () => ({ startManualRun: jest.fn() }));
```

2. In the `jest.mock("../jiraAssets.service", ...)` factory: delete `class JiraSyncInProgressError extends Error {}`, `JiraSyncInProgressError,` and `startManualSync: jest.fn(),`; add `getSyncHistory: jest.fn(),`, `updateSyncSettings: jest.fn(),` and `JIRA_ASSETS_KEY: "jira-assets",`.
3. Change the producer mock to `return { BackgroundJobsUnavailableError, hasPendingExtensionSyncJob: jest.fn() };`.
4. Imports: from `"../jiraAssets.ctrl"` add `getSyncHistoryCtrl`; from the producer import `hasPendingExtensionSyncJob` instead of `hasPendingJiraAssetsSyncJob`; from `"../jiraAssets.service"` remove `JiraSyncInProgressError` and `startManualSync`, add `getSyncHistory`; change the engine errors import to `import { SyncInProgressError, SyncNotReadyError } from "../../sync-engine/errors";` and add `import { startManualRun } from "../../sync-engine/jobs";`.
5. Replace `describe("POST /sync (Sync now)"` (lines 108-168) with:

```ts
describe("POST /sync (Sync now, deprecated)", () => {
  it("starts the engine's manual run: 202 with the job id and the newest run before it", async () => {
    (startManualRun as jest.Mock).mockResolvedValue({
      jobId: "ext-sync-jira-assets-5",
      previousRunId: 40,
    });
    const res = mockRes();

    await postSync(req, res);

    expect(startManualRun).toHaveBeenCalledWith("jira-assets", 5, 8);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      message: "Accepted",
      data: { jobId: "ext-sync-jira-assets-5", previousRunId: 40 },
    });
  });

  it("returns 503 when the queue does not answer", async () => {
    (startManualRun as jest.Mock).mockRejectedValue(
      new BackgroundJobsUnavailableError("Background jobs are unavailable"),
    );
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      message: "Service Unavailable",
      error: "Background jobs are unavailable",
    });
  });

  it.each([
    [
      new SyncNotReadyError(404, "Jira Assets is not configured. Save the connection first."),
      404,
      "Jira Assets is not configured. Save the connection first.",
    ],
    [
      new SyncNotReadyError(400, "Select an object type before syncing"),
      400,
      "Select an object type before syncing",
    ],
    [new SyncInProgressError(), 409, "A Jira Assets sync is already running for this organization"],
  ])("keeps the old status and reason for %p", async (err, status, reason) => {
    (startManualRun as jest.Mock).mockRejectedValue(err);
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json.mock.calls[0][0].data).toBe(reason);
  });

  it("hides unexpected errors behind a 500", async () => {
    (startManualRun as jest.Mock).mockRejectedValue(new Error("pool exhausted"));
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: "Internal Server Error",
      error: "Something went wrong",
    });
  });
});

describe("GET /sync/history (deprecated)", () => {
  it.each([
    [undefined, 20],
    ["7", 7],
    ["-5", 20],
    ["500", 200],
  ])("parses limit %p as %p", async (limit, expected) => {
    (getSyncHistory as jest.Mock).mockResolvedValue([]);
    const res = mockRes();

    await getSyncHistoryCtrl({ ...req, query: limit === undefined ? {} : { limit } }, res);

    expect(getSyncHistory).toHaveBeenCalledWith(5, expected);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

6. In `describe("GET /sync/status"`, replace `hasPendingJiraAssetsSyncJob` with `hasPendingExtensionSyncJob` (both tests) and add `expect(hasPendingExtensionSyncJob).toHaveBeenCalledWith("jira-assets", 5);` after `await getSyncStatusCtrl(req, res);` in the first test.
7. Delete the test `it("returns 409 while a sync is running"` in `describe("POST /import"` (Task 6's engine-409 test replaces it), and replace the remaining `new JiraSyncInProgressError("running")` (the remove-missing and delete tests) with `new SyncInProgressError()`.

In `Servers/services/automations/tests/automationProducer.spec.ts`: remove `enqueueJiraAssetsSyncRun,` and `hasPendingJiraAssetsSyncJob,` from the imports; in `describe("enqueueJiraAssetsSyncRun"` rename it to `describe("enqueueExtensionSyncRun (one job per extension and org)"`, set `const payload = { key: "jira-assets", orgId: 5, kind: "scheduled", triggeredBy: null, payload: null };`, and replace in that block every `enqueueJiraAssetsSyncRun(` with `enqueueExtensionSyncRun(`, `"jira-assets-sync-5"` with `"ext-sync-jira-assets-5"`, `"jira_assets_sync_run"` with `"extension_sync_run"`, and `hasPendingJiraAssetsSyncJob(5)` with `hasPendingExtensionSyncJob("jira-assets", 5)`. Then delete the now-duplicate tests `it("queues one attempt of extension_sync_run under that id, removed when done"` and `it("does not queue a second job while one is waiting"` from `describe("extension sync engine jobs"`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd Servers && npx jest -i extensions/jira-assets/__tests__/jiraAssets.service.test.ts extensions/jira-assets/__tests__/jiraAssets.ctrl.test.ts services/automations/tests/automationProducer.spec.ts`
Expected: FAIL: `getSyncHistory`/`getSyncStatus` return the old table's shape, `startManualRun` is never called by `postSync`, and `hasPendingExtensionSyncJob` is never called.

- [ ] **Step 4: Rework the service**

In `Servers/extensions/jira-assets/jiraAssets.service.ts`:

1. Imports: replace

```ts
import { enqueueJiraAssetsSyncRun } from "../../services/automations/automationProducer";
import { SQL_NOW_UTC, sqlWithinLastMinutes } from "../scheduledSync.utils";
```

with

```ts
import { SQL_NOW_UTC } from "../scheduledSync.utils";
```

and replace

```ts
import { errorMessage, isUniqueViolation, RunSupersededError } from "../sync-engine/errors";
import { ABANDONED_RUN_MESSAGE, SKIPPED_RUN_MESSAGE } from "../sync-engine/types";
import type { Readiness, RunContext, RunResult } from "../sync-engine/types";
```

with

```ts
import {
  errorMessage,
  isUniqueViolation,
  RunSupersededError,
  SyncValidationError,
} from "../sync-engine/errors";
import { parseIntervalHours, saveSchedule } from "../sync-engine/schedule";
import { getRunStatus, listRuns, type RunListRow, type RunView } from "../sync-engine/status";
import { ABANDONED_RUN_MESSAGE, SKIPPED_RUN_MESSAGE } from "../sync-engine/types";
import type { Readiness, RunContext, RunResult, RunStatus } from "../sync-engine/types";
```

2. Replace the block from `/** Bounds for \`sync_interval_hours\`; mirrors jira_assets_config_sync_interval_range_chk. */` (line 77) through the end of `sqlLiveRunExists` (line 107) with:

```ts
/** `sync_interval_hours` when POST /config leaves it out. */
const DEFAULT_SYNC_INTERVAL_HOURS = 24;
/** A run heartbeats every this many objects, and after every fetched page. */
export const HEARTBEAT_EVERY_OBJECTS = 25;
```

3. Delete the `JiraSyncInProgressError` class and its doc comment (keep `JIRA_SYNC_IN_PROGRESS_MESSAGE`).

4. Replace `parseSyncIntervalHours` (and its doc comment) with:

```ts
/**
 * Validate `sync_interval_hours` from a request body. Missing → default (24).
 * Otherwise the engine's rule (whole hours from 1 to 168; numeric strings are
 * accepted because the old panel's select handed one back), reported as a
 * Jira validation error (400).
 */
export function parseSyncIntervalHours(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SYNC_INTERVAL_HOURS;
  try {
    return parseIntervalHours(raw);
  } catch (err) {
    if (err instanceof SyncValidationError) throw new JiraConfigValidationError(err.message);
    throw err;
  }
}
```

5. Replace the body of `getPublicConfig` with:

```ts
export async function getPublicConfig(organizationId: number): Promise<JiraAssetsConfigRow | null> {
  // The schedule and the last-sync fields come from the sync engine. last_sync_*
  // is the newest finished manual or scheduled run that completed or failed;
  // abandoned and skipped runs never replace it, as before.
  const rows = (await sequelize.query(
    `SELECT c.id, c.jira_base_url, c.workspace_id, c.email, c.deployment_type,
            c.selected_schema_id, c.selected_object_type_id,
            COALESCE(s.enabled, FALSE) AS sync_enabled,
            COALESCE(s.interval_hours, :defaultInterval) AS sync_interval_hours,
            lf.completed_at AS last_sync_at,
            CASE lf.status WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'failed' END
              AS last_sync_status,
            lf.message AS last_sync_message,
            CASE WHEN c.api_token_encrypted IS NOT NULL AND c.api_token_encrypted <> ''
                 THEN TRUE ELSE FALSE END AS has_api_token
       FROM jira_assets_config c
       LEFT JOIN extension_sync_settings s
         ON s.organization_id = c.organization_id AND s.extension_key = :key
       LEFT JOIN LATERAL (
         SELECT r.status, r.message, r.completed_at
           FROM extension_sync_runs r
          WHERE r.organization_id = c.organization_id AND r.extension_key = :key
            AND r.kind IN ('manual', 'scheduled') AND r.status IN ('completed', 'failed')
          ORDER BY r.completed_at DESC, r.id DESC
          LIMIT 1
       ) lf ON TRUE
      WHERE c.organization_id = :organizationId
      LIMIT 1;`,
    {
      replacements: {
        organizationId,
        key: JIRA_ASSETS_KEY,
        defaultInterval: DEFAULT_SYNC_INTERVAL_HOURS,
      },
      type: QueryTypes.SELECT,
    },
  )) as JiraAssetsConfigRow[];
  return rows[0] ?? null;
}
```

6. In `loadFullConfig`, delete the two lines `    sync_enabled: row.sync_enabled,` and `    sync_interval_hours: row.sync_interval_hours,`.

7. In `saveConfig`: delete `    syncEnabled: body.sync_enabled ?? false,` and `    syncIntervalHours,` from `commonReplacements`; delete the line `                sync_enabled = :syncEnabled, sync_interval_hours = :syncIntervalHours,` from both `UPDATE jira_assets_config` statements; in the `INSERT INTO jira_assets_config` change `          sync_enabled, sync_interval_hours, created_by)` to `          created_by)` and `               :syncEnabled, :syncIntervalHours, :userId);` to `               :userId);`; and after the closing `}` of the `if (row) { … } else { … }` add:

```ts

  // The schedule lives in the sync engine. A body that carries the sync fields
  // still sets them, as POST /config always did; one that leaves both out keeps
  // the schedule as it is (the panel no longer sends them here).
  if (body.sync_enabled !== undefined || body.sync_interval_hours !== undefined) {
    await saveSchedule(JIRA_ASSETS_KEY, organizationId, {
      enabled: body.sync_enabled ?? false,
      intervalHours: syncIntervalHours,
    });
  }
```

8. Replace `updateSyncSettings` (and its doc comment) with:

```ts
/**
 * PATCH /config/sync (deprecated): change only the automatic-sync settings,
 * now kept by the sync engine. At least one field; 404 when no connection is
 * saved yet. Answers in the old shape.
 */
export async function updateSyncSettings(
  organizationId: number,
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
  const interval = hasInterval ? parseSyncIntervalHours(body.sync_interval_hours) : undefined;
  throwIfNotReady(await jiraCanSchedule(organizationId));
  const saved = await saveSchedule(JIRA_ASSETS_KEY, organizationId, {
    enabled: hasEnabled ? (body.sync_enabled as boolean) : undefined,
    intervalHours: interval,
  });
  return { sync_enabled: saved.enabled, sync_interval_hours: saved.interval_hours };
}
```

9. Delete `hasLiveRun`, `latestSyncRunId` and `startManualSync` with their doc comments (from `/** A live \`started\` run exists for the organization. */` through the end of `startManualSync`).

10. Replace the section from `// Sync status + history` (its comment banner) through the end of `getSyncHistory` with:

```ts
// ---------------------------------------------------------------------------
// Sync status + history: the old response shapes, served by the sync engine
// ---------------------------------------------------------------------------

/** One row of the old GET /sync/history (`SELECT *` on jira_assets_sync_history). */
export interface LegacySyncHistoryRow {
  id: number;
  organization_id: number;
  sync_type: string;
  status: "started" | "completed" | "failed";
  objects_fetched: number;
  objects_created: number;
  objects_updated: number;
  objects_deleted: number;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
  triggered_by: number | null;
  heartbeat_at: Date | null;
  /** Always null: the token is the engine's ownership secret. */
  run_token: null;
}

/** `latest_run` of the old GET /sync/status. */
export interface LegacyLatestRun {
  id: number;
  sync_type: string;
  status: "started" | "completed" | "failed";
  objects_fetched: number;
  objects_created: number;
  objects_updated: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  is_live: boolean;
  code: "abandoned" | "skipped" | null;
}

export interface LegacySyncStatus {
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  sync_enabled: boolean;
  sync_interval_hours: number;
  running: boolean;
  latest_run: LegacyLatestRun | null;
}

/** Abandoned and skipped runs were `failed` history rows. */
function legacyStatus(status: RunStatus): "started" | "completed" | "failed" {
  return status === "started" || status === "completed" ? status : "failed";
}

function legacyCode(status: RunStatus): "abandoned" | "skipped" | null {
  if (status === "abandoned") return JIRA_RUN_CODES.abandoned;
  if (status === "skipped") return JIRA_RUN_CODES.skipped;
  return null;
}

function countOf(counts: Record<string, number> | null | undefined, name: string): number {
  const value = counts?.[name];
  return typeof value === "number" ? value : 0;
}

export function toLegacyLatestRun(run: RunView): LegacyLatestRun {
  return {
    id: run.id,
    sync_type: run.kind,
    status: legacyStatus(run.status),
    objects_fetched: countOf(run.counts, "fetched"),
    objects_created: countOf(run.counts, "created"),
    objects_updated: countOf(run.counts, "updated"),
    error_message: run.message,
    started_at: run.started_at,
    completed_at: run.completed_at,
    is_live: run.is_live,
    code: legacyCode(run.status),
  };
}

export function toLegacyHistoryRow(run: RunListRow, organizationId: number): LegacySyncHistoryRow {
  return {
    id: run.id,
    organization_id: organizationId,
    sync_type: run.kind,
    status: legacyStatus(run.status),
    objects_fetched: countOf(run.counts, "fetched"),
    objects_created: countOf(run.counts, "created"),
    objects_updated: countOf(run.counts, "updated"),
    objects_deleted: countOf(run.counts, "deleted"),
    error_message: run.message,
    started_at: run.started_at,
    completed_at: run.completed_at,
    triggered_by: run.triggered_by,
    heartbeat_at: run.heartbeat_at,
    run_token: null,
  };
}

/**
 * GET /sync/status (deprecated) in its old shape: last_sync_* and the schedule
 * (as GET /config derives them), `running`, and the newest manual or scheduled
 * run (`latest_run`, `code` "abandoned" or "skipped"). Null when Jira is not
 * configured. The controller adds `queued`.
 */
export async function getSyncStatus(organizationId: number): Promise<LegacySyncStatus | null> {
  const config = await getPublicConfig(organizationId);
  if (!config) return null;
  const status = await getRunStatus(JIRA_ASSETS_KEY, organizationId);
  return {
    last_sync_at: config.last_sync_at,
    last_sync_status: config.last_sync_status,
    last_sync_message: config.last_sync_message,
    sync_enabled: config.sync_enabled,
    sync_interval_hours: config.sync_interval_hours,
    running: status.running,
    latest_run: status.latest_run ? toLegacyLatestRun(status.latest_run) : null,
  };
}

/** GET /sync/history (deprecated): every Jira Assets run, newest first, in the old row shape. */
export async function getSyncHistory(
  organizationId: number,
  limit: number,
): Promise<LegacySyncHistoryRow[]> {
  const runs = await listRuns(JIRA_ASSETS_KEY, organizationId, limit);
  return runs.map((run) => toLegacyHistoryRow(run, organizationId));
}
```

- [ ] **Step 5: Rework the controller**

In `Servers/extensions/jira-assets/jiraAssets.ctrl.ts`:

1. Replace the producer import with

```ts
import {
  BackgroundJobsUnavailableError,
  hasPendingExtensionSyncJob,
} from "../../services/automations/automationProducer";
```

   In the `"./jiraAssets.service"` import list remove `JiraSyncInProgressError` and `startManualSync`, and add `JIRA_ASSETS_KEY`. Replace `import { SyncInProgressError } from "../sync-engine/errors";` with:

```ts
import { SyncInProgressError, SyncNotReadyError } from "../sync-engine/errors";
import { startManualRun } from "../sync-engine/jobs";
import { parseRunsLimit } from "../sync-engine/status";
```

2. In `isExpectedError`, replace `err instanceof JiraSyncInProgressError ||` with `err instanceof SyncNotReadyError ||`.
3. In `sendError`, delete the `if (err instanceof JiraSyncInProgressError) { … }` block and its ` * - JiraSyncInProgressError → 409` doc line; add ` * - SyncNotReadyError (Jira readiness for "Sync now") → its status (404 or 400) with the reason` to the doc list and, as the first check in the function:

```ts
  if (err instanceof SyncNotReadyError) {
    return res.status(err.status).json(STATUS_CODE[err.status](err.message));
  }
```

4. In `patchSyncSettings`, change `await updateSyncSettings(orgId(req), uid(req), req.body ?? {})` to `await updateSyncSettings(orgId(req), req.body ?? {})`, and add `Deprecated: the panel uses PATCH /api/extensions/jira-assets/schedule.` to its doc comment.
5. Replace `postSync` and its doc comment with:

```ts
/**
 * POST /sync (deprecated) — "Sync now", served by the sync engine's manual
 * run with the old responses: 202 `{ jobId, previousRunId }`; 404 / 400 from
 * Jira's readiness; 409 if a run is live or a job is already waiting; 503 if
 * the queue does not answer. The panel uses POST /api/extensions/jira-assets/runs.
 */
export async function postSync(req: Request, res: Response): Promise<any> {
  try {
    const started = await startManualRun(JIRA_ASSETS_KEY, orgId(req), uid(req));
    return res.status(202).json(STATUS_CODE[202](started));
  } catch (err) {
    return sendError(req, res, err, "postSync");
  }
}
```

6. In `getSyncStatusCtrl`, change `queued = await hasPendingJiraAssetsSyncJob(orgId(req));` to `queued = await hasPendingExtensionSyncJob(JIRA_ASSETS_KEY, orgId(req));` and add `(deprecated: the panel uses GET /api/extensions/jira-assets/runs/status)` to its doc comment.
7. In `getSyncHistoryCtrl`, change `const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);` to `const limit = parseRunsLimit(req.query?.limit);` (a negative limit used to reach SQL and fail with 500).

- [ ] **Step 6: Trim the leftovers**

Replace `Servers/extensions/scheduledSync.utils.ts` with:

```ts
/**
 * SQL building block for Jira Assets' TIMESTAMP WITHOUT TIME ZONE columns
 * (`jira_assets_use_cases.missing_in_jira_since`), which hold UTC wall-clock
 * time. Run claims, history and schedules moved to the sync engine
 * (extensions/sync-engine, TIMESTAMPTZ); see the "Scheduled sync" section of
 * docs/technical/infrastructure/extensions.md.
 */

/** Current time as a UTC TIMESTAMP WITHOUT TIME ZONE. */
export const SQL_NOW_UTC = "(NOW() AT TIME ZONE 'UTC')";
```

In `Servers/services/automations/automationProducer.ts`, delete `jiraAssetsSyncJobId` and its comment, `hasPendingJiraAssetsSyncJob` and its comment, and `enqueueJiraAssetsSyncRun` with its doc comment (the block from `/** One Jira Assets sync job per org at a time` through the end of `enqueueJiraAssetsSyncRun`, keeping `PENDING_JOB_STATES`).

- [ ] **Step 7: Mark the old routes deprecated in swagger**

In `Servers/swagger.yaml`, under each of these four operations add `      deprecated: true` right after its `summary:` line, and start its `description:` with `Deprecated, kept for one release: use <new route>. `:

| Operation (anchor) | New route named in the description |
|---|---|
| `/extensions/jira-assets/sync:` → `post:` → `summary: 'Post Sync'` | `POST /extensions/{key}/runs` |
| `/extensions/jira-assets/sync/status:` → `get:` → `summary: 'Get Sync Status Ctrl'` | `GET /extensions/{key}/runs/status` |
| `/extensions/jira-assets/sync/history:` → `get:` → `summary: 'Get Sync History Ctrl'` | `GET /extensions/{key}/runs` |
| `/extensions/jira-assets/config/sync:` → `patch:` → `summary: 'Patch Sync Settings'` | `PATCH /extensions/{key}/schedule` |

For example the first becomes:

```yaml
  /extensions/jira-assets/sync:
    post:
      summary: 'Post Sync'
      deprecated: true
```

with `description: 'Deprecated, kept for one release: use POST /extensions/{key}/runs. Starts a manual sync in the background. Requires the jira-assets extension to be enabled for the organization and the extension.admin permission (Admin); 403 otherwise.'`. For the two GET operations, whose descriptions are `'Requires the jira-assets extension to be enabled for the organization (403 otherwise).'`, prefix the same way.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd Servers && npx jest -i extensions/jira-assets/__tests__ extensions/sync-engine/__tests__ services/automations/tests/automationProducer.spec.ts`
Expected: PASS. Then `grep -rn "jira_assets_sync_history\|JiraSyncInProgressError\|startManualSync\|hasPendingJiraAssetsSyncJob\|enqueueJiraAssetsSyncRun\|sqlWithinLastMinutes" Servers --include='*.ts' | grep -v node_modules` prints nothing.

- [ ] **Step 9: Build, format and commit**

```bash
cd Servers && npx prettier --write extensions services/automations swagger.yaml && npm run build
cd .. && git add Servers/extensions Servers/services/automations Servers/swagger.yaml
git commit -m "feat(jira-assets): serve the old sync routes from the sync engine" -m "POST /sync, GET /sync/status, GET /sync/history and PATCH /config/sync keep their URLs and response shapes, now backed by the engine's manual run, run history and schedule: kind becomes sync_type, counts become objects_*, abandoned and skipped runs are failed rows coded abandoned/skipped. GET /config derives sync_enabled, sync_interval_hours and last_sync_* (newest finished manual or scheduled run that completed or failed) from the engine. POST /config writes the schedule only when the body carries sync fields. History limits are parsed defensively. The four routes are marked deprecated in swagger."
```

---

### Task 8: Tenant isolation for the engine tables and routes

**Files:**
- Modify: `Servers/tests/integration/tenant-isolation/tenantIsolation.registry.ts` (after the `data_retention` entry, around line 146)
- Modify: `Servers/scripts/auditTenantIsolationCoverage.ts:134-137` (`jira_assets_sync_history` justification)
- Create: `Servers/tests/integration/tenant-isolation/extensionRuns.isolation.test.ts`

**Interfaces:**
- Consumes: `seedTwoTenantContexts`, `buildTenantContext` (harness), `cleanupDatabase` (`tests/integration/helpers.ts`), the routes from Task 5, `jiraCanSchedule` (Task 6, via `PATCH /:key/schedule`).
- Produces: registry entity `extension_sync` covering `extension_sync_runs` and `extension_sync_settings`.

The integration suite needs `Servers/.env.test` pointing at a test database (`tests/testDatabaseGuard.js` refuses the dev database). If none is set up locally, push the branch and read the result of CI's backend-checks job for the integration and audit steps; do not tick those steps without a real run.

- [ ] **Step 1: Write the isolation test**

Create `Servers/tests/integration/tenant-isolation/extensionRuns.isolation.test.ts`:

```ts
jest.setTimeout(60000);

import { QueryTypes } from "sequelize";
import { sequelize } from "../../../database/db";
import { cleanupDatabase, seedTwoOrgsAndUsers } from "../helpers";
import { buildTenantContext, seedTwoTenantContexts } from "./tenantIsolation.harness";

/**
 * Sync engine tables (extension_sync_runs, extension_sync_settings) and the
 * generic /api/extensions/:key/runs… and /:key/schedule routes. The CRUD
 * matrix is id-based and these routes are keyed by the extension key, so this
 * file covers them by hand.
 */

async function enableJiraAssets(orgId: number, userId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO extension_enablements (organization_id, extension_id, enabled, enabled_at, enabled_by)
     SELECT :orgId, e.id, TRUE, now(), :userId FROM extensions e WHERE e.key = 'jira-assets'
     ON CONFLICT (organization_id, extension_id) DO UPDATE SET enabled = TRUE, enabled_at = now();`,
    { replacements: { orgId, userId } },
  );
}

async function seedOwnerSync(orgId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO extension_sync_settings
       (organization_id, extension_key, enabled, interval_hours, consecutive_failures, failing_since)
     VALUES (:orgId, 'jira-assets', TRUE, 6, 2, now() - interval '1 hour');`,
    { replacements: { orgId } },
  );
  await sequelize.query(
    `INSERT INTO extension_sync_runs
       (organization_id, extension_key, kind, status, counts, message, run_token,
        started_at, completed_at)
     VALUES (:orgId, 'jira-assets', 'manual', 'completed', jsonb_build_object('fetched', 3),
             'owner run', 'owner-token', now() - interval '5 minutes', now());`,
    { replacements: { orgId } },
  );
}

async function count(table: string, orgId: number): Promise<number> {
  const [row] = await sequelize.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = :orgId`,
    { replacements: { orgId }, type: QueryTypes.SELECT },
  );
  return Number(row.n);
}

describe("extension sync tables tenant isolation", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  it("does not return org A rows when reading as org B", async () => {
    const { orgA, orgB } = await seedTwoOrgsAndUsers();
    await seedOwnerSync(orgA);

    for (const table of ["extension_sync_settings", "extension_sync_runs"]) {
      expect(await count(table, orgA)).toBe(1);
      expect(await count(table, orgB)).toBe(0);
    }
  });
});

describe("extension sync routes tenant isolation", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  it("shows org B none of org A's runs, schedule or failure streak", async () => {
    const { owner, attacker } = await seedTwoTenantContexts();
    const [catalog] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM extensions WHERE key = 'jira-assets'`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(catalog.n)).toBe(1);
    await enableJiraAssets(owner.orgId, owner.userId);
    await enableJiraAssets(attacker.orgId, attacker.userId);
    await seedOwnerSync(owner.orgId);

    const ownerStatus = await owner.request.get("/api/extensions/jira-assets/runs/status");
    expect(ownerStatus.status).toBe(200);
    expect(ownerStatus.body.data.latest_run).toMatchObject({
      kind: "manual",
      status: "completed",
      message: "owner run",
    });
    expect(ownerStatus.body.data.schedule).toMatchObject({
      enabled: true,
      interval_hours: 6,
      consecutive_failures: 2,
    });

    const attackerStatus = await attacker.request.get("/api/extensions/jira-assets/runs/status");
    expect(attackerStatus.status).toBe(200);
    expect(attackerStatus.body.data).toMatchObject({
      schedule: null,
      running: false,
      latest_run: null,
      last_finished_run: null,
    });

    const ownerRuns = await owner.request.get("/api/extensions/jira-assets/runs");
    expect(ownerRuns.body.data).toHaveLength(1);
    expect(ownerRuns.body.data[0]).not.toHaveProperty("run_token");
    const attackerRuns = await attacker.request.get("/api/extensions/jira-assets/runs");
    expect(attackerRuns.status).toBe(200);
    expect(attackerRuns.body.data).toEqual([]);
  });

  it("does not let org B change org A's schedule", async () => {
    const { owner, attacker } = await seedTwoTenantContexts();
    await enableJiraAssets(owner.orgId, owner.userId);
    await enableJiraAssets(attacker.orgId, attacker.userId);
    await seedOwnerSync(owner.orgId);
    await sequelize.query(
      `INSERT INTO jira_assets_config
         (organization_id, jira_base_url, workspace_id, email, api_token_encrypted, api_token_iv)
       VALUES (:orgId, 'https://b.atlassian.net', 'w', 'b@example.com', 'enc', 'iv');`,
      { replacements: { orgId: attacker.orgId } },
    );

    const patch = await attacker.request
      .patch("/api/extensions/jira-assets/schedule")
      .send({ enabled: false, interval_hours: 12 });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ enabled: false, interval_hours: 12 });

    const rows = await sequelize.query<{ organization_id: number; enabled: boolean; interval_hours: number }>(
      `SELECT organization_id, enabled, interval_hours FROM extension_sync_settings
        WHERE extension_key = 'jira-assets' ORDER BY organization_id`,
      { type: QueryTypes.SELECT },
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { organization_id: owner.orgId, enabled: true, interval_hours: 6 },
        { organization_id: attacker.orgId, enabled: false, interval_hours: 12 },
      ]),
    );
  });

  it("keeps the schedule when an Editor tries to change it", async () => {
    const editor = await buildTenantContext(3);
    await enableJiraAssets(editor.orgId, editor.userId);

    const res = await editor.request.patch("/api/extensions/jira-assets/schedule").send({ enabled: true });
    expect(res.status).toBe(403);
    expect(await count("extension_sync_settings", editor.orgId)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the coverage test to verify it fails**

Run: `cd Servers && npx jest -i tests/integration/tenant-isolation/tenantIsolation.coverage.test.ts`
Expected: PASS for the existing entries; the new file is not yet referenced. Then run the audit against a migrated test database: `cd Servers && npx ts-node scripts/auditTenantIsolationCoverage.ts`
Expected: FAIL (exit 1) naming `extension_sync_runs` and `extension_sync_settings` as uncovered scoped tables.

- [ ] **Step 3: Register the tables and update the audit allow-list**

In `Servers/tests/integration/tenant-isolation/tenantIsolation.registry.ts`, after the `data_retention` entry add:

```ts
  {
    // Sync engine runs and schedules. The routes are keyed by extension key
    // (/api/extensions/:key/runs…), not by row id, so a hand-written file covers them.
    name: "extension_sync",
    tables: ["extension_sync_runs", "extension_sync_settings"],
    baseRoute: "/api/extensions/:key/runs",
    testFile: "extensionRuns.isolation.test.ts",
  },
```

In `Servers/scripts/auditTenantIsolationCoverage.ts`, replace the `jira_assets_sync_history` justification with:

```ts
    justification:
      "Extension-owned table (jira-assets), no longer written or read: the sync engine's extension_sync_runs replaced it (migration 20261012200000 copied every row with its organization_id). Kept for one release so a rollback restores the old behaviour; a follow-up migration drops it.",
```

- [ ] **Step 4: Run the isolation tests and the audit**

Run: `cd Servers && npx jest -i tests/integration/tenant-isolation/tenantIsolation.coverage.test.ts && node --max-old-space-size=8192 node_modules/jest/bin/jest.js --config jest.config.js --globalSetup="<rootDir>/tests/integration/globalSetup.js" --runInBand tests/integration/tenant-isolation/extensionRuns.isolation.test.ts && npx ts-node scripts/auditTenantIsolationCoverage.ts`
Expected: PASS (coverage, 4 isolation tests), and the audit exits 0.

- [ ] **Step 5: Format and commit**

```bash
cd Servers && npx prettier --write tests/integration/tenant-isolation scripts/auditTenantIsolationCoverage.ts
cd .. && git add Servers/tests/integration/tenant-isolation Servers/scripts/auditTenantIsolationCoverage.ts
git commit -m "test(sync-engine): tenant isolation for sync runs and schedules" -m "Registers extension_sync_runs and extension_sync_settings and covers the key-addressed routes by hand: org B sees none of org A's runs, schedule or failure streak, cannot change org A's schedule, and an Editor cannot change a schedule. The jira_assets_sync_history allow-list entry now says the table is no longer written."
```

---

### Task 9: Client repository and `useExtensionSync` hook

**Files:**
- Create: `Clients/src/application/repository/extensionSync.repository.ts`
- Create: `Clients/src/application/hooks/useExtensionSync.ts`
- Test: `Clients/src/application/hooks/__tests__/useExtensionSync.test.ts`

**Interfaces:**
- Consumes: `GET /api/extensions/:key/runs/status`, `POST /api/extensions/:key/runs`, `PATCH /api/extensions/:key/schedule` (Task 5); `apiServices` (throws `CustomException` with `.status`).
- Produces:
  - Repository: `type ExtensionRunStatus`, `interface ExtensionRun`, `interface ExtensionSchedule`, `interface ExtensionSyncStatus`, `interface SchedulePatch`, `getExtensionSyncStatus(key, signal?)`, `startExtensionRun(key)`, `updateExtensionSchedule(key, patch)`.
  - Hook: `SYNC_POLL_MS = 3000`, `SYNC_POLL_LIMIT_MS = 1200000`, `NOT_STARTED_AFTER_POLLS = 3`, `type SyncNowOutcome = { kind: "refused"; error } | { kind: "done"; run } | { kind: "stalled" } | { kind: "not_started" } | { kind: "timeout" } | { kind: "unmounted" }`, `interface ScheduleState { enabled; interval_hours }`, `extensionSyncStatusKey(key)`, `decidePoll(status, previousRunId, idlePolls): PollStep`, `useExtensionSyncStatus(key)`, `useExtensionSync(key): { status, isLoading, isSyncing, syncNow(): Promise<SyncNowOutcome>, schedule: ScheduleState, setSchedule(patch: SchedulePatch): void, scheduleError: boolean, clearScheduleError(): void }`.

The polling rules move here unchanged from `JiraAssetsConfiguration.tsx:458-533` (`handleSyncNow`): every 3 seconds, up to 20 minutes; done when a run newer than `previousRunId` is no longer `started`; stalled when that newer run is `started` but not live; not started after 3 polls with `queued === false`, nothing running and no newer run (`queued: null` never counts). The ordered schedule saves move from `handleSyncSettingChange` (`:733-771`).

- [ ] **Step 1: Write the failing hook tests**

Create `Clients/src/application/hooks/__tests__/useExtensionSync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("../../repository/extensionSync.repository", () => ({
  getExtensionSyncStatus: vi.fn(),
  startExtensionRun: vi.fn(),
  updateExtensionSchedule: vi.fn(),
}));

import { decidePoll, useExtensionSync, type SyncNowOutcome } from "../useExtensionSync";
import {
  getExtensionSyncStatus,
  startExtensionRun,
  updateExtensionSchedule,
  type ExtensionRun,
  type ExtensionSyncStatus,
} from "../../repository/extensionSync.repository";

const run = (over: Partial<ExtensionRun> = {}): ExtensionRun => ({
  id: 41,
  kind: "manual",
  status: "completed",
  code: null,
  counts: {},
  message: null,
  started_at: "2026-10-12T10:00:00Z",
  completed_at: "2026-10-12T10:01:00Z",
  is_live: false,
  ...over,
});
const status = (over: Partial<ExtensionSyncStatus> = {}): ExtensionSyncStatus => ({
  schedule: null,
  running: false,
  queued: false,
  latest_run: null,
  last_finished_run: null,
  ...over,
});

describe("decidePoll", () => {
  it("reports a newer run that finished", () => {
    expect(decidePoll(status({ latest_run: run() }), 40, 0)).toEqual({ next: "done", run: run() });
  });

  it("treats a newer started run that stopped heart-beating as stalled", () => {
    const stuck = run({ status: "started", is_live: false, completed_at: null });
    expect(decidePoll(status({ latest_run: stuck }), 40, 0)).toEqual({ next: "stalled" });
  });

  it("keeps waiting while a newer run is live", () => {
    const live = run({ status: "started", is_live: true, completed_at: null });
    expect(decidePoll(status({ running: true, latest_run: live }), 40, 2)).toEqual({
      next: "wait",
      idlePolls: 0,
    });
  });

  it("keeps waiting, without counting, while the queue state is unknown", () => {
    expect(decidePoll(status({ queued: null, latest_run: run({ id: 40 }) }), 40, 2)).toEqual({
      next: "wait",
      idlePolls: 0,
    });
  });

  it("says not started after three idle polls", () => {
    const idle = status({ latest_run: run({ id: 40 }) });
    expect(decidePoll(idle, 40, 1)).toEqual({ next: "wait", idlePolls: 2 });
    expect(decidePoll(idle, 40, 2)).toEqual({ next: "not_started" });
  });

  it("reports the first run ever when there was none before", () => {
    expect(decidePoll(status({ latest_run: run({ id: 1 }) }), null, 0)).toMatchObject({ next: "done" });
  });
});

describe("useExtensionSync", () => {
  let queryClient: QueryClient;
  let current: ExtensionSyncStatus;
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    current = status({
      latest_run: run({ id: 40 }),
      schedule: { enabled: true, interval_hours: 6, consecutive_failures: 0, failing_since: null },
    });
    vi.mocked(getExtensionSyncStatus).mockImplementation(async () => current);
    vi.mocked(startExtensionRun).mockResolvedValue({
      jobId: "ext-sync-jira-assets-5",
      previousRunId: 40,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function mount() {
    const hook = renderHook(() => useExtensionSync("jira-assets"), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return hook;
  }

  it("loads the status and the saved schedule", async () => {
    const { result } = await mount();
    expect(result.current.status).toEqual(current);
    expect(result.current.schedule).toEqual({ enabled: true, interval_hours: 6 });
  });

  it("polls every 3 seconds until a newer run finishes", async () => {
    const { result } = await mount();
    let outcome: Promise<SyncNowOutcome> | undefined;
    await act(async () => {
      outcome = result.current.syncNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isSyncing).toBe(true);

    current = status({
      running: true,
      latest_run: run({ id: 41, status: "started", is_live: true, completed_at: null }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    current = status({ latest_run: run({ id: 41 }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await expect(outcome).resolves.toEqual({ kind: "done", run: run({ id: 41 }) });
    expect(result.current.isSyncing).toBe(false);
    expect(result.current.status?.latest_run?.id).toBe(41);
  });

  it("says the run did not start after three idle polls", async () => {
    const { result } = await mount();
    let outcome: Promise<SyncNowOutcome> | undefined;
    await act(async () => {
      outcome = result.current.syncNow();
      await vi.advanceTimersByTimeAsync(9000);
    });
    await expect(outcome).resolves.toEqual({ kind: "not_started" });
  });

  it("gives up after 20 minutes", async () => {
    current = status({ queued: null, latest_run: run({ id: 40 }) });
    const { result } = await mount();
    let outcome: Promise<SyncNowOutcome> | undefined;
    await act(async () => {
      outcome = result.current.syncNow();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 3000);
    });
    await expect(outcome).resolves.toEqual({ kind: "timeout" });
  });

  it("stops polling when the panel unmounts", async () => {
    const { result, unmount } = await mount();
    let outcome: Promise<SyncNowOutcome> | undefined;
    await act(async () => {
      outcome = result.current.syncNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBefore = vi.mocked(getExtensionSyncStatus).mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    await expect(outcome).resolves.toEqual({ kind: "unmounted" });
    expect(vi.mocked(getExtensionSyncStatus).mock.calls.length).toBe(callsBefore);
  });

  it("returns the refusal when the run cannot start", async () => {
    vi.mocked(startExtensionRun).mockRejectedValue({ status: 409 });
    const { result } = await mount();
    let outcome: SyncNowOutcome | undefined;
    await act(async () => {
      outcome = await result.current.syncNow();
    });
    expect(outcome).toEqual({ kind: "refused", error: { status: 409 } });
    expect(result.current.isSyncing).toBe(false);
  });

  it("saves schedule changes in order and reverts with an error when a save fails", async () => {
    vi.mocked(updateExtensionSchedule)
      .mockResolvedValueOnce({ enabled: false, interval_hours: 6, consecutive_failures: 0, failing_since: null })
      .mockRejectedValueOnce(new Error("500"));
    const { result } = await mount();

    await act(async () => {
      result.current.setSchedule({ enabled: false });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.schedule).toEqual({ enabled: false, interval_hours: 6 });

    await act(async () => {
      result.current.setSchedule({ interval_hours: 12 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateExtensionSchedule).toHaveBeenNthCalledWith(1, "jira-assets", { enabled: false });
    expect(updateExtensionSchedule).toHaveBeenNthCalledWith(2, "jira-assets", { interval_hours: 12 });
    expect(result.current.schedule).toEqual({ enabled: false, interval_hours: 6 });
    expect(result.current.scheduleError).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Clients && npx vitest run src/application/hooks/__tests__/useExtensionSync.test.ts`
Expected: FAIL with `Failed to resolve import "../useExtensionSync"`.

- [ ] **Step 3: Write the repository and the hook**

Create `Clients/src/application/repository/extensionSync.repository.ts`:

```ts
import { apiServices } from "../../infrastructure/api/networkServices";

/**
 * The sync engine's routes (Servers/routes/extensionRuns.route.ts): runs,
 * status and schedule for any extension with a sync provider.
 */

export type ExtensionRunStatus = "started" | "completed" | "failed" | "abandoned" | "skipped";

export interface ExtensionRun {
  id: number;
  kind: string;
  status: ExtensionRunStatus;
  /** "abandoned", "skipped" or a provider code. */
  code: string | null;
  counts: Record<string, number>;
  message: string | null;
  started_at: string;
  completed_at: string | null;
  is_live: boolean;
}

export interface ExtensionSchedule {
  enabled: boolean;
  interval_hours: number;
  consecutive_failures: number;
  failing_since: string | null;
}

export interface ExtensionSyncStatus {
  schedule: ExtensionSchedule | null;
  running: boolean;
  /** Null when the server could not ask the queue. */
  queued: boolean | null;
  latest_run: ExtensionRun | null;
  last_finished_run: ExtensionRun | null;
}

export interface SchedulePatch {
  enabled?: boolean;
  interval_hours?: number;
}

const base = (key: string) => `/extensions/${encodeURIComponent(key)}`;

export async function getExtensionSyncStatus(
  key: string,
  signal?: AbortSignal,
): Promise<ExtensionSyncStatus> {
  const response = await apiServices.get(`${base(key)}/runs/status`, { signal });
  return (response.data as { data: ExtensionSyncStatus }).data;
}

export async function startExtensionRun(
  key: string,
): Promise<{ jobId: string; previousRunId: number | null }> {
  const response = await apiServices.post(`${base(key)}/runs`, {});
  return (response.data as { data: { jobId: string; previousRunId: number | null } }).data;
}

export async function updateExtensionSchedule(
  key: string,
  patch: SchedulePatch,
): Promise<ExtensionSchedule> {
  const response = await apiServices.patch(`${base(key)}/schedule`, patch);
  return (response.data as { data: ExtensionSchedule }).data;
}
```

Create `Clients/src/application/hooks/useExtensionSync.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getExtensionSyncStatus,
  startExtensionRun,
  updateExtensionSchedule,
  type ExtensionRun,
  type ExtensionSyncStatus,
  type SchedulePatch,
} from "../repository/extensionSync.repository";

/** "Sync now" runs in the background; poll its status at this rate, up to the limit. */
export const SYNC_POLL_MS = 3000;
export const SYNC_POLL_LIMIT_MS = 20 * 60 * 1000;
/** Polls with nothing queued, nothing running and no new run before we say it did not start. */
export const NOT_STARTED_AFTER_POLLS = 3;
const DEFAULT_INTERVAL_HOURS = 24;

export type SyncNowOutcome =
  | { kind: "refused"; error: unknown }
  | { kind: "done"; run: ExtensionRun }
  | { kind: "stalled" }
  | { kind: "not_started" }
  | { kind: "timeout" }
  | { kind: "unmounted" };

export interface ScheduleState {
  enabled: boolean;
  interval_hours: number;
}

export type PollStep =
  | { next: "wait"; idlePolls: number }
  | { next: "done"; run: ExtensionRun }
  | { next: "stalled" }
  | { next: "not_started" };

export const extensionSyncStatusKey = (key: string) => ["extension-sync", key, "status"] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One poll after "Sync now": what the newest status means, given the run seen
 * before the click. A newer run that is no longer `started` is the answer; a
 * newer `started` run that stopped heart-beating has stalled; and if nothing
 * newer appears while nothing is queued or running for three polls, the job
 * never started. `queued: null` (queue state unknown) never counts as idle.
 */
export function decidePoll(
  status: ExtensionSyncStatus | null,
  previousRunId: number | null,
  idlePolls: number,
): PollStep {
  const latest = status?.latest_run ?? null;
  const isNew = !!latest && latest.id !== previousRunId;
  if (latest && isNew && latest.status !== "started") return { next: "done", run: latest };
  if (latest && isNew && !latest.is_live) return { next: "stalled" };
  const idle = !isNew && status?.queued === false && !status?.running;
  const nextIdle = idle ? idlePolls + 1 : 0;
  if (nextIdle >= NOT_STARTED_AFTER_POLLS) return { next: "not_started" };
  return { next: "wait", idlePolls: nextIdle };
}

/** The status query alone (shared cache), for pages that only display it. */
export function useExtensionSyncStatus(key: string) {
  return useQuery({
    queryKey: extensionSyncStatusKey(key),
    queryFn: ({ signal }) => getExtensionSyncStatus(key, signal),
  });
}

/**
 * Status, schedule saves and "Sync now" for one extension on the sync engine.
 * Schedule saves run one at a time, in order, each sending only what changed;
 * when the newest settles, the controls show the server's latest answer and an
 * error if any save in that burst failed.
 */
export function useExtensionSync(key: string) {
  const queryClient = useQueryClient();
  const statusQuery = useExtensionSyncStatus(key);
  const [isSyncing, setIsSyncing] = useState(false);
  const [scheduleError, setScheduleError] = useState(false);
  const [schedule, setScheduleState] = useState<ScheduleState>({
    enabled: false,
    interval_hours: DEFAULT_INTERVAL_HOURS,
  });
  const savedSchedule = useRef<ScheduleState | null>(null);
  const scheduleQueue = useRef<Promise<void>>(Promise.resolve());
  const scheduleSeq = useRef(0);
  const burstFailed = useRef(false);
  // Unmount flag so the "Sync now" poll loop stops with the panel.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Take the server's schedule once, when the first status arrives.
  const loaded = statusQuery.data;
  useEffect(() => {
    if (!loaded || savedSchedule.current) return;
    const initial = {
      enabled: loaded.schedule?.enabled ?? false,
      interval_hours: loaded.schedule?.interval_hours ?? DEFAULT_INTERVAL_HOURS,
    };
    savedSchedule.current = initial;
    setScheduleState(initial);
  }, [loaded]);

  const setSchedule = useCallback(
    (patch: SchedulePatch) => {
      setScheduleState((prev) => ({ ...prev, ...patch }));
      setScheduleError(false);
      const seq = ++scheduleSeq.current;
      scheduleQueue.current = scheduleQueue.current.then(async () => {
        try {
          const saved = await updateExtensionSchedule(key, patch);
          savedSchedule.current = { enabled: saved.enabled, interval_hours: saved.interval_hours };
          queryClient.setQueryData<ExtensionSyncStatus>(extensionSyncStatusKey(key), (prev) =>
            prev ? { ...prev, schedule: saved } : prev,
          );
        } catch {
          burstFailed.current = true;
        }
        // Only the newest request decides what the controls show.
        if (seq !== scheduleSeq.current || !mountedRef.current) return;
        if (burstFailed.current) {
          if (savedSchedule.current) setScheduleState(savedSchedule.current);
          setScheduleError(true);
        }
        burstFailed.current = false;
      });
    },
    [key, queryClient],
  );

  const syncNow = useCallback(async (): Promise<SyncNowOutcome> => {
    setIsSyncing(true);
    let previousRunId: number | null;
    try {
      previousRunId = (await startExtensionRun(key)).previousRunId ?? null;
    } catch (error) {
      setIsSyncing(false);
      return { kind: "refused", error };
    }

    const giveUpAt = Date.now() + SYNC_POLL_LIMIT_MS;
    let idlePolls = 0;
    let outcome: SyncNowOutcome = { kind: "timeout" };
    while (Date.now() < giveUpAt) {
      await sleep(SYNC_POLL_MS);
      if (!mountedRef.current) return { kind: "unmounted" };
      let status: ExtensionSyncStatus;
      try {
        status = await getExtensionSyncStatus(key);
      } catch {
        continue;
      }
      queryClient.setQueryData(extensionSyncStatusKey(key), status);
      const step = decidePoll(status, previousRunId, idlePolls);
      if (step.next === "wait") {
        idlePolls = step.idlePolls;
        continue;
      }
      outcome =
        step.next === "done"
          ? { kind: "done", run: step.run }
          : step.next === "stalled"
            ? { kind: "stalled" }
            : { kind: "not_started" };
      break;
    }
    if (!mountedRef.current) return { kind: "unmounted" };
    setIsSyncing(false);
    return outcome;
  }, [key, queryClient]);

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isLoading,
    isSyncing,
    syncNow,
    schedule,
    setSchedule,
    scheduleError,
    clearScheduleError: () => setScheduleError(false),
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd Clients && npx vitest run src/application/hooks/__tests__/useExtensionSync.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck, format and commit**

```bash
cd Clients && npx prettier --write src/application/repository/extensionSync.repository.ts src/application/hooks/useExtensionSync.ts src/application/hooks/__tests__/useExtensionSync.test.ts && npm run typecheck
cd .. && git add Clients/src/application/repository/extensionSync.repository.ts Clients/src/application/hooks/useExtensionSync.ts Clients/src/application/hooks/__tests__/useExtensionSync.test.ts
git commit -m "feat(sync-engine): useExtensionSync hook for the generic sync routes" -m "Status query, ordered schedule saves with revert-on-failure, and Sync now polling moved from the Jira Assets panel: every 3 seconds up to 20 minutes, done on a newer finished run, stalled on a newer run that stopped heart-beating, not started after three idle polls (an unknown queue state never counts). Polling stops at once when the panel unmounts."
```

---

### Task 10: `ExtensionSyncPanel`, the Jira Assets switch, run outcomes and translations

**Files:**
- Create: `Clients/src/application/utils/extensionRunOutcome.ts`
- Create: `Clients/src/presentation/components/ExtensionSyncPanel/index.tsx`
- Test: `Clients/src/presentation/components/ExtensionSyncPanel/__tests__/ExtensionSyncPanel.test.tsx`
- Modify: `Clients/src/presentation/pages/Extensions/jira-assets/runOutcome.ts` (whole file)
- Modify: `Clients/src/presentation/pages/Extensions/jira-assets/runOutcome.test.ts` (whole file)
- Modify: `Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.tsx` (line ranges below)
- Test: `Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.test.tsx`
- Modify: `Clients/src/i18n/translations.ts` (de, fr, es blocks)

**Interfaces:**
- Consumes: `useExtensionSync`, `useExtensionSyncStatus`, `SyncNowOutcome` (Task 9); `ExtensionRun` (Task 9 repository); `Toggle`, `Select`, `CustomizableButton`, `useFormattedDate`, `getApiErrorReason`.
- Produces:
  - `extensionRunOutcome.ts`: `SYNC_RUN_CODES`, `SYNC_RUNNING_MESSAGE`, `isAbandonedRun(run)`, `isSkippedRun(run)` (both read `status`, then `code`).
  - `ExtensionSyncPanel` (default and named export) with props `{ extensionKey: string; canManage: boolean; scheduleDescription?: string; scheduleHelp?: string; syncNowDisabled?: boolean; describeCompletedRun?: (run: ExtensionRun) => string; onRunCompleted?: (run: ExtensionRun) => void }`; also exports `INTERVAL_PRESETS`, `intervalItems(current: number)`, `outcomeMessage(outcome, describeCompleted)`.

The panel reproduces the Jira sync section: the "Enable automatic sync" toggle, the interval select (same five presets, plus the stored value when it is not a preset), "Sync now", the "Last sync" line (from `last_finished_run`: date, then "Successful" or the run's message; a note on a successful run shows beneath, as before), the running state, and the same outcome messages. It adds "Failing since <date>" when `consecutive_failures > 0`. Visible differences on the Jira page: "Sync now" moves from the Import header into the sync section, and the copy is sentence case ("Sync now", "Sync interval"). Before a connection is saved the page shows "Save the connection to set up automatic sync." instead of the controls (the schedule route answers 404 until then, as `PATCH /config/sync` did).

- [ ] **Step 1: Write the failing panel, outcome and page tests**

Replace `Clients/src/presentation/pages/Extensions/jira-assets/runOutcome.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { isAbandonedRun, isSkippedRun } from "./runOutcome";

describe("run outcome readers", () => {
  it("read the engine status, then the code, never the message", () => {
    expect(isAbandonedRun({ status: "abandoned", code: "abandoned" })).toBe(true);
    expect(isAbandonedRun({ code: "abandoned" })).toBe(true);
    expect(isAbandonedRun({ status: "failed", code: null })).toBe(false);
    expect(isAbandonedRun(null)).toBe(false);
    expect(isSkippedRun({ status: "skipped", code: "skipped" })).toBe(true);
    expect(isSkippedRun({ status: "completed", code: null })).toBe(false);
  });
});
```

Create `Clients/src/presentation/components/ExtensionSyncPanel/__tests__/ExtensionSyncPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { light } from "../../../themes";
import type {
  ExtensionRun,
  ExtensionSyncStatus,
} from "../../../../application/repository/extensionSync.repository";

const mockUseExtensionSync = vi.fn();
vi.mock("../../../../application/hooks/useExtensionSync", () => ({
  useExtensionSync: (key: string) => mockUseExtensionSync(key),
}));
vi.mock("../../../../application/hooks/useFormattedDate", () => ({
  default: () => () => "12-10-2026 10:00",
}));

import ExtensionSyncPanel from "../index";

const run = (over: Partial<ExtensionRun> = {}): ExtensionRun => ({
  id: 41,
  kind: "manual",
  status: "completed",
  code: null,
  counts: { created: 2, updated: 3 },
  message: null,
  started_at: "2026-10-12T10:00:00Z",
  completed_at: "2026-10-12T10:01:00Z",
  is_live: false,
  ...over,
});
const status = (over: Partial<ExtensionSyncStatus> = {}): ExtensionSyncStatus => ({
  schedule: null,
  running: false,
  queued: false,
  latest_run: null,
  last_finished_run: null,
  ...over,
});
const hookState = (over: Record<string, unknown> = {}) => ({
  status: status(),
  isLoading: false,
  isSyncing: false,
  syncNow: vi.fn(),
  schedule: { enabled: false, interval_hours: 24 },
  setSchedule: vi.fn(),
  scheduleError: false,
  clearScheduleError: vi.fn(),
  ...over,
});
const renderPanel = (props: Record<string, unknown> = {}) =>
  render(
    <ThemeProvider theme={light}>
      <ExtensionSyncPanel extensionKey="jira-assets" canManage {...props} />
    </ThemeProvider>,
  );

describe("ExtensionSyncPanel", () => {
  beforeEach(() => mockUseExtensionSync.mockReset());

  it("idle: schedule off, Sync now enabled, no last sync", () => {
    mockUseExtensionSync.mockReturnValue(hookState());
    renderPanel();
    expect(mockUseExtensionSync).toHaveBeenCalledWith("jira-assets");
    expect(screen.getByLabelText("Enable automatic sync")).not.toBeChecked();
    expect(screen.queryByText("Sync interval")).toBeNull();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.queryByText("Last sync")).toBeNull();
    expect(screen.queryByText("Failing since")).toBeNull();
  });

  it("saves the schedule when the toggle changes", () => {
    const state = hookState();
    mockUseExtensionSync.mockReturnValue(state);
    renderPanel();
    fireEvent.click(screen.getByLabelText("Enable automatic sync"));
    expect(state.setSchedule).toHaveBeenCalledWith({ enabled: true });
  });

  it("running: Sync now shows the run and is disabled", () => {
    mockUseExtensionSync.mockReturnValue(hookState({ status: status({ running: true }) }));
    renderPanel();
    expect(screen.getByRole("button", { name: /Syncing/ })).toBeDisabled();
  });

  it("shows the interval when the schedule is on", () => {
    mockUseExtensionSync.mockReturnValue(hookState({ schedule: { enabled: true, interval_hours: 6 } }));
    renderPanel();
    expect(screen.getByText("Every 6 hours")).toBeInTheDocument();
  });

  it("shows an interval that is not a preset", () => {
    mockUseExtensionSync.mockReturnValue(hookState({ schedule: { enabled: true, interval_hours: 72 } }));
    renderPanel();
    expect(screen.getByText("Every 72 hours")).toBeInTheDocument();
  });

  it("failing since: says when scheduled runs started failing", () => {
    mockUseExtensionSync.mockReturnValue(
      hookState({
        status: status({
          schedule: {
            enabled: true,
            interval_hours: 6,
            consecutive_failures: 3,
            failing_since: "2026-10-12T08:00:00Z",
          },
        }),
      }),
    );
    renderPanel();
    expect(screen.getByText("Failing since")).toBeInTheDocument();
  });

  it("last sync: a successful run, and a failed one with its message", () => {
    mockUseExtensionSync.mockReturnValue(hookState({ status: status({ last_finished_run: run() }) }));
    const { unmount } = renderPanel();
    expect(screen.getByText("Last sync")).toBeInTheDocument();
    expect(screen.getByText("Successful")).toBeInTheDocument();
    unmount();

    mockUseExtensionSync.mockReturnValue(
      hookState({ status: status({ last_finished_run: run({ status: "failed", message: "Jira returned 401" }) }) }),
    );
    renderPanel();
    expect(screen.getByText("Jira returned 401")).toBeInTheDocument();
  });

  it.each([
    [
      "skipped",
      { kind: "done", run: run({ status: "skipped", code: "skipped", message: "Another sync or import was running, so this sync did not start." }) },
      "Another sync or import was running, so this sync did not start.",
    ],
    ["abandoned", { kind: "done", run: run({ status: "abandoned", code: "abandoned" }) }, "The sync stopped responding. Try again."],
    ["stalled", { kind: "stalled" }, "The sync stopped responding. Try again."],
    ["not started", { kind: "not_started" }, "The sync did not start. Try again."],
    ["timeout", { kind: "timeout" }, "The sync is taking longer than expected. Check the last sync result later."],
    ["409", { kind: "refused", error: { status: 409 } }, "A sync is already running. Try again when it finishes."],
    ["failed", { kind: "done", run: run({ status: "failed", message: "Jira returned 500" }) }, "Jira returned 500"],
  ])("%s: Sync now reports the outcome", async (_label, outcome, text) => {
    mockUseExtensionSync.mockReturnValue(hookState({ syncNow: vi.fn().mockResolvedValue(outcome) }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("completed: describes the run and tells the page", async () => {
    const done = run();
    const onRunCompleted = vi.fn();
    mockUseExtensionSync.mockReturnValue(
      hookState({ syncNow: vi.fn().mockResolvedValue({ kind: "done", run: done }) }),
    );
    renderPanel({
      describeCompletedRun: (r: ExtensionRun) => `Sync completed: ${r.counts.created} created`,
      onRunCompleted,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Sync completed: 2 created")).toBeInTheDocument();
    expect(onRunCompleted).toHaveBeenCalledWith(done);
  });

  it("non-admins cannot change the schedule or sync", () => {
    mockUseExtensionSync.mockReturnValue(hookState());
    renderPanel({ canManage: false });
    expect(screen.getByLabelText("Enable automatic sync")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  });
});
```

Create `Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { light } from "../../../themes";

const panelProps = vi.fn();
vi.mock("../../../components/ExtensionSyncPanel", () => ({
  default: (props: Record<string, unknown>) => {
    panelProps(props);
    return <div data-testid="shared-sync-panel" />;
  },
}));
vi.mock("../../../../application/hooks/useExtensionSync", () => ({
  useExtensionSyncStatus: () => ({ data: { last_finished_run: null } }),
}));
vi.mock("../../../../application/hooks/useAuth", () => ({
  useAuth: () => ({ userRoleName: "Admin" }),
}));
vi.mock("../../../../application/hooks/useFormattedDate", () => ({
  default: () => () => "12-10-2026",
}));
const mockGet = vi.fn();
vi.mock("../../../../infrastructure/api/networkServices", () => ({
  apiServices: {
    get: (url: string) => mockGet(url),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import JiraAssetsConfiguration from "./JiraAssetsConfiguration";

const CONFIG = {
  id: 1,
  jira_base_url: "https://x.atlassian.net",
  workspace_id: "w",
  email: "a@b.co",
  deployment_type: "cloud",
  selected_schema_id: "1",
  selected_object_type_id: "42",
  has_api_token: true,
};

const renderPage = () =>
  render(
    <ThemeProvider theme={light}>
      <JiraAssetsConfiguration />
    </ThemeProvider>,
  );

describe("JiraAssetsConfiguration sync section", () => {
  beforeEach(() => {
    panelProps.mockReset();
    mockGet.mockImplementation(async (url: string) => ({
      data: { data: url.endsWith("/config") ? CONFIG : [] },
    }));
  });

  it("renders the shared sync panel for jira-assets once the connection is saved", async () => {
    renderPage();
    expect(await screen.findByTestId("shared-sync-panel")).toBeInTheDocument();
    expect(panelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ extensionKey: "jira-assets", canManage: true, syncNowDisabled: true }),
    );
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();
  });

  it("asks for the connection first when none is saved", async () => {
    mockGet.mockImplementation(async (url: string) => ({
      data: { data: url.endsWith("/config") ? null : [] },
    }));
    renderPage();
    expect(
      await screen.findByText("Save the connection to set up automatic sync."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("shared-sync-panel")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Clients && npx vitest run src/presentation/components/ExtensionSyncPanel src/presentation/pages/Extensions/jira-assets/runOutcome.test.ts src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.test.tsx`
Expected: FAIL: `Failed to resolve import "../index"`, `isSkippedRun is not a function`, and the page test finds no `shared-sync-panel`.

- [ ] **Step 3: Write the shared outcome readers and point `runOutcome.ts` at them**

Create `Clients/src/application/utils/extensionRunOutcome.ts`:

```ts
/**
 * How sync panels read a run's outcome: from the sync engine's `status` and
 * machine `code`, never from message text.
 */
export const SYNC_RUN_CODES = { abandoned: "abandoned", skipped: "skipped" } as const;

export const SYNC_RUNNING_MESSAGE = "A sync is already running. Try again when it finishes.";

type RunLike = { status?: string | null; code?: string | null } | null | undefined;

/** A run the server closed because it stopped heart-beating. */
export function isAbandonedRun(run: RunLike): boolean {
  return run?.status === "abandoned" || run?.code === SYNC_RUN_CODES.abandoned;
}

/** A manual run that did not start because another run held the claim. */
export function isSkippedRun(run: RunLike): boolean {
  return run?.status === "skipped" || run?.code === SYNC_RUN_CODES.skipped;
}
```

Replace `Clients/src/presentation/pages/Extensions/jira-assets/runOutcome.ts` with:

```ts
/**
 * How the Jira Assets panel reads run outcomes. Sync runs come from the sync
 * engine (`status`, and `code` "abandoned" or "skipped"); the readers are
 * shared with every sync panel. 409s from import and removal carry Jira's own
 * codes and are classified in batching.ts (classifyStop).
 */
export {
  isAbandonedRun,
  isSkippedRun,
  SYNC_RUNNING_MESSAGE,
} from "../../../../application/utils/extensionRunOutcome";

export const RUN_CODES = {
  abandoned: "abandoned",
  skipped: "skipped",
  importInterrupted: "import_interrupted",
  removalInterrupted: "removal_interrupted",
} as const;

/** Shown if a removal lost its claim and the 409 body carries no message. */
export const REMOVAL_INTERRUPTED_MESSAGE =
  "The removal was interrupted; nothing was removed. Try again.";
```

- [ ] **Step 4: Write `ExtensionSyncPanel`**

Create `Clients/src/presentation/components/ExtensionSyncPanel/index.tsx`:

```tsx
import { useState } from "react";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { RefreshCw } from "lucide-react";
import Toggle from "../Inputs/Toggle";
import Select from "../Inputs/Select";
import { CustomizableButton } from "../button/customizable-button";
import useFormattedDate from "../../../application/hooks/useFormattedDate";
import {
  useExtensionSync,
  type SyncNowOutcome,
} from "../../../application/hooks/useExtensionSync";
import type { ExtensionRun } from "../../../application/repository/extensionSync.repository";
import { getApiErrorReason } from "../../../application/utils/apiErrorReason";
import {
  isAbandonedRun,
  isSkippedRun,
  SYNC_RUNNING_MESSAGE,
} from "../../../application/utils/extensionRunOutcome";

export const INTERVAL_PRESETS = [
  { value: 1, label: "Every hour" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 48, label: "Every 48 hours" },
];

export const SYNC_SLOW_MESSAGE =
  "The sync is taking longer than expected. Check the last sync result later.";
export const SYNC_STALLED_MESSAGE = "The sync stopped responding. Try again.";
export const SYNC_NOT_STARTED_MESSAGE = "The sync did not start. Try again.";
const SYNC_FAILED_MESSAGE = "Sync failed";
const SYNC_COMPLETED_MESSAGE = "Sync completed.";
/** Desktop control height for the panel's button. */
const CONTROL_HEIGHT_SX = { height: "30px", minHeight: "30px" };

type PanelMessage = { type: "success" | "error"; text: string };

/** The presets, plus the stored interval when it is not one (set through the API). */
export function intervalItems(current: number): Array<{ _id: number; name: string }> {
  const items = INTERVAL_PRESETS.map((preset) => ({ _id: preset.value, name: preset.label }));
  if (!INTERVAL_PRESETS.some((preset) => preset.value === current)) {
    items.push({ _id: current, name: `Every ${current} hours` });
    items.sort((a, b) => a._id - b._id);
  }
  return items;
}

/** The message "Sync now" ends with; null when the panel went away mid-poll. */
export function outcomeMessage(
  outcome: SyncNowOutcome,
  describeCompleted: (run: ExtensionRun) => string,
): PanelMessage | null {
  switch (outcome.kind) {
    case "unmounted":
      return null;
    case "refused": {
      const error = outcome.error as { status?: number; message?: string } | null;
      return {
        type: "error",
        text:
          error?.status === 409
            ? SYNC_RUNNING_MESSAGE
            : getApiErrorReason(outcome.error) || error?.message || SYNC_FAILED_MESSAGE,
      };
    }
    case "timeout":
      return { type: "error", text: SYNC_SLOW_MESSAGE };
    case "not_started":
      return { type: "error", text: SYNC_NOT_STARTED_MESSAGE };
    case "stalled":
      return { type: "error", text: SYNC_STALLED_MESSAGE };
    case "done": {
      const { run } = outcome;
      if (isAbandonedRun(run)) return { type: "error", text: SYNC_STALLED_MESSAGE };
      if (isSkippedRun(run)) return { type: "error", text: run.message || SYNC_NOT_STARTED_MESSAGE };
      if (run.status === "completed") return { type: "success", text: describeCompleted(run) };
      return { type: "error", text: run.message || SYNC_FAILED_MESSAGE };
    }
  }
}

export interface ExtensionSyncPanelProps {
  /** extensions.key of an extension with a sync provider. */
  extensionKey: string;
  /** Admins change the schedule and start runs; others see the state only. */
  canManage: boolean;
  scheduleDescription?: string;
  scheduleHelp?: string;
  syncNowDisabled?: boolean;
  /** The success line for a completed "Sync now" run. */
  describeCompletedRun?: (run: ExtensionRun) => string;
  onRunCompleted?: (run: ExtensionRun) => void;
}

/**
 * The sync section shared by extensions on the sync engine: automatic sync and
 * its interval, "Sync now", the last finished sync, the running state, the
 * outcome of the last click, and "Failing since" while scheduled runs keep
 * failing.
 */
export function ExtensionSyncPanel({
  extensionKey,
  canManage,
  scheduleDescription,
  scheduleHelp,
  syncNowDisabled = false,
  describeCompletedRun = () => SYNC_COMPLETED_MESSAGE,
  onRunCompleted,
}: ExtensionSyncPanelProps) {
  const formatDate = useFormattedDate();
  const sync = useExtensionSync(extensionKey);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  const lastFinished = sync.status?.last_finished_run ?? null;
  const failures = sync.status?.schedule?.consecutive_failures ?? 0;
  const failingSince = sync.status?.schedule?.failing_since ?? null;
  const running = sync.isSyncing || !!sync.status?.running;

  const handleSyncNow = async () => {
    setMessage(null);
    const outcome = await sync.syncNow();
    const next = outcomeMessage(outcome, describeCompletedRun);
    if (next) setMessage(next);
    if (outcome.kind === "done" && outcome.run.status === "completed") {
      onRunCompleted?.(outcome.run);
    }
  };

  return (
    <Stack sx={{ gap: "16px" }} data-testid={`extension-sync-panel-${extensionKey}`}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
        <Toggle
          checked={sync.schedule.enabled}
          onChange={(event) => sync.setSchedule({ enabled: event.target.checked })}
          disabled={!canManage}
          ariaLabel="Enable automatic sync"
        />
        <Box>
          <Typography sx={{ fontSize: "13px", fontWeight: 500 }}>Enable automatic sync</Typography>
          {scheduleDescription && (
            <Typography sx={{ fontSize: "12px", color: "text.secondary" }}>
              {scheduleDescription}
            </Typography>
          )}
        </Box>
      </Box>

      {sync.schedule.enabled && (
        <Box>
          <Select
            id={`${extensionKey}-sync-interval`}
            label="Sync interval"
            value={sync.schedule.interval_hours}
            items={intervalItems(sync.schedule.interval_hours)}
            onChange={(event) => sync.setSchedule({ interval_hours: Number(event.target.value) })}
            disabled={!canManage}
          />
          {scheduleHelp && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: "4px", display: "block" }}
            >
              {scheduleHelp}
            </Typography>
          )}
        </Box>
      )}

      {sync.scheduleError && (
        <Alert severity="error" sx={{ fontSize: "13px" }} onClose={sync.clearScheduleError}>
          Could not save the sync settings. Try again.
        </Alert>
      )}

      {failures > 0 && failingSince && (
        <Alert severity="warning" sx={{ fontSize: "13px" }}>
          <span>Failing since</span>{" "}
          <span>{formatDate(new Date(failingSince), { includeTime: true })}</span>
        </Alert>
      )}

      {lastFinished?.completed_at && (
        <Alert
          severity={
            lastFinished.status === "completed" && !lastFinished.message ? "success" : "warning"
          }
          sx={{ fontSize: "13px" }}
        >
          <span>Last sync</span>{" "}
          <span>{formatDate(new Date(lastFinished.completed_at), { includeTime: true })}</span>
          {" - "}
          {lastFinished.status === "completed" ? (
            <span>Successful</span>
          ) : (
            <span>{lastFinished.message}</span>
          )}
          {lastFinished.status === "completed" && lastFinished.message && (
            <Box component="span" sx={{ display: "block", mt: "4px" }}>
              {lastFinished.message}
            </Box>
          )}
        </Alert>
      )}

      <Box>
        <CustomizableButton
          variant="outlined"
          text={running ? "Syncing..." : "Sync now"}
          startIcon={<RefreshCw size={14} strokeWidth={1.5} />}
          onClick={handleSyncNow}
          isDisabled={!canManage || running || syncNowDisabled}
          testId={`${extensionKey}-sync-now`}
          sx={CONTROL_HEIGHT_SX}
        />
      </Box>

      {message && (
        <Alert severity={message.type} sx={{ fontSize: "13px" }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}
    </Stack>
  );
}

export default ExtensionSyncPanel;
```

- [ ] **Step 5: Switch the Jira Assets page to the shared panel**

In `Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.tsx` (line numbers from develop `c5d8f439b`; apply bottom-up):

1. **Lines 1162-1177** (the `Sync Now` `<Button …>…</Button>` in the Import & Sync header): delete; the `Import` button stays.
2. **Lines 1157-1158**: replace

```tsx
                {localConfig.last_sync_at &&
                  ` • Last sync: ${formatDate(new Date(localConfig.last_sync_at), { includeTime: true })}`}
```

   with

```tsx
                {lastSyncAt && ` • Last sync: ${formatDate(new Date(lastSyncAt), { includeTime: true })}`}
```

3. **Lines 1076-1142** (from `      <Stack spacing={2.5}>` after the "Step 3: Sync Settings" heading through the closing `)}` of the `{/* Last Sync Info */}` block): replace with

```tsx
      {localConfig.has_api_token ? (
        <ExtensionSyncPanel
          extensionKey="jira-assets"
          canManage={canManageSync}
          scheduleDescription="Automatically sync data from JIRA on a schedule"
          scheduleHelp="Automatic sync refreshes use cases you have imported. It does not import new objects or remove any."
          syncNowDisabled={importedUseCases.length === 0}
          describeCompletedRun={describeJiraSync}
          onRunCompleted={() => {
            void loadImportedUseCases();
          }}
        />
      ) : (
        <Typography variant="body2" fontSize={13} color="text.secondary">
          Save the connection to set up automatic sync.
        </Typography>
      )}
```

4. **Lines 817-823** (`syncIntervalOptions`): delete.
5. **Lines 733-771** (the comment and `handleSyncSettingChange`): delete.
6. **Lines 667-668** in `handleSaveConfig` (`sync_enabled: …` and `sync_interval_hours: …`): delete; the schedule is saved by the panel.
7. **Lines 443-533** (`readSyncStatus` and `handleSyncNow` with their comments): delete.
8. **Lines 251-254** in `loadConfig` (the `savedSyncSettings.current = { … };` statement): delete.
9. **Lines 226-233** (the sync-settings comment, `syncSettingsQueue`, `syncSettingsSeq`, `syncSettingsBurstFailed`, `savedSyncSettings`): delete; keep the selection refs on lines 234-236.
10. **Lines 214-215** (`isSyncing` and `syncSettingsError` state): delete. After `const canManageSync = userRoleName === "Admin";` (line 135) add:

```tsx
  // The "Last sync" date in the Import & Sync header comes from the sync engine.
  const syncStatus = useExtensionSyncStatus("jira-assets");
  const lastSyncAt = syncStatus.data?.last_finished_run?.completed_at ?? null;
```

11. **Lines 163-167**: replace the initial `localConfig` with

```tsx
  const [localConfig, setLocalConfig] = useState<Record<string, any>>({
    deployment_type: "cloud",
  });
```

12. **Lines 85-93** (`NOT_STARTED_AFTER_POLLS`, `SYNC_POLL_MS`, `SYNC_POLL_LIMIT_MS`, `sleep`, `SyncSettings`) and **lines 74-75, 77-78** (`SYNC_SLOW_MESSAGE`, `SYNC_STALLED_MESSAGE`, `SYNC_NOT_STARTED_MESSAGE`): delete. After `const CONTROL_HEIGHT_SX = { height: 30, minHeight: 30 };` add:

```tsx
/** The "Sync now" success line, as the page showed it before the shared panel. */
function describeJiraSync(run: ExtensionRun): string {
  return `Sync completed: ${run.counts.created ?? 0} created, ${run.counts.updated ?? 0} updated`;
}
```

13. **Imports (lines 22-30):** change `import { RefreshCw, Download } from "lucide-react";` to `import { Download } from "lucide-react";`; change `import { VWField, VWSelect, VWToggle } from "./VWComponents";` to `import { VWField, VWSelect } from "./VWComponents";`; delete `import { isAbandonedRun, SYNC_RUNNING_MESSAGE } from "./runOutcome";`; and add:

```tsx
import ExtensionSyncPanel from "../../../components/ExtensionSyncPanel";
import { useExtensionSyncStatus } from "../../../../application/hooks/useExtensionSync";
import type { ExtensionRun } from "../../../../application/repository/extensionSync.repository";
```

After these edits `grep -n "isSyncing\|syncSettings\|handleSyncNow\|readSyncStatus\|SYNC_POLL\|sleep(\|VWToggle\|RefreshCw" Clients/src/presentation/pages/Extensions/jira-assets/JiraAssetsConfiguration.tsx` prints nothing.

- [ ] **Step 6: Add the translations**

Check none of the new keys exist yet: `grep -cE '^    "(Sync interval|Last sync|Failing since|Sync completed\.|Save the connection to set up automatic sync\.)":' Clients/src/i18n/translations.ts` prints `0`.

In `Clients/src/i18n/translations.ts`, after the de line `    "Enable automatic sync": "Automatische Synchronisierung aktivieren",` add:

```ts
    "Sync interval": "Synchronisierungsintervall",
    "Last sync": "Letzte Synchronisierung",
    "Failing since": "Fehlgeschlagen seit",
    "Sync completed.": "Synchronisierung abgeschlossen.",
    "Save the connection to set up automatic sync.":
      "Speichern Sie die Verbindung, um die automatische Synchronisierung einzurichten.",
```

after the fr line `    "Enable automatic sync": "Activer la synchronisation automatique",` add:

```ts
    "Sync interval": "Intervalle de synchronisation",
    "Last sync": "Dernière synchronisation",
    "Failing since": "En échec depuis",
    "Sync completed.": "Synchronisation terminée.",
    "Save the connection to set up automatic sync.":
      "Enregistrez la connexion pour configurer la synchronisation automatique.",
```

and after the es line `    "Enable automatic sync": "Activar sincronización automática",` add:

```ts
    "Sync interval": "Intervalo de sincronización",
    "Last sync": "Última sincronización",
    "Failing since": "Con errores desde",
    "Sync completed.": "Sincronización completada.",
    "Save the connection to set up automatic sync.":
      "Guarde la conexión para configurar la sincronización automática.",
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd Clients && npx vitest run src/presentation/components/ExtensionSyncPanel src/presentation/pages/Extensions/jira-assets src/application/hooks/__tests__/useExtensionSync.test.ts`
Expected: PASS (panel, page, run outcome, batching and hook suites).

- [ ] **Step 8: Gates, format and commit**

```bash
cd Clients && npx prettier --write src/application/utils/extensionRunOutcome.ts src/presentation/components/ExtensionSyncPanel src/presentation/pages/Extensions/jira-assets src/i18n/translations.ts && npm run typecheck && npm run i18n:audit:strict && npm run format-check
cd .. && git add Clients/src
git commit -m "feat(sync-engine): shared ExtensionSyncPanel, used by Jira Assets" -m "ExtensionSyncPanel reproduces the Jira Assets sync section on top of useExtensionSync: the automatic sync toggle, the interval (presets plus a stored value outside them), Sync now, the last finished sync, the running state and the same outcome messages, read from the run's status and code. It adds Failing since <date> while scheduled runs keep failing. The Jira Assets page renders it in place of its own sync code; runOutcome.ts re-exports the shared readers. Sentence-case copy with de, fr and es translations."
```

---

### Task 11: Docs, swagger and endpoint registry, final gates

**Files:**
- Modify: `docs/technical/infrastructure/extensions.md:106` (data table row) and `:314-686` ("Scheduled sync")
- Modify: `docs/technical/infrastructure/automations.md:97,214,223`
- Modify: `Servers/swagger.yaml` (regenerated, then the four generic operations described)
- Modify: `docs/api-docs/src/config/endpoints.ts` (regenerated)
- Modify: `Servers/CLAUDE.md:3` only if a rule there changed (none does in this plan, so leave it)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation of the engine, the provider contract and how to add a provider.

- [ ] **Step 1: Rewrite the "Scheduled sync" section of `extensions.md`**

1. In the data-model table (line 106) change the jira-assets row to:

```markdown
| jira-assets | `jira_assets_config`, `jira_assets_use_cases`, sequence `jira_use_case_uc_id_seq`; runs and schedule in the shared `extension_sync_runs` / `extension_sync_settings` (the old `jira_assets_sync_history` is kept, unwritten, for one release) |
```

2. Replace lines 314-455 (from `## Scheduled sync` through the end of the "Sync now and the panel" list, just before `**Pagination, timeouts, deadline.**`) with:

````markdown
## Scheduled sync

Runs of an extension (scheduled syncs, "Sync now", and any other exclusive
operation such as an import) go through the **sync engine** in
`Servers/extensions/sync-engine/`. Jira Assets is its first provider. MLflow
and Azure AI Foundry still sync on their own `POST /sync` routes.

**No sync deletes anything** (Jira Assets). Neither a manual nor a scheduled
sync removes a project or a use case. A linked object Jira no longer returns is
flagged instead (`jira_assets_use_cases.missing_in_jira_since`). An Admin
removes flagged use cases explicitly from the panel (see
[Removing missing use cases](#removing-missing-use-cases)).

### Tables

- `extension_sync_runs`: one row per claimed run or recorded skip, for every
  extension: `kind` (a kind the provider declares), `status` (`started`,
  `completed`, `failed`, `abandoned`, `skipped`), `code` (`abandoned`,
  `skipped` or a provider code), `counts` (JSONB, provider-defined),
  `message` (cut to 2,000 characters), `run_token`, `triggered_by`, and
  TIMESTAMPTZ `started_at`, `heartbeat_at`, `completed_at`. A partial unique
  index allows one `started` row per organization and extension.
- `extension_sync_settings`: one row per organization and extension with a
  schedule: `enabled`, `interval_hours` (1 to 168), `consecutive_failures`
  and `failing_since`.

Both cascade with the organization. Migration
`20261012200000-extension-sync-engine.js` created them and copied Jira Assets'
schedule and history (ids kept). `node scripts/checkExtensionSyncMigration.js`
and `node scripts/checkExtensionSyncEngineSql.js` check the migration and the
engine's SQL on a throwaway Postgres.

### The provider contract

```ts
interface SyncProvider {
  key: string;                    // extensions.key, /^[a-z0-9-]+$/
  kinds: readonly string[];       // every exclusive operation; must include "manual"
  scheduledKind?: string;         // the kind the tick queues; no schedule if absent
  runDeadlineMs?: number;         // ctx.signal deadline (default 10 minutes)
  readiness(orgId, kind): Promise<{ ready: true } | { ready: false; status: 400 | 404; reason: string }>;
  canSchedule?(orgId): Promise<Readiness>;   // may refuse PATCH /:key/schedule
  run(ctx: RunContext): Promise<RunResult | void>;  // void when it finalized itself
}
```

`RunContext` gives a run `orgId`, `runId`, `kind`, `payload`, `triggeredBy`,
`heartbeat()` (throws `RunSupersededError` once the claim is lost),
`sqlOwnsRun(alias?)` (a SQL boolean that share-locks the run's row, for guarded
writes), `assertOwned(t)`, `finalize(result, t?)`, `release(t?)` and `signal`
(aborted at the deadline). `RunResult` is `{ counts, message?, code? }`.

### Claims

`claimRun(key, orgId, kind, triggeredBy)` runs in one transaction:
`pg_advisory_xact_lock(hashtext('ext_sync:' || key), orgId)`; close `started`
rows with no heartbeat for 15 minutes as `abandoned` (code `abandoned`); throw
`SyncInProgressError` if a live run remains; otherwise insert a `started` row
with a random token. Every heartbeat and finalize matches id, org, extension,
token and `started`, so a duplicate job delivery cannot co-own a run. One claim
per (extension, organization) covers every kind, so a Jira import and a Jira
sync never overlap.

- `runClaimed(provider, ctx)` (the worker) finalizes a returned result. A
  thrown error closes the run as `failed` with its message and its `code` if it
  has one. A `RunSupersededError` writes nothing.
- `withClaim(key, orgId, kind, triggeredBy, fn, { releaseOn })` is for
  exclusive operations outside syncs. It claims, calls `fn(ctx)`, and then
  finalizes `fn`'s result, or releases the claim when there is no result or
  `releaseOn(err)` matches. Other errors fail the run. An operation that needs
  rollback safety calls `ctx.finalize(result, t)` or `ctx.release(t)` inside
  its own data transaction.

### Schedule, backoff and the tick

`extension_sync_tick` (`scheduleExtensionSyncTick`, every 5 minutes,
non-obliterating, registered in `addAllJobs()`) runs `DUE_RUNS_SQL` once per
provider with a schedule. It selects settings rows that are enabled, whose
extension is enabled for the org (jobs bypass `requireExtensionEnabled`, so the
join is the enablement check), with no live run, and whose due time has passed:
`last_run` is the newest `started_at` of a claimed (`run_token` not null)
manual or scheduled run, and the org is due when `last_run` is null or
`now() >= last_run + GREATEST(interval_hours, backoff(consecutive_failures))`
hours. `backoff(n)` is 0, then 1, 2, 4, 8, 16, and 24 hours; the exponent is
clamped, so a long streak cannot overflow. An interval change applies on the
next tick. A due org that is not ready (`readiness(orgId, scheduledKind)`)
records and logs nothing.

A scheduled run that fails, or is closed as abandoned, adds one to
`consecutive_failures` and, on the first failure of a streak, sets
`failing_since` to that run's start. Any completed manual or scheduled run
clears both. There is no auto-disable.

Behaviour change from the Jira-only scheduler: `last_run` is now the newest
run's start; it used to be bounded by `last_sync_at`, the finish. Scheduled
runs can move earlier by up to one run's duration.

### Jobs

`extension_sync_run` carries `{ key, orgId, kind, triggeredBy, payload }`
under jobId `ext-sync-<key>-<orgId>`, with one attempt, removed on complete and
on fail. `enqueueExtensionSyncRun` adds nothing when a job for the pair is
already waiting (`queued: false`); a queue call made for an HTTP request gives
up after 5 seconds with `BackgroundJobsUnavailableError` (503). The worker
(`runExtensionSyncJob`) validates the payload and claims at pickup. If a run is
live, a manual job records a `skipped` row (no token, "Another sync or import
was running, so this sync did not start.") and a scheduled job records nothing.
Enablement is not checked at pickup.

The worker also accepts the old Jira job names for one release:
`jira_assets_scheduled_sync_check` runs the tick and `jira_assets_sync_run` runs
the engine's job. **Deploy the API and the worker together**: during a mixed
old/new rollout the old and new code use different locks and tables and would
not exclude each other.

### Routes

Generic routes (`Servers/routes/extensionRuns.route.ts`, mounted at
`/api/extensions`) use `authenticateJWT` and `requireExtensionEnabledFromParam`;
writes need `extension.admin`. A key without a sync provider falls through to
the per-extension routers.

- `POST /:key/runs`: a manual run. 202 `{ jobId, previousRunId }`; the
  readiness status (400 or 404) with its reason; 409 if a run is live or a job
  is waiting; 503 if the queue does not answer.
- `GET /:key/runs/status`: `{ schedule, running, queued, latest_run,
  last_finished_run }`. `latest_run` is the newest manual or scheduled run
  (`{ id, kind, status, code, counts, message, started_at, completed_at,
  is_live }`); `last_finished_run` is the newest one that completed or failed;
  `queued` is null when the queue does not answer.
- `GET /:key/runs?limit=`: default 20, maximum 200.
- `PATCH /:key/schedule`: `{ enabled?, interval_hours? }`, 1 to 168; the
  provider may refuse with its status; the change goes to the event log.

The old Jira Assets routes stay, served by the engine with their exact
response shapes, and are deprecated in swagger: `POST /sync`,
`GET /sync/status` (`data: null` when Jira is not configured), `GET
/sync/history` and `PATCH /config/sync`. `GET /config` derives `sync_enabled`,
`sync_interval_hours` and `last_sync_*` from the engine (`last_sync_*` is the
newest finished manual or scheduled run that completed or failed).

### The panel

`ExtensionSyncPanel` (`Clients/src/presentation/components/ExtensionSyncPanel/`)
and `useExtensionSync(key)` (`Clients/src/application/hooks/`) give any
provider the sync section: the automatic sync toggle and interval, "Sync now",
the last finished sync, the running state, the outcome messages, and "Failing
since <date>" while scheduled runs keep failing. "Sync now" polls the status
every 3 seconds, for up to 20 minutes, and stops at the first of:

- a run newer than `previousRunId` has finished: its counts, or its message
  (`skipped` runs say why they did not start);
- that newer run stopped heart-beating, or was closed as `abandoned`: "The sync
  stopped responding. Try again.";
- nothing queued or running and no newer run for three polls: "The sync did
  not start. Try again."

### Jira Assets on the engine

`jiraAssetsSyncProvider` declares the kinds `manual`, `scheduled`, `import`
and `remove_missing` (single delete is recorded as `remove_missing`).
Readiness: `manual` needs a config (404) and an object type (400), not
existing use cases; `scheduled` also needs at least one use case; `import`
needs a config; `remove_missing` needs nothing. The run body is `runJiraSync`.
Import, remove-missing and single delete use `withClaim`; removal and delete
finalize or release inside their data transaction.

**What a sync does** (`runJiraSync`):
````

3. In the kept "What a sync does" list (old lines 398-430), replace `A CTE selects the run's history row (id, token, \`started\`) \`FOR SHARE\`, and the link update (which clears any missing flag) and the project update run only if it found the row.` with `The link update (which clears any missing flag) and the project update are guarded by \`ctx.sqlOwnsRun()\`, which share-locks the run's own \`started\` row.`, and replace `The run's note (\`error_message\` on the completed row, and \`last_sync_message\`) lists the missing objects.` with `The run's note (\`message\` on the completed run) lists the missing objects.` and `The result reports \`objectsMissingInJira\`, \`objectsNewlyMissing\` and \`missingInJiraIds\`. \`objects_deleted\` is always 0 for a sync.` with `The run's counts are \`fetched\`, \`created\`, \`updated\`, \`deleted\` (always 0 for a sync), \`missing\` and \`newly_missing\`.`
4. Replace the "Claims, tokens, heartbeats" paragraph and list (old lines 492-524, from `**Claims, tokens, heartbeats.**` through the migrations list) with:

```markdown
**Claims, tokens, heartbeats.** Every Jira Assets run takes the engine claim
(see [Claims](#claims)). A run heartbeats after every fetched page, every 25
objects and before setting flags; a heartbeat that matches no row, or a
database error, stops it with no further writes. The earlier Jira-only
migrations (`20261012003957-jira-assets-sync-heartbeat.js`,
`20261012062548-jira-assets-missing-flag-and-run-token.js`) shaped the old
history table that `20261012200000-extension-sync-engine.js` copied.
```

5. In "Removing missing use cases" (old lines 525-658) apply these replacements wherever they appear: `claimSyncRun` → `withClaim`; `the run's own history row` → `the run's own row`; `history row` → `run`; `assertRunOwned` → `ctx.assertOwned`; `finalizeSuccess` → `ctx.finalize`; `releaseClaim` → `ctx.release`; `objects_deleted` → `counts.deleted`; `jira_assets_sync_history` → `extension_sync_runs`.
6. Replace "Settings and validation" and "Adding a scheduled sync to another extension" (old lines 659-685) with:

```markdown
**Settings and validation.**

- `PATCH /api/extensions/:key/schedule` changes only `enabled` and/or
  `interval_hours` (whole hours, 1 to 168; a numeric string is accepted).
- `POST /config` still accepts `sync_enabled` / `sync_interval_hours` and
  writes them to the engine schedule; a body without them leaves the schedule
  as it is.
- `PATCH /config/selection` changes only `selected_schema_id` and/or
  `selected_object_type_id`.

The panel saves schedule changes one request at a time, keeps the newest
result, and reverts with an error if a save failed. The sync controls and the
remove button are disabled for non-Admins.

**Adding a provider:**

1. Implement `SyncProvider` in the extension's folder: declare every exclusive
   operation as a kind (including `"manual"`), set `scheduledKind` if the
   extension syncs on a schedule, and write `readiness` per kind.
2. In `run(ctx)`, heartbeat while working, guard writes with
   `ctx.sqlOwnsRun()` or `ctx.assertOwned(t)`, honour `ctx.signal`, and return
   `{ counts, message }`; throw on failure. Never delete on a sync: flag
   instead, set flags only after a complete walk, and leave removal to an
   explicit, confirmed Admin action.
3. Run other exclusive operations through `withClaim`.
4. Add the provider to `SYNC_PROVIDERS` in
   `Servers/extensions/sync-engine/providers.ts`.
5. Render `<ExtensionSyncPanel extensionKey="<key>" canManage={…} />` in the
   extension's settings panel.
6. Add tests like `extensions/jira-assets/__tests__/` (run body on a context
   from `createRunContext`, readiness per kind).
```

7. Run `grep -n "jira_assets_sync_history\|claimSyncRun\|runQueuedSync\|runClaimedSync\|startManualSync\|scheduleJiraAssetsScheduledSyncCheck\|jiraAssets.scheduler\|sqlIntervalElapsed" docs/technical/infrastructure/extensions.md` and confirm the only hits are the data-table row and the migration sentence written above.

- [ ] **Step 2: Update `automations.md`**

In `docs/technical/infrastructure/automations.md`:
- replace the `jira_assets_scheduled_sync_check` row (line 97) with:

```markdown
| `extension_sync_tick` | `*/5 * * * *` | Every 5 minutes | Sync engine: queues one `extension_sync_run` per org whose schedule is due (interval and failure backoff) for every extension with a sync provider (see [Extensions → Scheduled sync](./extensions.md#scheduled-sync)). Retires the old `jira_assets_scheduled_sync_check` scheduler, whose name the worker still accepts for one release |
```

- replace the `jira_assets_sync_run` row (line 214) with:

```markdown
| `extension_sync_run` | `automation-actions` | `startManualRun` (`POST /api/extensions/:key/runs` and Jira Assets' deprecated `POST /sync`) and the tick, via `enqueueExtensionSyncRun`; job id fixed per extension and org (`ext-sync-<key>-<orgId>`); `{ key, orgId, kind, triggeredBy, payload }`, one attempt, removed on complete and on fail. The old `jira_assets_sync_run` name is accepted for one release | `runExtensionSyncJob` (claims at pickup) → `runClaimed` |
```

- in the paragraph on line 223, replace `` `jira_assets_sync_run` also needs a worker. `` with `` `extension_sync_run` also needs a worker. ``.

- [ ] **Step 3: Regenerate swagger and the endpoint registry**

Run: `cd Servers && npm run generate:swagger && npm run generate:endpoints`
Expected: both succeed; `git diff --stat Servers/swagger.yaml docs/api-docs/src/config/endpoints.ts` shows the four new paths.

Then, in `Servers/swagger.yaml`, give the generated operations (found by `operationId: postRunCtrl`, `getRunStatusCtrl`, `getRunsCtrl`, `patchScheduleCtrl`) these `responses` and `description` (keep the generated `tags`, `operationId` and `security`):

```yaml
  /extensions/{key}/runs:
    post:
      summary: 'Start a manual run'
      parameters:
        - { name: key, in: path, required: true, schema: { type: string, pattern: '^[a-z0-9-]+$' } }
      responses:
        '202':
          description: 'Run queued ({ jobId, previousRunId }); the worker claims it at pickup. Poll GET /extensions/{key}/runs/status until nothing is queued or running and latest_run is newer than previousRunId'
        '400':
          description: "The provider's readiness refused the run (reason in data)"
        '403':
          description: 'Extension not enabled for this organization, or role not allowed'
        '404':
          description: "The provider's readiness refused the run, e.g. not configured (reason in data)"
        '409':
          description: 'A run is live, or a run job for this extension and organization is already waiting'
        '500':
          description: 'Internal server error'
        '503':
          description: 'Background jobs are unavailable (the queue did not answer within 5 seconds)'
      description: 'Sync engine. Only for extensions with a sync provider; other keys fall through to the extension''s own routes. Requires the extension to be enabled and the extension.admin permission.'
    get:
      summary: 'List runs'
      parameters:
        - { name: key, in: path, required: true, schema: { type: string } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 200, default: 20 } }
      responses:
        '200':
          description: 'Runs of the extension for the organization, newest first ({ id, kind, status, code, counts, message, triggered_by, started_at, heartbeat_at, completed_at }); a limit that is not a whole number of at least 1 lists 20'
        '403':
          description: 'Extension not enabled for this organization'
        '500':
          description: 'Internal server error'
      description: 'Sync engine. Requires the extension to be enabled for the organization.'
  /extensions/{key}/runs/status:
    get:
      summary: 'Run status'
      parameters:
        - { name: key, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: '{ schedule: { enabled, interval_hours, consecutive_failures, failing_since } | null, running, queued (null if the queue did not answer), latest_run, last_finished_run }; runs are { id, kind, status (started, completed, failed, abandoned, skipped), code, counts, message, started_at, completed_at, is_live }'
        '403':
          description: 'Extension not enabled for this organization'
        '500':
          description: 'Internal server error'
      description: 'Sync engine. Requires the extension to be enabled for the organization.'
  /extensions/{key}/schedule:
    patch:
      summary: 'Update the sync schedule'
      parameters:
        - { name: key, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                enabled: { type: boolean }
                interval_hours: { type: integer, minimum: 1, maximum: 168 }
      responses:
        '200':
          description: 'The schedule ({ enabled, interval_hours, consecutive_failures, failing_since })'
        '400':
          description: 'No field given, non-boolean enabled, or interval_hours outside 1-168'
        '403':
          description: 'Extension not enabled for this organization, or role not allowed'
        '404':
          description: 'The provider refused, e.g. the extension is not configured'
        '500':
          description: 'Internal server error'
      description: 'Sync engine. Event-logged. Requires the extension to be enabled and the extension.admin permission.'
```

Run `npm run generate:swagger` once more and confirm `git diff Servers/swagger.yaml` shows no further change (the generator keeps hand-written metadata) and `grep -c "deprecated: true" Servers/swagger.yaml` prints `4`.

- [ ] **Step 4: Run every gate**

```bash
cd Servers && npm run build && npm run format-check && npm run test
node scripts/checkExtensionSyncMigration.js && node scripts/checkExtensionSyncEngineSql.js
cd ../Clients && npm run typecheck && npm run i18n:audit:strict && npm run format-check && npx vitest run
```

Expected: every command exits 0. Report the real output of any that does not; if `npm run format-check` reports files, run `npm run format` in that package and re-run the gate.

- [ ] **Step 5: Commit**

```bash
git add docs/technical/infrastructure/extensions.md docs/technical/infrastructure/automations.md Servers/swagger.yaml docs/api-docs/src/config/endpoints.ts
git commit -m "docs(sync-engine): document the sync engine and its routes" -m "Rewrites the Scheduled sync section of extensions.md around the engine: tables, the provider contract, claims, schedule and backoff, jobs, routes, the shared panel, Jira Assets as the first provider, and how to add a provider. Updates the job tables in automations.md, notes that the API and the worker must be deployed together, regenerates swagger and the endpoint registry, and documents the four generic operations."
```

---

## Self-review

**Spec coverage.**

| Spec item | Task |
|---|---|
| Decision 1, per-org runs only; webhooks stay out | Architecture; nothing in the plan adds webhooks |
| Decision 2, one claim per (extension, org) for every exclusive operation | Task 2 (`claimRun`, `withClaim`), Task 6 (import, remove-missing, single delete) |
| Decision 3, two shared tables; extension config stays | Task 1 |
| Decision 4, real statuses | Task 1 (CHECK, mapping), Task 2 |
| Decision 5, TIMESTAMPTZ | Task 1; Global Constraints |
| Decision 6, one tick job and one per-org run job | Task 4 |
| Decision 7, backoff for scheduled runs only, no auto-disable | Task 3 |
| Decision 8, generic API on its own path; old Jira routes stay with their shapes | Tasks 5 and 7 |
| Decision 9, shared panel and hook; "Failing since" | Tasks 9 and 10 |
| Decision 10, out of scope items | Not touched (MLflow, Azure, token encryption, dropping old table, RLS) |
| Section 1, columns, indexes, partial unique index after copy | Task 1 |
| Section 2, settings copy, ids kept, `setval`, timestamp conversion, status mapping, old columns untouched, `down()` | Task 1 (check script covers each) |
| Section 3, interface, registry key check, `claimRun`, `runClaimed` (2,000 characters, code, superseded), `withClaim`, bookkeeping, due query, readiness at the tick, behaviour change | Tasks 2 and 3; behaviour change documented in Task 11 |
| Section 4, tick, run job, enqueue rules, pickup skip, old job names, deployment note, `removeJobScheduler` | Tasks 4 and 6; deployment note in Task 11 |
| Section 5, generic routes, gating, `next()` for unknown keys, readiness statuses, event log, old routes and mapping, `GET /config` derivation, swagger deprecation | Tasks 5 and 7 |
| Section 6, hook polling rules, panel parts, sentence case, translations, Jira switch, `runOutcome.ts` | Tasks 9 and 10 |
| Section 7, Jira kinds, readiness per kind, run body on ctx, `withClaim` with in-transaction finalize/release, removal of old code, `scheduledSync.utils.ts` | Tasks 6 and 7 (the file keeps only `SQL_NOW_UTC`, which `missing_in_jira_since` still uses) |
| Errors and edge cases (run in flight at deploy, two ticks, error without code, clock skew, org deleted) | Task 1 (live started row kept), Task 2 (unique violation → 409, null code), DB `now()` everywhere, cascades in Task 1 |
| Testing list | Engine: Tasks 2-5; migration: Task 1; Jira: Tasks 6-7; isolation: Task 8; client: Tasks 9-10 |
| Docs | Task 11 |

**Placeholder scan.** No "TBD", "TODO" or "similar to Task N". Moved code names its source lines and shows the full new code (Task 6 `runJiraSync`, `importObjects`; Task 7 legacy readers). The two mechanical edit lists (Task 6 test substitutions, Task 11 doc renames) give exact old and new text.

**Type consistency.** `ClaimedRun`, `EngineRunContext`, `createRunContext(provider, run, payload)`, `withClaim(key, orgId, kind, triggeredBy, fn, options)`, `startManualRun(key, orgId, userId)`, `getRunStatus(key, orgId)`, `listRuns(key, orgId, limit)`, `saveSchedule(key, orgId, { enabled?, intervalHours? })`, `ExtensionSyncJobData { key, orgId, kind, triggeredBy, payload }` and `SyncNowOutcome` are used with the same names and shapes in every task that consumes them. The client `ExtensionRun` mirrors the server `RunView`.

**Review focus.** Each of the five lines has a test in its owning task: unmount mid-poll (Task 9), interval outside the presets (Task 10), long failure streak (Task 3 unit and throwaway Postgres), non-`Error` throws (Task 2), malformed limit and schedule values (Task 5, plus the legacy history limit in Task 7).

**Spec ambiguities resolved here.**

1. `withClaim` needs a user for `triggered_by`; its signature is `withClaim(key, orgId, kind, triggeredBy, fn, options)`, and `fn` returns `{ value, result? }` with a `releaseOn` option for "nothing was done" errors.
2. Provider registration: there is no extension module index, so `Servers/extensions/sync-engine/providers.ts` lists the providers and both the router and the worker's jobs module register them.
3. The schedule route's refusal uses a new optional `canSchedule(orgId)` on `SyncProvider` (Jira: 404 without a config), since none of the declared kinds fits a schedule change.
4. `ctx.signal`'s deadline comes from a new optional `runDeadlineMs` (Jira: its 10-minute walk deadline).
5. The generic status adds `last_finished_run`, which the panel needs to reproduce the old "Last sync" line.
6. Legacy `GET /sync/history` returns `run_token: null` instead of the token.
7. `POST /config` writes the schedule only when the body carries sync fields (it used to reset them to off and 24 when they were missing); the panel stops sending them.
8. Old `started` rows without a token are closed as abandoned, so every `started` row has a token (new CHECK).
9. `scheduledSync.utils.ts` is kept with only `SQL_NOW_UTC`, which `missing_in_jira_since` still needs.
10. Before a Jira connection is saved the panel is replaced by a one-line prompt; "Sync now" moves into the sync section.
11. The generic `PATCH /:key/schedule` rejects `interval_hours: null` (400), while the deprecated `PATCH /config/sync` keeps its old "null means 24".
