// lib/search/summarize.ts
import type { Evidence } from "./types";

function normalizeForScore(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForDisplay(s: string) {
  return (s ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tokenize(q: string) {
  return Array.from(
    new Set(
      (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2)
    )
  );
}

function scoreLine(line: string, terms: string[]) {
  const s = normalizeForScore(line).toLowerCase();
  let score = 0;
  for (const t of terms) if (s.includes(t)) score += Math.min(6, t.length);
  if (/\d+\s*일/.test(line)) score += 4;
  if (/\d+[\d,]*\s*원/.test(line)) score += 4;
  if (/시행일|대상|절차|유형|조건|기준/.test(line)) score += 2;
  return score;
}

function clampParagraph(s: string, max = 700) {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

function htmlTableToMarkdown(html: string): string {
  const rows = Array.from(html.matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((m) => m[0]);
  if (!rows.length) return "";

  const parsed = rows
    .map((row) =>
      Array.from(row.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)).map((m) =>
        normalizeForDisplay(
          (m[2] ?? "")
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/\|/g, "\\|")
        )
      )
    )
    .filter((cells) => cells.some(Boolean));

  if (!parsed.length) return "";
  const width = Math.max(...parsed.map((r) => r.length));
  const normalized = parsed.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));

  const hasHeader = /<th[\s\S]*?>/i.test(rows[0]);
  const header = hasHeader
    ? normalized[0]
    : Array.from({ length: width }, (_, i) => `항목${i + 1}`);
  const body = hasHeader ? normalized.slice(1) : normalized;

  const head = `| ${header.join(" | ")} |`;
  const divider = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyLines = body.map((r) => `| ${r.join(" | ")} |`);

  return [head, divider, ...bodyLines].join("\n");
}

export function buildSummary(intent: string, evidenceAll: Evidence[], q: string) {
  const terms = tokenize(q);

  const paragraphs = evidenceAll
    .filter((e) => e.block_type === "p")
    .map((e, idx) => {
      const display = normalizeForDisplay(e.content_text ?? "");
      return {
        idx,
        display,
        score: scoreLine(display, terms),
      };
    })
    .filter((x) => x.display.length > 0);

  const tableMarkdown = evidenceAll
    .filter((e) => e.block_type === "table_html")
    .map((e) => htmlTableToMarkdown(e.content_html ?? ""))
    .find(Boolean);

  if (!paragraphs.length && !tableMarkdown) return "";

  const bestIdx = paragraphs.length
    ? paragraphs.reduce((best, cur, i, arr) =>
    cur.score > arr[best].score ? i : best, 0
      )
    : 0;

  const start = Math.max(0, bestIdx - 2);
  const selected = paragraphs.slice(start, start + 12);

  const title = intent ? `### ${intent} 관련 원문 발췌` : "### 규정 원문 발췌";

  return [
    title,
    ...selected.map((x) => clampParagraph(x.display)),
    tableMarkdown ? "\n### 관련 표\n" : "",
    tableMarkdown ?? "",
  ].join("\n\n");
}