import allowedRoles from "../constants/permissions";
import { useAuth } from "./useAuth";
import { useMyPermissions } from "./useRolePermissions";

/**
 * Whether the current user can add, edit and delete LLM keys. The server
 * allows any role holding llmKeys.admin, custom roles included; the built-in
 * role list keeps Admins allowed while the permission list is still loading.
 *
 * `permissionsLoading` is true until the permission list has loaded, so a
 * caller acting once on a "no" (such as consuming ?addKey=1) can wait for it.
 */
export function useCanManageLLMKeys() {
  const { userRoleName } = useAuth();
  const { can, isPending } = useMyPermissions();
  const canManageKeys =
    can("llmKeys.admin") || !!allowedRoles.llmKeys?.manage?.includes(userRoleName);
  return { canManageKeys, permissionsLoading: isPending };
}
