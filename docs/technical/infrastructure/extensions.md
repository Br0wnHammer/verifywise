# Extensions

> Replaces the former plugin system (removed in August 2026). For compliance
> frameworks, see [Compliance Frameworks](../domains/compliance-frameworks.md)
> and [Adding a New Compliance Framework](../guides/adding-new-framework.md).
> Frameworks are not extensions.

## Overview

Extensions are optional integrations that ship inside the VerifyWise codebase.
An Admin turns one on or off for their organization. Nothing is downloaded,
installed or built at runtime. There is no marketplace, no separate repository,
no `template.json` and no install/uninstall step.

Each extension has:

- a **catalog row** in `verifywise.extensions`, seeded by a migration
- an optional **declarative config form** in `verifywise.extension_config_fields`
- a **per-organization state row** in `verifywise.extension_enablements`
- **server code** in `Servers/extensions/<key>/`, mounted at
  `/api/extensions/<key>` behind the `requireExtensionEnabled("<key>")` gate
- **client code** in `Clients/src/presentation/pages/Extensions/<key>/`, shown
  only when `useExtensions().isEnabled("<key>")` is true

```
Browser ──► ExtensionsProvider (GET /api/extensions, once per session)
              │  isEnabled(key) gates tabs, buttons, menu items
              ▼
        /api/extensions            catalog router (list, detail, enable, disable,
                                   configuration, test-connection)
        /api/extensions/<key>/...  per-extension routers
              │  authenticateJWT → requireExtensionEnabled(key)
              ▼
        ExtensionService.getRuntimeConfiguration(key, orgId)  → decrypted config
```

---

## Data model

All three catalog tables are created by
`Servers/database/migrations/20260811102307-extensions-migration.js`.

### `extensions` (catalog, one row per extension)

| Column | Notes |
|--------|-------|
| `key` | Unique. `CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,63}$')` |
| `name`, `display_name`, `description`, `long_description` | Catalog text |
| `version`, `author` | Shown on the card as "`<Category> · v<version>`" |
| `category` | `CHECK` limited to `communication`, `ml_ops`, `data_management`, `version_control`, `monitoring`, `security`, `analytics`. A new category is a schema change. |
| `icon_path` | Path under `Clients/public/assets/extensions/` (set by `20260818124348-extension-icon-paths.js`) |
| `documentation_url`, `support_url` | Optional links |
| `requires_configuration` | Drives the "Configuration required" label and the **Test connection** button |
| `features` (JSONB array), `tags` (TEXT[]) | Catalog metadata |

The catalog is not tenant-scoped. It is the same for every organization.

### `extension_config_fields` (declarative config form)

One row per field. The client renders these with
`Clients/src/presentation/components/ExtensionConfigForm` on the settings page.

| Column | Notes |
|--------|-------|
| `extension_id` | FK → `extensions.id` (CASCADE) |
| `field_key` | `CHECK (field_key ~ '^[a-z_][a-z0-9_]{0,99}$')`, unique per extension |
| `field_type` | `text`, `textarea`, `url`, `email`, `password`, `number`, `boolean`, `select`, `multiselect` |
| `label`, `help_text`, `placeholder`, `display_order` | Presentation |
| `is_required` | Enforced on enable and on configuration update |
| `is_secret` | Value is encrypted at rest and never returned by the API |
| `default_value` | Stored as text |
| `options` (JSONB array) | `[{ label, value }]` for `select` / `multiselect` |
| `validation` (JSONB object) | `minLength`, `maxLength`, `pattern`, `min`, `max` |

Only **MLflow** and **Azure AI Foundry** have config fields today. Slack and
Jira Assets fields were removed by
`20260819105546-remove-dead-extension-config-fields.js` because nothing read
them. Those extensions are configured after enabling, through their own panels.

### `extension_enablements` (per organization)

| Column | Notes |
|--------|-------|
| `organization_id` | FK → `organizations.id` (CASCADE). Unique with `extension_id`. |
| `extension_id` | FK → `extensions.id` (CASCADE) |
| `enabled` | Boolean |
| `configuration` | JSONB object. `is_secret` values are ciphertext. |
| `enabled_at` | `CHECK (NOT enabled OR enabled_at IS NOT NULL)` |
| `enabled_by` | FK → `users.id` (SET NULL) |

A row exists once an organization has enabled the extension at least once.
Disabling does not delete it.

### Extension-owned data tables

These tables exist in every database, whether or not any organization has
enabled the extension. All are tenant-scoped by `organization_id`.

| Extension | Tables |
|-----------|--------|
| slack | `slack_webhooks` (predates extensions) |
| mlflow | `mlflow_model_records` (synced runs; `mlflow_integrations` also predates extensions) |
| azure-ai-foundry | `azure_ai_model_records` |
| model-lifecycle | `model_lifecycle_phases`, `_items`, `_values`, `_item_files`, `_item_people`, `_item_approvals`, `_change_history` |
| jira-assets | `jira_assets_config`, `jira_assets_use_cases`, `jira_assets_sync_history`, sequence `jira_use_case_uc_id_seq` |
| risk-import, dataset-bulk-upload | None. They write to the core `risks` and `datasets` / `files` tables. |

---

## Server

### Catalog service

`Servers/services/extension/extensionService.ts`, class `ExtensionService`:

| Method | Purpose |
|--------|---------|
| `listAll(orgId, category?)` | Catalog + config fields + this org's state, secrets stripped |
| `getByKey(key, orgId)` | Same, for one extension |
| `enable(key, orgId, userId, configuration)` | Merge with stored config, encrypt secrets, validate, upsert `enabled = true` |
| `disable(key, orgId)` | Set `enabled = false`. 404 if the org never enabled it. |
| `updateConfiguration(key, orgId, configuration)` | Merge, encrypt, validate, save. 404 if the org never enabled it. |
| `getRuntimeConfiguration(key, orgId)` | Full config with secrets **decrypted**, for server-side use only. Returns `{}` if there is no enablement row. |

