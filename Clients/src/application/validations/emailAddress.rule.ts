/**
 * Checks if the provided email address is valid.
 *
 * This function uses the `validator` library to determine if the given email
 * address conforms to standard email format.
 *
 * @param email - The email address to validate.
 * @returns `true` if the email address is valid, `false` otherwise.
 */

// Subpath import: the full `validator` package is ~85 KiB gz (locale data for
// tax IDs, postal codes, etc.); only isEmail is needed here.
import isEmail from "validator/lib/isEmail";

export function isValidEmail(email: string): boolean {
  return isEmail(email);
}
