import fs from "fs";
import path from "path";
import { EMAIL_TEMPLATES } from "../../constants/emailTemplates";

const TEMPLATES_DIR = path.join(__dirname, "../../templates");

// notificationService.sendEmailWithTemplate reads these names from
// templates/, so a name with no file only fails when an email is sent.
describe("EMAIL_TEMPLATES", () => {
  it.each(Object.entries(EMAIL_TEMPLATES))("%s names a template file", (_key, fileName) => {
    expect(fs.existsSync(path.join(TEMPLATES_DIR, fileName))).toBe(true);
  });
});
