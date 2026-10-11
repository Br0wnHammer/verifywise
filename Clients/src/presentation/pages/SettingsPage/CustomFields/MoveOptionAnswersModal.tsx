import React, { useState } from "react";
import { Stack, Typography } from "@mui/material";
import StandardModal from "../../../components/Modals/StandardModal";
import Select from "../../../components/Inputs/Select";
import { useTranslation } from "../../../../application/hooks/useTranslation";
import { fill } from "../../../../i18n/fill";
import {
  CustomFieldEntityType,
  entityCountNoun,
  formatScoredOption,
  IScoredOptionInput,
} from "../../../../domain/interfaces/i.customField";

export interface OptionInUse {
  id: string;
  label: string;
  count: number;
}

interface MoveOptionAnswersModalProps {
  inUse: OptionInUse[];
  entityType: CustomFieldEntityType;
  /**
   * Options that remain after the save. Scored options need an id to be a
   * target; a plain select or multiselect option is its own text.
   */
  remaining: ReadonlyArray<IScoredOptionInput | string>;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: (moves: Record<string, string>) => void;
}

const MoveOptionAnswersModal: React.FC<MoveOptionAnswersModalProps> = ({
  inUse,
  entityType,
  remaining,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const targets = remaining.flatMap((o) => {
    if (typeof o === "string") return [{ _id: o, name: o }];
    return typeof o.id === "string" ? [{ _id: o.id, name: formatScoredOption(o) }] : [];
  });

  return (
    <StandardModal
      isOpen={true}
      title="Move answers before removing options"
      description="Records use the options you removed. Choose where their answers go."
      submitButtonText="Move and save"
      isSubmitting={isSubmitting}
      isSubmitDisabled={targets.length === 0}
      onClose={onCancel}
      onSubmit={() => {
        if (inUse.some((o) => !moves[o.id])) {
          setError(t("Choose an option for each removed option."));
          return;
        }
        onConfirm(moves);
      }}
    >
      <Stack sx={{ gap: "16px" }}>
        {targets.length === 0 && (
          <Typography sx={{ fontSize: "13px", color: "text.secondary" }}>
            {t(
              "New options can't receive answers until they are saved. Save the new options first, then remove the old ones.",
            )}
          </Typography>
        )}
        {inUse.map((option) => (
          <Stack key={option.id} sx={{ gap: "8px" }}>
            <Typography sx={{ fontSize: "13px" }}>
              {fill(t("{option} is used by {count} {records}. Move these answers to:"), {
                count: option.count,
                records: t(entityCountNoun(entityType, option.count)),
                option: option.label,
              })}
            </Typography>
            <Select
              id={`move-${option.id}`}
              value={moves[option.id] ?? ""}
              items={targets}
              placeholder="Select an option"
              onChange={(e) => setMoves((m) => ({ ...m, [option.id]: e.target.value as string }))}
            />
          </Stack>
        ))}
        {error && <Typography sx={{ fontSize: "12px", color: "error.main" }}>{error}</Typography>}
      </Stack>
    </StandardModal>
  );
};

export default MoveOptionAnswersModal;
