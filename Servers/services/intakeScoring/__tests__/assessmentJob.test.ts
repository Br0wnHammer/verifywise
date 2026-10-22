jest.mock("../../../database/db", () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock("../../automations/automationProducer", () => ({
  automationQueue: { add: jest.fn() },
  enqueueAutomationAction: jest.fn(),
}));
jest.mock("../../emailService", () => ({ sendEmail: jest.fn() }));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  AssessmentDeps,
  backfillIntakeAssessments,
  runIntakeAssessment,
  scoreTextFor,
  sendIntakeNotificationOnce,
} from "../assessmentJob";
import { IntakeEntityType } from "../../../domain.layer/enums/intake-entity-type.enum";
import { IntakeSubmissionStatus } from "../../../domain.layer/enums/intake-submission-status.enum";
import type {
  IIntakeSubmission,
  IRiskAssessmentV2,
  ISuggestedRisksBlock,
} from "../../../domain.layer/interfaces/i.intakeSubmission";
import type { IIntakeForm } from "../../../domain.layer/interfaces/i.intakeForm";
import type { ClassificationContext } from "../aiScoring";

const ORG = 7;
const NOW = new Date("2026-10-21T12:00:00.000Z");

const form = (overrides: Partial<IIntakeForm> = {}): IIntakeForm =>
  ({
    id: 5,
    name: "AI intake",
    entityType: IntakeEntityType.USE_CASE,
    schema: {
      fields: [
        { id: "q1", label: "Purpose", type: "text", entityFieldMapping: "project_title" },
        { id: "q2", label: "Contact", type: "email" },
      ],
    },
    recipients: [9],
    llmKeyId: 3,
    euAiActRiskStepEnabled: true,
    ...overrides,
  }) as unknown as IIntakeForm;

const submission = (overrides: Partial<IIntakeSubmission> = {}): IIntakeSubmission =>
  ({
    id: 11,
    formId: 5,
    status: IntakeSubmissionStatus.PENDING,
    entityType: IntakeEntityType.USE_CASE,
    data: { q1: "Screening job applicants", q2: "jane@example.com" },
    submitterName: "Jane",
    submitterEmail: "jane@example.com",
    riskAssessment: null,
    suggestedRisks: null,
    ...overrides,
  }) as unknown as IIntakeSubmission;

const HIGH_RISK: ClassificationContext = {
  level: "High risk",
  reasons: [{ article: "Annex III", text: "employment" }],
};

const SUGGESTION = {
  risk_name: "Biased ranking",
  risk_description: "d",
  risk_category: ["Data privacy risk"],
  ai_lifecycle_phase: "Deployment & integration",
  likelihood: 3,
  severity: 4,
  impact: "i",
  mitigation_plan: "m",
  implementation_strategy: "s",
};

/** Answers scoring calls with `score` and suggestion calls with one risk. */
const fakeLlm = (score: number, opts: { failScoring?: boolean; failSuggestions?: boolean } = {}) =>
  jest.fn(async (args: { system: string }) => {
    if (args.system.includes("risk analyst")) {
      if (opts.failSuggestions) throw new Error("suggestions down");
      return { object: { matched: [], suggested: [SUGGESTION] } } as any;
    }
    if (opts.failScoring) throw new Error("scoring down");
    return { object: { score, reasons: [] } } as any;
  });

/** An in-memory submission store plus spies for everything else. */
function harness(
  sub: IIntakeSubmission,
  overrides: Partial<AssessmentDeps> = {},
  claims: boolean[] = [true, false],
) {
  const state = { submission: sub };
  const assessments: IRiskAssessmentV2[] = [];
  const blocks: ISuggestedRisksBlock[] = [];
  const deps: Partial<AssessmentDeps> = {
    getSubmission: jest.fn(async () => ({ ...state.submission })),
    getForm: jest.fn(async () => form()),
    getClassification: jest.fn(async () => HIGH_RISK),
    getModel: jest.fn(async () => ({ fake: true }) as any),
    saveAssessment: jest.fn(async (_id, a) => {
      assessments.push(a);
      state.submission = { ...state.submission, riskAssessment: a };
    }),
    saveSuggestions: jest.fn(async (_id, b) => {
      blocks.push(b);
      state.submission = { ...state.submission, suggestedRisks: b };
    }),
    claimNotification: jest.fn(async () => claims.shift() ?? false),
    sendNotification: jest.fn(async () => undefined),
    generateImpl: fakeLlm(64),
    now: () => NOW,
    ...overrides,
  };
  return { deps, state, assessments, blocks };
}

