const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field: quoted, quotes doubled, formula-looking text prefixed with '. */
export const csvField = (value: unknown): string => {
  if (value === null || value === undefined) return '""';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/** One CSV line, RFC 4180 line ending. */
export const csvRow = (values: unknown[]): string => `${values.map(csvField).join(",")}\r\n`;

/** Byte-order mark so spreadsheet apps read the file as UTF-8. */
export const CSV_BOM = "﻿";
