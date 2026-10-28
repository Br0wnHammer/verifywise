import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLanguage } from "../../i18n/domTranslator";
import {
  DEFAULT_RATE_LIMIT_PAUSE_SECONDS,
  postLiveChecks,
  type FormSchema,
  type PublicFormRef,
} from "../repository/intakeForm.repository";
import { HINT_KIND_ORDER, type LiveCheckHint } from "../../domain/types/intakeLiveChecks";
import { evaluateForm, sortFields } from "../utils/intakeFormLogic";
import { runRuleChecks } from "../utils/intakeLiveChecks";

/** The AI check can only run when some free-text answer has at least this many characters. */
const AI_MIN_ANSWER_CHARS = 20;
const TEXT_TYPES = ["text", "textarea"];

interface Params {
  ref: PublicFormRef;
  schema: FormSchema;
  values: Record<string, unknown>;
  enabled: boolean;
  aiAvailable: boolean;
}

interface AiResult {
  hints: LiveCheckHint[];
  /** The answers the hints were computed from, to dim hints whose answer has changed since. */
  snapshot: Record<string, unknown>;
}

interface Result {
  /** Rule hints plus the latest AI hints, most serious kind first, hidden fields dropped. */
  hints: LiveCheckHint[];
  hintsFor: (questionId: string) => LiveCheckHint[];
  /** Questions whose AI hints are out of date because the answer was edited since. */
  staleQuestionIds: Set<string>;
  /** True after a 429, until the server's reset time passes. */
  aiPaused: boolean;
  /** Runs one AI check on the current answers; does nothing when `aiCheck.canRun` is false. */
  checkWithAi: () => void;
  aiCheck: {
    /** The latest check: none yet, in flight, answered, or failed. */
    status: "idle" | "running" | "done" | "error";
    /** False while a check runs, after a 429, with no answer long enough, or once these answers were checked. */
    canRun: boolean;
  };
}

/**
 * Rule hints on every change, in the browser. AI hints only when the submitter
 * asks for them (one model call on the form's key per request), so token use
 * follows deliberate checks rather than typing pauses.
 */
export function useIntakeLiveChecks({ ref, schema, values, enabled, aiAvailable }: Params): Result {
  const [ai, setAi] = useState<AiResult | null>(null);
  const [aiPaused, setAiPaused] = useState(false);
  const [aiStatus, setAiStatus] = useState<Result["aiCheck"]["status"]>("idle");
  /** The text answers of the last check that got an answer, so the same answers are not sent twice. */
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  // State updates land after the render, so two clicks in one tick both see "idle".
  const runningRef = useRef(false);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { visibleIds, hasLongAnswer, textKey } = useMemo(() => {
    const { visibleIds: ids, effectiveAnswers } = evaluateForm(schema, values);
    const fields = sortFields(Array.isArray(schema?.fields) ? schema.fields : []).filter(
      (f) => TEXT_TYPES.includes(f.type) && ids.has(f.id),
    );
    const texts: Record<string, string> = {};
    for (const f of fields) {
      const v = effectiveAnswers[f.id];
      if (typeof v === "string") texts[f.id] = v;
    }
    return {
      visibleIds: ids,
      hasLongAnswer: Object.values(texts).some((t) => t.trim().length >= AI_MIN_ANSWER_CHARS),
      textKey: JSON.stringify(texts),
    };
  }, [schema, values]);

  const canRun =
    enabled &&
    aiAvailable &&
    !aiPaused &&
    hasLongAnswer &&
    aiStatus !== "running" &&
    checkedKey !== textKey;

  const checkWithAi = useCallback(() => {
    if (!canRun || runningRef.current) return;
    runningRef.current = true;
    setAiStatus("running");
    const snapshot = values;
    const key = textKey;
    postLiveChecks(ref, snapshot, getLanguage())
      .then((res) => {
        // A failed check leaves the hints already shown in place.
        if (res.error) {
          setAiStatus("error");
          return;
        }
        setAi({ hints: res.hints, snapshot });
        setCheckedKey(key);
        setAiStatus("done");
      })
      .catch((error: unknown) => {
        setAiStatus("error");
        const e = error as { status?: number; retryAfterSeconds?: number };
        if (e?.status === 429) {
          setAiPaused(true);
          const seconds = e.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_PAUSE_SECONDS;
          pauseTimerRef.current = setTimeout(() => setAiPaused(false), seconds * 1000);
        }
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, [canRun, values, textKey, ref]);

  useEffect(
    () => () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    },
    [],
  );

  const hints = useMemo(() => {
    if (!enabled) return [];
    const rules = runRuleChecks(schema, values);
    const aiHints = (ai?.hints ?? []).filter((h) => visibleIds.has(h.questionId));
    // Stable sort: rule hints stay ahead of AI hints within a kind.
    return [...rules, ...aiHints].sort(
      (a, b) => HINT_KIND_ORDER.indexOf(a.kind) - HINT_KIND_ORDER.indexOf(b.kind),
    );
  }, [enabled, schema, values, ai, visibleIds]);

  const staleQuestionIds = useMemo(() => {
    const stale = new Set<string>();
    if (!enabled || !ai) return stale;
    for (const h of ai.hints) {
      for (const id of [h.questionId, h.alsoQuestionId]) {
        if (id && !Object.is(ai.snapshot[id], values[id])) stale.add(id);
      }
    }
    return stale;
  }, [enabled, ai, values]);

  const hintsFor = useCallback(
    (questionId: string) =>
      hints.filter((h) => h.questionId === questionId || h.alsoQuestionId === questionId),
    [hints],
  );

  return {
    hints,
    hintsFor,
    staleQuestionIds,
    aiPaused,
    checkWithAi,
    aiCheck: { status: aiStatus, canRun },
  };
}
