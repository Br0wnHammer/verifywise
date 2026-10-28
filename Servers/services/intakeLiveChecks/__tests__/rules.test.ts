/**
 * Runs the shared rule-check cases. The client copy of the rules runs the
 * same fixture files, so both sides fire the same hints with the same copy.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RULE_COPY, runRuleChecks } from "..";
import type { FormSchema } from "../../intakeRiskScoring.service";
import type { HintKind } from "../../../domain.layer/interfaces/i.intakeLiveChecks";

interface RuleCase {
  name: string;
  schema: FormSchema;
  data: Record<string, unknown>;
  expected: Array<{ ruleId: string; questionId: string; kind: HintKind }>;
}

const readFixture = <T>(file: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, "../__fixtures__", file), "utf8"));

const cases = readFixture<RuleCase[]>("ruleCases.json");

describe("intake live checks: rules", () => {
  it.each(cases)("$name", ({ schema, data, expected }) => {
    const hints = runRuleChecks(schema, data);
    expect(hints.map(({ ruleId, questionId, kind }) => ({ ruleId, questionId, kind }))).toEqual(
      expected,
    );
  });

  it("builds every hint from its rule copy", () => {
    const hints = cases.flatMap((c) => runRuleChecks(c.schema, c.data));
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      const copy = RULE_COPY[hint.ruleId!];
      expect(hint).toMatchObject({
        id: `${hint.ruleId}:${hint.questionId}`,
        source: "rule",
        title: copy.title,
        text: copy.text,
      });
      expect(hint.ref).toBe(copy.ref);
    }
  });

  it("quotes the matched words in the excerpt, never in the copy", () => {
    const [hint] = runRuleChecks(
      { version: "1", fields: [{ id: "q", type: "textarea", label: "Q" }] },
      { q: "Scrape faces from public websites" },
    );
    expect(hint.ruleId).toBe("art5_facial_scraping");
    expect(hint.excerpt).toBe("Scrape, faces");
  });

  it("matches the shared copy fixture", () => {
    expect(RULE_COPY).toEqual(readFixture("ruleCopy.json"));
  });
});
