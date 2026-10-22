import { Transaction } from "sequelize";
import type { IIntakeForm } from "../../domain.layer/interfaces/i.intakeForm";
import {
  isAssessmentV2,
  type IIntakeSubmission,
  type ISubmissionRouting,
} from "../../domain.layer/interfaces/i.intakeSubmission";
import { IntakeSubmissionStatus } from "../../domain.layer/enums/intake-submission-status.enum";
import {
  getSubmissionsByFormIdQuery,
  updateSubmissionRoutingQuery,
} from "../../utils/intakeForm.utils";
import { logSuccess } from "../../utils/logger/logHelper";
import { laneFor } from "./routingRules";

const PAGE_SIZE = 200;

/**
 * Decide the review lane of a pending, scored submission and store it.
 * Returns null (and writes nothing) when routing is off, the submission is
 * decided, scoring has not settled, or a reviewer already escalated it.
 */
export async function routeSubmission(
  submission: IIntakeSubmission,
  form: IIntakeForm,
  organizationId: number,
  opts: { now?: Date; transaction?: Transaction } = {},
): Promise<ISubmissionRouting | null> {
  const cfg = form.routing;
  if (!cfg?.enabled) return null;
  if (submission.status !== IntakeSubmissionStatus.PENDING) return null;

  const assessment = submission.riskAssessment;
  if (!isAssessmentV2(assessment) || assessment.status === "pending") return null;

  const existing = submission.routing;
  if (existing?.escalation) return null;

  const result = laneFor(
    {
      level: assessment.classificationLevel,
      finalScore: assessment.finalScore,
      scoringStatus: assessment.status,
    },
    cfg,
  );
  // A raised override keeps the submission with a senior reviewer even when
  // the recomputed score alone would send it to the standard lane.
  const keepRaised =
    existing?.lane === "senior" &&
    existing.reason === "override_raised" &&
    result.lane === "standard";

  const routing: ISubmissionRouting = {
    lane: keepRaised ? existing.lane : result.lane,
    reason: keepRaised ? existing.reason : result.reason,
    score: assessment.finalScore,
    threshold: cfg.threshold,
    closeCallMargin: cfg.closeCallMargin,
    routedAt: (opts.now ?? new Date()).toISOString(),
    ...(existing?.secondReview ? { secondReview: existing.secondReview } : {}),
  };

  await updateSubmissionRoutingQuery(submission.id, routing, organizationId, opts.transaction);
  await logSuccess({
    eventType: "Update",
    description: `routed submission ${submission.id} to ${routing.lane}: ${routing.reason}`,
    functionName: "routeSubmission",
    fileName: "routingService.ts",
    userId: 0,
    organizationId,
  });
  return routing;
}

/** Route every pending submission of the form again; returns how many changed. */
export async function rerouteFormPending(
  form: IIntakeForm,
  organizationId: number,
): Promise<number> {
  let changed = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await getSubmissionsByFormIdQuery(
      form.id,
      organizationId,
      IntakeSubmissionStatus.PENDING,
      PAGE_SIZE,
      offset,
    );
    for (const submission of page) {
      const before = submission.routing;
      const after = await routeSubmission(submission, form, organizationId);
      if (
        after &&
        (before?.lane !== after.lane ||
          before?.reason !== after.reason ||
          before?.score !== after.score ||
          before?.threshold !== after.threshold ||
          before?.closeCallMargin !== after.closeCallMargin)
      ) {
        changed += 1;
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return changed;
}
