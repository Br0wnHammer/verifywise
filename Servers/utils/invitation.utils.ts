import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../database/db";

interface InvitationRow {
  id: number;
  email: string;
  name: string;
  surname: string;
  role_id: number;
  status: string;
  invited_by: number;
  created_at: string;
  expires_at: string;
  updated_at: string;
  role_name?: string;
}

/**
 * Create or update an invitation record.
 * Uses ON CONFLICT with partial unique index (organization_id, email) WHERE status='pending'.
 */
export const createInvitationQuery = async (
  organizationId: number,
  email: string,
  name: string,
  surname: string,
  roleId: number,
  invitedBy: number,
  expiresAt: Date,
  transaction?: Transaction,
): Promise<InvitationRow> => {
  const result = (await sequelize.query(
    `INSERT INTO invitations (organization_id, email, name, surname, role_id, status, invited_by, expires_at)
     VALUES (:organizationId, :email, :name, :surname, :roleId, 'pending', :invitedBy, :expiresAt)
     ON CONFLICT (organization_id, email) WHERE status = 'pending'
     DO UPDATE SET
       name = EXCLUDED.name,
       surname = EXCLUDED.surname,
       role_id = EXCLUDED.role_id,
       invited_by = EXCLUDED.invited_by,
       expires_at = EXCLUDED.expires_at,
       created_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    {
      replacements: {
        organizationId,
        email,
        name,
        surname,
        roleId,
        invitedBy,
        expiresAt: expiresAt.toISOString(),
      },
      transaction,
    },
  )) as [InvitationRow[], number];

  return result[0][0];
};

/**
 * Get all pending invitations for an organization, joined with role name.
 */
export const getInvitationsByOrganizationQuery = async (
  organizationId: number,
): Promise<InvitationRow[]> => {
  const result = (await sequelize.query(
    `SELECT i.id, i.email, i.name, i.surname, i.role_id, i.status, i.invited_by,
            to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
            i.updated_at,
            r.name AS role_name
     FROM invitations i
     LEFT JOIN roles r ON r.id = i.role_id
     WHERE i.organization_id = :organizationId AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    { replacements: { organizationId } },
  )) as [InvitationRow[], number];

  return result[0];
};

/**
 * @deprecated Use getInvitationsByOrganizationQuery instead
 */
export const getInvitationsByTenantQuery = getInvitationsByOrganizationQuery;

/**
 * Get a single invitation by id.
 */
export const getInvitationByIdQuery = async (
  organizationId: number,
  id: number,
): Promise<InvitationRow | null> => {
  const result = (await sequelize.query(
    `SELECT i.*, r.name AS role_name
     FROM invitations i
     LEFT JOIN roles r ON r.id = i.role_id
     WHERE i.organization_id = :organizationId AND i.id = :id AND i.status = 'pending'`,
    { replacements: { organizationId, id } },
  )) as [InvitationRow[], number];

  return result[0][0] || null;
};

/**
 * Revoke (delete) an invitation.
 */
export const revokeInvitationQuery = async (
  organizationId: number,
  id: number,
): Promise<boolean> => {
  const result = (await sequelize.query(
    `DELETE FROM invitations
     WHERE organization_id = :organizationId AND id = :id AND status = 'pending'
     RETURNING id`,
    { replacements: { organizationId, id } },
  )) as [InvitationRow[], number];

  return result[0].length > 0;
};

/**
 * Mark invitation as accepted when user registers via invite link. Pass the
 * user-creation transaction so the user and the used-up link commit together.
 * Returns how many pending invitations were marked; 0 means it was revoked
 * or already used in the meantime.
 */
export const markInvitationAcceptedQuery = async (
  organizationId: number,
  email: string,
  transaction?: Transaction,
): Promise<number> => {
  const rows = await sequelize.query(
    `UPDATE invitations
     SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = :organizationId AND email = :email AND status = 'pending'
     RETURNING id`,
    { replacements: { organizationId, email }, transaction, type: QueryTypes.SELECT },
  );
  return rows.length;
};

/**
 * Update invitation expiry after resend.
 */
export const updateInvitationExpiryQuery = async (
  organizationId: number,
  id: number,
  expiresAt: Date,
): Promise<void> => {
  await sequelize.query(
    `UPDATE invitations
     SET created_at = CURRENT_TIMESTAMP, expires_at = :expiresAt, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = :organizationId AND id = :id`,
    { replacements: { organizationId, id, expiresAt: expiresAt.toISOString() } },
  );
};

/**
 * The pending invitation for an email, with its expiry as epoch ms. The
 * column is TIMESTAMP (no zone) holding UTC, which EXTRACT(EPOCH) reads as UTC.
 */
export const getPendingInvitationQuery = async (
  organizationId: number,
  email: string,
  transaction?: Transaction,
): Promise<{ id: number; role_id: number; expires_at_ms: number } | null> => {
  const result = (await sequelize.query(
    `SELECT id, role_id, ROUND(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_at_ms
     FROM invitations
     WHERE organization_id = :organizationId AND email = :email AND status = 'pending'
     ORDER BY id DESC
     LIMIT 1`,
    { replacements: { organizationId, email }, transaction },
  )) as [{ id: number; role_id: number; expires_at_ms: string | number }[], number];

  const row = result[0][0];
  return row
    ? { id: row.id, role_id: row.role_id, expires_at_ms: Number(row.expires_at_ms) }
    : null;
};
