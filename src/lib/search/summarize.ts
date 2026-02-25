// lib/search/summarize.ts
import type { Evidence } from "./types";

function normalizeLine(s: string) {
  return (s ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function linesFromEvidence(evs: Evidence[]) {
  const out: string[] = [];
  for (const e of evs) {
    if (e.block_type === "p") {
      const t = normalizeLine(e.content_text ?? "");
      if (t) out.push(t);
    }
  }
  return out;
}

function findSectionStart(intent: string, lines: string[]) {
  if (/경조/.test(intent)) {
    return lines.findIndex((l) => l.includes("경조"));
  }
  if (/기타/.test(intent)) {
    return lines.findIndex((l) => l.includes("기타 휴가"));
  }
  if (/연차/.test(intent)) {
    return lines.findIndex((l) => l.includes("연차"));
  }
  return 0;
}

export function buildSummary(intent: string, evidenceAll: Evidence[], q: string) {
  const lines = linesFromEvidence(evidenceAll);
  if (!lines.length) return "";

  const start = findSectionStart(intent, lines);
  if (start === -1) return lines.slice(0, 20).join("\n");

  // 다음 큰 섹션 나오기 전까지만 자르기
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/연차 휴가|경조 휴가|기타 휴가/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end);

  return section.map((x) => (x.startsWith("- ") ? x : `- ${x}`)).join("\n");
}