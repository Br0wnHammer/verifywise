import { compileMjmlToHtml } from "../mjmlCompiler";

const template = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;

describe("compileMjmlToHtml", () => {
  it("fills every placeholder", async () => {
    const html = await compileMjmlToHtml(template("{{a}} and {{b}} and {{a}}"), {
      a: "one",
      b: "two",
    });
    expect(html).toContain("one and two and one");
  });

  it("inserts replacement patterns like $& and $' literally", async () => {
    const html = await compileMjmlToHtml(template("[{{name}}] tail"), { name: "Cash$'App $& $$" });
    expect(html).toContain("[Cash$'App $& $$] tail");
  });

  it("does not substitute a placeholder that appears inside a value", async () => {
    const html = await compileMjmlToHtml(template("{{name}} {{url}}"), {
      name: "{{url}}",
      url: "https://example.com",
    });
    expect(html).toContain("{{url}} https://example.com");
  });

  it("leaves placeholders without data untouched", async () => {
    const html = await compileMjmlToHtml(template("{{missing}}"), {});
    expect(html).toContain("{{missing}}");
  });
});
