import { useRef, useState, ChangeEvent } from "react";
import { Box, Menu, MenuItem, Typography, useTheme } from "@mui/material";
import Field from "../../components/Inputs/Field";
import type { FormField } from "./types";
import {
  evaluateFormula,
  normalizeDecimals,
  parseFormula,
} from "../../../application/utils/intakeFormLogic";
import {
  describeFormula,
  formatCalculatedValue,
} from "../../../application/utils/intakeAnswerFormat";

interface FormulaEditorProps {
  formula: string;
  /** Number and calculated fields above the field being edited. */
  numericFields: FormField[];
  decimals?: number;
  onChange: (formula: string) => void;
}

export function FormulaEditor({ formula, numericFields, decimals, onChange }: FormulaEditorProps) {
  const theme = useTheme();
  const caretRef = useRef<number>(formula.length);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const parsed = formula.trim() === "" ? null : parseFormula(formula);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    caretRef.current = caret;
    onChange(next);
    // Typing "{" opens the picker of fields the formula may use.
    if (next.length === formula.length + 1 && next[caret - 1] === "{") {
      setPickerAnchor(event.target);
    }
  };

  const insertField = (fieldId: string) => {
    const caret = Math.min(caretRef.current, formula.length);
    const before = formula.slice(0, caret);
    const after = formula.slice(caret);
    const base = before.endsWith("{") ? before.slice(0, -1) : before;
    onChange(`${base}{${fieldId}}${after}`);
    setPickerAnchor(null);
  };

  const preview =
    parsed && parsed.ok
      ? evaluateFormula(
          parsed.ast,
          Object.fromEntries(parsed.refs.map((ref) => [ref, 1])),
          normalizeDecimals(decimals),
        )
      : null;

  return (
    <Box>
      <Field
        id="field-formula"
        label="Formula"
        value={formula}
        onChange={handleChange}
        placeholder="Type { to insert a field"
      />
      <Menu
        anchorEl={pickerAnchor}
        open={Boolean(pickerAnchor)}
        onClose={() => setPickerAnchor(null)}
      >
        {numericFields.length === 0 ? (
          <MenuItem disabled>Add a number field above this one first</MenuItem>
        ) : (
          numericFields.map((field) => (
            <MenuItem
              key={field.id}
              onClick={() => insertField(field.id)}
              sx={{ fontSize: "13px" }}
            >
              {field.label}
            </MenuItem>
          ))
        )}
      </Menu>
      {parsed && !parsed.ok && (
        <Typography sx={{ fontSize: "11px", color: theme.palette.status.error.text, mt: "4px" }}>
          {`${parsed.error} at position ${parsed.position + 1}`}
        </Typography>
      )}
      {parsed && parsed.ok && (
        <>
          <Typography sx={{ fontSize: "12px", color: theme.palette.text.secondary, mt: "4px" }}>
            {describeFormula(formula, numericFields)}
          </Typography>
          <Box sx={{ display: "flex", gap: "4px", mt: "2px" }}>
            <Typography sx={{ fontSize: "11px", color: theme.palette.text.accent }}>
              Result with every input set to 1:
            </Typography>
            <Typography sx={{ fontSize: "11px", color: theme.palette.text.accent }}>
              {formatCalculatedValue(preview, { decimals })}
            </Typography>
          </Box>
        </>
      )}
    </Box>
  );
}

export default FormulaEditor;
