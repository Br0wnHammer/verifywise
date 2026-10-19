jest.mock("../../../utils/aiTrustIndex.utils");
jest.mock("../../emailService", () => ({
  sendAutomationEmail: jest.fn().mockResolvedValue(undefined),
}));

import { syncAiTrustIndex, escapeHtml, sectionHtml } from "../actions/syncAiTrustIndex";
import * as utils from "../../../utils/aiTrustIndex.utils";
import { sendAutomationEmail } from "../../emailService";
import { compileMjmlToHtml } from "../../../tools/mjmlCompiler";
import { readFileSync } from "fs";
import path from "path";

const feedApp = (slug: string, grade = "B") => ({
  slug,
  name: slug,
  vendor: "V",
  domain: `${slug}.com`,
  category: "Assistant",
  scoreOutOf100: 80,
  letterGrade: grade,
  displayedGrade: grade,
  confidence: "High",
  dealbreakerFlags: [],
  summary: "s",
  highlights: [],
  policyUrl: "https://x.com",
  policyLastUpdated: null,
  modalities: ["text"],
  processesBiometrics: false,
});
const feed = {
  feedVersion: 1,
  count: 12,
  apps: Array.from({ length: 12 }, (_, i) => feedApp(`a${i}`)),
};

const diff = (
  gradeFrom: string,
  gradeTo: string,
  scoreFrom = 70,
  scoreTo = 70,
  notes: string[] = [],
) => ({
  grade: { from: gradeFrom, to: gradeTo },
  score: { from: scoreFrom, to: scoreTo },
  notes,
});

describe("syncAiTrustIndex", () => {
  beforeEach(() => jest.clearAllMocks());

  it("seeds silently on first run (no emails)", async () => {
    (utils.getMetaQuery as jest.Mock).mockResolvedValue({
      seeded_at: null,
      last_good_count: null,
      last_run_week: null,
    });
    (utils.upsertFeedTx as jest.Mock).mockResolvedValue({
      materialChanged: [{ slug: "a0", diff: diff("A", "B") }],
      newlyRemoved: [],
      wasFirstSeed: true,
    });
    const r = await syncAiTrustIndex({ feed });
    expect(sendAutomationEmail).not.toHaveBeenCalled();
    expect(r.orgsEmailed).toBe(0);
  });

  it("emails affected orgs on a subsequent run", async () => {
    (utils.getMetaQuery as jest.Mock).mockResolvedValue({
      seeded_at: new Date(),
      last_good_count: 12,
      last_run_week: "2026-W10",
    });
    (utils.upsertFeedTx as jest.Mock).mockResolvedValue({
      materialChanged: [{ slug: "a0", diff: diff("A", "B", 72, 61, ["policy updated"]) }],
      newlyRemoved: ["a9"],
      wasFirstSeed: false,
    });
    (utils.getAffectedOrgsBySlugs as jest.Mock).mockResolvedValue([
      { organization_id: 7, app_slug: "a0", name: "App Zero" },
      { organization_id: 7, app_slug: "a9", name: "App Nine" },
    ]);
    (utils.resolveRecipients as jest.Mock).mockResolvedValue(["admin@acme.com"]);
    const r = await syncAiTrustIndex({ feed });
    expect(sendAutomationEmail).toHaveBeenCalledTimes(1);
    expect(r.orgsEmailed).toBe(1);
  });

  it("no-ops if already run this ISO week", async () => {
    const thisWeek = (utils as any).currentIsoWeek?.(new Date()) ?? "2026-W25";
    (utils.currentIsoWeek as jest.Mock).mockReturnValue(thisWeek);
    (utils.getMetaQuery as jest.Mock).mockResolvedValue({
      seeded_at: new Date(),
      last_good_count: 12,
      last_run_week: thisWeek,
    });
    const r = await syncAiTrustIndex({ feed });
    expect(utils.upsertFeedTx).not.toHaveBeenCalled();
    expect(r.skipped).toBeDefined();
  });

  it("aborts and writes nothing on a bad feed", async () => {
    (utils.getMetaQuery as jest.Mock).mockResolvedValue({
      seeded_at: new Date(),
      last_good_count: 40,
      last_run_week: "2026-W10",
    });
    const r = await syncAiTrustIndex({ feed: { feedVersion: 2, count: 0, apps: [] } });
    expect(utils.upsertFeedTx).not.toHaveBeenCalled();
    expect(sendAutomationEmail).not.toHaveBeenCalled();
    expect(r.skipped).toBeDefined();
  });
});

