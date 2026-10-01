import { lazy, ComponentType } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";

export const LazyFallback = () => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "100%",
    }}
  >
    {/* role="progressbar" needs an accessible name (axe: aria-progressbar-name).
        This fallback is on screen for every lazy route while its chunk loads,
        so an unnamed spinner here is the one a11y violation every page shows. */}
    <CircularProgress size={32} aria-label="Loading" />
  </Box>
);

/**
 * Wraps React.lazy() with retry logic for chunk load failures.
 * Retries up to 3 times with exponential backoff (1.5s, 3s, 6s).
 */
export function lazyRoute<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() => retryImport(factory));
}

function retryImport<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 3,
  delay = 1500,
): Promise<{ default: T }> {
  return factory().catch((err) => {
    if (retries <= 0) throw err;
    return new Promise<{ default: T }>((resolve) =>
      setTimeout(() => resolve(retryImport(factory, retries - 1, delay * 2)), delay),
    );
  });
}
