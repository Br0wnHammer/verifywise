# Invitation expiry: one week → one month

**Date:** 2026-10-06
**Status:** Approved (requested by the product owner)

## Goal

An invitation stays valid for one month after it is sent (or resent). Before
that it can be used to create an account; after it, it cannot.

"One month" is **30 days**, a fixed duration. A calendar month varies (28–31
days), and the invite token needs a fixed lifetime in milliseconds.

## How an invitation's lifetime works today

An invitation has two expiry records, both set from the same constant,
`ONE_WEEK_MS` (`Servers/utils/jwt.utils.ts`):

| Record | Set in | Enforced / shown in |
| --- | --- | --- |
| Invite link token (JWT, `expire` + `exp`) | `generateInviteToken` default, called by `sendInviteEmail` (`Servers/utils/inviteEmail.utils.ts`) | `register.middleware.ts`: `decoded.expire < Date.now()` → 406 "This invitation link is expired…"; `getTokenPayload` (`jwt.verify`) also rejects past `exp` |
| `invitations.expires_at` | `sendInviteEmail` (`expiresAt`), stored by `createInvitationQuery` / `updateInvitationExpiryQuery`; super-admin invite (`superAdmin.ctrl.ts`) | Team page: `isExpired = expires_at <= now` → "Expired" / "Pending" chip |

There is no database default for `expires_at`, and no email, UI or user-guide
copy states the duration.

`generateInviteToken` is also used for password reset, which passes its own
`ONE_HOUR_MS` and is not affected.

## Design

- Add `INVITATION_LIFETIME_MS = THIRTY_DAYS_MS` in `jwt.utils.ts`, the single
  source for invitation lifetime.
- `generateInviteToken` defaults to it (password reset keeps passing 1 hour).
- `sendInviteEmail` and the super-admin invite set `expires_at` from it, so the
  link and the stored expiry agree.
- Remove `ONE_WEEK_MS` (no other users).

Boundary: the token is valid while `now <= expire`; the Team page shows
"Expired" once `expires_at <= now`. The two are computed from the same
constant at send time, so they differ by at most the milliseconds between
the two `Date.now()` calls.

## Existing invitations

The lifetime is baked into each token when it is signed, so invitations sent
before this change keep their 7-day link. Extending their `expires_at` in the
database would make the Team page show "Pending" for a link that no longer
works, so there is no data migration. Resending an invitation issues a new
30-day link.

## Out of scope

- Configurable lifetime per organization.
- Changing password-reset or API-token lifetimes.
