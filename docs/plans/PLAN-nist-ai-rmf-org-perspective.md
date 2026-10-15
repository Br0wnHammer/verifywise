# Plan: AI Advisor NIST AI RMF org-perspective fix

Issue: `docs/plans/ISSUE-nist-ai-rmf-org-perspective.md`
Repro: `Servers/advisor/tests/repro/orgPerspective.repro.test.ts` (temporary; deleted in Step 1 — its assertions are the negation of the fix and would keep the suite red)

## Background (confirmed by exploration)

- NIST AI RMF = `framework_id 4`, `is_organizational = true`; it is tracked on the
  org-wide project (`projects.is_organizational = true`) via `projects_frameworks`.
- All NIST read tools resolve `project_id → projects_frameworks.id` via
  `getProjectFrameworkId` (`Servers/advisor/functions/nistAiRmfFunctions.ts:14-26`),
  which throws a non-actionable error when no link exists.
- `list_projects` strips `is_organizational` (`projectFunctions.ts:93-100`), so the
  model cannot identify the org project.
- Tool bridge catches function errors and returns `{ error: message }` to the model
  (`toolBridge.ts:219-224`) — so improving the message is sufficient for the model to
  relay setup guidance.
- `advisor.ctrl.ts:167` spreads `availableNistAiRmfTools` and `:213` spreads
  `nistAiRmfToolsDefinition` (import alias for the `toolsDefinition` export of
  `nistAiRmfTools.ts`) wholesale — adding entries to those source files requires NO
  controller change.
- Routing: NIST tools fall into the "universal" bucket (the names in
  `agents/agentToolMap.ts:159-172` are stale and match nothing, so
  `routing.ts:147-154` treats all real NIST tools as universal). A new unclaimed NIST
  tool is automatically exposed. Fixing the stale map is out of scope (pre-existing
  drift affecting EU/ISO equally).
- Count utils `countSubcategoriesNISTByProjectId` /
  `countSubcategoryAssignmentsNISTByProjectId` (`utils/nistAiRmfCorrect.utils.ts:29-69`)
  are pure org-scoped aggregate SELECTs that return **strings** (NULL possible on zero
  rows). They never auto-create rows — subcategory rows are created only at
  framework-link time.
- Authorization convention: advisor read tools are org-scoped only (no per-user
  membership filtering, unlike `getUserProjects`). The new tool follows this existing
  convention; not a regression.
- i18n: `Servers/scripts/extract-i18n-keys.mjs:53-60` does not scan `advisor/`, so the
  i18n audit is vacuous for these files (still run in final validation, but it proves
  nothing about the advisor changes). All advisor error strings are English-only today.

## Step 1 — Actionable missing-framework error

File: `Servers/advisor/functions/nistAiRmfFunctions.ts`

- In `getProjectFrameworkId`, replace
  `NIST AI RMF framework not found for project #${projectId}` with an actionable
  message, e.g.:
  `NIST AI RMF is not linked to project #${projectId}. To set it up: (1) go to the Frameworks page, (2) select your organizational project, (3) add the NIST AI RMF framework, then try again.`
- The message reaches the model wrapped as
  `Failed to fetch NIST AI RMF progress: <message>` (existing per-tool wrapping) via
  the tool bridge's `{ error }` return — acceptable and intact.
- Delete `Servers/advisor/tests/repro/orgPerspective.repro.test.ts` in this step (its
  assertions encode the old broken behavior).
- No other behavior change; per-project contract preserved.

## Step 2 — Organization-scoped aggregation tool

Files: `Servers/advisor/functions/nistAiRmfFunctions.ts`, `Servers/advisor/tools/nistAiRmfTools.ts`

