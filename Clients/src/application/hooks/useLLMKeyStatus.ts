import { useQuery } from "@tanstack/react-query";
import { getLLMKeyStatus, LLMKeyStatus } from "../repository/llmKeys.repository";
import { useAuth } from "./useAuth";

/** Prefix for every org's status entry; see invalidateLLMKeyQueries. */
export const LLM_KEY_STATUS_QUERY_KEY = ["llmKeyStatus"] as const;

/**
 * Whether the organization has an LLM API key. One cached query per org,
 * shared by its callers. Scoped to the org because the query cache outlives a
 * logout, so a shared key would show one org's status to the next user.
 *
 * `hasKeys` is optimistically true while loading (and before there is an
 * organization to ask about), so callers that gate an action on it do not
 * flash a "no key" state.
 */
export function useLLMKeyStatus() {
  const { organizationId } = useAuth();
  const query = useQuery<LLMKeyStatus>({
    queryKey: [...LLM_KEY_STATUS_QUERY_KEY, organizationId ?? null],
    queryFn: getLLMKeyStatus,
    enabled: organizationId != null,
    retry: false,
  });

  const loading = query.isPending;
  // A failed refetch keeps the previous data next to the error; treat it as
  // unknown, as a failed first load is, rather than trust the stale answer.
  const data = query.isError ? null : (query.data ?? null);
  const error = query.error ? query.error.message || "Failed to fetch LLM key status" : null;

  return { data, loading, error, hasKeys: loading || (data?.hasKeys ?? false) };
}
