import { useEffect, useState } from "react";
import { getLLMKeyStatus } from "../repository/llmKeys.repository";

/**
 * Whether the current organization has at least one LLM API key.
 * `null` while the status request is in flight, or if it fails.
 */
const useHasLLMKeys = (): boolean | null => {
  const [hasLLMKeys, setHasLLMKeys] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    getLLMKeyStatus()
      .then((status) => {
        if (!cancelled) setHasLLMKeys(status.hasKeys);
      })
      .catch(() => {
        if (!cancelled) setHasLLMKeys(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return hasLLMKeys;
};

export default useHasLLMKeys;
