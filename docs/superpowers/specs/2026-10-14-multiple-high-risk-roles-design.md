# Multiple high-risk roles on a use case — design

**Date:** 2026-10-14
**Status:** Approved in conversation; awaiting written-spec review
**Branch:** `feature/multiple-high-risk-roles`

## Why

A customer asked whether a use case can have more than one EU AI Act role, for
example Provider and Deployer at the same time. Today it cannot: each use case
has one `type_of_high_risk_role` (Provider or Deployer). An organization that
builds an AI system and also uses it in-house is both, and has the obligations
of both.

## Scope

**In:** a use case can hold Provider, Deployer or both. Everything that reads the
role (requirements filter, EU AI Act questionnaire, intake, screens, exports,
automations, change history, API) handles the list.

**Out:** new roles (Importer, Distributor, Authorised representative, Product
manufacturer — collapsed into Provider/Deployer by migration
`20260421234619-reduce-high-risk-role-to-provider-deployer.js`; bringing them back
needs a compliance decision on which requirements apply to each), custom role
labels, per-role progress breakdowns. "Downstream deployer" is not an EU AI Act
term; the closest is "downstream provider" in the general-purpose AI chapter.

## Success criteria

1. A use case with both roles shows the High risk and GPAI requirement
   categories of both roles; compliance progress, readiness and the compliance
   report count them.
2. The EU AI Act questionnaire accepts both roles and lists the obligations of
   both, without repeats.
3. Existing API clients, Jira Assets mappings and automation templates keep
   working without changes, and cannot silently drop a role.
4. Existing data migrates with no change in behaviour: every current use case
   sees exactly the same requirements as before.

## 1. Data and API

### Storage

- New column `projects.high_risk_roles TEXT[] NOT NULL DEFAULT '{}'` with
  `CHECK (high_risk_roles <@ ARRAY['Provider','Deployer']::text[])`. A text array
  is used instead of an array of the existing enum because Sequelize handles
  enum arrays poorly and raw SQL would need casts and an empty-array special case.
- Migration (one file, `verifywise.` prefix in DDL, one transaction):
  1. Add the column.
  2. Backfill `high_risk_roles = ARRAY[type_of_high_risk_role::text]` where the
     old column is not null.
  3. Drop `type_of_high_risk_role`. The enum type
     `enum_projects_type_of_high_risk_role` stays (the down migration needs it,
     and dropping types is not worth the risk).
  - **Down:** re-add `type_of_high_risk_role` as the enum, set it to `Provider`
    when the list contains Provider, else `Deployer` when it contains Deployer,
    else null; drop `high_risk_roles`. A use case with both roles loses Deployer;
    the migration file says so.
- Every raw SQL reader of the old column is updated in the same change (known:
  `eu.utils.ts` filter, `approvalRequest.utils.ts`, `project.utils.ts` create and
  update, `euAiActClassification.utils.ts` write-back, Jira Assets sync,
  seeds). A missed one fails with an SQL error, not wrong data.
- The application always stores the list normalised: no duplicates, fixed
  order Provider then Deployer. One helper (`normalizeHighRiskRoles`) does this
  and is used by every write path.
- `eu_ai_act_classifications` gets `roles TEXT[] NOT NULL DEFAULT '{}'` with the
  same CHECK. The existing `role` column stays and is filled with the derived
  single value (rule below), so older records read as before. Backfill
  `roles = ARRAY[role]` where `role` is not null.

### API

- **Read:** project responses gain `high_risk_roles: string[]`. They keep
  `type_of_high_risk_role`, derived by one helper (`legacyHighRiskRole`):
  `Provider` if the list contains Provider, `Deployer` if it contains only
  Deployer, `null` if empty. Swagger marks it deprecated.
- **Write:** create and update accept either field.
  - `high_risk_roles` replaces the list (after normalising).
  - `type_of_high_risk_role: X` is a no-op when X is already in the use case's
    list; otherwise it sets the list to `[X]`. `null` clears the list. This stops
    a client that reads the derived value and writes it back from dropping a
    role.
  - Both fields present and disagreeing (the legacy value is not in the new
    list, or is null while the list is not empty) → 400.
- **Validation** (`projectValidation.utils.ts`, `project.validator.ts`), same rule
  as today applied to the list:
  - Only `Provider` and `Deployer`; duplicates are normalised away, not rejected.
  - EU AI Act among the frameworks (non-organizational project) → at least one
    role. Error: "Select at least one high-risk role when EU AI Act is selected."
  - Otherwise, and for organizational projects → the list must be empty
    (existing `HIGH_RISK_ROLE_WITHOUT_EU_AI_ACT` code, message adjusted).
  - `validateRiskClassificationConsistency` takes the list; every element must
    be a valid role.

### Requirements filter

`getVisibleEuCategoryIdsForProject` (`Servers/utils/eu.utils.ts`) reads
`p.high_risk_roles` and matches a role-filtered category (tiers High risk and
GPAI) when `r.name = ANY(:roles)`. An empty list matches no role-filtered
category, exactly as a null role does today. Its callers — compliance counts,
the requirements tracker, readiness scoring, the compliance report, the
categories endpoint — need no change beyond what they pass through.

## 2. Questionnaire, intake and other consumers

### EU AI Act questionnaire (`Servers/services/euAiActClassification/`)

- `questionnaire.v2.ts` role question: `inputType: "multi_select"` (already
  supported; the transparency question uses it), same options and article
  reference, text "What is your role for this AI system? Select all that apply."
  The questionnaire version is not bumped: every saved single-role answer is a
  valid answer to the new question.
