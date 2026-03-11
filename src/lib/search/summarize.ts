// lib/search/summarize.ts
import type { Evidence } from "./types";

type QuestionType = "direct" | "list" | "explain";

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

function cleanLine(line: string): string {
  return normalizeForDisplay(line)
    .replace(/^[•●◊✅📌■-]\s*/, "")
    .replace(/^문의[:：]?.*$/g, "")
    .replace(/^(제목|안내|참고)[:：].*$/g, "")
    .trim();
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, "").replace(/[,:：·•()\[\]{}"'`.-]/g, "");
    if (!line || key.length < 8 || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function buildSummary(intent: string, evidenceAll: Evidence[], q: string, questionType: QuestionType = "direct") {
  const terms = tokenize(q);

  const paragraphs = evidenceAll
    .filter((e) => e.block_type === "p")
    .map((e, idx) => {
      const display = cleanLine(e.content_text ?? "");
      return {
        idx,
        display,
        score: scoreLine(display, terms),
      };
    })
    .filter((x) => x.display.length > 0);

  if (!paragraphs.length) return "";

  const bestIdx = paragraphs.length
    ? paragraphs.reduce((best, cur, i, arr) =>
    cur.score > arr[best].score ? i : best, 0
      )
    : 0;

  const start = Math.max(0, bestIdx - 2);
  const selected = dedupeLines(paragraphs.slice(start, start + 14).map((x) => x.display)).slice(0, 7);
  const head = selected[0] ?? "";
  const tail = selected.slice(1);

  if (questionType === "list") {
    const summary = head
      ? `${intent || "해당 항목"}은 아래 핵심 항목으로 확인됩니다.`
      : `${intent || "해당 항목"}의 핵심 목록은 다음과 같습니다.`;
    return [summary, ...tail.slice(0, 5).map((x) => `- ${clampParagraph(x, 240)}`)].join("\n");
  }

  if (questionType === "explain") {
    const conclusion = head
      ? `${intent || "해당 규정"}의 기준은 ${clampParagraph(head, 160)}입니다.`
      : `${intent || "해당 규정"}의 기준은 아래와 같습니다.`;
    const basis = tail.slice(0, 4).map((x) => `- ${clampParagraph(x, 240)}`);
    return [conclusion, ...basis].join("\n");
  }

  const para1 = head ? `${intent || "해당 규정"}은 ${clampParagraph(head, 180)}.` : `${intent || "해당 규정"}은 아래 근거로 확인됩니다.`;
  const para2 = tail[0] ? `${clampParagraph(tail[0], 220)}.` : "";
  const para3 = tail[1] ? `${clampParagraph(tail[1], 220)}.` : "";
  return [para1, para2, para3].filter(Boolean).join("\n\n");
}