Each read response (`assemble`) contains the catalog fields, `configFields`,
`enabled`, the redacted `configuration` and the raw `enablement` row.

### Secrets and validation

- On write, `mergeAndEncrypt` keeps only known `field_key`s. Secret values are
  encrypted with `encrypt()` from `Servers/utils/encryption.utils.ts`
  (AES-256-GCM, key from `ENCRYPTION_KEY`; legacy AES-256-CBC values still
  decrypt).
- If a secret field is missing or blank in the payload, the stored ciphertext
  carries over. This is how the UI's "Leave blank to keep the existing value"
  works. Non-secret fields that are missing from the payload are dropped,
  because the caller sends the full non-secret shape each time.
- `validate` enforces `is_required` (a required secret passes if a previous
  value exists), type checks per `field_type`, `options` membership and the
  `validation` rules. It rejects unknown keys.
- On read, `redactSecrets` removes secret keys entirely. Masked values are not
  returned either.
- Per-extension code must read config through `getRuntimeConfiguration`. Never
  return that result to the client.

Jira Assets is the exception. It keeps its connection settings, including its
own encrypted `api_token` (via `Servers/tools/createSecureValue`), in the
`jira_assets_config` table. Its `extension_enablements.configuration` is empty.

### Catalog routes

`Servers/routes/extension.route.ts`, mounted at `/api/extensions`. Controllers
are in `Servers/controllers/extension.ctrl.ts`.

| Method | Path | Roles | Body |
|--------|------|-------|------|
| GET | `/api/extensions` | Any authenticated user | `?category=` optional |
| GET | `/api/extensions/:key` | Any authenticated user | |
| POST | `/api/extensions/:key/enable` | Admin | `{ configuration?: {...} }` |
| POST | `/api/extensions/:key/disable` | Admin | |
| PATCH | `/api/extensions/:key/configuration` | Admin | `{ configuration: {...} }` |
| POST | `/api/extensions/:key/test-connection` | Admin | `{ configuration?: {...} }` |

Keys are checked against `EXTENSION_KEY_PATTERN`, so a malformed key gets a 400.
An unknown key gets a 404 ("Extension not found"). A `ValidationException` gets
a 400.

**Mount order matters.** In `Servers/app.ts` the catalog router is registered
before the seven per-extension routers. Otherwise a per-extension mount such as
`/api/extensions/slack` would catch `GET /api/extensions/slack` and return 403
through the gate. Per-extension sub-paths are all multi-segment (`/models`,
`/oauth/workspaces`, ...), so they never collide with `/:key`.

### Gate middleware

`Servers/middleware/requireExtensionEnabled.middleware.ts`

```ts
import { requireExtensionEnabled } from "../../middleware/requireExtensionEnabled.middleware";

router.use(authenticateJWT);
router.use(requireExtensionEnabled("mlflow"));
```

| Condition | Response |
|-----------|----------|
| No `req.organizationId` | 401 "User not authenticated" |
| Key not in the catalog | 404 "Extension '`<key>`' not found in catalog" |
| No enablement row, or `enabled = false` | 403 "Extension '`<key>`' is not enabled for this organization" |
| Lookup error | 500 |

The key → id lookup is cached in process. The catalog only changes through
migrations.

### Test connection

`TEST_CONNECTION_DISPATCH` in `Servers/controllers/extension.ctrl.ts` maps a key
to a runner that returns `{ success, message, testedAt }`:

| Key | Runner |
|-----|--------|
| `mlflow` | Stored runtime config overlaid with the submitted config → `testConnection` in `extensions/mlflow/mlflow.service.ts` |
| `azure-ai-foundry` | Same pattern → `testConnection` in `extensions/azure-ai-foundry/azureAiFoundry.service.ts` |
| `jira-assets` | Submitted config. If no `api_token` is submitted, the stored token comes from `jira_assets_config`. Then `clientFromConfig(...).testConnection()`. |

Any other key returns **200** with `success: false` and "Test connection is not
available for '`<key>`'." It never 404s. Jira Assets has no route of its own for
this. A `/test-connection` route under `/api/extensions/jira-assets` would be
shadowed by the catalog router.

---

## Client

| Piece | Path |
|-------|------|
| Context | `Clients/src/application/contexts/Extensions.context.tsx`: `ExtensionsProvider` (mounted in `App.tsx`) and `useExtensions()` → `{ extensions, loading, error, refetch, enable, disable, updateConfiguration, isEnabled(key), getByKey(key) }` |
| Repository | `Clients/src/application/repository/extension.repository.ts`: `listExtensions`, `getExtensionByKey`, `enableExtension`, `disableExtension`, `updateExtensionConfiguration`, `testExtensionConnection` |
| Types | `Clients/src/domain/types/extensions.ts` |
| Catalog page | `Clients/src/presentation/pages/Extensions/index.tsx`, route `/extensions` |
| Settings page | `Clients/src/presentation/pages/Extensions/Settings/index.tsx`, route `/extensions/:key/settings` |
| Generic config form | `Clients/src/presentation/components/ExtensionConfigForm` |
| Per-extension UI | `Clients/src/presentation/pages/Extensions/<key>/` |
| Header entry point | `Clients/src/presentation/components/Layout/DashboardActionButtons.tsx` (disabled for non-Admins) |
| Icons | `Clients/public/assets/extensions/<key>.svg` (Azure uses `.jpg`) |

The provider fetches `/api/extensions` once the user has a token and an
organization, and clears it on logout. Mutations update the local cache, so
gated UI re-renders straight away.

