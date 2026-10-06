import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../useAuth", () => ({
  useAuth: () => ({ organizationId: 1 }),
}));

vi.mock("../../repository/llmKeys.repository", () => ({
  getLLMKeys: vi.fn(),
  getLLMKeyStatus: vi.fn(),
}));

import { useLLMKeys, invalidateLLMKeyQueries } from "../useLLMKeys";
import { useLLMKeyStatus } from "../useLLMKeyStatus";
import { getLLMKeys, getLLMKeyStatus } from "../../repository/llmKeys.repository";

const mockGetKeys = vi.mocked(getLLMKeys);
const mockGetStatus = vi.mocked(getLLMKeyStatus);

const keysResponse = (names: string[]) =>
  ({
    data: { data: names.map((name, i) => ({ id: i + 1, name, model: "m", key: "***" })) },
  }) as any;

describe("useLLMKeys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refetches the key list and the status after invalidateLLMKeyQueries", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    mockGetKeys.mockResolvedValueOnce(keysResponse([]));
    mockGetStatus.mockResolvedValueOnce({ hasKeys: false, keyCount: 0, providers: [] });
    const { result } = renderHook(() => ({ keys: useLLMKeys(), status: useLLMKeyStatus() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.keys.data).toEqual([]));
    await waitFor(() => expect(result.current.status.hasKeys).toBe(false));

    // A key was added on the keys page.
    mockGetKeys.mockResolvedValueOnce(keysResponse(["OpenAI"]));
    mockGetStatus.mockResolvedValueOnce({ hasKeys: true, keyCount: 1, providers: ["OpenAI"] });
    await act(() => invalidateLLMKeyQueries(client));

    await waitFor(() => expect(result.current.keys.data).toHaveLength(1));
    expect(result.current.status.hasKeys).toBe(true);
  });
});
