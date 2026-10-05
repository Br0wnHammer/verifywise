import { act, renderHook, waitFor } from "@testing-library/react";
import useHasLLMKeys from "../useHasLLMKeys";

const mockGetLLMKeyStatus = vi.fn();

vi.mock("../../repository/llmKeys.repository", () => ({
  getLLMKeyStatus: (...args: unknown[]) => mockGetLLMKeyStatus(...args),
}));

describe("useHasLLMKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays null until the status request resolves", () => {
    mockGetLLMKeyStatus.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHasLLMKeys());
    expect(result.current).toBeNull();
  });

  it("returns false when the organization has no keys", async () => {
    mockGetLLMKeyStatus.mockResolvedValue({ hasKeys: false, keyCount: 0, providers: [] });
    const { result } = renderHook(() => useHasLLMKeys());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("returns true when the organization has a key", async () => {
    mockGetLLMKeyStatus.mockResolvedValue({
      hasKeys: true,
      keyCount: 1,
      providers: ["OpenAI"],
    });
    const { result } = renderHook(() => useHasLLMKeys());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays null when the status request fails", async () => {
    let rejectStatus: (error: Error) => void = () => {};
    mockGetLLMKeyStatus.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStatus = reject;
      }),
    );
    const { result } = renderHook(() => useHasLLMKeys());

    await act(async () => {
      rejectStatus(new Error("unavailable"));
    });

    expect(result.current).toBeNull();
  });
});
