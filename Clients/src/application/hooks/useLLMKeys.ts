import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getLLMKeys } from "../repository/llmKeys.repository";
import { LLMKeysModel } from "../../domain/models/Common/llmKeys/llmKeys.model";
import { useAuth } from "./useAuth";
import { LLM_KEY_STATUS_QUERY_KEY } from "./useLLMKeyStatus";

/** Prefix for every org's key list. */
export const LLM_KEYS_QUERY_KEY = ["llmKeys"] as const;

/**
 * The organization's LLM keys, one cached query per org. Scoped to the org
 * because the query cache outlives a logout.
 */
export function useLLMKeys() {
  const { organizationId } = useAuth();
  return useQuery<LLMKeysModel[]>({
    queryKey: [...LLM_KEYS_QUERY_KEY, organizationId ?? null],
    queryFn: async () => {
      const response = await getLLMKeys();
      return response.data.data?.map((key: LLMKeysModel) => new LLMKeysModel(key)) ?? [];
    },
    enabled: organizationId != null,
    retry: false,
  });
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
