# Intake forms: AI scoring and suggested risks

Public intake submissions get a rule-floored risk score and up to 10 suggested risks, computed in the background. Reviewers see both in the review modal. Accepted suggestions become real risks when the submission is approved.

Design spec: `docs/superpowers/specs/2026-10-21-ai-intake-classification-design.md`.

## Where the code lives

| Area | Path |
|---|---|
| Score maths (server, mirrored on the client) | `Servers/services/intakeScoring/scoreMath.ts`, `Clients/src/application/utils/intakeScoring/scoreMath.ts` |
| AI scoring runs, prompt | `Servers/services/intakeScoring/aiScoring.ts`, `prompts.ts`, `scoringInput.ts` |
| Suggested risks, register mappers | `Servers/services/intakeScoring/intakeSuggestions.ts`, `riskMappers.ts` |
| Background job, enqueue, email | `Servers/services/intakeScoring/assessmentJob.ts`, `enqueue.ts` |
| Retry stage selection | `Servers/services/intakeScoring/retry.ts` |
| Approval risks, recompute | `Servers/services/intakeScoring/approvalRisks.ts` |
| Storage queries | `Servers/utils/intakeForm.utils.ts` |
| Migration | `Servers/database/migrations/20261021120000-intake-ai-assessment.js` |
| Review UI | `Clients/src/presentation/pages/IntakeFormBuilder/assessment/` |

## Score

The final score is the higher of the rule minimum and the AI median. The AI can raise it but never lower it.

| EU AI Act level | Rule minimum |
|---|---|
| Prohibited | 90 |
| High risk | 70 |
| Limited risk | 30 |
| Minimal risk, Out of scope | 0 |
| No questionnaire run (step off, model forms) | none, `notRuleChecked: true` |

- The level comes from the submission's stored EU AI Act run, re-scored under its own questionnaire version (`rescoreStoredRun` in `Servers/utils/intakeSubmissionData.utils.ts`).
- The AI part is 5 parallel runs on the form's LLM key (temperature 0.7). A run is valid when it parses against the schema. At least 3 valid runs are needed for a median.
- Each reason must quote the answer it cites. Reasons whose excerpt is not in that answer are dropped. Select answers are matched against the option label.
- Bands: Low 0 to 25, Medium 26 to 50, High 51 to 75, Critical 76 to 100. `risk_tier` stores the band for v2 rows.
- With no AI median the score is the rule minimum (`rulesOnly`), shown as "at least N (rules only)". With no AI median and a minimum of 0 there is no score (`finalScore: null`).

### Prompt safety

Submitter name, submitter email and schema fields of type `email` never reach the LLM. Answers are serialised as JSON inside a delimiter tag carrying a per-call random nonce, and the nonce is stripped from the submitted text, so an answer can't close the block. The system prompt names the tag and tells the model to ignore instructions inside it. The suggestion prompt fences its context the same way. Each answer is capped at 2,000 characters and all answers at 24,000.

## Storage

`intake_submissions.risk_assessment` holds a versioned object. `version: 2` is the AI score; rows without a version are the old keyword score and keep the old display.

```ts
{ version: 2, status, notRuleChecked, classificationLevel, ruleMinimum,
  ai: { runs, failedRuns, validRuns, median, min, max, reasons } | null,
  finalScore, source: "rule_minimum" | "ai" | null, rulesOnly,
  overallScore /* = finalScore */, tier /* band */, stageStartedAt, scoredAt, error? }
```

`intake_submissions.suggested_risks` (JSONB) holds `{ status, items, droppedCount, stageStartedAt, generatedAt, error? }`. `notification_sent_at` marks the one-time email.

Stage statuses: `pending`, `complete`, `ai_not_configured` (form has no LLM key, or the key was deleted) and `ai_failed`.

Per-suggestion writes are single atomic `UPDATE`s on the matching array element (`updateSuggestedRiskItemQuery`, `setAllSuggestionStatesQuery`). Two reviewers acting at once don't overwrite each other, and the same statement refuses to leave an accepted item without a mitigation plan. Every assessment and suggestion write requires `status = 'pending'`, so a job that finishes after approve or reject changes nothing. The assessment write keeps a reviewer override's band in `risk_tier`.

## Background job

Both public submit handlers call `startIntakeAssessment` after the transaction commits. It is not awaited, so a slow queue never delays the submitter.

