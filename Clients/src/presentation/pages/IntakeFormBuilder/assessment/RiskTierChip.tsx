import { Box, CircularProgress, Typography, useTheme } from "@mui/material";
import Chip from "../../../components/Chip";
import type { IntakeSubmission } from "../../../../application/repository/intakeForm.repository";
import { isAssessmentV2 } from "../../../../application/utils/intakeScoring/isAssessmentV2";

/**
 * A submission's risk in the submissions list. AI-scored (v2): the number next
 * to its band ("64 High"), "≥70" when it is the rule minimum alone, nothing
 * without a score. Older (v1) scores keep their tier chip.
 */
function RiskTierChip({ submission }: { submission: IntakeSubmission }) {
  const theme = useTheme();
  const assessment = submission.riskAssessment;

  if (isAssessmentV2(assessment)) {
    if (assessment.finalScore === null) return null;
    if (assessment.rulesOnly) {
      return (
        <Typography sx={{ fontSize: "13px", color: theme.palette.text.primary }}>
          ≥{assessment.finalScore}
        </Typography>
      );
    }
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <Typography sx={{ fontSize: "13px", fontWeight: 600, color: theme.palette.text.primary }}>
          {assessment.finalScore}
        </Typography>
        <Chip label={submission.riskTier || assessment.tier || ""} />
      </Box>
    );
  }

  if (!submission.riskTier && !assessment) {
    return <CircularProgress size={14} sx={{ color: theme.palette.text.accent }} />;
  }
  const tier = (submission.riskTier || assessment?.tier || "").toLowerCase();
  if (!tier) return <Chip label="Pending" />;
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  return <Chip label={label} />;
}

export default RiskTierChip;
