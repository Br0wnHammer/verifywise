/**
 * VerifyWise Unified Color Palette
 *
 * Single source of truth for ALL colors across every module:
 * Governance, LLM Evals, AI Detection, Shadow AI, Model Inventory.
 *
 * Grey, green, red, amber, orange, blue, indigo, purple, teal, and pink tokens
 * derive from primitives.ts.
 * Other status, risk, accent, and chart hues remain here until their scales are defined.
 *
 * Usage:
 *   import { palette } from '@/presentation/themes/palette';
 *   <Box sx={{ color: palette.status.error.text }} />
 *
 * Migration guide: see /docs/COLOR_MIGRATION.md
 */

import { grey, green, red, amber, orange, blue, indigo, purple, teal, pink } from "./primitives";

// ---------------------------------------------------------------------------
// 1. Semantic status colors (success / error / warning / info / default)
//    Background = light pastel, text = muted dark tone.
// ---------------------------------------------------------------------------

export const status = {
  // strong = vivid green reserved for transient confirmations (e.g. save success).
  // Not on the green ramp; kept here until that step exists in primitives.ts.
  success: { bg: green[200], text: green[600], border: green[300], strong: "#079455" },
  error: { bg: red[200], text: red[500], border: red[300] },
  warning: { bg: amber[100], text: amber[600], border: amber[200] },
  info: { bg: blue[50], text: blue[800], border: blue[100] },
  default: { bg: grey[100], text: grey[500], border: grey[200] },
} as const;

// ---------------------------------------------------------------------------
// 2. Risk levels (critical → very-low)
//    Same pastel style as Chip. Used in risk tables, charts, badges.
// ---------------------------------------------------------------------------

export const risk = {
  critical: { bg: red[200], text: red[500], border: red[300] },
  high: { bg: orange[100], text: orange[600], border: orange[200] },
  medium: { bg: amber[100], text: amber[600], border: amber[200] },
  low: { bg: green[200], text: green[600], border: green[300] },
  veryLow: { bg: "#E0F7FA", text: "#00695C", border: "#B2EBF2" },
} as const;

// ---------------------------------------------------------------------------
// 3. Severity aliases (map to the same risk colors)
// ---------------------------------------------------------------------------

export const severity = {
  catastrophic: risk.critical,
  major: risk.high,
  moderate: risk.medium,
  minor: risk.low,
  negligible: risk.veryLow,
} as const;

// ---------------------------------------------------------------------------
// 4. Feature accent colors (sidebar icons, top-bar buttons, module branding)
//    Muted / pastel versions — distinct per feature but calming.
// ---------------------------------------------------------------------------

export const accent = {
  primary: { bg: green[100], text: green[700], border: green[400] },
  indigo: { bg: indigo[50], text: indigo[600], border: indigo[100] },
  purple: { bg: purple[50], text: purple[600], border: purple[100] },
  orange: { bg: orange[50], text: orange[600], border: orange[200] },
  teal: { bg: teal[50], text: teal[800], border: teal[100] },
  blue: { bg: blue[50], text: blue[800], border: blue[100] },
  pink: { bg: pink[50], text: pink[800], border: pink[100] },
  amber: { bg: amber[100], text: amber[700], border: amber[200] },
} as const;

// ---------------------------------------------------------------------------
// 5. Chart palette (ordered sequence for pie/bar/line charts)
//    Same hue families as accents but tuned for data-viz legibility.
//    8 colors — enough for most charts; cycle if > 8 series.
// ---------------------------------------------------------------------------

export const chart = [
  "#5C8A7D", // muted teal-green (primary family)
  "#7986CB", // muted indigo
  "#A1887F", // muted brown
  "#9575CD", // muted purple
  "#4DB6AC", // muted teal
  "#E57373", // muted red
  "#FFB74D", // muted orange
  "#81C784", // muted green
] as const;

// ---------------------------------------------------------------------------
// 6. Text hierarchy (Figma grey scale)
// ---------------------------------------------------------------------------

export const text = {
  primary: grey[900],
  secondary: grey[700],
  tertiary: grey[600],
  accent: grey[400],
  disabled: grey[350],
  black: grey[950],
  icon: grey[450],
  muted: grey[600],
  subdued: grey[450],
} as const;

// ---------------------------------------------------------------------------
// 7. Backgrounds
// ---------------------------------------------------------------------------

export const background = {
  main: grey[50],
  alt: grey[100],
  modal: grey[100],
  fill: green[100],
  accent: grey[100],
  hover: grey[150],
  selected: green[100],
  surface: grey[150],
  gradientStop: "#f8fafc",
} as const;

// ---------------------------------------------------------------------------
// 8. Borders (Figma grey scale)
// ---------------------------------------------------------------------------

export const border = {
  light: grey[200],
  dark: grey[300],
} as const;

// ---------------------------------------------------------------------------
// 9. Primary / brand
// ---------------------------------------------------------------------------

export const brand = {
  primary: green[700],
  primaryHover: green[900],
  primaryLight: green[100],
  primaryDark: green[800],
} as const;

// ---------------------------------------------------------------------------
// 10. Policy editor tokens (TipTap surface, toolbar, image node)
//     Module-specific values without a semantic slot above — kept here so
//     editor component files stay free of hardcoded hex literals.
// ---------------------------------------------------------------------------

export const editor = {
  highlight: "#fef08a", // <mark> and search-match fill
  searchRing: "#eab308", // ring around the active search match
  codeBlockBg: "#1e1e1e",
  codeBlockText: "#d4d4d4",
  historyActiveBg: "#E6F4F1", // history sidebar toggle, active
  historyActiveHoverBg: "#D1EDE6", // history sidebar toggle, active hover
  imageErrorBg: "#fee2e2",
  imageErrorText: "#991b1b",
  imagePlaceholderBg: "#f0f0f0",
  imagePlaceholderText: "#666666",
} as const;

// ---------------------------------------------------------------------------
// 11. User-facing text colors (policy editor color-picker swatches)
//     Content colors chosen by the document author — not theme colors.
// ---------------------------------------------------------------------------

export const userTextColors = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#ca8a04",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
] as const;

// ---------------------------------------------------------------------------
// Combined export
// ---------------------------------------------------------------------------

export const palette = {
  status,
  risk,
  severity,
  accent,
  chart,
  text,
  background,
  border,
  brand,
  editor,
} as const;

export default palette;