const finalAssessment = (h: ReturnType<typeof harness>) => h.assessments[h.assessments.length - 1];
const finalBlock = (h: ReturnType<typeof harness>) => h.blocks[h.blocks.length - 1];
const BOTH = ["scoring", "suggestions"] as const;
const job = (overrides = {}) => ({
  organizationId: ORG,
  submissionId: 11,
  stages: [...BOTH],
  notify: true,
  lang: "en",
  ...overrides,
});

describe("runIntakeAssessment", () => {
  it("scores, suggests and emails once when both stages complete", async () => {
    const h = harness(submission(), { generateImpl: fakeLlm(64) });
    await runIntakeAssessment(job(), h.deps);

    // pending first, then the result
    expect(h.assessments[0].status).toBe("pending");
    expect(h.assessments[0].stageStartedAt).toBe(NOW.toISOString());
    expect(h.blocks[0].status).toBe("pending");

    const a = finalAssessment(h);
    expect(a.status).toBe("complete");
    expect(a.classificationLevel).toBe("High risk");
    expect(a.ruleMinimum).toBe(70);
    expect(a.ai?.median).toBe(64);
    expect(a.finalScore).toBe(70); // max(70, 64)
    expect(a.source).toBe("rule_minimum");
    expect(a.tier).toBe("High");
    expect(a.overallScore).toBe(70);
    expect(a.notRuleChecked).toBe(false);

    const b = finalBlock(h);
    expect(b.status).toBe("complete");
    expect(b.items).toHaveLength(1);
    expect(b.items[0].implementationStrategy).toBe("s");

    expect(h.deps.sendNotification).toHaveBeenCalledTimes(1);
    const args = (h.deps.sendNotification as jest.Mock).mock.calls[0];
    expect(args[0]).toEqual([9]);
    expect(args[7]).toEqual({
      level: "High risk",
      scoreText: "70 (High)",
      suggestionCount: 1,
      capReached: false,
    });
  });

  it("uses the AI median when it is above the rule minimum", async () => {
    const h = harness(submission(), { generateImpl: fakeLlm(82) });
    await runIntakeAssessment(job(), h.deps);
    expect(finalAssessment(h).finalScore).toBe(82);
    expect(finalAssessment(h).source).toBe("ai");
    expect(finalAssessment(h).tier).toBe("Critical");
  });

  it("without an LLM key: rules-only score, no suggestions", async () => {
    const h = harness(submission(), { getForm: jest.fn(async () => form({ llmKeyId: null })) });
    await runIntakeAssessment(job(), h.deps);
    const a = finalAssessment(h);
    expect(a.status).toBe("ai_not_configured");
    expect(a.finalScore).toBe(70);
    expect(a.rulesOnly).toBe(true);
    expect(a.ai).toBeNull();
    expect(finalBlock(h)).toMatchObject({ status: "ai_not_configured", items: [] });
    expect((h.deps.sendNotification as jest.Mock).mock.calls[0][7].scoreText).toBe(
      "at least 70 (rules only)",
    );
    expect(h.deps.getModel).not.toHaveBeenCalled();
  });

  it("without a key and with no rules check: no score yet", async () => {
    const h = harness(submission(), {
      getForm: jest.fn(async () => form({ llmKeyId: null, euAiActRiskStepEnabled: false })),
      getClassification: jest.fn(async () => null),
    });
    await runIntakeAssessment(job(), h.deps);
    const a = finalAssessment(h);
    expect(a.finalScore).toBeNull();
    expect(a.tier).toBeNull();
    expect(a.notRuleChecked).toBe(true);
    expect((h.deps.sendNotification as jest.Mock).mock.calls[0][7]).toMatchObject({
      level: null,
      scoreText: "No score yet",
    });
  });

  it("treats a deleted key as not configured and records why", async () => {
    const h = harness(submission(), { getModel: jest.fn(async () => null) });
    await runIntakeAssessment(job(), h.deps);
    expect(finalAssessment(h)).toMatchObject({
      status: "ai_not_configured",
      error: "The form's LLM key no longer exists",
    });
    expect(finalBlock(h).status).toBe("ai_not_configured");
  });

  it("marks a failed scoring stage and still runs suggestions", async () => {
    const h = harness(submission(), { generateImpl: fakeLlm(64, { failScoring: true }) });
    await runIntakeAssessment(job(), h.deps);
    const a = finalAssessment(h);
    expect(a.status).toBe("ai_failed");
    expect(a.finalScore).toBe(70); // the floor still holds
    expect(a.error).toBeDefined();
    expect(finalBlock(h).status).toBe("complete");
    expect(h.deps.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("marks a failed suggestions stage and keeps the score", async () => {
    const h = harness(submission(), {
      generateImpl: fakeLlm(64, { failSuggestions: true }),
    });
    await runIntakeAssessment(job(), h.deps);
    expect(finalAssessment(h).status).toBe("complete");
    expect(finalBlock(h)).toMatchObject({ status: "ai_failed", items: [] });
    expect(finalBlock(h).error).toBeDefined();
  });

  it("scoring-only runs never touch suggestions", async () => {
    const block: ISuggestedRisksBlock = {
      status: "complete",
      items: [],
      droppedCount: 0,
      stageStartedAt: "x",
      generatedAt: "y",
    };
    const h = harness(submission({ suggestedRisks: block }));
    await runIntakeAssessment(job({ stages: ["scoring"], notify: false }), h.deps);
    expect(h.deps.saveSuggestions).not.toHaveBeenCalled();
    expect(finalAssessment(h).status).toBe("complete");
  });

  it("model submissions are not rule-checked", async () => {
    const h = harness(submission({ entityType: IntakeEntityType.MODEL }), {
      getForm: jest.fn(async () => form({ entityType: IntakeEntityType.MODEL })),
      getClassification: jest.fn(async () => null),
    });
    await runIntakeAssessment(job(), h.deps);
    const a = finalAssessment(h);
    expect(a.notRuleChecked).toBe(true);
    expect(a.classificationLevel).toBeNull();
    expect(a.finalScore).toBe(64);
    expect(finalBlock(h).items[0].modelRiskCategory).toBeDefined();
  });

  it("does nothing for a submission that is no longer pending", async () => {
    const h = harness(submission({ status: IntakeSubmissionStatus.APPROVED }));
    await runIntakeAssessment(job(), h.deps);
    expect(h.deps.saveAssessment).not.toHaveBeenCalled();
    expect(h.deps.saveSuggestions).not.toHaveBeenCalled();
    expect(h.deps.sendNotification).not.toHaveBeenCalled();
  });

  it("does not email when notify is off", async () => {
    const h = harness(submission());
    await runIntakeAssessment(job({ notify: false }), h.deps);
    expect(h.deps.claimNotification).not.toHaveBeenCalled();
    expect(h.deps.sendNotification).not.toHaveBeenCalled();
  });

  it("never sends contact data to the LLM", async () => {
    const generateImpl = fakeLlm(64);
    const h = harness(submission(), { generateImpl });
    await runIntakeAssessment(job(), h.deps);
    for (const call of generateImpl.mock.calls) {
      const { system, prompt } = call[0] as unknown as { system: string; prompt: string };
      expect(`${system}\n${prompt}`).not.toContain("jane@example.com");
    }
  });
});

describe("sendIntakeNotificationOnce", () => {
  const settled = () =>
    submission({
      riskAssessment: {
        version: 2,
        status: "complete",
        notRuleChecked: false,
        classificationLevel: "High risk",
        ruleMinimum: 70,
        ai: null,
        finalScore: 70,
        source: "rule_minimum",
        rulesOnly: false,
        overallScore: 70,
        tier: "High",
        stageStartedAt: "x",
        scoredAt: "y",
      },
      suggestedRisks: {
        status: "complete",
        items: [],
        droppedCount: 0,
        stageStartedAt: "x",
        generatedAt: "y",
      },
    });

  it("a second call after the claim is taken sends nothing", async () => {
    const h = harness(settled());
    await sendIntakeNotificationOnce(ORG, 11, "en", { capReached: false }, h.deps);
    await sendIntakeNotificationOnce(ORG, 11, "en", { capReached: true }, h.deps);
    expect(h.deps.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("the cap sends a still-running note while a stage is pending", async () => {
    const h = harness(
      submission({
        suggestedRisks: {
          status: "pending",
          items: [],
          droppedCount: 0,
          stageStartedAt: "x",
          generatedAt: null,
        },
      }),
    );
    await sendIntakeNotificationOnce(ORG, 11, "en", { capReached: true }, h.deps);
    expect((h.deps.sendNotification as jest.Mock).mock.calls[0][7].capReached).toBe(true);
  });

  it("the cap reports results when both stages had already settled", async () => {
    const h = harness(settled());
    await sendIntakeNotificationOnce(ORG, 11, "en", { capReached: true }, h.deps);
    expect((h.deps.sendNotification as jest.Mock).mock.calls[0][7].capReached).toBe(false);
  });

  it("with no recipients, skips without claiming unless admin fallback is on", async () => {
    const h = harness(settled(), { getForm: jest.fn(async () => form({ recipients: [] })) });
    await sendIntakeNotificationOnce(ORG, 11, "en", { capReached: false }, h.deps);
    expect(h.deps.claimNotification).not.toHaveBeenCalled();
    expect(h.deps.sendNotification).not.toHaveBeenCalled();

    await sendIntakeNotificationOnce(
      ORG,
      11,
      "en",
      { capReached: false, adminFallback: true },
      h.deps,
    );
    expect((h.deps.sendNotification as jest.Mock).mock.calls[0][0]).toBe(ORG);
  });
});

describe("scoreTextFor", () => {
  const base = { finalScore: 64, rulesOnly: false } as IRiskAssessmentV2;
  it("words each case", () => {
    expect(scoreTextFor(null)).toBe("No score yet");
    expect(scoreTextFor({ ...base, finalScore: null })).toBe("No score yet");
    expect(scoreTextFor(base)).toBe("64 (High)");
    expect(scoreTextFor({ ...base, finalScore: 70, rulesOnly: true })).toBe(
      "at least 70 (rules only)",
    );
  });
});

describe("backfillIntakeAssessments", () => {
  it("queues only the stages each row needs, without email", async () => {
    const enqueue = jest.fn(async () => undefined);
    const queued = await backfillIntakeAssessments({
      listNeedingAssessment: jest.fn(async () => [
        { id: 1, organizationId: 2, needsScoring: true, needsSuggestions: true },
        { id: 3, organizationId: 4, needsScoring: false, needsSuggestions: true },
        { id: 5, organizationId: 6, needsScoring: true, needsSuggestions: false },
      ]),
      enqueue,
    });
    expect(queued).toBe(3);
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      organizationId: 2,
      submissionId: 1,
      stages: ["scoring", "suggestions"],
      notify: false,
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      organizationId: 4,
      submissionId: 3,
      stages: ["suggestions"],
      notify: false,
    });
    expect(enqueue).toHaveBeenNthCalledWith(3, {
      organizationId: 6,
      submissionId: 5,
      stages: ["scoring"],
      notify: false,
    });
  });

  it("keeps going when one row fails to queue", async () => {
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined);
    const queued = await backfillIntakeAssessments({
      listNeedingAssessment: jest.fn(async () => [
        { id: 1, organizationId: 2, needsScoring: true, needsSuggestions: false },
        { id: 3, organizationId: 4, needsScoring: true, needsSuggestions: false },
      ]),
      enqueue,
    });
    expect(queued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
