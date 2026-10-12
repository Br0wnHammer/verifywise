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
| `/api/extensions/jira-assets` | `GET/POST /config`, `PATCH /config/sync`, `PATCH /config/selection`, `GET /vw-attributes`, schema and object-type discovery (`GET /object-types/:id/objects` is one bounded page of up to 1000 for the import picker), `POST /import`, `POST /sync` (202, runs in the worker), `GET /sync/status`, `GET /sync/history`, `GET/DELETE /use-cases/:id`, `GET /use-cases`, `GET /projects/:projectId/custom-frameworks-progress` | `extension.admin` (Admin) on `POST /config`, `PATCH /config/sync`, `PATCH /config/selection`, `POST /import`, `POST /sync`, `DELETE /use-cases/:id`. Errors: 400 bad input, 404 not configured, 409 a sync or import is running, 502 Jira or network failure (reason in `error`). |
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
  the extension is disabled.

---

## Scheduled sync

Jira Assets is the first extension that syncs on a schedule. Follow the same
pattern for any later one (for example a Jira incident sync).

**A quick check job, then one sync job per org.** `scheduleJiraAssetsScheduledSyncCheck`
in `Servers/services/automations/automationProducer.ts` upserts the repeatable
`jira_assets_scheduled_sync_check` job on the `automation-actions` queue,
every 5 minutes (`*/5 * * * *`). It is registered in `addAllJobs()`
(`Servers/jobs/producer.ts`) through `safeSchedule`, and `createAutomationWorker`
(`automationWorker.ts`) dispatches it to `runJiraAssetsScheduledSyncAllOrgs`
in `Servers/extensions/jira-assets/jiraAssets.scheduler.ts`. The check does
not sync. For each due org it calls `startScheduledSync`, which claims a run
and queues a `jira_assets_sync_run` job. The check returns quickly, and each
org syncs independently in the worker (concurrency 10). The claim comes before
the enqueue, so overlapping ticks cannot queue two runs for one org: the
second claim throws `JiraSyncInProgressError` and the org is skipped. If
queueing fails, the claimed row is closed as failed.

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
  `last_sync_at` and the newest manual or scheduled `started_at`. Imports do
  not count. "Never synced" counts as due, and a manual sync resets the clock.

The pure `evaluateScheduledSync` turns these flags into a decision. No JS
`Date` parsing of a `TIMESTAMP` column decides anything. A sync runs only
when there is something to refresh and no run is live.

**Time.** The run columns (`started_at`, `heartbeat_at`, `completed_at`,
`last_sync_at`) are `TIMESTAMP WITHOUT TIME ZONE` holding UTC wall-clock time.
They are written with `(NOW() AT TIME ZONE 'UTC')` and compared against that
same expression. Sequelize's default `timezone: "+00:00"` also sets each
session to UTC (`SET TIME ZONE INTERVAL '+00:00'`) and serialises JS Dates as
UTC. The SQL is explicit, so it would stay right if that setting changed.
The building blocks are in `Servers/extensions/scheduledSync.utils.ts`:
`SQL_NOW_UTC`, `sqlIntervalElapsed`, `sqlWithinLastMinutes`.

**Scheduled runs only refresh.** A queued scheduled run executes
`runClaimedSync(orgId, historyId, null, "scheduled")`. The history row is
written with `sync_type = 'scheduled'` and `triggered_by = NULL`. A scheduled run updates
the project and the `jira_assets_use_cases` row of every linked object. It
never creates a use case and never deletes one. Linked objects that Jira no
longer returns are kept and reported:

- in the result, as `objectsMissingInJira` and `missingInJiraIds`
- as a note on the history row's `error_message` and the config's
  `last_sync_message` (the run is still `completed` / `success`), which the
  panel's "Last sync" line shows
- in a log line

**Manual sync runs in the worker.** `POST /sync` (`startManualSync`):

1. checks the config: 404 if it is not configured, 400 if no object type is
   selected
2. claims the run: 409 if a sync or import is running
3. queues a `jira_assets_sync_run` job (`syncType: "manual"`, one attempt),
   then returns 202 with `{ historyId }`

