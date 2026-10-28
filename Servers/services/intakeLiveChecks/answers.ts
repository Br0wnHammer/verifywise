// Servers/services/intakeLiveChecks/answers.ts
// The answers the AI checks read: visible fields only (hidden and unknown keys
// dropped), capped like the scoring input. Shared by the public endpoint and
// the assessment job so both send the model the same thing.
import { cleanSubmission, type LogicSchema } from "../intakeFormLogic";
import type { FormSchema } from "../intakeRiskScoring.service";
import { buildScoringAnswers, type ScoringAnswer } from "../intakeScoring/scoringInput";

export function visibleScoringAnswers(
  schema: unknown,
  data: Record<string, unknown>,
): ScoringAnswer[] {
  const { data: visible } = cleanSubmission(schema as LogicSchema, data);
  return buildScoringAnswers(visible, schema as FormSchema);
}