- `intake_assessment` runs the requested stages (`scoring`, `suggestions`) side by side. Each stage writes `pending` first, then its result. A failure in one stage, or in loading the key, classification or answers, is recorded as `ai_failed` and the other stage still runs. Its job id is `intake-assessment:{org}:{submission}-{stages}`: BullMQ rejects a custom id containing `:` unless it has exactly 3 parts.
- `intake_notify_cap` fires 2 minutes later. The new-submission email goes out once, when both stages settle or at the cap, whichever comes first. `claimSubmissionNotificationQuery` makes it one email. A cap that fires mid-run sends a "still running" note in place of numbers. A submission already approved or rejected gets no email.
- If the job can't be queued, the handler emails reviewers at once without results, after claiming the notification.
- Forms opened through the legacy `/{tenantSlug}/{formSlug}` route email org admins when the form has no recipients (`adminFallback`). The public-id route skips them, as before.
- On worker start, `backfillIntakeAssessments` queues the stages each pending submission still needs: legacy rows, missing blocks and stages pending for over 10 minutes. It never re-runs a settled stage. A submission whose email never went (`notification_sent_at` is NULL, so its job or cap was lost) is queued with `notify: true`, or emailed at once when both stages have settled. Only forms with recipients count, so a form without recipients (which never claims) isn't listed on every start. The direct send also waits until the submission is over 10 minutes old, so a live job keeps its own email and language. The submitter's language and the route's `adminFallback` aren't stored, so that email uses the default language and a form without recipients stays silent.

## Review endpoints

All new writes use `authorize("intakeForm.edit")`.

| Route | Purpose |
|---|---|
| `GET /intake/submissions/:id/preview` | Adds `assessment`, `suggestedRisks`, `ruleMinimumPreview` (current rules) and `assessedLevel` (stored) |
| `POST /intake/submissions/:id/assessment/retry` | 202 with the stages queued. Only failed stages, stages never stored, or stages pending over 10 minutes. 409 when nothing qualifies |
| `PATCH /intake/submissions/:id/suggested-risks/:suggestionId` | Edit, accept, dismiss or restore one suggestion. Whitelisted fields only. Accepting needs a mitigation plan |
| `POST /intake/submissions/:id/suggested-risks/accept-all` | Accepts open suggestions that have a mitigation plan. Returns `{ accepted, skipped, items }`, with items as stored. 409 when the submission isn't pending, including one decided during the call |
| `PATCH /intake/submissions/:id/risk-override` | Pending submissions only (409 otherwise). A pre-v2 tier name is stored as its band (`bandOfTier`). For v2, or a submission not scored yet, the tier must be a band at or above the band of the current rule minimum |

## Approval

Inside the existing approval transaction:

1. A v2 assessment is re-floored under the level being approved (the reviewer may have changed it) with `recomputeAssessmentForLevel`. A stage still running is closed: scoring keeps the rule minimum (`ai_failed`, "Approved before AI scoring finished") and pending suggestions are marked `ai_failed`.
2. A band override below that level's minimum is refused with 400, whether it comes with the request or was saved earlier through `PATCH /risk-override`. The stored override is built from whitelisted fields.
3. Each accepted suggestion becomes a risk on the new entity. Use cases go through `createRiskService` (owner = approver, deadline = suggestion deadline or approval + 90 days, "Not Started", default category "Strategic risk"). Models go through `createNewModelRiskQuery` (owner = approver id as a string, status "Open"). Any failure rolls the whole approval back. Rejecting creates nothing, but closes running stages the same way as step 1 (`settleAssessmentOnDecision`), so a rejected submission never shows "Scoring…".

## Release

The migration adds `suggested_risks` and `notification_sent_at` and sets the default of `intake_forms.eu_ai_act_risk_step_enabled` to `true`. Existing forms keep their setting. A second migration, `20261022001648-intake-ai-assessment-data`, marks existing submissions as notified (`notification_sent_at = created_at`), because the old code emailed at submit. It also moves a pending submission's override saved under the pre-v2 tiers to the band covering the same scores (Minimal → Low, Limited → Medium, Unacceptable → Critical), in `risk_override.tier` and `risk_tier`. Decided submissions keep their history. Pending submissions are then scored by the worker-start backfill, with no email.

## Tests

Server: `Servers/services/intakeScoring/__tests__/`, `Servers/utils/__tests__/intakeForm.assessment.utils.test.ts`, `Servers/controllers/__tests__/intakeForm.{assessmentEnqueue,review,approveRisks}.test.ts`. Client: `Clients/src/presentation/pages/IntakeFormBuilder/__tests__/{ScoreSection,SuggestedRisksSection,OverrideBandFloor,RiskTierChip}.test.tsx`.
