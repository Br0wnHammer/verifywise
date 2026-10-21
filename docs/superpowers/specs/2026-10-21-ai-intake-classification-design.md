# AI-assisted intake, part 1: classification, scoring and suggested risks

Date: 2026-10-21
Branch: `feature/ai-intake-classification` (off `origin/develop` @ 2454c4785)
Reference demo: `docs/demos/ai-intake-review.html` in the main checkout (untracked), published at https://claude.ai/artifact/NbqsjFHhQSxQqVxiCKN66A, tabs "Classify and score" and "Suggested risks"

## Why

A customer focused on the EU AI Act has seen the AI intake demo and wants it in the product. Their AI governance team reviews intake submissions, and as soon as a submission arrives they want to see:

1. its EU AI Act classification,
2. a risk score they can trust and understand,
3. the risks it is likely to carry, ready to add to the register.

Today the reviewer gets a keyword score and, if the form enables it, a rule-based EU AI Act classification. Nobody reads the free-text answers for risk, nothing suggests risks, and a failed scoring run fails silently.

This is part 1 of 3. The user set the order:

1. **This document:** classification, scoring and suggested risks.
2. Later: risk-based routing to reviewers (≥50% to Person A, <50% to Person B, prohibited or ±10 band to A, 1-in-10 random audit of B approvals), and the oversight dashboard.
3. Later, not yet scheduled: live checks while filling in the form, the full reviewer brief (summary, grouped flags, "3 things to check"), and weekly oversight emails.

## Goals

- Every new submission gets a **final risk score (0–100)** built as max(rule minimum, AI median of 5 runs), with the range and the AI's reasons shown.
- The **EU AI Act questions step is on by default** for new forms. Turning it off shows the admin what they lose.
- The reviewer can open **"How this score is built"** in the app and see every input to the number. The user's condition for the design: "as soon as the customer knows how that score is built / shown, inside the app."
- Every new submission gets **suggested risks**. The reviewer can edit, accept, dismiss or accept all of them. Accepted ones are created **on approval**: as use-case risks when the submission creates a use case, as **model risks** when it creates a model.
- Scoring and suggestion status is visible (running, done, AI not set up, failed with retry). Nothing fails silently.

## Non-goals (this part)

- Routing to different reviewers, the oversight dashboard, digest emails, live form checks, the reviewer brief. These are parts 2 and 3.
- A second-model "AI judge" check. **Dropped by the user. Do not build it.**
- A score distribution chart or threshold slider. **Dropped by the user.**
- Changing the EU AI Act questionnaire or its rules (`euAiActClassification/questionnaire.v2.ts`, `score.v2.ts`).
- Re-scoring historical submissions.

## Anti-goals (failures even if it "works")

- **The AI, or a reviewer's score override, lowers a score below the rule minimum.** The rule floor is authoritative for both (user: "the minimum hold for people too").
- **A number is shown that was not computed.** No placeholder scores, no AI median when the AI did not run.
- **Anything is approved, or any risk is created, without a person deciding.** The user said "always add human in the loop". There is no auto-approve.
- **Risks are created on reject**, or before approval.
- **The score is presented as a probability or a confidence.** It is a score. Use the words "score" and "range", never "probability", "confidence" or "certainty".
- **The copy claims compliance that the code doesn't deliver**, or cites ISO 42001 control IDs. Articles shown must come from `score.v2.ts` reasons.
- **The legal EU AI Act classification and the score contradict each other on screen.** For example, "Limited risk" next to a tier labelled "Unacceptable". See *Display* below.

## Existing code to build on (verified 2026-10-21 against develop)

