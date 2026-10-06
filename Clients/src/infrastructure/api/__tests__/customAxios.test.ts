import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../env.vars", () => ({
  ENV_VARs: { URL: "http://localhost:3000" },
}));

vi.mock("../../../application/redux/store", () => ({
  store: {
    getState: vi.fn(),
    dispatch: vi.fn(),
  },
  persistor: { flush: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../../../application/redux/auth/authSlice", () => ({
  clearAuthState: vi.fn(() => ({ type: "auth/clearAuthState" })),
  setAuthToken: vi.fn((token: string) => ({ type: "auth/setAuthToken", payload: token })),
}));

vi.mock("../../../i18n/domTranslator", () => ({
  getLanguage: vi.fn(() => "en"),
  translateKey: vi.fn((key: string) => key),
}));

import { CanceledError, type AxiosError } from "axios";
import CustomAxios, { showAlert, setShowAlertCallback } from "../customAxios";
import { store } from "../../../application/redux/store";
import { queryClient } from "../../../application/config/queryClient";
import { translateKey } from "../../../i18n/domTranslator";

const mockStore = vi.mocked(store);

const DE: Record<string, string> = {
  "Error": "Fehler",
  "An error occurred. Please try again later":
    "Ein Fehler ist aufgetreten. Bitte versuchen Sie es später erneut",
};

describe("customAxios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(translateKey).mockImplementation((key: string) => key);
    setShowAlertCallback(null as any);
    mockStore.getState.mockReturnValue({
      auth: { authToken: "test-token" },
    } as any);
  });

  describe("request interceptor", () => {
    it("adds Authorization header when token exists", async () => {
      const config = await (CustomAxios.interceptors.request as any).handlers[0].fulfilled({
        headers: {} as any,
        url: "/some-endpoint",
      });
      expect(config.headers.Authorization).toBe("Bearer test-token");
    });

    it("does not add Authorization header for reset-password endpoint", async () => {
      const config = await (CustomAxios.interceptors.request as any).handlers[0].fulfilled({
        headers: {} as any,
        url: "/users/reset-password",
      });
      expect(config.headers.Authorization).toBeUndefined();
    });

    it("does not add Authorization header for register endpoint", async () => {
      const config = await (CustomAxios.interceptors.request as any).handlers[0].fulfilled({
        headers: {} as any,
        url: "/users/register",
      });
      expect(config.headers.Authorization).toBeUndefined();
    });

    it("sets withCredentials for login endpoint", async () => {
      const config = await (CustomAxios.interceptors.request as any).handlers[0].fulfilled({
        headers: {} as any,
        url: "/users/login",
      });
      expect(config.withCredentials).toBe(true);
    });
  });

  describe("showAlert / setShowAlertCallback", () => {
    it("does nothing when no callback is set", () => {
      setShowAlertCallback(null as any);
      expect(() => showAlert({ variant: "error", body: "test" })).not.toThrow();
    });

    it("calls the callback when set", () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);
      showAlert({ variant: "success", body: "Done" });
      expect(callback).toHaveBeenCalledWith({ variant: "success", body: "Done" });
    });
  });

  describe("response interceptor global error toast", () => {
    const rejected = (CustomAxios.interceptors.response as any).handlers[0].rejected;

    it("shows a translated error toast for HTTP 5xx responses", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: { status: 500, data: { message: "Server error" } },
        message: "Internal Server Error",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).toHaveBeenCalledWith({
        variant: "error",
        title: "Error",
        body: "An error occurred. Please try again later",
      });
    });

    it("shows a translated error toast for network errors", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: undefined,
        request: {},
        message: "Network Error",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).toHaveBeenCalledWith({
        variant: "error",
        title: "Error",
        body: "An error occurred. Please try again later",
      });
    });

    it("translates the toast body when the active language is not English", async () => {
      vi.mocked(translateKey).mockImplementation((key: string) => DE[key] ?? key);
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: { status: 503, data: {} },
        message: "Service Unavailable",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).toHaveBeenCalledWith({
        variant: "error",
        title: "Fehler",
        body: "Ein Fehler ist aufgetreten. Bitte versuchen Sie es später erneut",
      });
    });

    it("shows a translated toast with the envelope detail for 4xx client errors", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      // Standardized 4xx envelope: reason phrase in `message`, detail in `data`
      const error = {
        config: { url: "/test" },
        response: { status: 400, data: { message: "Bad Request", data: "Name is required" } },
        message: "Bad Request",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).toHaveBeenCalledWith({
        variant: "error",
        title: "Error",
        body: "Name is required",
      });
    });

    it("falls back to the top-level message for legacy raw 4xx bodies", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: { status: 409, data: { message: "Already exists" } },
        message: "Conflict",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).toHaveBeenCalledWith({
        variant: "error",
        title: "Error",
        body: "Already exists",
      });
    });

    it("does not show a toast for 404 (callers handle it as empty state)", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: { status: 404, data: { message: "Not Found", data: "Resource not found" } },
        message: "Not Found",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).not.toHaveBeenCalled();
    });

    it("matches the 403 org-mismatch logout flow on the envelope `data` detail", async () => {
      vi.useFakeTimers();
      // performLogout assigns window.location.href, which jsdom cannot navigate.
      const originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { href: "", assign: vi.fn() },
      });
      mockStore.getState.mockReturnValue({ auth: { authToken: "token" } } as any);
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test", headers: {} },
        response: {
          status: 403,
          data: { message: "Forbidden", data: "User does not belong to this organization" },
        },
        message: "Forbidden",
      };

      await expect(rejected(error)).rejects.toThrow("User does not belong to this organization");
      expect(callback).toHaveBeenCalledWith({
        variant: "info",
        title: "Access Denied",
        body: "Please login again to continue.",
      });
      // Let the scheduled logout finish, so the next test starts logged in.
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    // Hooks that abort in-flight requests on cleanup (the assessment hooks do)
    // reject with a CanceledError that carries no response. That is the caller
    // walking away, not a failure — it must not reach the user as an error toast.
    it("does not show a toast when the request was canceled", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = new CanceledError("canceled");
      (error as AxiosError).config = { url: "/test" } as AxiosError["config"];

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).not.toHaveBeenCalled();
    });

    it("does not show a toast when the request was aborted via AbortSignal", async () => {
      const callback = vi.fn();
      setShowAlertCallback(callback);

      const error = {
        config: { url: "/test" },
        response: undefined,
        code: "ERR_CANCELED",
        message: "canceled",
      };

      await expect(rejected(error)).rejects.toEqual(error);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("forced logout clears the query cache", () => {
    const rejected = (CustomAxios.interceptors.response as any).handlers[0].rejected;
    const originalLocation = window.location;
    const mockAssign = vi.fn();

    beforeEach(() => {
      queryClient.setQueryData(["projects"], [{ id: 1, name: "Previous user's project" }]);
      // A forced logout loads /login as a new page, which jsdom cannot do.
      mockAssign.mockClear();
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { href: "", assign: mockAssign },
      });
      mockStore.getState.mockReturnValue({ auth: { authToken: "token" } } as any);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      queryClient.clear();
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    it("clears auth and the cache when a 403 org mismatch logs the user out", async () => {
      vi.useFakeTimers();

      const error = {
        config: { url: "/test", headers: {} },
        response: {
          status: 403,
          data: { message: "Forbidden", data: "User does not belong to this organization" },
        },
        message: "Forbidden",
      };

      await expect(rejected(error)).rejects.toThrow("User does not belong to this organization");
      // Nothing is cleared until the scheduled logout runs.
      expect(queryClient.getQueryData(["projects"])).toBeDefined();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockStore.dispatch).toHaveBeenCalledWith({ type: "auth/clearAuthState" });
      expect(queryClient.getQueryData(["projects"])).toBeUndefined();
      expect(mockAssign).toHaveBeenCalledWith("/login");
    });

    it("ignores a 403 that arrives after the session was already cleared", async () => {
      vi.useFakeTimers();
      const alert = vi.fn();
      setShowAlertCallback(alert);
      mockStore.getState.mockReturnValue({ auth: { authToken: "" } } as any);
      const error = {
        config: { url: "/test", headers: {} },
        response: {
          status: 403,
          data: { message: "Forbidden", data: "User does not belong to this organization" },
        },
        message: "Forbidden",
      };

      await expect(rejected(error)).rejects.toThrow("User does not belong to this organization");
      await vi.advanceTimersByTimeAsync(1000);

      expect(alert).not.toHaveBeenCalled();
      expect(mockAssign).not.toHaveBeenCalled();
      setShowAlertCallback(null as any);
    });

    it("logs out once when several requests fail with the 403 at the same time", async () => {
      vi.useFakeTimers();
      const alert = vi.fn();
      setShowAlertCallback(alert);
      const error = () => ({
        config: { url: "/test", headers: {} },
        response: {
          status: 403,
          data: { message: "Forbidden", data: "User does not belong to this organization" },
        },
        message: "Forbidden",
      });

      await Promise.allSettled([rejected(error()), rejected(error()), rejected(error())]);
      await vi.advanceTimersByTimeAsync(1000);

      expect(alert).toHaveBeenCalledTimes(1);
      const logouts = mockStore.dispatch.mock.calls.filter(
        ([action]: any[]) => action?.type === "auth/clearAuthState",
      );
      expect(logouts).toHaveLength(1);
      setShowAlertCallback(null as any);
    });

    it("clears auth and the cache when the token refresh is rejected with 406", async () => {
      const refreshError = { isAxiosError: true, response: { status: 406 }, message: "Expired" };
      const postSpy = vi.spyOn(CustomAxios, "post").mockRejectedValueOnce(refreshError);

      const error = {
        config: { url: "/test", headers: {} },
        response: { status: 406, data: { message: "Not Acceptable" } },
        message: "Not Acceptable",
      };

      await expect(rejected(error)).rejects.toBe(refreshError);

      expect(postSpy).toHaveBeenCalledWith("/users/refresh-token", {}, { withCredentials: true });
      expect(mockStore.dispatch).toHaveBeenCalledWith({ type: "auth/clearAuthState" });
      expect(queryClient.getQueryData(["projects"])).toBeUndefined();
      // A full page load, so app-level state does not outlive the session.
      await vi.waitFor(() => expect(mockAssign).toHaveBeenCalledWith("/login"));
    });

    it.each([
      [401, "Invalid refresh token"],
      [400, "Refresh token is required"],
    ])("ends the session when the refresh is rejected with %i", async (status, detail) => {
      const refreshError = {
        isAxiosError: true,
        response: { status, data: { message: "Error", data: detail } },
        message: detail,
      };
      vi.spyOn(CustomAxios, "post").mockRejectedValueOnce(refreshError);
      const error = {
        config: { url: "/test", headers: {} },
        response: { status: 406, data: { message: "Not Acceptable" } },
        message: "Not Acceptable",
      };

      await expect(rejected(error)).rejects.toBe(refreshError);

      expect(mockStore.dispatch).toHaveBeenCalledWith({ type: "auth/clearAuthState" });
      expect(queryClient.getQueryData(["projects"])).toBeUndefined();
      await vi.waitFor(() => expect(mockAssign).toHaveBeenCalledWith("/login"));
    });

    it("keeps the cache when the token refresh fails for another reason", async () => {
      const refreshError = { isAxiosError: true, response: { status: 500 }, message: "Boom" };
      vi.spyOn(CustomAxios, "post").mockRejectedValueOnce(refreshError);

      const error = {
        config: { url: "/test", headers: {} },
        response: { status: 406, data: { message: "Not Acceptable" } },
        message: "Not Acceptable",
      };

      await expect(rejected(error)).rejects.toBe(refreshError);

      expect(mockStore.dispatch).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(["projects"])).toBeDefined();
    });
  });
});
