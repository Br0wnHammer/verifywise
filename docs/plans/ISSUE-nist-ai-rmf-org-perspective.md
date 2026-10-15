# Issue: AI Advisor cannot answer NIST AI RMF organization-level questions

**Component:** AI Advisor (`Servers/advisor/`)
**Severity:** Medium — feature gap with a confusing error path
**Date:** 2026-10-15

## Summary

NIST AI RMF is an *organizational* framework (`framework_id = 4`,
`is_organizational = true` — seeded in
`Servers/database/migrations/20260226234301-public-schema-tables.js:207`).
In the product it is tracked on the organization's single org-wide project
(`projects.is_organizational = true`), not on individual use cases.

The AI Advisor's NIST tools, however, are purely *project-scoped*: every
progress/status tool hard-requires a `project_id`, and nothing lets the model
(a) discover which project holds the org's NIST assessment, or
(b) aggregate progress across all NIST-linked projects in the organization.

Result: questions like "How are we doing on NIST AI RMF?" either fail with a
non-actionable error or silently require the user to already know an internal
project id.

## Reproduction

Reproduced with `Servers/advisor/tests/repro/orgPerspective.repro.test.ts`
(mocked DB + NIST counting utils, no database needed):

```
cd Servers && npx jest advisor/tests/repro/orgPerspective.repro.test.ts
```

### Setup (a): organization with NO NIST-linked projects

`get_nist_progress({ project_id: 5 })` throws:

```
Failed to fetch NIST AI RMF progress: NIST AI RMF framework not found for project #5
```

(`Servers/advisor/functions/nistAiRmfFunctions.ts:23`). The message names no
remedy — it does not tell the user or the model that NIST AI RMF must be
linked to the organizational project, or how to do it.

### Setup (b): org-wide project IS linked to NIST AI RMF

Per-project progress works *if the caller already knows the org project id*:

```json
{"totalSubcategories":100,"doneSubcategories":25,"completionPercentage":25,"totalAssigned":40,"assignmentPercentage":40}
```

But:

1. **The model cannot discover the org project.** `list_projects`
   (`Servers/advisor/functions/projectFunctions.ts:93-100`) strips
   `is_organizational` from its output, so the model cannot distinguish the
   org-wide project from use cases.
2. **No org-scoped aggregation tool exists.** The NIST tool surface is
   `get_nist_functions`, `get_nist_categories_by_function`,
   `get_nist_subcategory_detail`, `get_nist_progress`,
   `get_nist_progress_by_function`, `get_nist_status_breakdown`,
   `agent_update_nist_subcategory` — every progress/status tool requires
   `project_id`. Nothing aggregates across all NIST-linked projects in the
   organization.
3. **`project_id: 0` cannot be used as an org sentinel** — the tool bridge
   strips any `*_id: 0` parameter (`Servers/advisor/toolBridge.ts:191-193`).

## Expected behavior

- When NIST AI RMF is not linked anywhere in the organization, the error
  message tells the user exactly how to set it up (link NIST AI RMF to the
  organizational project via the Frameworks page).
- The advisor can answer organization-level NIST AI RMF questions by
  discovering all NIST-linked projects and aggregating their progress, without
  requiring a specific project id.
- Organizations with zero and with multiple NIST-linked projects are both
  handled gracefully.

## Constraints / non-goals

- Preserve organization scoping, authorization, existing tool contracts, and
  project-level functionality.
- Do not silently link frameworks or fabricate progress.