| Piece | Where | Notes |
|---|---|---|
| EU AI Act step | `Servers/services/euAiActClassification/*`, flag `intake_forms.eu_ai_act_risk_step_enabled` | Multiple-choice only. `scoreV2(answers)` → `{level, roles, reasons[{article,text,appliesFrom}], obligations}`. Levels: Prohibited, High risk, Limited risk, Minimal risk, Out of scope. Stored in `eu_ai_act_classifications` inside the submit transaction (`intakeForm.ctrl.ts` ~2057). Column default is `false` (migration `20261008120100`) |
| Keyword score | `Servers/services/intakeRiskScoring.service.ts` | `calculateSubmissionRisk` (:555), `enhanceWithLLM` (:425, one call, ±15 per dimension), `TIER_THRESHOLDS` (:237). Runs fire-and-forget after submit commits (`ctrl` ~2120). Writes `intake_submissions.risk_assessment` (JSONB), `risk_tier` (varchar 20) |
| Reviewer override | `risk_override` JSONB, `OverrideSection` in the modal | Tier and dimension overrides with a ≥10-char justification. Separate EU AI Act level override |
| Reviewer UI | `Clients/src/presentation/pages/IntakeFormBuilder/SubmissionPreviewModal.tsx` (815 lines) | Modal only, no per-submission page. Preview data from `getSubmissionPreview` (`ctrl` ~1110) |
| Risk suggestions | `Servers/services/riskSuggestions/riskSuggestions.service.ts:233` `suggestRisksForUseCase({name, purpose?, technology?})` | Returns catalog `matched[]` + AI `suggested[]`. `likelihood`/`severity` are ints 1–5. The HTTP endpoint needs an existing project, so call the service directly |
| Use-case risk create | `Servers/utils/risk.utils.ts:654` `createRiskQuery(risk & {projects:[id]}, orgId, tx)` | Table `risks`, link via `projects_risks`. Required: `risk_owner` (user id), `deadline`, enums below |
| Model risk | `Servers/domain.layer/models/modelRisk/modelRisk.model.ts`, `utils/modelRisk.utils.ts` | Table `model_risks`. Required: `risk_name`, `risk_category` (Performance, Bias & Fairness, Security, Data Quality, Compliance), `risk_level` (Low, Medium, High, Critical), `status` (Open…), `owner` (string), `target_date`. Optional `description`, `mitigation_plan`, `impact`, `likelihood` (string), `model_id` |
| Approval | `approveSubmission` (`intakeForm.ctrl.ts` ~1320–1580) | One transaction. USE_CASE → `createNewProjectQuery` (+ EU framework + classification run copy). MODEL → `createNewModelInventoryQuery`. Emails after commit |
| LLM model from key | `Servers/advisor/llmModelFactory.ts` `createModelFromKey` | Use this. Don't add a fourth builder (intake has two inline ones today) |
| Use-case risk enums | `Servers/domain.layer/models/risks/risk.model.ts` | likelihood: Rare…Almost Certain. severity: Negligible…Catastrophic. `risk_level_autocalculated`: No risk…Very high risk. Watch the "Very Low risk" capitalisation in `current_risk_level` (:124). Frontend mappers in `Clients/src/presentation/components/AddNewRiskForm/riskSuggestionMappers.ts` and `projectRiskValue.ts` |

## Design

### 1. EU AI Act step on by default

- New forms are created with `euAiActRiskStepEnabled = true`, through the form-creation default and a migration that changes the column default to `true`.
- **Existing forms keep their current setting** (my call). Flipping a live form silently would change what submitters see mid-flight.
- When the step is off, the form builder shows a persistent notice next to the toggle, not a one-off dialog. Draft copy (sentence case, humanize before shipping):
  > EU AI Act questions are off. Submissions from this form won't get a rule-based EU AI Act classification, the risk score will have no rule-based minimum and will be marked "not rule-checked", and use cases approved from it won't get an EU AI Act classification.
- The same notice applies to existing forms that have it off.

### 2. Scoring

**Inputs:** all submitted answers (question label + answer, including free text), plus the rule classification result with its reasons, when the step is on.

**Rule minimum** from the classification level:

| Level | Minimum |
|---|---|
| Prohibited | 90 (user, via demo) |
| High risk | 70 (user, via demo) |
| Limited risk | 30 (my call) |
| Minimal risk | 0 (my call) |
| Out of scope | 0 (my call) |
| Step off | none, and the score is marked "not rule-checked" |

**Reviewer changes the EU AI Act level** (my call, after the builder check): today the level override only exists as modal state and is sent with the approve request (`intakeForm.ctrl.ts` ~1367, 1391). It is never saved on the submission. Keep it that way. When the reviewer picks a different level in the modal, the modal recomputes the minimum and final score on the client from the stored AI median, using a shared pure function, and the explainer says "minimum based on your level change". On approve, the server runs the same function, and saves the recomputed `ruleMinimum`, `finalScore` and `risk_tier` along with the override. No new endpoint, no AI re-run.

**Model submissions** (my call, after the builder check): the EU AI Act step only exists on use-case forms (`resolveEuAiActRiskStep`, `Servers/utils/intakeFormSchema.validation.ts:94-99`). Model submissions are always scored by the AI alone and always labelled "not rule-checked", with explainer copy saying that EU AI Act questions apply to use cases, not models. The "on by default" setting and the "step is off" notice apply to use-case forms only.

