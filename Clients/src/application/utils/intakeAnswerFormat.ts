import { normalizeDecimals } from "./intakeFormLogic";

interface CalculatedDisplay {
  decimals?: number | null;
  prefix?: string | null;
  suffix?: string | null;
}

/**
 * A calculated value as people read it: grouped and fixed to the field's
 * decimals in the viewer's locale, with its prefix and suffix. "—" when there
 * is no value.
 */
export function formatCalculatedValue(
  value: number | null | undefined,
  field: CalculatedDisplay,
  locale: string = typeof navigator !== "undefined" ? navigator.language : "en-US",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const decimals = normalizeDecimals(field.decimals ?? undefined);
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return [field.prefix, number, field.suffix]
    .filter((part) => part && part.trim() !== "")
    .join(" ");
}

const OPERATOR_SYMBOLS: Record<string, string> = { "*": "×", "/": "÷", "-": "−" };

/** "{cost} * 12" → "= Monthly cost × 12". Empty for an empty formula. */
export function describeFormula(
  formula: string,
  fields: Array<{ id: string; label: string }>,
): string {
  if (formula.trim() === "") return "";
  const labels = new Map(fields.map((field) => [field.id, field.label]));
  const text = formula.replace(/\{([A-Za-z0-9_-]+)\}|[*/-]/g, (match: string, id?: string) =>
    id !== undefined ? (labels.get(id) ?? "missing field") : OPERATOR_SYMBOLS[match],
  );
  return `= ${text.replace(/\s+/g, " ").trim()}`;
}
