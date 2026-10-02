import { test as setup } from "@playwright/test";
import { loginAs } from "./helpers/auth.helper";
import { seedAdminInOrg } from "./helpers/seedAdmin.helper";

/**
 * Auth state for the risk-inheritance reports.
 *
 * Deliberately separate from global.setup.ts: that one creates a brand-new
 * organization on every run, so its admin sees zero risks — which would make
 * the duplicate and coverage sections render their empty states and verify
 * nothing. These reports are aggregates, so they need an organization that
 * already has risks in it.
 *
 * E2E_REPORT_ORG_ID picks that organization (default 1, the dev-bootstrap org).
 * seedAdminInOrg is idempotent: it re-seeds the existing admin rather than
 * creating a second one, and reads the password from the restricted file the
 * seed script writes (it no longer prints it).
 */

const ORG_ID = Number(process.env.E2E_REPORT_ORG_ID || "1");
// Its own user: global.setup.ts seeds the default e2e admin into its own org,
// and the seed script returns an existing user by email wherever it lives.
const REPORT_ADMIN_EMAIL =
  process.env.E2E_REPORT_ADMIN_EMAIL || "e2e-risk-inheritance-admin@verifywise.local";
export const REPORT_AUTH_STATE_PATH = "e2e/.auth/risk-inheritance-admin.json";

setup("authenticate as an admin of an organization that has risks", async ({ page }) => {
  const admin = seedAdminInOrg(ORG_ID, [`--email=${REPORT_ADMIN_EMAIL}`]);

  await loginAs(page, admin.email, admin.password, /\/(overview)?$/);

  await page.context().storageState({ path: REPORT_AUTH_STATE_PATH });
});