**AI runs:**
- 5 independent runs, in parallel, with the form's LLM key via `createModelFromKey`, using non-zero temperature so the runs can differ.
- Each run returns structured output: `score` (int 0–100) and `reasons[]` of `{text, quotedAnswer: {questionId, excerpt}}`.
- Validate every run with a schema. Drop any reason whose excerpt is not actually in that answer, since quotes must be real.
- **At least 3 valid runs are needed** to report a median. With fewer, the AI part counts as failed (my call).
- The prompt asks for EU AI Act-relevant risk and tells the model to pay particular attention to vulnerable groups, public-sector and critical-infrastructure contexts, which LLMs tend to under-score (research note in the handover).

**Final score** = max(rule minimum, AI median). Also stored: the AI range (min–max of the valid runs), which number won ("rule minimum" or "AI"), and the reasons from the run closest to the median, deduplicated.

**Statuses** (stored, shown in the UI):

| Status | Meaning | Score shown |
|---|---|---|
| `pending` | job queued or running | none, "Scoring…" |
| `complete` | AI ran | final score + range |
| `ai_not_configured` | form has no LLM key | rule minimum only, labelled as such, with the note "AI scoring isn't set up for this form" |
| `ai_failed` | fewer than 3 valid runs, or the key or provider errored | rule minimum only, error note, **Retry** |
| `not_rule_checked` flag | step off | combined with the above. With no key **and** the step off, there is no score at all, just a plain note |

**Execution:** a BullMQ job (via the existing producer and `safeSchedule` patterns in `Servers/jobs/`) enqueued after the submit transaction commits, replacing today's fire-and-forget promise. It has two independent stages, scoring and then suggestions, each with its own status.

**Retry** is a reviewer action (`POST` on the submission) that re-runs **only the stages that failed** (my call). It never regenerates a stage that succeeded, so it can never wipe the reviewer's edits, accepts or dismissals. Only users who can approve intake submissions can retry (my call: `intakeForm.edit`, as the approval route uses).

**Resubmissions** (a new submission linked by `originalSubmissionId`) start fresh: they are re-scored and get new suggestions. Decisions from the earlier round are not carried over, but they stay on the old submission (my call).

**Storage** (my call, builder may refine):
- Write a versioned shape into `risk_assessment`: `{version: 2, status, notRuleChecked, classificationLevel, ruleMinimum, ai: {runs:[{score}], validRuns, median, min, max, reasons[]}, finalScore, source: "rule_minimum"|"ai", scoredAt, error?}`.
- Keep `overallScore` = `finalScore` so the existing list and stats code keeps working.
- Update `risk_tier` from the final score as today.
- Old submissions with no `version` keep the old display.

**Retire the keyword score for new submissions:** no per-dimension bars on v2 assessments. Two disagreeing scores would confuse reviewers (my call, which the user accepted when it was played back). Keep the old code path only to render pre-existing v1 assessments.

### 3. Display: the "Classify and score" section of the review modal

- **EU AI Act classification:** the level (from rules, or the reviewer's override) with its cited articles, as today.
- **Risk score:** the final number, the AI range ("AI scores ranged 62–71"), a short line on which number won, and the top reasons with their quoted answers.
- **Avoid the contradiction anti-goal.** When the form's tier system is `eu_ai_act`, its tier names (Minimal / Limited / High / Unacceptable) collide with the legal levels. For v2 assessments, **on every screen that shows the tier**, show the score as a number with a neutral band label instead (my call; the builder may propose another neutral wording). That covers the modal, the submissions list chip (`IntakeFormsListPage.tsx:98`), and the use case page's "Risk: {riskTier}" (`ProjectView/IntakeSubmissionCard/index.tsx:100`). The EU AI Act level is only ever the rules result or the reviewer's override.
- **"How this score is built"** (expandable, or a side panel):
  - the step's answers that drove the classification
  - the level and its articles
  - the minimum it set
  - all 5 AI scores (or which ones failed)
  - the median and range
  - the formula in words: "The final score is the higher of the rule minimum and the AI median. The AI can raise the score but never lower it."
  - the quoted reasons
  - any status note ("not rule-checked", "AI scoring isn't set up", "AI scoring failed")
- **Override:** the reviewer can still override the score band with a justification (existing `OverrideSection`, relabelled to the neutral bands for v2). Dimension overrides don't apply to v2 assessments. The explainer shows that an override happened, and who made it.
- **The rule minimum holds for people too (user decision).** A reviewer override can raise the band but never set it below the band that contains the rule minimum. The UI disables the lower options and the server rejects them. The only way to lower the minimum is to change the EU AI Act level itself. That change is recorded with the approval, and the explainer shows the minimum came from the reviewer's level (my call: it's the existing level override, so it is already justified and recorded on the classification run).

### 4. Suggested risks