- New function `getNistOrgProgress(params, organizationId)`:
  - Discovery query (raw SQL with replacements, org-scoped, same convention as
    `getProjectFrameworkId`; note `projects_frameworks.organization_id` is nullable —
    NULL-org rows are dropped, consistent with the existing lookup):
    `SELECT pf.id AS project_framework_id, pf.project_id, p.project_title, p.is_demo
     FROM projects_frameworks pf
     JOIN projects p ON p.id = pf.project_id AND p.organization_id = pf.organization_id
     WHERE pf.organization_id = :organizationId AND pf.framework_id = 4`
  - **Zero linked projects:** return a structured result (not an exception) with an
    explicit discriminator so the model cannot misread it as real progress:
    `{ status: "not_configured", linkedProjects: 0, projects: [], totals: null, message: "<same actionable setup text as Step 1, org-phrased>" }`.
  - **One or more linked projects:** for each non-demo project, call
    `countSubcategoriesNISTByProjectId` + `countSubcategoryAssignmentsNISTByProjectId`
    (via `Promise.all`, as `getNistProgress` does) with that row's
    `projects_frameworks.id`.
  - **Demo contamination guard:** the Auto Driver can create a *demo* org project with
    NIST linked and mock statuses. Exclude `is_demo = true` projects from `totals`;
    surface them separately (e.g. `excludedDemoProjects: [{ project_id, project_title }]`)
    so nothing is hidden and nothing fabricated.
  - **Aggregation rules (from review):** coerce every count with `parseInt(x) || 0`
    *per project before summing* (counts are strings; NULL possible). Sum raw counts
    only. Recompute `completionPercentage` / `assignmentPercentage` from the summed
    counts with a `> 0` denominator guard — never sum percentages.
  - Result shape: `{ status: "ok", linkedProjects: N, projects: [{ project_id, project_title, totalSubcategories, doneSubcategories, completionPercentage, ... }], totals: { ...summed counts + recomputed percentages }, excludedDemoProjects: [...] }`.
  - If all linked projects are demo-only, return the `not_configured` shape with a
    message noting only demo data exists.
  - Partial failure policy: if any linked project's count call rejects, the tool fails
    wholesale with the wrapped `Failed to fetch ...` error (consistent with the
    per-project tools; no silent partial data).
