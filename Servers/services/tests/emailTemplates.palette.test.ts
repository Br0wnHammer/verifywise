import fs from "fs";
import path from "path";
import logger from "../../utils/logger/fileLogger";
import { applyColorTokens, emailColorTokens } from "../../tools/emailColors";
import { compileMjmlToHtml } from "../../tools/mjmlCompiler";

const TEMPLATES_DIR = path.join(__dirname, "../../templates");
const PARTIALS_DIR = path.join(TEMPLATES_DIR, "partials");
const HEX = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi;
const COLOR_KEY = /{{(color[A-Za-z0-9]+)}}/g;
const INCLUDE = "<mj-include";

const read = (file: string) => fs.readFileSync(file, "utf-8");
const templates = fs
  .readdirSync(TEMPLATES_DIR)
  .filter((name) => name.endsWith(".mjml"))
  .map((name) => ({ name, source: read(path.join(TEMPLATES_DIR, name)) }));
const partials = fs
  .readdirSync(PARTIALS_DIR)
  .filter((name) => name.endsWith(".mjml"))
  .map((name) => ({ name: `partials/${name}`, source: read(path.join(PARTIALS_DIR, name)) }));

// A template is on the palette once it uses a color token or the shared head.
const onPalette = templates.filter(
  ({ source }) => source.includes("{{color") || source.includes(INCLUDE),
);

describe("email templates and the shared palette", () => {
  it.each([...templates, ...partials])("$name only uses known color tokens", ({ source }) => {
    const unknown = [...source.matchAll(COLOR_KEY)]
      .map((match) => match[1])
      .filter((key) => !(key in emailColorTokens));
    expect(unknown).toEqual([]);
  });

  it.each(partials)("$name has no hardcoded colors", ({ source }) => {
    expect(source.match(HEX)).toBeNull();
  });

  it.each(onPalette)("$name has no hardcoded colors", ({ source }) => {
    expect(source.match(HEX)).toBeNull();
  });

  it.each(onPalette)("$name compiles with every color filled in", async ({ source }) => {
    const html = await compileMjmlToHtml(source, {});
    expect(html).not.toContain("{{color");
    expect(html).not.toContain(INCLUDE);
    expect(html).toContain(emailColorTokens.colorButtonText);
  });

  it("expands the shared head before applying color tokens", async () => {
    const html = await compileMjmlToHtml(
      '<mjml><mj-include path="./partials/email-head.mjml" /><mj-body background-color="{{colorPageBackground}}"><mj-section><mj-column><mj-button href="https://example.com">{{label}}</mj-button></mj-column></mj-section></mj-body></mjml>',
      { label: "Open" },
    );
    expect(html).toContain(emailColorTokens.colorButtonPrimary);
    expect(html).toContain(emailColorTokens.colorPageBackground);
    expect(html).toContain("Open");
  });

  it("refuses an include of a partial that does not exist", async () => {
    await expect(
      compileMjmlToHtml('<mjml><mj-include path="./partials/missing.mjml" /></mjml>', {}),
    ).rejects.toThrow();
  });

  it("leaves an unknown color token in place and logs it once", () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      expect(applyColorTokens("{{colorNotAToken}} {{colorNotAToken}}")).toBe(
        "{{colorNotAToken}} {{colorNotAToken}}",
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
