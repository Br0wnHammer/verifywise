import { getRoleByName, getRoleInfoById } from "./roleMap";
import { getEffectivePermissions } from "./rolePermissions.utils";

/** Why a role may not be granted through an invitation. */
export type InviteRoleRefusal = "unknown_role" | "exceeds_access";

/**
 * Why `inviterRole` may not grant `roleId` through an invitation into
 * `organizationId`, or null if it may. Used by invite and resend.
 *
 * The role must exist, must not be SuperAdmin (granted through the
 * super_admins mapping, never an invite) and must be a built-in or this
 * organization's own role. Only the built-in Admin grants a built-in role:
 * built-ins carry powers checked by role name, outside the permission matrix.
 * Any other inviter grants only custom roles with no permission it lacks.
 *
 * A null inviterRole is a trusted caller (a super admin inviting into an
 * organization): the role is still checked, the inviter's ceiling is not.
 */
export async function inviteRoleRefusal(
  organizationId: number,
  inviterRole: string | null,
  roleId: number,
): Promise<InviteRoleRefusal | null> {
  const role = await getRoleInfoById(roleId);
  if (
    !role ||
    role.name === "SuperAdmin" ||
    (role.organizationId !== null && role.organizationId !== organizationId)
  ) {
    return "unknown_role";
  }
  if (inviterRole === null) return null;

  const inviter = await getRoleByName(organizationId, inviterRole);
  if (inviter?.organizationId === null && inviter.name === "Admin") return null;
  if (role.organizationId === null) return "exceeds_access";

  const [granted, held] = await Promise.all([
    getEffectivePermissions(organizationId, role.name),
    getEffectivePermissions(organizationId, inviterRole),
  ]);
  for (const permission of granted) {
    if (!held.has(permission)) return "exceeds_access";
  }
  return null;
}
