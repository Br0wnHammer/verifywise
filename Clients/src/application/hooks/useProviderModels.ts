import { useQuery } from "@tanstack/react-query";
import { getGatewayModelsForProvider } from "../repository/deepEval.repository";
import { PROVIDERS, type ModelInfo } from "../../presentation/utils/providers";

const PROVIDER_MODELS_KEY = ["provider-models"] as const;

/**
 * Merge the gateway catalog with the bundled list: catalog entries are named by ID only,
 * so a model the bundled list knows keeps its name and description. Without a catalog
 * (gateway down or still loading) the bundled list is used.
 */
export function mergeWithBundledModels(provider: string, live: ModelInfo[]): ModelInfo[] {
  const bundled = PROVIDERS[provider]?.models ?? [];
  if (live.length === 0) return bundled;
  const known = new Map(bundled.map((m) => [m.id, m]));
  return live.map((m) => {
    const k = known.get(m.id);
    return k ? { ...m, name: k.name, description: k.description } : m;
  });
}

/** A provider's chat models: the AI Gateway's LiteLLM catalog, else the bundled list. */
export function useProviderModels(provider: string) {
  const query = useQuery({
    queryKey: [...PROVIDER_MODELS_KEY, provider],
    queryFn: () => getGatewayModelsForProvider(provider),
    enabled: !!provider,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
  return { models: mergeWithBundledModels(provider, query.data ?? []), isLoading: query.isLoading };
}
