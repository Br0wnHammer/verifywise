// Tooltips for an experiment's rerun, download and copy actions, shared by the
// experiments table menu and the experiment detail header. Translated by exact text
// (i18n/translations.ts), so keep the wording identical in both places.
export const EXPERIMENT_ACTION_TOOLTIPS = {
  rerun:
    "Start a new experiment with the same model, dataset, judge and metrics. This experiment is kept, and every prompt is sent to the model and judge again.",
  rerunWhileRunning: "You can rerun this experiment once it finishes.",
  // The table only has the experiment record; its results hold summary scores and a
  // preview of the first samples, not every sample.
  downloadSummary:
    "Save this experiment's settings and summary results as a JSON file. To include every sample, open the experiment and use Download there.",
  copySummary:
    "Copy this experiment's settings and summary results as JSON. To include every sample, open the experiment and use Copy there.",
  // The detail view also has every sample's log.
  downloadFull:
    "Save this experiment's settings and every sample's input, output and scores as a JSON file.",
  copyFull:
    "Copy this experiment's settings and every sample's input, output and scores to the clipboard as JSON.",
} as const;