- New tool definition `get_nist_org_progress` (no parameters — follows the
  `get_nist_functions` precedent) in `nistAiRmfTools.ts`. Its description carries the
  routing guidance (per `prompts.ts` design principle #3): use it for
  organization-level NIST AI RMF questions; use the project-scoped tools for a
  specific named project; when it returns `status: "not_configured"`, relay the setup
  steps and never present the result as progress data.
- Register in `availableNistAiRmfTools`. Controller unchanged (wholesale spread).

## Step 3 — Model routing: prompts + project resolution

Files: `Servers/advisor/prompts.ts`, `Servers/advisor/functions/projectFunctions.ts`,
`Servers/advisor/tools/projectTools.ts`

- `projectFunctions.ts` / `projectTools.ts`: include `is_organizational` in the
  `list_projects` SELECT, mapping, `AdvisorProjectSummary` interface, and tool
  description (which enumerates returned fields), so the model can identify the
  org-wide project. Precedent: `list_frameworks` already exposes `is_organizational`;
  no cross-tenant concern (query is org-scoped).
- `prompts.ts`: add a short "For NIST AI RMF Questions" block in the GUIDELINES
  section (matching the file's established per-domain style):
  - Organization-level NIST AI RMF questions → call `get_nist_org_progress` directly;
    no project id needed.
  - Project-specific NIST questions → resolve the project via `list_projects`; on zero
    or multiple matches, ask ONE clarifying question naming the candidates.
    **This bullet must be worded as an explicit, narrow exception** to the blanket
    "never ask clarifying questions" read-tool rules (`prompts.ts:76,189,362`) —
    e.g. "Exception to the never-ask rule: ..." — otherwise the absolute rules win.
    (Requested behavior; reviewers flagged the conflict and this wording resolves it.)
  - If a NIST tool returns the not-linked error or `status: "not_configured"`, relay
    the setup steps; never present it as progress.

## Step 4 — Focused unit tests

File: `Servers/advisor/tests/functions/nistAiRmfOrgProgress.test.ts` (new), following
the `getComplianceScore.test.ts` / `agentSendInvitation.test.ts` conventions.
The LLM is never called.

Mocks (per review):
- `jest.mock("../../../database/db")` with a controllable `sequelize.query` — beware
  the two return shapes: tuple form for `getProjectFrameworkId` (no QueryTypes) vs.
  rows-array for `QueryTypes.SELECT` queries.
- `jest.mock("../../../utils/nistAiRmfCorrect.utils")`.
- `jest.mock("../../approval/approvalGateway", () => ({ submitForApproval: jest.fn() }))`
  — avoids a real IORedis client connecting at import time via
  `createWriteTool` → `approvalGateway` → `confirmationStore` → `redis.ts`.
- `jest.mock("../../../utils/logger/fileLogger")` (matches `readinessFunctions.test.ts`).

Test cases:
1. Step 1: `get_nist_progress` with no framework link throws the fully wrapped
   actionable message (`Failed to fetch NIST AI RMF progress: NIST AI RMF is not
   linked... To set it up: ...`).
2. toolBridge propagation: bridge `get_nist_progress`, execute with a failing lookup,
   assert the model-facing `{ error }` contains the actionable setup text (pins the
   contract that makes Step 1 sufficient with no controller change).
3. `get_nist_org_progress`, zero linked projects → `status: "not_configured"`,
   `totals: null`, setup message present.
4. Single linked project → counts pass through, percentages correct.
5. Multiple linked projects with **string** counts and a NULL (`doneSubcategories:
   null`) → coercion works, totals summed, percentages **recomputed** from summed
   counts (e.g. 25/100 + 40/40 → 65/140 ≈ 46%, not 65%).
6. Demo project linked alongside a real one → demo excluded from totals, listed in
   `excludedDemoProjects`; demo-only org → `not_configured`.
7. DB/count failure → wrapped `Failed to fetch ...` error (wholesale fail policy).
8. SQL shape: discovery query contains `framework_id = 4` and the org filter;
   replacements carry only `organizationId` (no interpolation).
9. `list_projects` output includes `is_organizational`.
10. Definition↔implementation parity: every name in `nistAiRmfTools.ts`
    `toolsDefinition` exists in `availableNistAiRmfTools` and vice versa (the tool
    bridge silently skips unmatched definitions).
11. Light prompt drift-guard: `getAdvisorPrompt()` mentions `get_nist_org_progress`
    and the org-level routing rule (no prompt-assertion framework).

Note: no existing test snapshots the NIST tool catalogue
(`__tests__/routingRealCatalogue.test.ts` doesn't import NIST tools; its only size
assertion is `> 60`), so adding a tool breaks nothing.

## Final validation

In `Servers/`: `npm run format-check` (fix with `npm run format` on changed files),
`npm run i18n:audit` (vacuous for advisor/, run anyway), `npx jest advisor` plus
`npm run test:unit` (broader suite), `npm run build`. Report actual results; fix any
failures introduced by the changes.

## Out of scope

- Stale tool names in `agents/agentToolMap.ts` / `agents/compliance.agent.ts`
  (pre-existing drift affecting EU/ISO/NIST equally).
- Same org-perspective gap in ISO 42001 / ISO 27001 tools (possible follow-up issue;
  EU AI Act is project-based by design).
- Filing the GitHub issue itself (report is issue-ready; can file via `gh` on request).

## Review record

Reviewed by three independent sub-agents (architecture, edge cases, test coverage) —
all **APPROVE WITH CHANGES**. Integrated amendments: percentage recomputation from
summed counts, string/NULL count coercion, demo-project exclusion, `not_configured`
discriminator, explicit exception wording for the clarifying-question rule,
approvalGateway/fileLogger mocks, toolBridge propagation test, SQL-shape test,
definition parity test, repro deletion moved to Step 1, corrected export/convention
references, authorization and i18n notes.
