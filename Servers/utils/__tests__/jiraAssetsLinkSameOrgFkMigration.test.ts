import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { Sequelize, Transaction } from "sequelize";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("../../database/migrations/20261012165625-jira-assets-link-same-org-fk.js");

const TABLE = "verifywise.jira_assets_use_cases";
const BACKUP = "verifywise.jira_assets_use_cases_fk_cleanup_backup";
const PROJECTS_UNIQUE = "projects_id_organization_id_key";

function fakeQueryInterface() {
  const statements: { sql: string; inTransaction: boolean }[] = [];
  const tx = {};
  const query = async (sql: string, options?: { transaction?: unknown }) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    statements.push({ sql: flat, inTransaction: options?.transaction === tx });
    if (flat.includes("information_schema.columns")) {
      return [
        [{ column_name: "id" }, { column_name: "organization_id" }, { column_name: "project_id" }],
      ];
    }
    if (flat.includes("to_regclass")) return [[{ present: false }]];
    return [[]];
  };
  return {
    statements,
    queryInterface: { sequelize: { query, transaction: async (fn: any) => fn(tx) } },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("jira-assets-link-same-org-fk migration statements", () => {
  it("up() locks projects then the link table, and never touches organizations", async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    const { statements, queryInterface } = fakeQueryInterface();

    await migration.up(queryInterface);

    const locks = statements.filter((s) => s.sql.startsWith("LOCK TABLE")).map((s) => s.sql);
    expect(locks).toEqual([
      "LOCK TABLE verifywise.projects IN SHARE ROW EXCLUSIVE MODE;",
      `LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`,
    ]);
    expect(statements.findIndex((s) => s.sql.startsWith("LOCK TABLE"))).toBe(1);
    expect(statements.some((s) => /REFERENCES verifywise\.organizations/.test(s.sql))).toBe(false);
    // Plain LIKE: no defaults, so the backup is not tied to the live id sequence.
    expect(statements.map((s) => s.sql)).toContain(
      `CREATE TABLE IF NOT EXISTS ${BACKUP} (LIKE ${TABLE});`,
    );
    expect(statements.map((s) => s.sql)).toContain(
      `CREATE UNIQUE INDEX ${PROJECTS_UNIQUE} ON verifywise.projects (id, organization_id);`,
    );
    expect(statements.every((s) => s.inTransaction)).toBe(true);
  });

  it("down() leaves the shared unique index on projects in place", async () => {
    const { statements, queryInterface } = fakeQueryInterface();

    await migration.down(queryInterface);

    expect(statements.some((s) => s.sql.includes(PROJECTS_UNIQUE))).toBe(false);
    expect(statements.every((s) => s.inTransaction)).toBe(true);
  });
});

// Runs only against a throwaway database whose name ends in _migration_test,
// e.g. MIGRATION_TEST_DATABASE_URL=postgres://localhost:55433/jira_migration_test
// It drops and recreates the verifywise schema there.
const DB_URL = process.env.MIGRATION_TEST_DATABASE_URL;
const dbSafe = !!DB_URL && /_migration_test(\?.*)?$/.test(DB_URL);
const describeDb = dbSafe ? describe : describe.skip;