Both pages redirect non-Admins to `/` (`userRoleName !== "Admin"`). The old
`/plugins` route has no redirect.

**Catalog card buttons** (`Extensions/index.tsx`): **Enable** when there are no
pre-enable fields; **Configure to enable** when there are; **Configure** when
enabled and the extension has a settings surface; **Disable** when enabled. A
settings surface is either config fields or membership in
`KEYS_WITH_POST_ENABLE_UI` (`slack`, `model-lifecycle`, `jira-assets`).

**Settings page** (`Extensions/Settings/index.tsx`): a **Configuration** card
when `configFields.length > 0`. Then the extension's own panel for `slack`
(`SlackConfiguration`), `model-lifecycle` (`ModelLifecycleConfig`) or
`jira-assets` (`JiraAssetsConfiguration`). Then the **Enable**/**Disable**,
**Save configuration** and **Test connection** actions. **Test connection**
appears for any enabled extension with `requires_configuration = true`. For
Slack and Model Lifecycle it therefore shows the "not available" message.

---

## The seven extensions

| Key | Category | Config fields | Server dir | Client dir | Where it surfaces |
|-----|----------|---------------|------------|------------|-------------------|
| `slack` | communication | none (post-enable panel) | `Servers/extensions/slack/` (reuses `controllers/slackWebhook.ctrl.ts`) | `Extensions/slack/` | Settings page panel: **Add to Slack** OAuth, workspace table, notification routing |
| `mlflow` | ml_ops | `tracking_server_url` (url, required), `auth_method` (select none/basic/token, default none), `username`, `password` (secret), `api_token` (secret), `timeout` (number 1–600, default 30; per-request) | `Servers/extensions/mlflow/` | `Extensions/mlflow/` (`MLFlowTab`) | Model inventory **MLFlow** tab with manual **Sync** |
| `azure-ai-foundry` | ml_ops | `project_endpoint` (url, required), `api_key` (secret, required), `subscription_id`, `resource_group`, `resource_name` (optional) | `Servers/extensions/azure-ai-foundry/` | `Extensions/azure-ai-foundry/` (`AzureAIFoundryTab`) | Model inventory **Azure AI Foundry** tab with **Sync**; Agent discovery (`AgentTable`) |
| `model-lifecycle` | ml_ops | none (post-enable panel) | `Servers/extensions/model-lifecycle/` | `Extensions/model-lifecycle/` | **View lifecycle** in Model inventory rows; model lifecycle detail page |
| `risk-import` | data_management | none | `Servers/extensions/risk-import/` | `Extensions/risk-import/` | Risk management → **Import from Excel** |
| `jira-assets` | data_management | none (post-enable panel, stored in `jira_assets_config`) | `Servers/extensions/jira-assets/` | `Extensions/jira-assets/` | Imported use cases; Jira use-case views in `ProjectView/V1.0ProjectView` |
| `dataset-bulk-upload` | data_management | none | `Servers/extensions/dataset-bulk-upload/` | `Extensions/dataset-bulk-upload/` | Datasets → **Bulk upload** |

Client dirs are relative to `Clients/src/presentation/pages/`.

### Per-extension routes

Every router begins with `authenticateJWT` and then
`requireExtensionEnabled("<key>")`. Role checks beyond that are listed. Where
none is listed, any authenticated user in an organization with the extension
enabled can call the route.

| Base path | Routes | Extra roles |
|-----------|--------|-------------|
| `/api/extensions/slack` | `GET/POST /oauth/workspaces`, `GET/PATCH/DELETE /oauth/workspaces/:id`, `POST /oauth/workspaces/:id/send` | `POST /oauth/workspaces` rate-limited (`slackWorkspaceCreateLimiter`, 10/hour) |
| `/api/extensions/mlflow` | `GET /models`, `GET /models/:modelId`, `POST /sync` | |
| `/api/extensions/azure-ai-foundry` | `GET /models`, `GET /models/:deploymentId`, `POST /sync`, `GET /discover` | |
| `/api/extensions/model-lifecycle` | `GET /config`; phases CRUD and reorder; items CRUD and reorder; `GET /models/:id/lifecycle`, `/progress`; item values, files, people and approvals under `/models/:id/lifecycle/items/:itemId/...` | |
| `/api/extensions/risk-import` | `GET /template`, `POST /import` | Admin, Editor |
| `/api/extensions/jira-assets` | `GET/POST /config`, `PATCH /config/sync`, `PATCH /config/selection`, `GET /vw-attributes`, schema and object-type discovery (`GET /object-types/:id/objects?startAt=` is one page of up to 1000 for the import picker), `POST /import`, `POST /sync` (202, queued for the worker), `GET /sync/status`, `GET /sync/history`, `GET /use-cases`, `POST /use-cases/remove-missing`, `GET/DELETE /use-cases/:id`, `GET /projects/:projectId/custom-frameworks-progress` | `extension.admin` (Admin) on `POST /config`, `PATCH /config/sync`, `PATCH /config/selection`, `POST /import`, `POST /sync`, `POST /use-cases/remove-missing`, `DELETE /use-cases/:id`. Errors: 400 bad input, 404 not configured, 409 a run is live or a sync job is waiting, 502 Jira or network failure (reason in `error`), 503 the job queue did not answer. |
| `/api/extensions/dataset-bulk-upload` | `POST /upload` (multipart, one file per request, 30 MB, CSV/XLS/XLSX; 413/415 on error) | Admin, Editor |

The full list is in `Servers/swagger.yaml` under `/extensions/...`.

### Environment variables

Only Slack needs deployment-level settings: `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET` and `SLACK_API_URL` on the server, and
`VITE_SLACK_CLIENT_ID` and `VITE_SLACK_URL` on the client. The other
extensions are configured per organization in the UI.

---

## Enable and disable semantics

- **Enable** upserts the enablement row with `enabled = true`, `enabled_at`
  and `enabled_by`. Any submitted `configuration` is merged into the stored
  config and validated. Re-enabling keeps earlier config values.
- **Disable** sets `enabled = false`. Configuration, secrets and all
  extension-owned data (synced models, lifecycle phases, Jira use cases, Slack
  webhooks) are **kept**. Re-enabling restores access to them. The UI shows no
  confirmation dialog.
- **There is no uninstall** and no way to purge an extension's data from the
  UI or API.
- While disabled, the gate returns 403 on every `/api/extensions/<key>/...`
  route and the client hides the extension's entry points.
- MLflow and Azure AI Foundry sync is manual only. Jira Assets also refreshes
  its imported use cases on the configured interval (see
  [Scheduled sync](#scheduled-sync)). The scheduler skips organizations where
  the extension is disabled. No Jira Assets sync ever deletes a use case:
  objects gone from Jira are flagged, and an Admin removes them explicitly.

---

## Scheduled sync

Jira Assets is the first extension that syncs on a schedule. Follow the same
pattern for any later one (for example a Jira incident sync).

**No sync deletes anything.** Neither a manual nor a scheduled sync removes a
project or a use case. A linked object Jira no longer returns is flagged
instead (`jira_assets_use_cases.missing_in_jira_since`). An Admin removes
flagged use cases explicitly from the panel (see
[Removing missing use cases](#removing-missing-use-cases)).

**A quick check job, then one sync job per org.**

- `scheduleJiraAssetsScheduledSyncCheck` in
  `Servers/services/automations/automationProducer.ts` upserts the repeatable
  `jira_assets_scheduled_sync_check` job on the `automation-actions` queue,
  every 5 minutes (`*/5 * * * *`).
- The job is registered in `addAllJobs()` (`Servers/jobs/producer.ts`)
  through `safeSchedule`. `createAutomationWorker` (`automationWorker.ts`)
  dispatches it to `runJiraAssetsScheduledSyncAllOrgs` in
  `Servers/extensions/jira-assets/jiraAssets.scheduler.ts`.
- The check does not sync. For each due org it only queues a
  `jira_assets_sync_run` job (`startScheduledSync`), so it returns quickly and
  each org syncs independently in the worker (concurrency 10).

**Jobs are queued, then claimed at pickup.** `enqueueJiraAssetsSyncRun` queues
the job under a job id that is fixed per org (`jira-assets-sync-<orgId>`), with
one attempt and `removeOnComplete` / `removeOnFail`.

- If a job for the org is already waiting or running, nothing is added
  (`queued: false`). A finished job left behind is removed first. If that
  removal fails, the job is looked up again:
  - gone: the add goes ahead
  - now waiting: `queued: false`
  - still there and finished: a genuine queue failure (503)
- So overlapping scheduler ticks, or a tick plus a "Sync now", never queue two
  jobs for one org.
- Every queue call made for an HTTP request has a 5-second limit
  (`QUEUE_CALL_TIMEOUT_MS`). Past it, or on any queue error, it throws
  `BackgroundJobsUnavailableError` and the route returns 503 "Background jobs
  are unavailable". Known edge: if the 5-second limit fires after Redis has
  already accepted the add, the caller gets 503 although the job is queued.
  The next attempt finds it waiting (409), and it runs normally.

The worker entry `runQueuedSync` validates the payload. It fails closed
without a valid `organizationId` or `syncType`, and falls back to no user for
an invalid `triggeredBy`. Then it claims the run. Time spent waiting in the
queue therefore never counts against the run's heartbeat. If another run is
live, the job is skipped. For a manual sync, someone is waiting on the
result, so a closed `failed` history row (no token) is recorded with "Another
sync or import was running, so this sync did not start." The panel's poll
reports it. Scheduled skips are not recorded. The scheduler's last-run lookup
only counts claimed runs (`run_token IS NOT NULL`), so a skipped row never
delays the schedule. `runClaimedSync` then owns finalization of the row:
it records failures and returns a failed result instead of throwing.

**Candidates and timing are decided in SQL.** `getScheduledSyncCandidates`
runs one cross-org discovery query. It selects `jira_assets_config` with
`sync_enabled = true`, joined to `extension_enablements` (`enabled = true`)
and `extensions` (`key = 'jira-assets'`). Jobs bypass
`requireExtensionEnabled`, so the join is the enablement check. Every
subquery is correlated on the row's own `organization_id`. The query returns
these flags:

- `has_object_type`
- `has_use_cases`
- `running_is_live`: a `started` run with a heartbeat inside 15 minutes
- `is_due`: `sync_interval_hours` have passed since the later of
  `last_sync_at` and the newest manual or scheduled `started_at`. Imports and
  removals do not count. "Never synced" counts as due.

The pure `evaluateScheduledSync` turns these flags into a decision.

**Time.** The run columns (`started_at`, `heartbeat_at`, `completed_at`,
`last_sync_at`, `missing_in_jira_since`) are `TIMESTAMP WITHOUT TIME ZONE`
holding UTC wall-clock time. They are written with
`(NOW() AT TIME ZONE 'UTC')` and compared against that same expression.
Sequelize's default `timezone: "+00:00"` also sets each session to UTC. The
SQL does not rely on that setting. The building blocks are in
`Servers/extensions/scheduledSync.utils.ts`: `SQL_NOW_UTC`,
`sqlIntervalElapsed`, `sqlWithinLastMinutes`.

**What a sync does** (`runClaimedSync`):

- **Scheduled** (`triggered_by = NULL`) is refresh-only. It updates the
  project and link row of every linked object Jira returns, and creates
  nothing.
- **Manual** ("Sync now") also creates use cases for new objects of the
  selected type, owned by the user who clicked.
- **Flags:**
  - Both clear `missing_in_jira_since` on every object Jira returns.
  - After a walk that was complete and returned at least one object, both set
    the flag on linked objects that were not returned. An existing flag keeps
    its earlier date.
  - The flag is set only on links whose stored object type
    (`data.objectType.id`) is the type that was just walked. The query checks
    this again in SQL. A link from another or an unknown type is never flagged
    by that walk, and is left exactly as it was. Switching the selected type
    therefore never flags the old type's use cases.
  - Every per-object write happens only while the run still owns its claim.
    A linked object is updated in one statement: a CTE selects the run's
    history row (id, token, `started`) `FOR SHARE`, and the link update
    (which clears any missing flag) and the project update run only if it
    found the row. Ownership and both writes share one snapshot and commit
    together, and a claim closing the row as abandoned must wait for the
    statement. If the row is no longer the run's, nothing is written and the
    run stops with `RunSupersededError`. A new use case is created in a
    transaction that first takes the same `FOR SHARE` lock. Setting flags
    carries an `EXISTS` guard on the same row.
  - After an incomplete or empty walk, no flag is set. A false "complete"
    would only mis-flag, which the next complete sync clears.
- The run's note (`error_message` on the completed row, and
  `last_sync_message`) lists the missing objects. It also says whether they
  were flagged, or why not. The result reports `objectsMissingInJira`,
  `objectsNewlyMissing` and `missingInJiraIds`. `objects_deleted` is always 0
  for a sync.

**Sync now and the panel.** `POST /sync` (`startManualSync`):

1. checks the config: 404 if it is not configured, 400 if no object type is
   selected
2. returns 409 if a run is live or a job for the org is already waiting
3. otherwise queues the job and returns 202 with `{ jobId, previousRunId }`

`previousRunId` is the newest manual or scheduled run before the click.
`GET /sync/status` returns:

- `running` and `latest_run` (with `is_live`, and `code`: `"abandoned"` or
  `"skipped"` for a run closed for that reason, else null), computed in SQL
- `queued`: whether a job for the org is waiting. It is `null` if the queue did
  not answer.

The panel polls every 3 seconds, for up to 20 minutes, and stops at the first
of these:

- a run newer than `previousRunId` has finished: it reports that run's counts,
  or its error
- that newer run stopped heart-beating, or was closed with `code`
  `"abandoned"`: "The sync stopped responding. Try again."
- nothing is queued or running and no newer run appears for three polls: "The
  sync did not start. Try again."

**Pagination, timeouts, deadline.** `JiraAssetsClient.getAllObjects` follows
the Assets API pages. Completeness now only decides whether flags may be set.

- **Cloud:** `POST object/aql?startAt=&maxResults=`. Only `isLast === true`
  proves the end, because `total` can be capped. The walk advances by the
  number of rows returned.
- **Data Center:** `GET iql/objects?...&page=&resultPerPage=`. The server may
  cap `resultPerPage`, so a short page alone proves nothing, and `pageSize`
  (the page count) is never used: a capping server may compute it from the
  size that was asked for. The walk is complete on an empty page, on
  `isLast === true`, or on as many distinct objects as `totalFilterCount`
  (on a short or repeated page only, since a count reached on a full page
  could be capped). A repeated page (some servers answer past the end with
  their last page) with none of these ends the walk incomplete. The accepted
  trade-off: a server that reports only `pageSize` and repeats its last page
  past the end never gets a complete walk, so its syncs refresh what they see
  but never flag anything as missing in Jira.

Every request has a 30-second timeout. The worker's walk has a 10-minute
deadline (`WORKER_SYNC_DEADLINE_MS`). When it passes, the run fails with
nothing changed. Every request, connection or body-read failure becomes
`JiraUpstreamError`. An error thrown by the sync's per-page heartbeat (a lost
claim) propagates as itself and is not reported as a deadline stop. The
import picker (`GET /object-types/:id/objects?startAt=`) returns one page of up
to 1000 as `{ objects, hasMore, nextStartAt }`, with **Load more** in the
panel. `POST /import` takes at most 100 `object_ids` per request
(`IMPORT_MAX_OBJECTS`, 400 above that), because it runs inside the request and
fetches each object from Jira in turn. The panel sends a bigger selection as
sequential batches of 100.

The import result carries `errors` for objects that could not be imported,
and `failed_ids` with their ids, so the panel can keep exactly those objects
selected for a retry.
An import that loses its claim returns 409 with
`{ message, code: "import_interrupted", imported, skipped }`.

**Claims, tokens, heartbeats.** Every run starts with `claimSyncRun`: syncs at
worker pickup, plus imports (`sync_type = 'import'`) and removals
(`'remove_missing'`). In one transaction it:

1. takes `pg_advisory_xact_lock(hashtext('jira_assets_sync'), orgId)`
2. closes as failed any `started` row with no heartbeat for 15 minutes (SQL)
3. inserts the new `started` row with a random `run_token`, or throws
   `JiraSyncInProgressError` if another run is still `started`

Heartbeats and both finalize steps match the row's id AND token, and require
it to still be `started`. A duplicate delivery of the same job therefore cannot
co-own the run.

A run touches `heartbeat_at` after every fetched page, every 25 objects, and
before setting flags. `touchHeartbeat` throws in two cases, and the run stops
with no further writes:

- `RunSupersededError` when the update matched no row
- the database error itself when the database fails, because the run can no
  longer prove it owns the row

A finalize that matches no row leaves the config alone. `finalizeFailure`
never throws. Failures are written to the history row and to the config
(`last_sync_*`), so the scheduler's interval acts as backoff. Imports and
removals record only on their history row.

The migrations are:

- `20261012003957-jira-assets-sync-heartbeat.js`: `heartbeat_at` and the
  `'import'` type
- `20261012062548-jira-assets-missing-flag-and-run-token.js`:
  `missing_in_jira_since`, `run_token` and the `'remove_missing'` type

**Removing missing use cases.** <a id="removing-missing-use-cases"></a> The
panel lists the flagged use cases under "Missing in Jira", with key, name and
the date they were flagged. The use case's overview shows a "Missing in Jira"
chip.

Each row has a checkbox, all unchecked by default, plus a select-all. An Admin
ticks the use cases to delete and clicks **Remove selected use cases (N)**.
They confirm in a `StandardModal` that shows the count and the list, and that
says the projects and their data will be deleted. The panel then calls
`POST /use-cases/remove-missing` with `{ use_case_ids }`, exactly the selected
ids. A request may name up to 1000 ids (`REMOVE_MISSING_MAX_IDS`) but cover
at most 100 use cases (`REMOVE_MISSING_MAX_PROJECTS`, the same number as the
import limit): the cost of a removal is one project deletion per use case. A
request covering exactly one use case is exempt from the id cap, up to 25,000
ids (`REMOVE_MISSING_SINGLE_USE_CASE_MAX_IDS`, the most objects a sync
walks), so a use case with many links can always be removed. The rule is
checked before claiming and again on the locked rows; a request that breaks
it is a 400 and leaves no run in the history. The panel groups the selected
ids by use case (`planBatches`), so every link of one use case goes in the
same request, and packs the groups into sequential requests of up to 100 ids;
a single use case with more than 100 links goes alone. It shows "Removing use
cases 101–200 / 250" and reports how many were removed. A batch rejected as
invalid (400) is reported ("Use cases not removed") and stays selected, and
the next batches still go; a 409 (sync running, removal interrupted) or any
other error stops the run. Import
batches the same way ("Importing objects …"), 100 objects per request;
objects a batch reports as failed make the outcome a warning with a "not
imported" count.

A removal reports each skipped id with a reason (`skipped_items`):
`no_longer_missing` and `not_found` leave the list on reload, and
`has_live_links` (still linked to an object Jira returns) has its own
message; all three are deselected. `other_links_not_selected` (other missing
items of the same use case were not ticked) and `changed` stay selected, with
a message saying why; so does a reason the panel does not know. "Use cases
removed" counts projects; "Jira links removed" is shown next to it when it
differs. Links cleaned up are counted separately ("Links cleaned up"). A
delete that failed shows the server's message, which names the use case by
the requested link's title and Jira key. Failed and unsent ids stay selected,
so a retry is one click.

After an import the panel reloads the imported use cases and applies
`finishImport`'s updaters with that fresh list to the latest state (a "Load
more" or toggle made meanwhile is kept): imported objects leave the picker
and the selection, and nothing else is dropped. A "Load more" page is
filtered against the imported ids known when it lands (`appendPage`, with the
ids set where the imported list is fetched), so one still in flight during an
import cannot bring imported objects back. Picker requests run through
`runPickerRequest` with a generation (`createRequestGate`): a reset, an
object-type change or a fresh load starts a new one, a response from an older
one is dropped (objects and paging alike), and the loading flag is always
cleared (a reset clears it, and so does a failed load). A refresh reloads as
many pages as were loaded before, up to 5 (`loadPages`,
`MAX_REFRESH_PAGES`), de-duplicating objects by id and stopping if the next
offset is missing or does not move forward. Ticks on objects in the reloaded
pages are kept; the stored selection is pruned to the reloaded list in the
same step, so past 5 pages ticks on objects beyond them are dropped. A reset
or type change clears the selection. The effective selection is also derived at render
(`keepShown`), so nothing selected is ever hidden. The outcome is shown last.
All of this lives in `jira-assets/batching.ts`.

`removeMissingUseCases` (through `deleteUseCasesUnderClaim`):

1. takes the same claim, so it cannot race a sync or import (409)
2. reads the listed links, unlocked, for their project ids; locks those
   projects in this organization in one statement (`ORDER BY id FOR UPDATE`),
   which also classifies them as in this organization or not; then locks the
   listed links, then every link of a locked project (two queries, each
   ordered by id), and decides each listed id from those locked rows.
3. for each project in this organization, deletes it once only when every
   link of it is in the request and flagged missing. A project that also
   backs a link Jira still returns is skipped (`has_live_links`); one with
   flagged links that are not in the request is skipped
   (`other_links_not_selected`). Nothing the admin did not tick is ever
   removed by cascade. Otherwise the project goes through
   `deleteProjectWithSideEffects` (see below): approval withdrawal, change
   history, `deleteProjectByIdQuery` (files, risks, members, per-framework
   rows, custom-field values). Its links go with it (cascade): two selected
   links to one project make one removed use case and two `links_removed`. A
   locked project that fails to delete throws `JiraUseCaseDeleteFailedError`,
   which names the use case by the requested link's title and Jira key; the
   whole removal rolls back and the route returns 500 with that message. The
   `project_deleted` automation is queued after the transaction commits
   (`enqueueAutomationAfterCommit`), so a rolled-back removal fires none.
4. for a link with no project, or whose project is not in this organization
   (another organization's, or a bad id), deletes only the link row: no
   project is touched, no change history is written and no automation fires.
   It is reported as `unlinked`, not as a removed use case. Without this,
   such a link could never leave the "Missing in Jira" list. The database
   now enforces same-organization links (see below), so in practice this
   only handles links with a NULL `project_id`; the cross-organization check
   is unreachable and stays only until that migration's rollback window has
   passed.
5. records the run (`objects_deleted` = use cases, that is projects,
   removed; a note counts the links cleaned up)

Steps 2 to 4 run in one transaction, which first share-locks the run's own
history row so no other claim can close it mid-way.

Deleting a project: every path goes through `deleteProjectWithSideEffects`
(`Servers/utils/projectDeletion.utils.ts`), which runs, in this order: lock
the project row (`lockProjectForDelete`, unless the caller already holds
it; if there is no such project it stops there and touches nothing else),
withdraw a pending approval request, record the deletion in the change
history, then `deleteProjectByIdQuery` (which takes the lock again as its
first statement, a no-op within the transaction). The core "Delete use case" calls it
first thing in its transaction; the Jira flow locks its projects before any
link row and passes `alreadyLocked`; the demo-data driver locks each project
before deleting its NIST data and skips the approval and history steps. So
every path takes a project's lock before anything that references it, a
Jira removal and a core "Delete use case" on the same project wait for each
other instead of deadlocking, and the order cannot drift between callers.

`DELETE /use-cases/:id` deletes one imported use case through the same
`deleteUseCasesUnderClaim` flow (409 while a sync, import or removal runs; its
history row is `'remove_missing'` with `objects_deleted = 1`; 409
`removal_interrupted` if it lost its claim). It is an explicit action on the
project, so the project goes with all its links, and the response reports
them (`{ success, unlinked, links_removed }`). The requested project itself
is locked, so a link that changed between the unlocked read and the lock is
still found. A project that is not linked in
`jira_assets_use_cases` is 404 from an unlocked check before claiming, so it
never takes or waits on the claim (404, not 409, during a sync). If the link
vanished between that check and the locked one under the claim, the
transaction rolls back and the claimed history row is deleted, so nothing is
recorded. A link whose project is not in this organization has only its link
row deleted and returns 200 with `unlinked: true`.

**Same-organization links (database).** `jira_assets_use_cases.project_id`
references `projects` through a composite foreign key,
`(project_id, organization_id) REFERENCES projects (id, organization_id) ON
DELETE CASCADE` (`projects` has `UNIQUE (id, organization_id)` as its
target), so a link can only point at a project in its own organization; a
NULL `project_id` is allowed. The app only ever creates a link together with
its project, in one transaction, and never changes `project_id` afterwards.
Migration `20261012165625-jira-assets-link-same-org-fk.js` added the key. It
first copied existing links whose project was missing or in another
organization into `jira_assets_use_cases_fk_cleanup_backup` (named columns
plus `cleaned_at`; its `organization_id` cascades with the organization) and
deleted them, logging the count; no project was touched, and their Jira
objects can be imported again. It reuses an existing equivalent unique index
on `projects (id, organization_id)` (valid, immediate, non-partial, key
columns only) if there is one, otherwise it creates its own
(`projects_id_org_for_jira_link_fk_key`). The FK is added `NOT VALID`, then
validated. The old single-column FK is kept: dropping any FK from this table
to `projects` takes `ACCESS EXCLUSIVE` on `projects`, which the migration
avoids; it is redundant with the composite one and harmless. The old
`project_id` index is replaced by one on `(project_id, organization_id)`.
Locks, taken up front with a 10 s `lock_timeout`, projects first:
`SHARE ROW EXCLUSIVE` on `projects` (reads, including `SELECT ... FOR
UPDATE`, are not blocked; writes wait) and `ACCESS EXCLUSIVE` on
`jira_assets_use_cases`. Deploy it with the worker stopped or idle (no sync
running), as API and worker deploy together. `down()` drops the composite FK
(which does lock `projects` exclusively, briefly), its index and only its own
unique index, recreates the old index, and puts the backed-up links back where
the single-column FK allows it (organization and project still exist; a link
re-imported since wins). Restored rows leave the backup; the backup table is
dropped only when it is empty, otherwise it is kept and the remaining count is
logged. The id sequence is never moved backwards.

A use case a sync found again in the
meantime is no longer flagged and is skipped. The response is
`{ removed, links_removed, unlinked, skipped, skipped_items }`: `removed`
counts use cases (projects) deleted, `links_removed` the links that went with
them, and `skipped_items` is `[{ id, reason }]`. If the removal loses its claim before it finishes, the
transaction rolls back and the route returns 409 with
`{ message: "The removal was interrupted; nothing was removed. Try again.",
code: "removal_interrupted" }`. The panel switches on `code`, never on the
message text.

**Settings and validation.**

- `POST /config` validates `sync_interval_hours` (whole hours, 1 to 168).
- `PATCH /config/sync` changes only `sync_enabled` and/or
  `sync_interval_hours`.
- `PATCH /config/selection` changes only `selected_schema_id` and/or
  `selected_object_type_id`.

The panel saves sync settings one request at a time, keeps the newest result,
and reverts with an error if a save failed. The sync controls and the remove
button are disabled for non-Admins.

**Adding a scheduled sync to another extension:**

1. Write a candidate query that joins `extension_enablements` (jobs bypass
   `requireExtensionEnabled`). Compute due and live flags in SQL with the
   `scheduledSync.utils.ts` helpers.
2. Queue one job per org under a fixed job id, with a timeout on queue calls.
   Claim the run (with a token) when the worker picks the job up.
3. Heartbeat while running, and stop on a lost claim or a database error.
   Record every failure through a finalize step that never throws.
4. Never delete on a sync. Flag instead, set flags only after a complete walk,
   and leave removal to an explicit, confirmed Admin action.
5. Add tests: a case in `services/automations/tests/automationProducer.spec.ts`,
   and unit tests like those in `extensions/jira-assets/__tests__/`.

---

## Adding a new extension

Base it on `mlflow` if the extension has config fields and a connection test,
or on `risk-import` if it needs neither.

1. **Migration.** Create it with a `date`-generated timestamp (see
   `Servers/CLAUDE.md`). It should:
   - insert the `extensions` row. The key must match
     `^[a-z0-9][a-z0-9-]{0,63}$` and the category must be one of the allowed
     values.
   - insert `extension_config_fields` rows, if any. Set `is_secret: true` on
     credentials.
   - create any data tables with `organization_id` and FKs.

   Copy the insert logic in `20260811102307-extensions-migration.js`
   (`EXTENSIONS_SEED`, `CONFIG_FIELDS_BY_KEY`, and the `toPgTextArray` helper for
   `tags`).
2. **Icon.** Add it to `Clients/public/assets/extensions/` and set `icon_path`
   in the migration.
3. **Server code** in `Servers/extensions/<key>/`:
   - `<name>.route.ts` with `router.use(authenticateJWT)` and
     `router.use(requireExtensionEnabled("<key>"))`, plus `authorize([...])`
     where roles matter
   - `<name>.ctrl.ts` and `<name>.service.ts`. Read config with
     `ExtensionService.getRuntimeConfiguration("<key>", organizationId)`. All
     queries filter on `organization_id`.
4. **Mount** the router in `Servers/app.ts` at `/api/extensions/<key>`, after
   the `/api/extensions` catalog router. Use multi-segment sub-paths only.
5. **Connection test (optional).** Add a `TEST_CONNECTION_DISPATCH` entry in
   `Servers/controllers/extension.ctrl.ts`.
6. **Client UI** in `Clients/src/presentation/pages/Extensions/<key>/`:
   - Gate every entry point (tab, button, menu item) with
     `useExtensions().isEnabled("<key>")`.
   - If the extension has a post-enable settings panel, add its key to
     `KEYS_WITH_POST_ENABLE_UI` in `Extensions/index.tsx` and render the panel
     in `Extensions/Settings/index.tsx` next to the Slack, Model Lifecycle and
     Jira panels.
   - Pre-enable config fields need no client code. `ExtensionConfigForm`
     renders them.
7. **Tenant tables.** Register new tables in `Servers/scripts/migrationConfig.ts`
   and in the tenant-isolation audit (`Servers/scripts/auditTenantIsolationCoverage.ts`).
   CI fails for org-scoped tables it doesn't know about.
8. **API docs.** In `Servers/`, run `npm run generate:swagger`. It reads
   `app.ts` and the route files under `routes/` and `extensions/`, and merges
   the new endpoints into `swagger.yaml`. Add descriptions to those entries,
   then run `npm run generate:endpoints` to refresh
   `docs/api-docs/src/config/endpoints.ts`.
9. **User guide.** Add an article under `shared/user-guide-content/`.

---

## Migration from the plugin system (Aug 2026)

The old system loaded plugins at runtime from a separate plugin repository. It
had a marketplace, install/uninstall, `template.json` UI bundles and
`Servers/temp/plugins`. Two PRs replaced it:

- **Frameworks became core (PR #4443).** The 21 framework plugins (SOC 2, GDPR,
  HIPAA, ...) are declared in `Servers/structures/` and get real per-framework
  tables (framework ids 5–25). This was done by migrations
  `20260805125946-create-framework-struct-tables.js` and
  `20260805130326-create-framework-impl-tables.js`.
  `20260805131033-migrate-framework-data.js` copied implementation rows, risk
  links and evidence links from the legacy `custom_framework_*` tables.
  `20260807142621-fix-legacy-file-entity-links.js` repaired the old
  `file_entity_links`. The legacy tables were **not** dropped.
- **Integration plugins became extensions (PR #4512).**
  `20260811102307-extensions-migration.js` created the three catalog tables
  and seeded the seven extensions. It copied each `plugin_installations` row
  into `extension_enablements`, joined on `plugin_key = extensions.key`
  (`status = 'installed'` → `enabled = true`, configuration copied as-is).
  Then it **dropped** `plugin_installations`. Rows with unknown keys were
  logged and skipped. The same migration creates the Azure, Model Lifecycle
  and Jira data tables that the plugins used to create in their install hooks.

Removed: `/api/plugins/*` (marketplace, install, installations, UI bundle
serving), `plugin.route.ts`, `pluginGuard.middleware.ts` / `requirePlugin`,
`PluginSlot` and the `/plugins` page, `Servers/temp/plugins`, the
`build:framework-plugins` step, and the external plugin repository dependency.

## Known leftovers

These exist in the code today. They are recorded here so they are not mistaken
for live features.

- `Servers/database/seeds/plugins/manifests.json` is unused.
- `Clients/e2e/plugins.spec.ts` is skipped (`test.describe.skip`).
- `Servers/docs/api/files-plugins-shadow-pmm-openapi.yaml` keeps its old file
  name but now documents the `/extensions` catalog paths.
- The legacy `/api/slackWebhooks` router is still mounted in `Servers/app.ts`
  and is **not** behind the extension gate. It shares handlers with
  `/api/extensions/slack/oauth/workspaces`.
- Slack notification delivery (`Servers/services/slack/`) reads
  `slack_webhooks` directly and does not check whether the extension is
  enabled.
- The legacy `custom_framework_*` tables remain.
  `GET /api/extensions/jira-assets/projects/:projectId/custom-frameworks-progress`
  (`jiraAssets.service.ts`) still reads them.
- No scheduler exists for MLflow or Azure AI Foundry sync.
- The Frameworks page **Settings** tab
  (`Clients/src/presentation/pages/Framework/Settings`) only lists ISO 27001,
  ISO 42001 and NIST AI RMF. The bundled organizational frameworks are added
  through **Manage frameworks → Add/remove frameworks**.

## Related documentation

- [Compliance Frameworks](../domains/compliance-frameworks.md)
- [Adding a New Compliance Framework](../guides/adding-new-framework.md)
- [External Integrations](./integrations.md)
- [API Endpoints](../api/endpoints.md)
- [Middleware](../../claude/middleware.md)
