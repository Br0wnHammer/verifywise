import type { Dispatch } from "@reduxjs/toolkit";
import { clearAuthState } from "../redux/auth/authSlice";
import { resetQueryCache } from "../config/queryClient";

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
