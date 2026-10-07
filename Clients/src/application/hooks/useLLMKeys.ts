import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getLLMKeys } from "../repository/llmKeys.repository";
import { LLMKeysModel } from "../../domain/models/Common/llmKeys/llmKeys.model";
import { useAuth } from "./useAuth";
import { useSettledLoading } from "./useSettledLoading";
import { LLM_KEY_STATUS_QUERY_KEY } from "./useLLMKeyStatus";

/** Prefix for every org's key list. */
export const LLM_KEYS_QUERY_KEY = ["llmKeys"] as const;

/** Stable empty list, so callers' memos and effects do not re-run while loading. */
const NO_KEYS: LLMKeysModel[] = [];

/**
 * The organization's LLM keys, one cached query per org. Scoped to the org
 * because the query cache outlives a logout.
 *
 * `loading` also covers this mount's own refetch of a cached list, so a stale
 * empty list is not read as "no keys"; later refetches (after an
 * invalidation) keep the settled list. Without an organization the query
 * never runs: that is a settled empty list, not a load.
 */
export function useLLMKeys() {
  const { organizationId } = useAuth();
  const hasOrganization = organizationId != null;
  const query = useQuery<LLMKeysModel[]>({
    queryKey: [...LLM_KEYS_QUERY_KEY, organizationId ?? null],
    queryFn: async () => {
      const response = await getLLMKeys();
      return response.data.data?.map((key: LLMKeysModel) => new LLMKeysModel(key)) ?? [];
    },
    enabled: hasOrganization,
  });

  const loading = useSettledLoading(query, hasOrganization, organizationId);

  return {
    // A failed refetch keeps the last list, so a transient failure does not
    // empty it.
    keys: query.data ?? NO_KEYS,
    loading,
    isFetching: query.isFetching,
    isError: query.isError,
    errorUpdatedAt: query.errorUpdatedAt,
  };
}

/**
 * After a key is created, edited or deleted: refresh the list and the
 * has-a-key status everywhere they are shown. Both come from the server, so
 * no screen works out the status on its own.
 */
export const invalidateLLMKeyQueries = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: LLM_KEY_STATUS_QUERY_KEY }),
  ]);
