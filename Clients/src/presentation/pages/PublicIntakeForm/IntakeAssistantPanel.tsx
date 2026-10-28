import { Box, ButtonBase, Typography } from "@mui/material";
import {
  HINT_KIND_ORDER,
  type HintKind,
  type LiveCheckHint,
} from "../../../domain/types/intakeLiveChecks";
import { border } from "../../themes/palette";
import { HINT_KIND_COLORS } from "./LiveCheckHints";

const KIND_LABELS: Record<HintKind, string> = {
  prohibited: "Possible prohibited practice",
  regulation: "Possible regulated use",
  contradiction: "Conflicting answers",
  vague: "Needs more detail",
};

/**
 * "Intake assistant": counts per hint kind, the open hints (each jumps to its
 * question), how many prefilled answers still need confirming, and the
 * promise that none of this blocks submission.
 */
export function IntakeAssistantPanel({
  hints,
  unconfirmedCount,
  aiPaused,
  questionLabel,
  onSelect,
}: {
  hints: LiveCheckHint[];
  unconfirmedCount: number;
  aiPaused: boolean;
  questionLabel: (questionId: string) => string;
  onSelect: (questionId: string) => void;
}) {
  const counts = HINT_KIND_ORDER.map((kind) => ({
    kind,
    count: hints.filter((h) => h.kind === kind).length,
  })).filter((c) => c.count > 0);

  return (
    <Box
      component="aside"
      aria-label="Intake assistant"
      data-testid="intake-assistant-panel"
      sx={{
        p: "16px",
        border: `1px solid ${border.dark}`,
        borderRadius: "4px",
        backgroundColor: "background.main",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <Typography component="h2" sx={{ fontSize: "14px", fontWeight: 600, color: "text.primary" }}>
        Intake assistant
      </Typography>

      {counts.length === 0 ? (
        <Typography sx={{ fontSize: "13px", color: "text.secondary" }}>No hints so far.</Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {counts.map(({ kind, count }) => (
            <Box
              key={kind}
              data-testid={`assistant-count-${kind}`}
              sx={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: HINT_KIND_COLORS[kind].text,
                  flexShrink: 0,
                }}
              />
              <Typography
                component="span"
                sx={{ fontSize: "13px", color: "text.primary", flex: 1 }}
              >
                {KIND_LABELS[kind]}
              </Typography>
              <Typography component="span" sx={{ fontSize: "13px", fontWeight: 600 }}>
                {count}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      {hints.length > 0 && (
        <Box
          component="ul"
          sx={{
            listStyle: "none",
            m: 0,
            p: 0,
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          {hints.map((hint) => (
            <li key={hint.id}>
              <ButtonBase
                onClick={() => onSelect(hint.questionId)}
                sx={{
                  "width": "100%",
                  "justifyContent": "flex-start",
                  "textAlign": "left",
                  "p": "6px 8px",
                  "borderRadius": "4px",
                  "gap": "8px",
                  "&:hover": { backgroundColor: "background.accent" },
                }}
              >
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    mt: "6px",
                    alignSelf: "flex-start",
                    borderRadius: "50%",
                    backgroundColor: HINT_KIND_COLORS[hint.kind].text,
                    flexShrink: 0,
                  }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    data-vw-no-translate={hint.source === "ai" ? "true" : undefined}
                    sx={{ fontSize: "13px", fontWeight: 500, color: "text.primary" }}
                  >
                    {hint.title}
                  </Typography>
                  <Typography
                    data-vw-no-translate="true"
                    sx={{
                      fontSize: "12px",
                      color: "text.tertiary",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {questionLabel(hint.questionId)}
                  </Typography>
                </Box>
              </ButtonBase>
            </li>
          ))}
        </Box>
      )}

      {unconfirmedCount > 0 && (
        <Typography
          data-testid="assistant-unconfirmed"
          sx={{ fontSize: "13px", color: "text.primary" }}
        >
          <span>{unconfirmedCount}</span>{" "}
          <span>
            {unconfirmedCount === 1
              ? "answer was read from the vendor document. Confirm before submitting."
              : "answers were read from the vendor document. Confirm before submitting."}
          </span>
        </Typography>
      )}

      {aiPaused && (
        <Typography sx={{ fontSize: "12px", color: "text.tertiary" }}>
          AI checks paused for a few minutes
        </Typography>
      )}

      <Typography sx={{ fontSize: "12px", color: "text.tertiary", lineHeight: 1.5 }}>
        These checks never block submission. Your reviewer sees them too.
      </Typography>
    </Box>
  );
}

export default IntakeAssistantPanel;
