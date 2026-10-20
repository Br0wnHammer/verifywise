import React from "react";
import { Box } from "@mui/material";

interface ReadOnlyFieldsetProps {
  /** When true, every form control inside is disabled and ignores pointer input. */
  readOnly: boolean;
  children: React.ReactNode;
}

/**
 * Makes a block of form controls view-only for roles that cannot edit.
 * Native inputs follow the fieldset's disabled state; pointer events are also
 * blocked so custom controls (selects, date pickers) cannot be opened.
 *
 * @example
 * <ReadOnlyFieldset readOnly={!canEdit}>{formContent}</ReadOnlyFieldset>
 */
const ReadOnlyFieldset: React.FC<ReadOnlyFieldsetProps> = ({ readOnly, children }) => (
  <Box
    component="fieldset"
    disabled={readOnly}
    sx={{ border: 0, m: 0, p: 0, minWidth: 0, pointerEvents: readOnly ? "none" : "auto" }}
  >
    {children}
  </Box>
);

export default ReadOnlyFieldset;
