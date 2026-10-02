import { useState } from "react";
import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { Network } from "lucide-react";
import { CustomizableButton } from "../button/customizable-button";
import { EmptyState } from "../EmptyState";
import { textStyles } from "../../themes/typography";
import {
  useUpdateVendorRiskLinkStatus,
  useVendorRiskLinks,
} from "../../../application/hooks/useRiskLinks";
import { DismissReason, RiskLink, RiskLinkStatus } from "../../../domain/interfaces/i.riskLink";
import LinkChildRiskForm from "./LinkChildRiskForm";
import LinkRow from "./LinkRow";

interface VendorRiskLinksPanelProps {
  vendorRiskId: number;
}

/**
 * The vendor risk's side of value-chain inheritance: the project risks that
 * inherit from it. A vendor risk is only ever a parent, so there is one group
 * and one way to add to it. There is no scan here either — derived scoring
 * runs between project risks only, and vendor parents are suggested by the
 * hierarchy pass, which an administrator starts from a project risk's panel.
 */
export default function VendorRiskLinksPanel({ vendorRiskId }: VendorRiskLinksPanelProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<RiskLink | null>(null);

  const {
    data: links = [],
    isLoading,
    isError,
    refetch,
  } = useVendorRiskLinks(vendorRiskId, showDismissed ? "dismissed" : undefined);
  const updateStatus = useUpdateVendorRiskLinkStatus(vendorRiskId);

  const onMutationError = (error: any) =>
    setNotice(
      error?.status === 404
        ? "One of these risks no longer exists"
        : error?.message || "Failed to update the link",
    );

  // Same rule as the project risk panel: dismissing a suggestion asks why,
  // un-linking a confirmed child does not.
  const handleAction = (link: RiskLink, next: RiskLinkStatus) => {
    setNotice(null);
    if (next === "dismissed" && link.status === "suggested") {
      setDismissing(link);
      return;
    }
    setDismissing(null);
    updateStatus.mutate({ id: link.id, status: next }, { onError: onMutationError });
  };

  const submitDismissal = (
    link: RiskLink,
    dismissal?: { dismissReason: DismissReason; dismissNote?: string },
  ) => {
    setNotice(null);
    setDismissing(null);
    updateStatus.mutate(
      { id: link.id, status: "dismissed", dismissal },
      { onError: onMutationError },
    );
  };

  if (isError) {
    return (
      <Alert
        severity="error"
        action={
          <CustomizableButton size="small" variant="text" onClick={() => void refetch()}>
            Retry
          </CustomizableButton>
        }
      >
        Failed to load linked risks.
      </Alert>
    );
  }

  return (
    <Stack spacing={8} sx={{ py: 8 }}>
      <Stack direction="row" justifyContent="space-between">
        <CustomizableButton
          size="small"
          variant="text"
          onClick={() => setShowForm((open) => !open)}
        >
          {showForm ? "Cancel" : "Link a project risk"}
        </CustomizableButton>
        <CustomizableButton
          size="small"
          variant="text"
          color="secondary"
          onClick={() => setShowDismissed((shown) => !shown)}
        >
          {showDismissed ? "Hide dismissed" : "Show dismissed"}
        </CustomizableButton>
      </Stack>

      {/* Dismissed rows are not the active list the form excludes; see LinkedRisksPanel. */}
      {showForm && (
        <LinkChildRiskForm
          vendorRiskId={vendorRiskId}
          existingLinks={showDismissed ? [] : links}
          onClose={() => setShowForm(false)}
        />
      )}

      {notice && <Alert severity="info">{notice}</Alert>}

      {isLoading && <CircularProgress size={20} />}

      {!isLoading && links.length === 0 && (
        <Stack spacing={4} alignItems="center">
          <EmptyState
            icon={Network}
            message="No project risks inherit from this vendor risk yet."
            showBorder={false}
          />
          <Typography sx={{ ...textStyles.caption, color: "text.accent" }}>
            Link a project risk that this vendor risk applies to. Suggestions from Suggest hierarchy
            appear here too.
          </Typography>
        </Stack>
      )}

      {links.length > 0 && (
        <Box>
          <Typography sx={{ ...textStyles.subsectionTitle, color: "text.primary", mb: 2 }}>
            Child risks
          </Typography>
          <Typography sx={{ ...textStyles.caption, color: "text.accent", mb: 4 }}>
            When the level of this risk changes, each child is flagged for review.
          </Typography>
          <Stack spacing={4}>
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                dismissing={dismissing?.id === link.id}
                statusPending={updateStatus.isPending}
                onAction={handleAction}
                onSubmitDismissal={(dismissal) => submitDismissal(link, dismissal)}
                onCancelDismissal={() => setDismissing(null)}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
