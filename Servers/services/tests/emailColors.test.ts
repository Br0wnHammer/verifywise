import fs from "fs";
import path from "path";
import { brand } from "../../../shared/design-tokens/palette";
import { applyColorTokens, emailColorTokens } from "../../tools/emailColors";
import { compileMjmlToHtml } from "../../tools/mjmlCompiler";

describe("email color tokens", () => {
  it("reads the shared brand primary", () => {
    expect(emailColorTokens.colorBrandPrimary).toBe(brand.primary);
  });

  it("substitutes a color placeholder and leaves other placeholders", () => {
    const html = applyColorTokens('<a style="color: {{colorBrandPrimary}}">{{heading}}</a>');
    expect(html).toBe(`<a style="color: ${brand.primary}">{{heading}}</a>`);
  });

  it("substitutes palette colors in the account creation email", async () => {
    const mjml = fs.readFileSync(
      path.join(__dirname, "../../templates/account-creation-email.mjml"),
      "utf-8",
    );
    const html = await compileMjmlToHtml(mjml, {
      heading: "Welcome",
      greeting: "Hi",
      intro: "Intro",
      instruction: "Do this",
      link: "https://example.com",
      button: "Open",
      ignore: "Ignore",
      thanks: "Thanks",
      footer: "Footer",
    });

    expect(mjml).not.toMatch(/#13715b/i);
    expect(html).toContain(brand.primary);
    expect(html).toContain("Welcome");
    expect(html).not.toContain("{{color");
  });

  it("substitutes color placeholders before MJML compilation", async () => {
    const html = await compileMjmlToHtml(
      '<mjml><mj-body><mj-text color="{{colorBrandPrimary}}">{{heading}}</mj-text></mj-body></mjml>',
      { heading: "Welcome" },
    );
    expect(html).toContain(brand.primary);
    expect(html).toContain("Welcome");
    expect(html).not.toContain("{{color");
  });
});
