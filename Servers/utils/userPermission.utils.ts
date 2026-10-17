import { getUserByIdQuery } from "./user.utils";
import { getRoleNameById } from "./roleMap";
import { roleHasPermission } from "./rolePermissions.utils";
import type { PermissionKey } from "../config/rolePermissions.config";

/**
 * True when user `userId` is a member of `organizationId` and their current
 * role holds `permissionKey`. Resolves the role from the users row (not from a
 * token), the same way userInviteRefusal does, for code paths such as advisor
 * tools that know the caller's id but not their role. Fails closed: no user,
 * a user of another organization, or an unknown role all return false.
 */
export async function userHasPermission(
  organizationId: number,
  userId: number | undefined,
  permissionKey: PermissionKey,
): Promise<boolean> {
  if (!userId) return false;
  const user = await getUserByIdQuery(userId);
  if (!user || user.organization_id !== organizationId) return false;
  const roleName = await getRoleNameById(user.role_id);
  if (!roleName) return false;
  return roleHasPermission(organizationId, roleName, permissionKey);
}
