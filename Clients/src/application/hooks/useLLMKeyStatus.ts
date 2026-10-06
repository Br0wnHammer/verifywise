import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getLLMKeyStatus, LLMKeyStatus } from "../repository/llmKeys.repository";
import { useAuth } from "./useAuth";

/** Prefix for every org's status entry. */
export const LLM_KEY_STATUS_QUERY_KEY = ["llmKeyStatus"] as const;

/**
 * Scoped to the organization: the query cache outlives a logout, so a shared
 * key would show one org's status to the next user who signs in.
 */
const statusKey = (organizationId: number | null | undefined) =>
  [...LLM_KEY_STATUS_QUERY_KEY, organizationId ?? null] as const;

/**
 * Write the status from a key list the caller has just fetched, the same way
 * GET /llm-keys/status computes it, instead of requesting it again.
 */
export const setLLMKeyStatusFromKeys = (
  queryClient: QueryClient,
  organizationId: number | null | undefined,
  keys: { name: string }[],
) => {
  queryClient.setQueryData<LLMKeyStatus>(statusKey(organizationId), {
    hasKeys: keys.length > 0,
    keyCount: keys.length,
    providers: [...new Set(keys.map((key) => key.name))],
  });
};

/**
 * Whether the organization has an LLM API key. One cached query per org,
 * shared by its callers, so the keys page's update reaches them all.
 *
 * `hasKeys` is optimistically true while loading, so callers that gate an
 * action on it do not flash a "no key" state.
 */
export function useLLMKeyStatus() {
  const { organizationId } = useAuth();
  const query = useQuery<LLMKeyStatus>({
    queryKey: statusKey(organizationId),
    queryFn: getLLMKeyStatus,
    retry: false,
  });

  const loading = query.isPending;
  // A failed refetch keeps the previous data next to the error; treat it as
  // unknown, as a failed first load is, rather than trust the stale answer.
  const data = query.isError ? null : (query.data ?? null);
  const error = query.error ? query.error.message || "Failed to fetch LLM key status" : null;

  return { data, loading, error, hasKeys: loading || (data?.hasKeys ?? false) };
}
