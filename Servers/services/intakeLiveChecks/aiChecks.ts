// Servers/services/intakeLiveChecks/aiChecks.ts
// AI live checks: one model call that looks for vague answers and answers that
// conflict. Pure service code: no DB, no routes. A hint is kept only when it
// names questions that were sent and quotes its answer verbatim, so text the
// model invents (or is talked into by an answer) is dropped.
import { createHash } from "crypto";
import { z } from "zod";
import { generateObjectWithSelfCorrection, GenerateObjectImpl } from "../../advisor/llmSelfCorrect";
import logger from "../../utils/logger/fileLogger";
import type { ILiveChecks, LiveCheckHint } from "../../domain.layer/interfaces/i.intakeLiveChecks";
import { newDelimiterNonce } from "../intakeScoring/prompts";
import type { ScoringAnswer } from "../intakeScoring/scoringInput";
import { buildLiveCheckSystemPrompt, buildLiveCheckUserPrompt } from "./prompts";

export type LiveCheckLanguage = NonNullable<ILiveChecks["ai"]["language"]>;

const LANGUAGES: readonly LiveCheckLanguage[] = ["en", "de", "fr", "es"];

export const LIVE_CHECK_TIMEOUT_MS = 15_000;
export const MAX_AI_HINTS = 8;

export interface AiCheckResult {
  ok: boolean;
  hints: LiveCheckHint[];
  error?: string;
}

/** "de", "de-DE" and "DE_at" all give "de"; anything unsupported gives "en". */
export function toLiveCheckLanguage(raw: unknown): LiveCheckLanguage {
  if (typeof raw !== "string") return "en";
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(primary) ? (primary as LiveCheckLanguage) : "en";
}

const liveCheckOutputSchema = z
  .object({
    hints: z
      .array(
        z
          .object({
            kind: z.enum(["vague", "contradiction"]),
            questionId: z.string(),
            // Models often send null for an absent optional field.
            alsoQuestionId: z.string().nullish(),
            title: z.string().max(80),
            text: z.string().max(300),
            excerpt: z.string().max(200),
          })
          .strict(),
      )
      .max(MAX_AI_HINTS),
  })
  .strict();

type LiveCheckOutput = z.infer<typeof liveCheckOutputSchema>;

const normalise = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

const hintId = (
  kind: string,
  questionId: string,
  alsoQuestionId: string,
  excerpt: string,
): string =>
  `ai:${createHash("sha1")
    .update(kind + questionId + alsoQuestionId + excerpt)
    .digest("hex")
    .slice(0, 12)}`;

function validHints(output: LiveCheckOutput, answers: ScoringAnswer[]): LiveCheckHint[] {
  const textById = new Map(answers.map((a) => [a.questionId, normalise(a.text)]));
  const seen = new Set<string>();
  const kept: LiveCheckHint[] = [];
  for (const hint of output.hints) {
    if (kept.length >= MAX_AI_HINTS) break;
    const title = hint.title.trim();
    const text = hint.text.trim();
    const excerpt = normalise(hint.excerpt);
    const source = textById.get(hint.questionId);
    if (!title || !text || !excerpt || source === undefined || !source.includes(excerpt)) continue;

    let alsoQuestionId: string | undefined;
    if (hint.kind === "contradiction") {
      const other = hint.alsoQuestionId;
      if (!other || other === hint.questionId || !textById.has(other)) continue;
      alsoQuestionId = other;
    }

    const id = hintId(hint.kind, hint.questionId, alsoQuestionId ?? "", excerpt);
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push({
      id,
      kind: hint.kind,
      source: "ai",
      questionId: hint.questionId,
      ...(alsoQuestionId ? { alsoQuestionId } : {}),
      title,
      text,
      excerpt: hint.excerpt.trim(),
    });
  }
  return kept;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runAiChecks(params: {
  answers: ScoringAnswer[];
  language: LiveCheckLanguage;
  model: unknown;
  timeoutMs: number;
  generate?: GenerateObjectImpl;
}): Promise<AiCheckResult> {
  const { answers, language, model, timeoutMs, generate } = params;
  if (answers.length === 0) return { ok: true, hints: [] };

  const nonce = newDelimiterNonce();
  const system = buildLiveCheckSystemPrompt(nonce, toLiveCheckLanguage(language));
  const prompt = buildLiveCheckUserPrompt(answers, nonce);

  let timer: NodeJS.Timeout | undefined;
  // The abort signal stops a well-behaved provider; this race also bounds a
  // call that ignores it.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for the model")), timeoutMs);
  });

  try {
    const { object } = await Promise.race([
      generateObjectWithSelfCorrection(
        {
          model,
          schema: liveCheckOutputSchema,
          system,
          prompt,
          temperature: 0,
          // Exactly one model call per run.
          innerMaxRetries: 0,
          maxSelfCorrectionAttempts: 0,
          timeoutMs,
        },
        generate,
      ),
      deadline,
    ]);
    // The real SDK validates already; an injected generate may not.
    const parsed = liveCheckOutputSchema.safeParse(object);
    if (!parsed.success) {
      logger.warn("intake live checks: model output did not match the schema");
      return { ok: false, hints: [], error: "Model output did not match the schema" };
    }
    return { ok: true, hints: validHints(parsed.data, answers) };
  } catch (err) {
    const message = errorMessage(err);
    // The message only: never the prompt, the answers or the key.
    logger.warn(`intake live checks: AI check failed: ${message}`);
    return { ok: false, hints: [], error: message };
  } finally {
    clearTimeout(timer);
  }
}