describeDb("jira-assets-link-same-org-fk migration against Postgres", () => {
  jest.setTimeout(30000);
  let sequelize: Sequelize;
  const qi = () => ({ sequelize });
  const one = async <T>(sql: string): Promise<T> => {
    const [rows] = await sequelize.query(sql);
    return rows[0] as T;
  };
  const count = async (sql: string) => Number((await one<{ n: number }>(sql)).n);
  const linkIds = async (table: string) =>
    (await sequelize.query(`SELECT id FROM ${table} ORDER BY id;`))[0].map((r: any) => r.id);

  beforeAll(async () => {
    sequelize = new Sequelize(DB_URL as string, { logging: false });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    await sequelize.query(`
      DROP SCHEMA IF EXISTS verifywise CASCADE;
      CREATE SCHEMA verifywise;
      CREATE TABLE verifywise.organizations (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE verifywise.projects (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
        project_title TEXT NOT NULL
      );
      CREATE TABLE verifywise.jira_assets_use_cases (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
        jira_object_id VARCHAR(100) NOT NULL,
        project_id INTEGER REFERENCES verifywise.projects(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        sync_status VARCHAR(20) NOT NULL DEFAULT 'synced',
        CONSTRAINT jira_assets_use_cases_org_object_unique UNIQUE (organization_id, jira_object_id)
      );
      CREATE INDEX idx_jira_use_cases_project_id
        ON verifywise.jira_assets_use_cases(project_id) WHERE project_id IS NOT NULL;
      INSERT INTO verifywise.organizations (id, name) VALUES (1, 'one'), (2, 'two');
      INSERT INTO verifywise.projects (id, organization_id, project_title) VALUES (10, 1, 'p1'), (20, 2, 'p2');
      SELECT setval('verifywise.projects_id_seq', 20);
      INSERT INTO verifywise.jira_assets_use_cases (id, organization_id, jira_object_id, project_id, data) VALUES
        (1, 1, 'OK-1', 10, '{}'),    -- same organization: kept
        (2, 1, 'CROSS-1', 20, '{}'), -- another organization's project: backed up
        (4, 2, 'NULL-1', NULL, '{}'); -- no project: kept
      SELECT setval('verifywise.jira_assets_use_cases_id_seq', 4);
    `);
    // An orphan (project gone) cannot be written through the single-column FK;
    // bypass the FK triggers to reproduce one from an install that lacked it.
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`SET LOCAL session_replication_role = replica;`, { transaction });
      await sequelize.query(
        `INSERT INTO ${TABLE} (id, organization_id, jira_object_id, project_id, data)
         VALUES (3, 1, 'ORPHAN-1', 999, '{}');`,
        { transaction },
      );
    });
  });

  afterAll(async () => {
    await sequelize?.close();
  });

  it("up() backs up and deletes cross-org and orphan links without locking organizations", async () => {
    // An open transaction writing organizations (as an org settings update
    // would) must not block up().
    const other = new Sequelize(DB_URL as string, { logging: false });
    const t = await other.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });
    try {
      await other.query(`UPDATE verifywise.organizations SET name = name WHERE id = 1;`, {
        transaction: t,
      });
      await migration.up(qi());
    } finally {
      await t.rollback();
      await other.close();
    }

    expect(await linkIds(TABLE)).toEqual([1, 4]);
    expect(await linkIds(BACKUP)).toEqual([2, 3]);
    expect(await count(`SELECT COUNT(*) AS n FROM ${BACKUP} WHERE cleaned_at IS NOT NULL;`)).toBe(
      2,
    );
    // No foreign keys and no column defaults copied from the live table.
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM pg_constraint WHERE conrelid = '${BACKUP}'::regclass AND contype = 'f';`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = 'verifywise' AND table_name = 'jira_assets_use_cases_fk_cleanup_backup'
            AND column_default IS NOT NULL AND column_name <> 'cleaned_at';`,
      ),
    ).toBe(0);
  });

  it("the composite FK rejects a link to another organization's project", async () => {
    await expect(
      sequelize.query(
        `INSERT INTO ${TABLE} (organization_id, jira_object_id, project_id, data)
         VALUES (1, 'CROSS-2', 20, '{}');`,
      ),
    ).rejects.toThrow(/jira_assets_use_cases_project_org_fkey/);
  });

  it("down() restores what it can and keeps the shared unique index", async () => {
    await migration.down(qi());

    // The cross-org link is back; the orphan stays in the backup.
    expect(await linkIds(TABLE)).toEqual([1, 2, 4]);
    expect(await linkIds(BACKUP)).toEqual([3]);
    expect(
      await count(`SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = '${PROJECTS_UNIQUE}';`),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM pg_constraint WHERE conname = 'jira_assets_use_cases_project_org_fkey';`,
      ),
    ).toBe(0);
  });

  it("up() runs again after down() and reuses the unique index", async () => {
    await migration.up(qi());

    expect(await linkIds(TABLE)).toEqual([1, 4]);
    expect(await linkIds(BACKUP)).toEqual([2, 3]);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM pg_index i
          WHERE i.indrelid = 'verifywise.projects'::regclass AND i.indisunique AND i.indnkeyatts = 2;`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM pg_constraint WHERE conname = 'jira_assets_use_cases_project_org_fkey';`,
      ),
    ).toBe(1);
  });
});
