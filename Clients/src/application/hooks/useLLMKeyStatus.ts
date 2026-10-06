import { useQuery } from "@tanstack/react-query";
import { getLLMKeyStatus, LLMKeyStatus } from "../repository/llmKeys.repository";

/** Invalidate after a key is created, edited or deleted. */
export const LLM_KEY_STATUS_QUERY_KEY = ["llmKeyStatus"] as const;

/**
 * Whether the organization has an LLM API key. One cached query shared by
 * every caller, so a change on the keys page reaches them all.
 *
 * `hasKeys` is optimistically true while loading, so callers that gate an
 * action on it do not flash a "no key" state.
 */
export function useLLMKeyStatus() {
  const query = useQuery<LLMKeyStatus>({
    queryKey: LLM_KEY_STATUS_QUERY_KEY,
    queryFn: getLLMKeyStatus,
    retry: false,
  });

  const loading = query.isPending;
  const data = query.data ?? null;
  const error = query.error ? query.error.message || "Failed to fetch LLM key status" : null;

  return { data, loading, error, hasKeys: loading || (data?.hasKeys ?? false) };
}
