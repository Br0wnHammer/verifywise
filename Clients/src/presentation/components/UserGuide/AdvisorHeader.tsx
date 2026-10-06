import { FC, useEffect } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { colors, typography, spacing, border } from "./styles/theme";
import { LLMKeysModel } from "../../../domain/models/Common/llmKeys/llmKeys.model";
import { useLLMKeys } from "../../../application/hooks/useLLMKeys";

/** Stable empty list, so effects do not re-run on every render while loading. */
const NO_KEYS: LLMKeysModel[] = [];

interface AdvisorHeaderProps {
  onClose: () => void;
  selectedLLMKeyId?: number;
  onLLMKeyChange?: (keyId: number) => void;
  onLLMKeysLoaded?: (hasKeys: boolean, isLoading: boolean) => void;
  isEnlarged?: boolean;
  onToggleEnlarge?: () => void;
}

const AdvisorHeader: FC<AdvisorHeaderProps> = ({
  onClose,
  selectedLLMKeyId,
  onLLMKeyChange,
  onLLMKeysLoaded,
  isEnlarged = false,
  onToggleEnlarge,
}) => {
  // The shared, cached key list: the keys page invalidates it after a change,
  // so adding a key from Start here unlocks the Advisor without a remount.
  const { data: fetchedKeys, isPending: loading, isError } = useLLMKeys();
  const llmKeys = fetchedKeys ?? NO_KEYS;

  useEffect(() => {
    if (loading) {
      onLLMKeysLoaded?.(false, true);
      return;
    }
    const keys = fetchedKeys ?? NO_KEYS;
    onLLMKeysLoaded?.(!isError && keys.length > 0, false);

    // Auto-select the first key if none is selected or the saved one is gone.
    if (keys.length > 0 && onLLMKeyChange) {
      const savedKeyExists = selectedLLMKeyId && keys.some((k) => k.id === selectedLLMKeyId);
      if (!savedKeyExists) {
        onLLMKeyChange(keys[0].id);
      }
    }
  }, [fetchedKeys, loading, isError, selectedLLMKeyId, onLLMKeyChange, onLLMKeysLoaded]);

  const handleKeyChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const keyId = parseInt(event.target.value);
    if (onLLMKeyChange) {
      onLLMKeyChange(keyId);
    }
  };

  return (
    <div
      style={{
        backgroundColor: colors.background.white,
        borderBottom: border.default,
        padding: `${spacing.sm} ${spacing.md}`,
      }}
    >
      {/* Main header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: spacing.sm,
        }}
      >
        <span
          style={{
            fontFamily: typography.fontFamily.sans,
            fontSize: typography.fontSize.sm,
            fontWeight: typography.fontWeight.medium,
            color: colors.text.primary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          AI advisor
        </span>

        {/* Right side: LLM Key Selector and Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.sm,
            flexShrink: 0,
          }}
        >
          {/* LLM Key Dropdown - only show if more than 1 key */}
          {!loading && llmKeys.length > 1 && (
            <select
              value={selectedLLMKeyId || ""}
              onChange={handleKeyChange}
              style={{
                fontFamily: typography.fontFamily.sans,
                fontSize: typography.fontSize.xs,
                padding: `4px 8px`,
                borderRadius: border.radius,
                border: `1px solid ${colors.border?.default || "#e5e7eb"}`,
                backgroundColor: colors.background.white,
                color: colors.text.primary,
                cursor: "pointer",
                outline: "none",
              }}
              title="Select AI model"
            >
              {llmKeys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.model}
                </option>
              ))}
            </select>
          )}

          {/* Enlarge/Shrink button */}
          {onToggleEnlarge && (
            <button
              onClick={onToggleEnlarge}
              className="header-icon-button"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                backgroundColor: "transparent",
                border: "none",
                borderRadius: border.radius,
                cursor: "pointer",
                color: colors.text.secondary,
              }}
              title={isEnlarged ? "Shrink" : "Enlarge"}
            >
              {isEnlarged ? (
                <Minimize2 size={14} strokeWidth={1.5} />
              ) : (
                <Maximize2 size={14} strokeWidth={1.5} />
              )}
            </button>
          )}

          {/* Close button */}
          <button
            onClick={onClose}
            className="header-icon-button"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              backgroundColor: "transparent",
              border: "none",
              borderRadius: border.radius,
              cursor: "pointer",
              color: colors.text.secondary,
            }}
            title="Close"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdvisorHeader;
