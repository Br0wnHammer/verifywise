/**
 * The backup migration copies every left-aligned form before 20261024110000
 * centers it, and a copy restores the form.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { cleanupDatabase, createTestOrganization, createTestUser } from "./helpers";

const backup = require("../../database/migrations/20261024105900-backup-left-aligned-intake-forms.js");
const center = require("../../database/migrations/20261024110000-intake-form-alignment-center.js");

const queryInterface = { sequelize };

const createForm = async (orgId: number, userId: number, slug: string, design: object | null) => {
  const [{ id }] = await sequelize.query<{ id: number }>(
    `INSERT INTO intake_forms (organization_id, name, description, slug, entity_type, created_by, design_settings)
     VALUES (:orgId, :slug, '', :slug, 'use_case', :userId, CAST(:design AS jsonb))
     RETURNING id`,
    {
      replacements: {
        orgId,
        userId,
        slug,
        design: design === null ? null : JSON.stringify(design),
      },
      type: QueryTypes.SELECT,
    },
  );
  return id;
};

const designOf = async (id: number) =>
  (
    await sequelize.query<{ design_settings: Record<string, unknown> | null }>(
      `SELECT design_settings FROM intake_forms WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT },
    )
  )[0].design_settings;

const backedUp = async () =>
  sequelize.query<{ form_id: number; design_settings: Record<string, unknown> }>(
    `SELECT form_id, design_settings FROM intake_forms_alignment_backup ORDER BY form_id`,
    { type: QueryTypes.SELECT },
  );

// cleanupDatabase restarts form ids but does not touch the backup table, so a
// copy left by another test would shadow a new form with the same id.
const emptyBackup = () => sequelize.query(`DELETE FROM intake_forms_alignment_backup`);

beforeEach(emptyBackup);

afterEach(async () => {
  await emptyBackup();
  await cleanupDatabase();
});

describe("migration: back up left-aligned intake forms before centering", () => {
  it("copies only the forms the centering changes, and the copy restores them", async () => {
    const suffix = Date.now();
    const orgId = await createTestOrganization(`Org ${suffix}`);
    const userId = await createTestUser(orgId, 1, `admin-${suffix}@test.com`, "Password123!");
    const leftDesign = { alignment: "left", primaryColor: "#123456" };
    const left = await createForm(orgId, userId, `left-${suffix}`, leftDesign);
    const centred = await createForm(orgId, userId, `center-${suffix}`, { alignment: "center" });
    const unset = await createForm(orgId, userId, `unset-${suffix}`, null);

    await backup.up(queryInterface);
    await center.up(queryInterface);

    expect(await backedUp()).toEqual([{ form_id: left, design_settings: leftDesign }]);
    expect(await designOf(left)).toEqual({ ...leftDesign, alignment: "center" });
    expect(await designOf(centred)).toEqual({ alignment: "center" });
    expect(await designOf(unset)).toBeNull();

    // The restore documented in the migration header.
    await sequelize.query(
      `UPDATE intake_forms f SET design_settings = b.design_settings
         FROM intake_forms_alignment_backup b
        WHERE f.id = b.form_id AND f.id = :id`,
      { replacements: { id: left } },
    );
    expect(await designOf(left)).toEqual(leftDesign);
  });

  it("keeps the first copy when it runs again", async () => {
    const suffix = Date.now();
    const orgId = await createTestOrganization(`Org ${suffix}`);
    const userId = await createTestUser(orgId, 1, `admin-${suffix}@test.com`, "Password123!");
    const form = await createForm(orgId, userId, `left-${suffix}`, { alignment: "left", v: 1 });

    await backup.up(queryInterface);
    await sequelize.query(
      `UPDATE intake_forms SET design_settings = '{"alignment":"left","v":2}'::jsonb WHERE id = :id`,
      { replacements: { id: form } },
    );
    await backup.up(queryInterface);

    expect(await backedUp()).toEqual([
      { form_id: form, design_settings: { alignment: "left", v: 1 } },
    ]);
  });
});
