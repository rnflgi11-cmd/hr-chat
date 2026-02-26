// lib/search/summarize.ts
import type { Evidence } from "./types";

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
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
  const s = line.toLowerCase();
  let score = 0;
  for (const t of terms) if (s.includes(t)) score += Math.min(6, t.length);
  if (/\d+\s*일/.test(line)) score += 4;
  if (/\d+[\d,]*\s*원/.test(line)) score += 4;
  if (/기준|대상|절차|유형|조건/.test(line)) score += 2;
  return score;
}

export function buildSummary(intent: string, evidenceAll: Evidence[], q: string) {
  const terms = tokenize(q);

  const candidates = evidenceAll
    .filter((e) => e.block_type === "p")
    .map((e, idx) => ({
      idx,
      text: clean(e.content_text ?? ""),
    }))
    .filter((x) => x.text.length > 0)
    .map((x) => ({ ...x, score: scoreLine(x.text, terms) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));

  if (!candidates.length) return "";

    const selected = candidates.slice(0, 8).sort((a, b) => a.idx - b.idx).map((x) => x.text);
  const title = intent ? `### ${intent} 관련 요약` : "### 규정 요약";

  return [title, ...selected.map((x) => `- ${x.startsWith("-") ? x.slice(1).trim() : x}`)].join("\n");
}