/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState } from "react";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEvidenceGaps } from "../../../application/hooks/useEvidenceAi";
import { useTranslation } from "../../../../application/hooks/useTranslation";
import Chip from "../../components/Chip";
import { palette } from "../../themes/palette";

const FRAMEWORK_LABELS: Record<string, string> = {
  eu_ai_act: "EU AI Act",
  iso_42001: "ISO 42001",
};

/**
 * Evidence gap summary for the Evidence hub tab (#4911). Mounted ONCE at the
 * tab level (not inside the reused table) so org-wide coverage numbers are
 * not repeated per group/model. Shows counts by gap severity and expands to
 * name the gaps whenever there are any.
 */
const EvidenceGapsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, error } = useEvidenceGaps();
  const [expanded, setExpanded] = useState(false);

  if (isLoading || error || !data) return null;

  const gaps: any[] = data.gaps ?? [];
  const total = data.total_controls ?? 0;
  if (total === 0) return null;

  const worst = gaps.slice(0, 8);
  const hasGaps = gaps.length > 0;

  return (
    <Box sx={{ mb: 2 }}>
      <Alert
        severity={hasGaps ? "warning" : "success"}
        icon={hasGaps ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
        onClick={() => hasGaps && setExpanded((prev) => !prev)}
        sx={{ cursor: hasGaps ? "pointer" : "default", alignItems: "center" }}
      >
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
            {t("Evidence coverage")}: {total - gaps.length}/{total} {t("controls adequate")}
          </Typography>
          {data.controls_without_evidence > 0 && (
            <Chip
              size="small"
              variant="error"
              uppercase={false}
              label={`${data.controls_without_evidence} ${t("without evidence")}`}
            />
          )}
          {data.controls_with_low_quality > 0 && (
            <Chip
              size="small"
              variant="warning"
              uppercase={false}
              label={`${data.controls_with_low_quality} ${t("low quality")}`}
            />
          )}
        </Stack>
        {expanded && worst.length > 0 && (
          <Stack component="ul" spacing={0.5} sx={{ mt: 1, pl: 2, m: 0 }}>
            {worst.map((gap: any) => (
              <Typography
                component="li"
                key={`${gap.framework_type}-${gap.control_id}`}
                sx={{ fontSize: 12 }}
              >
                {FRAMEWORK_LABELS[gap.framework_type] ?? gap.framework_type}: {gap.control_title} (
                {gap.gap_type === "no_evidence" ? t("no evidence") : t("low quality")})
              </Typography>
            ))}
            {gaps.length > worst.length && (
              <Typography component="li" sx={{ fontSize: 12, color: palette.text.tertiary }}>
                {gaps.length - worst.length} {t("more")}…
              </Typography>
            )}
          </Stack>
        )}
      </Alert>
    </Box>
  );
};

export default EvidenceGapsPanel;