Manual and scheduled runs share the worker entry `runQueuedSync`, which
validates the payload:

- It fails closed when `organizationId` or `historyId` is missing or invalid,
  because there is then no row it can safely touch.
- It also fails closed on an unknown `syncType`, because guessing could turn a
  refresh-only run into one that deletes. The row is known in that case, so it
  is closed as failed first.
- An invalid `triggeredBy` only loses attribution, so it falls back to null.

After that, `runClaimedSync` is the single owner of the row's finalization. It
records failures and returns a failed result rather than throwing.

**Stale pickup.** A queued run first revives its heartbeat, but only if its row
is still `started` and still live (SQL). A row that went stale while queued is
not run. It is closed as "The sync waited too long to start", and the panel
shows that message.

The panel polls `GET /sync/status?historyId=<id>` every 3 seconds, for up to
20 minutes. That endpoint returns `run`: that history row (this org's only)
with `is_live` computed in SQL. Polling stops once the run is no longer
`started`, or no longer live. The panel then reports that run's own result:

- **completed:** the counts (created, updated, deleted, and "unlinked" when
  `links_removed` > 0)
- **failed:** the run's `error_message`
- **stopped heart-beating** (still `started`, or closed as abandoned): "The
  sync stopped responding. Try again."

The response also carries `running` and `latest_run`. The browser's
120-second request timeout no longer applies to a sync.

A manual sync creates use cases for new objects of the selected type, owned
by the user who started it. It removes the ones that disappeared upstream only
when the fetch can be trusted:

- If Jira returns 0 objects while links exist, the run fails and nothing
  changes.
- Deletes are skipped, and the missing objects reported, when any of these
  hold:
  - the fetch was incomplete
  - any link was imported from a different object type
    (`jira_assets_use_cases.data.objectType.id`)
  - any link's type is unknown ("skipped: type unknown")
- `objects_deleted` counts only projects actually removed (`DELETE ...
  RETURNING`). A link row with no project whose object is gone is removed on
  its own. It is counted in the history column `links_removed` (and
  `linksRemoved` in the result), and the panel shows it as "unlinked".

**Pagination, timeouts, deadline.** `JiraAssetsClient.getAllObjects` follows
the Assets API pages.

- **Cloud:** `POST object/aql?startAt=&maxResults=` with `{ qlQuery }`. Only
  `isLast === true` proves the end. `total` can be capped for large result
  sets (reported as 1,000), so reaching it proves nothing. The server may also
  return fewer rows than asked for, so a short page proves nothing either. The
  walk advances by the number of rows returned.
- **Data Center:** `GET iql/objects?...&page=&resultPerPage=`. There is no
  last-page flag, and `pageSize` (the page count) and `totalFilterCount`
  cannot be shown to be uncapped, so they are not used. The walk keeps asking
  for pages until one comes back partial or empty, and that page proves the
  end. A type whose size is an exact multiple of 50 costs one extra (empty)
  request.

Anything else returns `complete: false`: on cloud, an empty page without
`isLast`; the 500-page stop; or the deadline.

Every request has a 30-second timeout (`requestSignal`). The worker's walk has
an overall deadline of `WORKER_SYNC_DEADLINE_MS` (10 minutes). That stays well
inside the 15-minute stale window, because the sync heartbeats after every
page. When the deadline passes, the fetch is flagged and the run fails with
"Jira did not return every object within 10 minutes, so nothing was changed".
Browser-initiated calls (discovery, the picker, the connection test) keep the
110-second `EXTERNAL_SYNC_DEADLINE_MS`.

Jira and network failures become `JiraUpstreamError`, with the status or the
cause from `describeFetchError`. That includes a response body that times out
or cannot be read.

The import picker (`GET /object-types/:id/objects?startAt=`) uses
`getObjectsPage`. That is one request for up to 1000 objects, and it never
walks further pages. It returns `{ objects, hasMore, nextStartAt }`. When
`hasMore` is true, the panel shows "More objects exist in Jira than are shown
here." with a **Load more** button that asks for the next page.

**Atomic writes.** A new use case (project plus link row) is created in one
transaction. A unique violation on `(organization_id, jira_object_id)` counts
as "already linked". An updated use case (project plus link row) is also
written in one transaction.

**No overlap: sync, scheduled sync and import share one claim.** Every sync
and every import (`POST /import`, `sync_type = 'import'`) starts with
`claimSyncRun`. In one transaction it:

1. takes `pg_advisory_xact_lock(hashtext('jira_assets_sync'), orgId)`
2. closes as failed any `started` row with no heartbeat for 15 minutes
   (`NOT SQL_RUN_IS_LIVE`, computed in SQL)
3. inserts the new `started` row only if no other is left. Otherwise it
   throws `JiraSyncInProgressError`.

A run touches `heartbeat_at` at pickup (live rows only), after every fetched
page, every 25 objects, before the delete phase and every 25 deletes. If that update affects 0 rows, another claim has
closed the run as abandoned. `touchHeartbeat` then throws `RunSupersededError`
and the run stops at once, with no further writes. Inside the delete phase,
that means the remaining deletes are not made. Both finalize steps update
only their own row, by id and while it is still `started`. If that update
affects 0 rows, they leave the config alone.

- `heartbeat_at` and the `'import'` sync type come from migration
  `20261012003957-jira-assets-sync-heartbeat.js`.
- `links_removed` comes from `20261012013720-jira-assets-sync-links-removed.js`,
  a separate migration so databases that already ran the first one still get
  the column.

If an import is closed as abandoned part-way, it stops and `POST /import`
returns 409 with `{ message, imported, skipped }`. Objects imported before
that stay imported.

**Failures are recorded and back off.** For a sync, every failure after the
claim is written to the history row and the config by `finalizeFailure`. That
covers a missing config, a token decrypt error, Jira and network errors, the
deadline and the empty-fetch guard. The config fields are `last_sync_at`,
`last_sync_status = 'failed'` and `last_sync_message`. The scheduler's
interval counts from that failure, so a broken org is retried once per
interval, not every 5 minutes. Import failures are recorded on the import's
history row only. They never touch `last_sync_*`, so an import cannot shift
the sync schedule. `finalizeFailure` never throws.

**Settings and validation.**

- `POST /config` validates `sync_interval_hours` (whole hours, 1 to 168).
- `PATCH /config/sync` changes only `sync_enabled` and/or
  `sync_interval_hours`.
- `PATCH /config/selection` changes only `selected_schema_id` and/or
  `selected_object_type_id`. A field left out is kept, and null clears it.
- Both PATCH routes return 400 on bad input and 404 before a connection has
  been saved. Both are three segments below `/api/extensions`, so the catalog
  router cannot shadow them.

The panel saves sync settings through `PATCH /config/sync`, one request at a
time, in order. When the newest request settles, the controls are set to the
server's last confirmed values. If any request in that burst failed, the panel
also shows "Could not save the sync settings. Try again." Schema and
object-type picks go through `PATCH /config/selection`. The sync controls are
disabled for non-Admins.

**Adding a scheduled sync to another extension:**

1. Write a candidate query that joins `extension_enablements` (jobs bypass
   `requireExtensionEnabled`). Compute due and live flags in SQL with the
   `scheduledSync.utils.ts` helpers.
2. Claim before doing anything, with an overlap guard that manual runs share
   too. Heartbeat while running, and stop when the heartbeat finds the run
   closed. Record every failure through a finalize step that never throws.
3. Make the scheduled run conservative: refresh only, and never delete on an
   unconfirmed, empty or timed-out fetch.
4. Run every sync in the worker as its own job: user-triggered ones return
   202 and the panel polls a status endpoint, and the scheduled check only
   claims and queues.
5. Add a `schedule…` function with `upsertJobScheduler` and no obliterate.
   Register it in `addAllJobs()` after the obliterating schedulers, and
   dispatch it in `createAutomationWorker`.
6. Add tests: a case in `services/automations/tests/automationProducer.spec.ts`,
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
