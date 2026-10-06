import { configureStore } from "@reduxjs/toolkit";
import authReducer from "../../redux/auth/authSlice";
import { queryClient } from "../../config/queryClient";
import { clearSession } from "../clearSession";

function createStore() {
  return configureStore({
    reducer: { auth: authReducer },
    preloadedState: {
      auth: {
        isLoading: false,
        authToken: "some-token",
        user: "user-data",
        userExists: true,
        success: true,
        message: null,
        expirationDate: Date.now() + 3600000,
        onboardingStatus: "completed",
        isOrgCreator: false,
        isSuperAdmin: false,
      },
    },
  });
}

describe("clearSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    queryClient.clear();
  });

  it("clears the auth state and every cached query", () => {
    const store = createStore();
    queryClient.setQueryData(["projects"], [{ id: 1, name: "Previous user's project" }]);

    clearSession(store.dispatch);

    expect(store.getState().auth.authToken).toBe("");
    expect(store.getState().auth.user).toBe("");
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("clears auth before the cache so a refetch has no token to send", () => {
    const store = createStore();
    let tokenWhenCleared: string | undefined;
    vi.spyOn(queryClient, "clear").mockImplementation(() => {
      tokenWhenCleared = store.getState().auth.authToken;
    });

    clearSession(store.dispatch);

    expect(tokenWhenCleared).toBe("");
  });
});
