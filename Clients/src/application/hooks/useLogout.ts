import { useDispatch } from "react-redux";
import { clearSession } from "../utils/clearSession";
import { persistor } from "../redux/store";
import { apiServices } from "../../infrastructure/api/networkServices";

/**
 * Custom hook for handling user logout
 *
 * @returns {Function} A function that handles the logout process
 */
const useLogout = () => {
  const dispatch = useDispatch();

  /**
   * Handles logging out the user
   * Clears the authentication state and query cache, then loads the login page
   */
  const logout = async () => {
    // Revoke the refresh token server-side and clear the cookie.
    // Best-effort: local logout must proceed even if the API is unreachable.
    try {
      await apiServices.post("/users/logout", {});
    } catch {
      // Intentionally ignored — local state is cleared regardless.
    }

    // Clear the auth state and the query cache
    clearSession(dispatch);

    // Write the cleared auth to storage before the reload, or the old token
    // could be restored from it.
    try {
      await persistor.flush();
    } catch {
      // Best-effort: the reload still goes ahead.
    }

    // A full page load, not a client-side navigate: app-level providers (the
    // Advisor conversation, VerifyWise context) start empty for the next user.
    window.location.assign("/login");
  };

  return logout;
};

export default useLogout;
