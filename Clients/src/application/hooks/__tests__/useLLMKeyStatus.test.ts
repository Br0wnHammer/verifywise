import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockOrganizationId: number | null = 1;
vi.mock("../useAuth", () => ({
  useAuth: () => ({ organizationId: mockOrganizationId }),
}));

vi.mock("../../repository/llmKeys.repository", () => ({
  getLLMKeyStatus: vi.fn(),
}));

import { useLLMKeyStatus } from "../useLLMKeyStatus";
import { getLLMKeyStatus } from "../../repository/llmKeys.repository";

const mockGetStatus = vi.mocked(getLLMKeyStatus);

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

// A fresh client per hook unless a test shares one on purpose.
const render = (client: QueryClient = newClient()) => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useLLMKeyStatus(), { wrapper });
};

describe("useLLMKeyStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganizationId = 1;
  });

  it("fetches and returns LLM key status", async () => {
    const status = { hasKey: true, provider: "openai" };
    mockGetStatus.mockResolvedValue(status as any);

    const { result } = render();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(status);
    expect(result.current.error).toBeNull();
  });

  it("sets error on failure", async () => {
    mockGetStatus.mockRejectedValue(new Error("Network error"));

    const { result } = render();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("Network error");
  });

  it("starts in loading state", () => {
    mockGetStatus.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = render();
    expect(result.current.loading).toBe(true);
  });

  it("derives hasKeys as true while still loading, regardless of eventual result", () => {
    mockGetStatus.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = render();
    expect(result.current.loading).toBe(true);
    expect(result.current.hasKeys).toBe(true);
  });

  it("derives hasKeys as false once resolved with no keys configured", async () => {
    mockGetStatus.mockResolvedValue({ hasKeys: false, keyCount: 0, providers: [] } as any);
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasKeys).toBe(false);
  });

  it("derives hasKeys as true once resolved with keys configured", async () => {
    mockGetStatus.mockResolvedValue({
      hasKeys: true,
      keyCount: 1,
      providers: ["Anthropic"],
    } as any);
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasKeys).toBe(true);
  });

  it("drops the cached answer when a refetch fails", async () => {
    const client = newClient();
    mockGetStatus.mockResolvedValueOnce({ hasKeys: true, keyCount: 1, providers: ["OpenAI"] });
    const { result } = render(client);
    await waitFor(() => expect(result.current.data?.hasKeys).toBe(true));

    // The last key was deleted, then the status request failed.
    mockGetStatus.mockRejectedValueOnce(new Error("Network error"));
    await act(() => client.refetchQueries());

    await waitFor(() => expect(result.current.error).toBe("Network error"));
    expect(result.current.data).toBeNull();
    expect(result.current.hasKeys).toBe(false);
  });

  it("keeps each organization's status separate", async () => {
    const client = newClient();
    mockGetStatus.mockResolvedValueOnce({ hasKeys: true, keyCount: 1, providers: ["OpenAI"] });
    const first = render(client);
    await waitFor(() => expect(first.result.current.data?.hasKeys).toBe(true));
    first.unmount();

    // Another org signs in on the same tab: it must not see the first org's answer.
    mockOrganizationId = 2;
    mockGetStatus.mockReturnValueOnce(new Promise(() => {}));
    const second = render(client);
    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.data).toBeNull();
  });

  it("does not ask for a status before there is an organization", () => {
    mockOrganizationId = null;
    const { result } = render();
    expect(mockGetStatus).not.toHaveBeenCalled();
    // Optimistic, like any other pending state.
    expect(result.current.loading).toBe(true);
    expect(result.current.hasKeys).toBe(true);
  });
});
