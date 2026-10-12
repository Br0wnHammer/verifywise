/**
 * Mirrors INCIDENT_DESCRIPTION_MAX_LENGTH in
 * Servers/utils/validations/incidentManagementValidation.utils.ts.
 * Keep in sync — this is the frontend SSOT for the same rule.
 *
 * 32,767 is Jira's text-field limit, so descriptions copied from Jira issues
 * fit without truncation.
 */
export const INCIDENT_DESCRIPTION_MAX_LENGTH = 32767;

export const INCIDENT_DESCRIPTION_TOO_LONG_MESSAGE = `Description cannot exceed ${INCIDENT_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters.`;

/**
 * Returns an error message for an incident description, or "" when valid.
 * Length is measured after trimming, matching the backend validator.
 */
export function validateIncidentDescription(value: unknown): string {
  if (!value) return "Description is required.";
  if (String(value).trim().length > INCIDENT_DESCRIPTION_MAX_LENGTH) {
    return INCIDENT_DESCRIPTION_TOO_LONG_MESSAGE;
  }
  return "";
}