- `score.v2.ts`:
  - `toRoles(answer)` returns the normalised list from a string or an array.
  - `highRiskObligations(routes, roles)` iterates roles in order Provider then
    Deployer and keeps the existing article+text de-duplication.
  - Transparency obligations: kept when the list is empty or contains the
    obligation's role.
  - The result carries `roles` and, for compatibility, `role` (legacy derived
    value).
- Saved single-role answers score exactly as before; the wizard pre-fills them as
  a one-item selection.
- Write-back (`setUseCaseClassificationQuery`): a non-empty `roles` replaces the
  use case's list; an empty one leaves it unchanged (today's `COALESCE`).
  `eu_ai_act_classifications` stores `roles` and the derived `role`.
- The reviewer wizard result mapping in `ProjectSettings` sets the list.

### Intake forms

- The risk step on the public form renders the same multi-select question; on
  approval (`intakeForm.ctrl.ts`) all roles go to the new use case
  (`high_risk_roles: computed.roles`).
- The mapping target for the role field (`IntakeFormBuilder/types.ts`) accepts
  `select` and `multiselect` questions. Each selected option sets one role,
  matched by label as today. Options that are not Provider or Deployer are
  ignored, and the submission preview names them ("Not a high-risk role:
  <label>") instead of dropping them silently.
- `RISK_STEP_SET_FIELDS` keeps working with the field name unchanged.

### Other consumers

- **Change history** (`changeHistory.config.ts`): the field is compared as a set
  and displayed as "Provider, Deployer"; reordering records nothing.
- **Automations** (`project.automation.utils.ts`): `{{project.type_of_high_risk_role}}`
  renders the full list ("Provider, Deployer"); the role-changed comparison
  compares sets.
- **Approval requests** (`approvalRequest.utils.ts`, `entityTypeConfig.tsx`):
  select and display the list.
- **Jira Assets sync** (`jiraAssets.service.ts`): passes `high_risk_roles` and
  keeps sending the derived `type_of_high_risk_role` for existing mappings.
- **Auto driver and seeds:** write lists (`['Deployer']`).
- **Enum manifest / drift script:** the `HighRiskRole` enum values are unchanged;
  regenerate the manifest if its shape requires it and keep
  `checkEnumLabelDrift.ts` passing.

## 3. Screens, docs and testing

### Screens

- The role field becomes a multi-select (`AutoCompleteField` with `multiple`,
  as used for "Applicable regulations") in `Forms/ProjectForm`,
  `CreateProjectForm` and `ProjectView/ProjectSettings`.
- Label "High-risk roles" (was "Type of high risk role"); required message
  "Select at least one high-risk role when EU AI Act is selected." The "If you are
  not sure…" link to the questionnaire stays.
- List display "Provider, Deployer" in: use case table (sorting by the joined
  string), CSV export, entity graph sidebar, approval request details, intake
  submission preview.
- `project.mapper.ts`: `mapHighRiskRoles` maps to the list; unknown values are
  dropped (no more silent default to Provider). Legacy inputs (`not_applicable`,
  1, 2, a single string) still map.
- Frontend DTOs, types and ports carry `high_risk_roles: HighRiskRole[]`; the
  legacy field is read only where an external shape needs it.
- New and changed strings get de, fr and es entries in `Clients/src/i18n/translations.ts`.

### Docs

- `shared/user-guide-content/content/ai-governance/use-cases.ts`: replace the
  outdated six-role list with the two roles and multi-selection (mirror to the
  website repo, uncommitted).
- `shared/user-guide-content/content/ai-governance/intake-forms.ts`: multi-select
  mapping and the questionnaire change (mirror likewise).
- `docs/technical/domains/use-cases.md`: column, derived legacy field, write rule,
  filter; remove the outdated role list.
- `Servers/swagger.yaml` regenerated (`npm run generate:swagger`,
  `generate:endpoints`, `check:api-drift`); `Servers/docs/api/projects-openapi.yaml`
  updated by hand if it is not generated.
- Stale schema copies (`Servers/SQL_Commands.sql`, `Servers/docs/schema.dbml`)
  updated for the new column.

### Testing

- **Backend (Jest):** `normalizeHighRiskRoles` and `legacyHighRiskRole`; the write
  rule (no-op on an existing role, replace on a new one, 400 on conflict); validation with and
  without the EU AI Act and for organizational projects; scorer (both roles →
  union without repeats; old single-role answers unchanged; transparency filter);
  intake approval with both roles; change-history set comparison.
- **Requirements filter** against the test database: Provider only, Deployer only,
  both, empty — both shows the union of the first two.
- **Migration:** up, down, up on the local dev database; existing rows keep the
  same visible categories.
- **Frontend (Vitest):** forms (multi-select, required rule, payload), mapper,
  table display and sort, intake mapping with a multi-select question; existing
  tests, factories and e2e fixtures updated to the list shape.
- **Gates:** `cd Servers && npm run build && npm run format-check`;
  `cd Clients && npm run typecheck && npm run i18n:audit:strict && npm run lint && npx vitest run`;
  Semgrep PR gate locally; `/code-review` before any PR.

## Risks

- **Missed raw SQL reader of the dropped column.** Mitigation: grep for
  `type_of_high_risk_role` across `Servers/` after the change; every remaining
  hit must be the derived API field, the legacy input or docs.
- **Down migration is lossy** for both-role use cases (documented).
- **Integrators writing `type_of_high_risk_role`** can only set a single role; the
  no-op rule keeps them from removing one.
