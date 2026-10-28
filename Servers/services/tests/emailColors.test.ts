import fs from "fs";
import path from "path";
import { brand } from "../../../shared/design-tokens/palette";
import {
  applyColorTokens,
  colorTokenRoot,
  emailColorTokens,
  emailCssVariables,
} from "../../tools/emailColors";
import { compileMjmlToHtml } from "../../tools/mjmlCompiler";

describe("email color tokens", () => {
  it("reads the shared brand primary", () => {
    expect(emailColorTokens.colorBrandPrimary).toBe(brand.primary);
  });

  it("sets the report CSS variables from the shared palette", () => {
    expect(emailCssVariables["--color-background"]).toBe(emailColorTokens.colorBackground);
    expect(emailCssVariables["--color-primary"]).toBe(brand.primary);

    const css = colorTokenRoot();
    expect(css).toContain(`--color-background: ${emailColorTokens.colorBackground}`);
    expect(css).toContain(`--color-primary: ${brand.primary}`);
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

  it("uses a hex brand override and ignores anything else", () => {
    expect(colorTokenRoot("#112233")).toContain("--color-primary: #112233");

    const rejected = colorTokenRoot("red; } body { background: url(evil)");
    expect(rejected).toContain(`--color-primary: ${brand.primary}`);
    expect(rejected).not.toContain("evil");
  });

  it("substitutes a color placeholder and leaves other placeholders", () => {
    const html = applyColorTokens('<a style="color: {{colorBrandPrimary}}">{{heading}}</a>');
    expect(html).toBe(`<a style="color: ${brand.primary}">{{heading}}</a>`);
  });

  it("substitutes palette colors in the approval requested email", async () => {
    const mjml = fs.readFileSync(
      path.join(__dirname, "../../templates/approval-requested.mjml"),
      "utf-8",
    );
    const html = await compileMjmlToHtml(mjml, {
      step_number: "1",
      approver_name: "Ada",
      use_case_name: "Hiring assistant",
      requester_name: "Grace",
      workflow_name: "Launch",
      total_steps: "3",
      approval_url: "https://example.com/approve",
    });

    expect(mjml).not.toMatch(/#13715b/i);
    expect(html).toContain(brand.primary);
    expect(html).toContain("Hiring assistant");
    expect(html).not.toContain("{{color");
  });

  it("substitutes palette colors in the AI gateway budget warning email", async () => {
    const mjml = fs.readFileSync(
      path.join(__dirname, "../../templates/ai-gateway-budget-warning.mjml"),
      "utf-8",
    );
    const html = await compileMjmlToHtml(mjml, {
      recipient_name: "Ada",
      spend_percentage: "80",
      current_spend: "800",
      monthly_limit: "1000",
      threshold: "75",
      hard_limit_status: "Off",
      total_requests: "1200",
      gateway_url: "https://example.com/gateway",
    });

    expect(mjml).not.toMatch(/#13715b/i);
    expect(html).toContain(brand.primary);
    expect(html).toContain("Ada");
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