describe("email HTML escaping", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml("<b>x</b> & \"y\" 'z'")).toBe(
      "&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; &#39;z&#39;",
    );
  });
  it("renders an item's name HTML-escaped inside the section", () => {
    const html = sectionHtml("Changed", [{ name: "<b>evil</b>" }]);
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil</b>");
  });
  it("renders plain HTML table rows, never <mj-*> tags", () => {
    const html = sectionHtml("Changed", [{ name: "Workday", diff: diff("B", "F", 60, 34) }]);
    expect(html).toContain("<table");
    expect(html).toContain("<tr>");
    expect(html).not.toMatch(/<mj-/);
  });
  it("shows grade and score as old → new with the score delta", () => {
    const html = sectionHtml("Changed", [{ name: "Workday", diff: diff("B", "F", 60, 34) }]);
    expect(html).toMatch(/B →<\/span> <span style="color: #B42318[^"]*">F</);
    expect(html).toMatch(/60 →<\/span> <span style="color: #B42318[^"]*">34</);
    expect(html).toContain("−26");
  });
  it("colours an improvement green", () => {
    const html = sectionHtml("Changed", [{ name: "Gemini", diff: diff("F", "C", 31, 53) }]);
    expect(html).toMatch(/<span style="color: #067647[^"]*">C</);
    expect(html).toContain("+22");
  });
  it("shows an unchanged grade as the plain value", () => {
    const html = sectionHtml("Changed", [{ name: "DeepSeek", diff: diff("C", "C", 54, 55) }]);
    expect(html).not.toContain("C →");
  });
  it("lists notes in sentence case under the app name", () => {
    const html = sectionHtml("Changed", [
      { name: "Cursor", diff: diff("B", "C", 69, 59, ["new dealbreaker flag", "policy updated"]) },
    ]);
    expect(html).toContain("New dealbreaker flag · Policy updated");
  });
  it("lists the biggest score drop first", () => {
    const html = sectionHtml("Changed", [
      { name: "Up", diff: diff("F", "C", 31, 53) },
      { name: "Small drop", diff: diff("B", "B", 66, 65) },
      { name: "Big drop", diff: diff("B", "F", 60, 34) },
    ]);
    expect(html.indexOf("Big drop")).toBeLessThan(html.indexOf("Small drop"));
    expect(html.indexOf("Small drop")).toBeLessThan(html.indexOf("Up"));
  });
  it("lists a grade drop above a larger score drop with no grade change", () => {
    const html = sectionHtml("Changed", [
      { name: "Score only", diff: diff("C", "C", 66, 50) },
      { name: "Grade drop", diff: diff("B", "F", 60, 60) },
    ]);
    expect(html.indexOf("Grade drop")).toBeLessThan(html.indexOf("Score only"));
  });
  it("rounds a fractional score delta", () => {
    const html = sectionHtml("Changed", [{ name: "Frac", diff: diff("C", "C", 70.2, 71.3) }]);
    expect(html).toContain("+1.1");
    expect(html).not.toContain("1.0999");
  });
  it("gives a changed app with no diff empty grade and score cells", () => {
    const html = sectionHtml("Changed", [
      { name: "Has diff", diff: diff("B", "C", 60, 50) },
      { name: "No diff" },
    ]);
    const row = html.slice(html.indexOf("No diff"));
    expect(row.match(/<td/g)).toHaveLength(2);
  });
  it("renders removed apps as name-only rows without a header", () => {
    const html = sectionHtml("No longer assessed", [{ name: "Leonardo AI" }]);
    expect(html).toContain("Leonardo AI");
    expect(html).not.toContain("<th");
  });
  it("compiles inside the real template as a table, one row per app", async () => {
    const template = readFileSync(
      path.join(__dirname, "../../../templates/ai-trust-index-digest.mjml"),
      "utf8",
    );
    const out = await compileMjmlToHtml(template, {
      changedSection: sectionHtml("Changed", [
        { name: "Workday", diff: diff("B", "F", 60, 34) },
        { name: "Cursor", diff: diff("B", "C", 69, 59) },
      ]),
      removedSection: "",
      moduleUrl: "u",
      trackedUrl: "u",
      settingsUrl: "u",
    });
    expect(out).toMatch(/<tr><td[^>]*><span[^>]*>Workday</);
    expect(out).toMatch(/<tr><td[^>]*><span[^>]*>Cursor</);
  });
  it("returns empty string for no items", () => {
    expect(sectionHtml("Changed", [])).toBe("");
  });
});
