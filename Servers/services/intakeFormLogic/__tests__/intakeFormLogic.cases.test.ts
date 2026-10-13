/**
 * Runs the shared intake form logic cases. The Vitest runner in
 * Clients/src/application/utils/intakeFormLogic/__tests__ runs the same file
 * against the client copy, so both sides behave the same.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { evaluateFormula, parseFormula } from "..";

type FormulaCase = { formula?: string; formulaParts?: Array<[string, number]> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cases: any = JSON.parse(
  readFileSync(resolve(__dirname, "../__fixtures__/intakeFormLogic.cases.json"), "utf8"),
);

const formulaOf = (c: FormulaCase): string =>
  c.formulaParts ? c.formulaParts.map(([text, times]) => text.repeat(times)).join("") : c.formula!;

describe("intake form logic cases", () => {
  describe("parseFormula", () => {
    it.each(cases.parse)("$name", (c: any) => {
      const result = parseFormula(formulaOf(c));
      expect(result.ok).toBe(c.ok);
      if (result.ok) expect(result.refs).toEqual(c.refs);
      else expect(result.position).toBe(c.position);
    });
  });

  describe("evaluateFormula", () => {
    it.each(cases.evaluateFormula)("$name", (c: any) => {
      const parsed = parseFormula(c.formula);
      if (!parsed.ok) throw new Error(`fixture formula does not parse: ${c.formula}`);
      const result = evaluateFormula(parsed.ast, c.values, c.decimals);
      expect(Object.is(result, c.expected)).toBe(true);
    });
  });
});