**Generation:** in the same job, after scoring.
- Call `suggestRisksForUseCase`, extended so it can take the submission's answers and the classification result as extra context, not only name, purpose and technology.
- Name, purpose and technology come from the submission's entity mapping, the same fields approval uses to build the use case or model.
- Both catalog matches and AI suggestions are included. Each is marked with its source ("From the risk catalog" / "AI-suggested").

**Shape stored per suggestion:**
- `id`, `source`, `name`, `description`, `category`, `mitigationPlan`, `impact`
- likelihood and severity as **register enum values** (map 1–5 ints on generation, not on create)
- `state`: `suggested` | `accepted` | `dismissed`
- `editedBy` / `editedAt` when changed
- `decidedBy` / `decidedAt`

Storage: a JSONB column `suggested_risks` on `intake_submissions` plus a `suggestions_status` (same status values as scoring). These are my calls. If the builder prefers a table, it must be org-scoped and registered in `tests/integration/tenant-isolation/tenantIsolation.registry.ts`.

**Reviewer actions** in the "Suggested risks" section:
- edit name, description, likelihood, severity, mitigation (and, for model submissions, category and level)
- accept, dismiss, accept all, undo

Each action persists immediately via an endpoint, so closing the modal keeps the choices. Same permission as approving.

**On approve** (inside the existing approval transaction; if any create fails, the whole approval rolls back):
- **USE_CASE:** for each accepted suggestion, call `createRiskQuery({..., projects: [entityId]}, orgId, tx)`. `risk_owner` = the approving user, `deadline` = approval date + 90 days (my call, editable in the suggestion before accepting). `risk_level_autocalculated` comes from the same likelihood × severity mapping the risk form uses. Reuse the existing mapper logic; don't hand-roll a new matrix.
- **MODEL:** for each accepted suggestion, create a `model_risks` row with `model_id` = the new model, `status` Open, `owner` = the approving user's display name (check what `owner` holds elsewhere and match it), `target_date` = approval + 90 days, `likelihood` as the register string, `risk_level` from likelihood × severity mapped to Low/Medium/High/Critical, and `risk_category` mapped from the suggestion's category. The mapping is a builder's call, defaulting to Compliance when nothing fits. The reviewer can change category and level before accepting.
- **Reject:** creates nothing. The suggestions stay on the submission as a record.

**Audit:** accepted, dismissed and edited states with who and when stay on the submission. They become the audit trail for part 2.

### 5. Form-level LLM key

- No org-default fallback (my call, played back to the user). The form's `llmKeyId` decides.
- Without a key, both scoring and suggestions report `ai_not_configured`, and the form builder already shows the key picker.
- Without a key, there are **no suggested risks at all**, and the section shows the `ai_not_configured` note (my call, after the builder check). Catalog matching is LLM-picked (`riskSuggestions.service.ts:233-290`), and unvetted keyword matches would be noise.

## Constraints

- House UI: `StandardModal`, `CustomizableButton`, theme palette, sentence case, 30px controls, `#d0d5dd` borders, 4px radius, pixel-string spacing, Lucide icons. The modal is already 815 lines, so split new sections into their own components.
- i18n: every new string needs de/fr/es in `i18n/translations.ts` (`npm run i18n:audit:strict`).
- Multi-tenancy: every query filters `organization_id`.
- Migrations: plain JS raw SQL in `Servers/database/migrations/`, `IF NOT EXISTS` style.
- Gates: `cd Servers && npm run build && npm run test && npm run format-check`; `cd Clients && npm run typecheck && npm run i18n:audit:strict && npm run format-check && npm run build && npx vitest run`; Semgrep PR gate locally.
- Never run `npx jest <pattern>` without `--testPathIgnorePatterns=/tests/integration/`. It can wipe the dev DB.
- Docs: there is no intake domain doc. Create `docs/technical/domains/intake-forms.md` covering scoring v2 and suggestions, and add it to the CLAUDE.md reference table. Add a user-guide page in `shared/user-guide-content/` and mirror it to the website repo.

## Tests the builder must write

- Floor and median: each level × AI medians above and below the floor; fewer than 3 valid runs; quoted-excerpt validation drops fabricated quotes; step off; no key; both off.
- The 1–5 → enum mappers for use-case and model risks.
- Approval: accepted suggestions create use-case risks linked to the project, or model risks linked to the model, inside the transaction; a create failure rolls back the approval; reject creates none.
- Retry re-enqueues and moves the status from `ai_failed` to `pending`.
- Frontend: the explainer renders each status; a v1 assessment still renders the old view.

## Left to the builder

- The exact prompt, schema library usage and temperature.
- The neutral band wording for the score.
- Whether the explainer is an accordion or a side panel.
- The model-risk category mapping table.
- How to split `SubmissionPreviewModal`.
- Endpoint paths, following the existing intake route conventions.
