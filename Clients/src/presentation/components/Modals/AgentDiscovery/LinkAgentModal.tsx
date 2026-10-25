import React, { useMemo, useState } from "react";
import { Drawer, Stack, Typography, Divider, IconButton } from "@mui/material";
import { X } from "lucide-react";
import AutoCompleteField from "../../Inputs/Autocomplete";
import { CustomizableButton } from "../../button/customizable-button";
import Alert from "../../Alert";
import { apiServices } from "../../../../infrastructure/api/networkServices";
import { getClientErrorReason } from "../../../../application/utils/apiErrorReason";
import { useProjects } from "../../../../application/hooks/useProjects";
import { useModelInventories } from "../../../../application/hooks/useModelInventories";
import { formatModelLabel } from "../../../pages/AgentDiscovery/agentLabels";
import { palette } from "../../../themes/palette";

/** What the drawer links the agent to. */
export type AgentLinkKind = "model" | "useCase";

interface PickerOption {
  id: number;
  name: string;
}

const COPY: Record<
  AgentLinkKind,
  {
    title: string;
    intro: string;
    label: string;
    placeholder: string;
    empty: string;
    submit: string;
    submitting: string;
    path: string;
    bodyKey: string;
  }
> = {
  model: {
    title: "Link to model",
    intro: "Select a model from the inventory to link with this agent.",
    label: "Model",
    placeholder: "Select a model",
    empty: "No models",
    submit: "Link model",
    submitting: "Linking...",
    path: "link-model",
    bodyKey: "model_id",
  },
  useCase: {
    title: "Link to use case",
    intro: "Select the use case this agent belongs to.",
    label: "Use case",
    placeholder: "Select a use case",
    empty: "No use cases",
    submit: "Link use case",
    submitting: "Linking...",
    path: "link-use-case",
    bodyKey: "project_id",
  },
};

interface LinkAgentModalProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  agentId: number;
  kind: AgentLinkKind;
  onSuccess: () => void;
}

const singlePickerSx = { "& .MuiAutocomplete-input": { fontSize: "13px" } };

const LinkAgentModal: React.FC<LinkAgentModalProps> = ({
  isOpen,
  setIsOpen,
  agentId,
  kind,
  onSuccess,
}) => {
  const copy = COPY[kind];
  const [selected, setSelected] = useState<PickerOption | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both lists are cached; only the one this drawer needs is fetched, and only
  // while it is open.
  const { approvedProjects } = useProjects({ enabled: isOpen && kind === "useCase" });
  const { data: inventory } = useModelInventories({ enabled: isOpen && kind === "model" });

  const options = useMemo<PickerOption[]>(() => {
    if (kind === "useCase") {
      return approvedProjects
        .filter((p) => !p.is_organizational)
        .map((p) => ({ id: Number(p.id), name: p.project_title }));
    }
    return (inventory ?? [])
      .filter((m): m is typeof m & { id: number } => m.id != null)
      .map((m) => ({ id: Number(m.id), name: formatModelLabel(m) }));
  }, [kind, approvedProjects, inventory]);

  const handleClose = () => {
    setIsOpen(false);
    setSelected(null);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selected) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await apiServices.patch(`/agent-primitives/${agentId}/${copy.path}`, {
        [copy.bodyKey]: selected.id,
      });
      handleClose();
      onSuccess();
    } catch (err) {
      setError(getClientErrorReason(err) ?? "Could not update the agent. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={isOpen}
      onClose={handleClose}
      PaperProps={{
        sx: { width: 400, backgroundColor: palette.background.modal },
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ p: "16px 24px" }}
      >
        <Typography fontSize={16} fontWeight={600}>
          {copy.title}
        </Typography>
        <IconButton onClick={handleClose} size="small">
          <X size={20} />
        </IconButton>
      </Stack>

      <Divider />

      {/* Content */}
      <Stack sx={{ p: "24px", gap: "20px", flex: 1 }}>
        <Typography fontSize={13} color="text.secondary">
          {copy.intro}
        </Typography>

        <AutoCompleteField<PickerOption>
          id={kind === "model" ? "link-model-select" : "link-use-case-select"}
          sx={singlePickerSx}
          label={copy.label}
          isRequired
          placeholder={copy.placeholder}
          value={selected}
          options={options}
          getOptionLabel={(o) => o.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          noOptionsText={copy.empty}
          onChange={(_e, option) => setSelected(option ?? null)}
        />

        {error && (
          <Alert variant="error" body={error} hasIcon={false} sx={{ position: "static" }} />
        )}
      </Stack>

      {/* Footer */}
      <Divider />
      <Stack direction="row" justifyContent="flex-end" gap="8px" sx={{ p: "16px 24px" }}>
        <CustomizableButton
          variant="outlined"
          sx={{ border: `1px solid ${palette.border.dark}` }}
          onClick={handleClose}
        >
          Cancel
        </CustomizableButton>
        <CustomizableButton
          variant="contained"
          sx={{ backgroundColor: "brand.primary", border: "1px solid brand.primary" }}
          onClick={handleSubmit}
          isDisabled={isSubmitting || !selected}
        >
          {isSubmitting ? copy.submitting : copy.submit}
        </CustomizableButton>
      </Stack>
    </Drawer>
  );
};

export default LinkAgentModal;
