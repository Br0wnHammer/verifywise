import type { Dispatch } from "@reduxjs/toolkit";
import { clearAuthState, setAuthToken } from "../redux/auth/authSlice";
import { resetQueryCache } from "../config/queryClient";
import { persistor } from "../redux/store";

/**
 * Ends the local session: clears the auth state, then every cached server
 * response, so nothing from this session is shown to whoever signs in next
 * in the same tab. Every logout path (manual or forced) goes through here.
 *
 * Auth is cleared first so that anything refetching after the cache is
 * emptied has no token to send.
 */
export const clearSession = (dispatch: Dispatch) => {
  dispatch(clearAuthState());
  resetQueryCache();
};

/**
 * Ends the session and loads /login as a new page: manual logout and every
 * forced logout. The full load (not a client-side navigate) means app-level
 * providers (the Advisor conversation, VerifyWise context) start empty, and
 * the cleared auth is flushed to storage first so the reload restores it, not
 * the old token.
 */
export const endSessionAndReload = async (dispatch: Dispatch) => {
  clearSession(dispatch);
  try {
    await persistor.flush();
  } catch {
    // Best-effort: the reload still goes ahead.
  }
  window.location.assign("/login");
};

/**
 * Starts a session with a new token: empties the query cache first, so no
 * response cached in this tab before (an earlier session that was never
 * logged out, or another user) is shown to the user signing in. Every
 * sign-in path (password, Microsoft, registration) goes through here.
 */
export const startSession = (dispatch: Dispatch, token: string) => {
  resetQueryCache();
  dispatch(setAuthToken(token));
};
