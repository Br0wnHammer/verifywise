import { promises as fs } from "fs";
import path from "path";
import { fetchFeed, validateFeed } from "../../../utils/aiTrustIndexFeed";
import {
  getMetaQuery,
  upsertFeedTx,
  getAffectedOrgsBySlugs,
  resolveRecipients,
  currentIsoWeek,
  type MaterialDiff,
} from "../../../utils/aiTrustIndex.utils";
import { sendAutomationEmail } from "../../emailService";
import { compileMjmlToHtml } from "../../../tools/mjmlCompiler";
import logger from "../../../utils/logger/fileLogger";

const FRONTEND = process.env.FRONTEND_URL ?? "http://localhost:5173";
// Deep links surfaced in the digest. The module link lands on Browse (the bare
// /ai-trust-index path redirects there); tracked and settings are direct.
const MODULE_URL = FRONTEND + "/ai-trust-index/browse";
const TRACKED_URL = FRONTEND + "/ai-trust-index/tracked";
const SETTINGS_URL = FRONTEND + "/ai-trust-index/settings";

// Escape HTML metacharacters so a slug can never inject markup into the
// rendered email (defensive — the feed is first-party, but the digest is HTML).
// Exported for unit testing of the HTML-escaping path (no behavioral change).
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A single row in a digest section: the human app name (falls back to the slug
// when no name resolved) and, for changed apps, what moved. Removed apps carry
// no diff.
export interface DigestItem {
  name: string;
  diff?: MaterialDiff;
}

const TEXT = "#1c2130";
const MUTED = "#667085";
const WORSE = "#B42318";
const BETTER = "#067647";
const DIVIDER = "1px solid #eaecf0";
const GRADE_ORDER = "ABCDF";

// Positive when the grade got worse, negative when better, 0 when unknown.
function gradeTrend(from: string, to: string): number {
  const a = GRADE_ORDER.indexOf(from.charAt(0).toUpperCase());
  const b = GRADE_ORDER.indexOf(to.charAt(0).toUpperCase());
  return a < 0 || b < 0 ? 0 : b - a;
}

function scoreDelta(diff?: MaterialDiff): number {
  return diff && diff.score.from !== null ? diff.score.to - diff.score.from : 0;
}

// "B → F" with the new value coloured by direction, or just the value when it
// did not change.
function transitionHtml(from: string | null, to: string, trend: number): string {
  if (from === null || from === to) return `<span style="color: ${TEXT};">${escapeHtml(to)}</span>`;
  const colour = trend > 0 ? WORSE : trend < 0 ? BETTER : TEXT;
  return `<span style="color: ${MUTED};">${escapeHtml(from)} →</span> <span style="color: ${colour}; font-weight: 600;">${escapeHtml(to)}</span>`;
}

function scoreHtml(diff: MaterialDiff): string {
  const { from, to } = diff.score;
  const delta = scoreDelta(diff);
  const cell = transitionHtml(from === null ? null : String(from), String(to), -delta);
  if (!delta) return cell;
  const sign = delta > 0 ? "+" : "−";
  return `${cell}<br><span style="color: ${delta > 0 ? BETTER : WORSE}; font-size: 12px;">${sign}${Math.abs(delta)}</span>`;
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const cellStyle = (extra = "") =>
  `padding: 10px 12px 10px 0; border-top: ${DIVIDER}; vertical-align: top; text-align: left;${extra}`;
const headStyle = (extra = "") =>
  `padding: 0 12px 8px 0; color: ${MUTED}; font-size: 12px; font-weight: 500; text-align: left;${extra}`;

function appCellHtml(item: DigestItem): string {
  const name = `<span style="color: ${TEXT}; font-weight: 500;">${escapeHtml(item.name)}</span>`;
  const notes = item.diff?.notes.length
    ? `<br><span style="color: ${MUTED}; font-size: 13px;">${escapeHtml(item.diff.notes.map(sentenceCase).join(" · "))}</span>`
    : "";
  return `<td style="${cellStyle()}">${name}${notes}</td>`;
}

// Build an HTML table for one digest section. It is injected into a {{...}}
// slot inside the template's <mj-text>, so it must be plain HTML: <mj-*> tags
// nested in <mj-text> do not render as blocks and the rows run together.
// Changed apps are listed biggest score drop first. Exported for unit testing.
export function sectionHtml(title: string, items: DigestItem[]): string {
  if (!items.length) return "";
  const withDiff = items.some((it) => it.diff);
  const ordered = withDiff
    ? [...items].sort((a, b) => scoreDelta(a.diff) - scoreDelta(b.diff))
    : items;
  const rows = ordered
    .map((it) => {
      if (!it.diff) return `<tr>${appCellHtml(it)}</tr>`;
      const { grade } = it.diff;
      const trend = grade.from === null ? 0 : gradeTrend(grade.from, grade.to);
      const gradeCell = transitionHtml(grade.from, grade.to, trend);
      return (
        `<tr>${appCellHtml(it)}` +
        `<td style="${cellStyle(" white-space: nowrap;")}">${gradeCell}</td>` +
        `<td style="${cellStyle(" white-space: nowrap; padding-right: 0;")}">${scoreHtml(it.diff)}</td></tr>`
      );
    })
    .join("");
  const head = withDiff
    ? `<tr><th style="${headStyle()}">App</th>` +
      `<th style="${headStyle(" width: 64px;")}">Grade</th>` +
      `<th style="${headStyle(" width: 88px; padding-right: 0;")}">Score</th></tr>`
    : "";
  return (
    `<p style="color: ${TEXT}; font-size: 15px; font-weight: 600; margin: 8px 0 12px 0;">${escapeHtml(title)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin: 0 0 24px 0; font-size: 14px; line-height: 20px;">${head}${rows}</table>`
  );
}

async function renderDigest(orgChanged: DigestItem[], orgRemoved: DigestItem[]): Promise<string> {
  const tmplPath = path.join(__dirname, "../../../templates/ai-trust-index-digest.mjml");
  const template = await fs.readFile(tmplPath, "utf8");
  return compileMjmlToHtml(template, {
    changedSection: sectionHtml("Changed", orgChanged),
    removedSection: sectionHtml("No longer assessed", orgRemoved),
    moduleUrl: MODULE_URL,
    trackedUrl: TRACKED_URL,
    settingsUrl: SETTINGS_URL,
  });
}

export async function syncAiTrustIndex(deps?: { feed?: unknown }): Promise<{
  fetched: number;
  materialChanged: number;
  newlyRemoved: number;
  orgsEmailed: number;
  skipped?: string;
}> {
  const meta = await getMetaQuery();
  const thisWeek = currentIsoWeek(new Date());
  if (meta.last_run_week === thisWeek) {
    return {
      fetched: 0,
      materialChanged: 0,
      newlyRemoved: 0,
      orgsEmailed: 0,
      skipped: `already ran ${thisWeek}`,
    };
  }

  let raw: unknown;
  try {
    raw = deps?.feed ?? (await fetchFeed());
  } catch (e) {
    logger.error(`[ai-trust-index] feed fetch failed: ${(e as Error).message}`);
    return {
      fetched: 0,
      materialChanged: 0,
      newlyRemoved: 0,
      orgsEmailed: 0,
      skipped: "fetch failed",
    };
  }

  const validated = validateFeed(raw, meta.last_good_count ?? null);
  if (!validated.ok) {
    logger.error(`[ai-trust-index] feed rejected: ${validated.reason}`);
    return {
      fetched: 0,
      materialChanged: 0,
      newlyRemoved: 0,
      orgsEmailed: 0,
      skipped: validated.reason,
    };
  }

  const { materialChanged, newlyRemoved, wasFirstSeed } = await upsertFeedTx(
    validated.apps,
    validated.presentSlugs,
    validated.rawCount,
  );

  if (wasFirstSeed) {
    logger.info(
      `[ai-trust-index] first seed complete (${validated.apps.length} apps); emails suppressed`,
    );
    return {
      fetched: validated.apps.length,
      materialChanged: 0,
      newlyRemoved: 0,
      orgsEmailed: 0,
    };
  }

  // Map each changed slug to what moved (grade, score, notes). These come from
  // upsertFeedTx, which compares the previous and current records using
  // displayedGrade — the governance grade.
  const diffBySlug = new Map<string, MaterialDiff>(
    materialChanged.map(({ slug, ...diff }) => [slug, diff]),
  );
  const changedSlugs = Array.from(
    new Set([...materialChanged.map((m) => m.slug), ...newlyRemoved]),
  );
  let orgsEmailed = 0;
  if (changedSlugs.length) {
    const affected = await getAffectedOrgsBySlugs(changedSlugs);
    const byOrg = new Map<number, { changed: DigestItem[]; removed: DigestItem[] }>();
    for (const row of affected) {
      const bucket = byOrg.get(row.organization_id) ?? { changed: [], removed: [] };
      // Prefer the human name; fall back to the slug if the join found no row.
      const name = row.name ?? row.app_slug;
      if (newlyRemoved.includes(row.app_slug)) {
        bucket.removed.push({ name });
      } else {
        bucket.changed.push({ name, diff: diffBySlug.get(row.app_slug) });
      }
      byOrg.set(row.organization_id, bucket);
    }
    for (const [orgId, { changed, removed }] of byOrg) {
      const recipients = await resolveRecipients(orgId);
      if (!recipients.length) continue;
      const html = await renderDigest(changed, removed);
      await sendAutomationEmail(recipients, "AI Trust Index — weekly update", html, undefined);
      orgsEmailed++;
    }
  }

  logger.info(
    `[ai-trust-index] sync done: fetched=${validated.apps.length} changed=${materialChanged.length} removed=${newlyRemoved.length} orgsEmailed=${orgsEmailed}`,
  );
  return {
    fetched: validated.apps.length,
    materialChanged: materialChanged.length,
    newlyRemoved: newlyRemoved.length,
    orgsEmailed,
  };
}
