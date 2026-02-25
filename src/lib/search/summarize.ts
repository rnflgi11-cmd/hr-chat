// lib/search/summarize.ts
import type { Evidence } from "./types";

function isCatalogQuestion(q: string) {
  const s = (q ?? "").trim();
  if (!s) return false;
  return /뭐가\s*있어|목록|전체|항목|종류|리스트|제도|복리후생|기타휴가|지원.*(항목|제도)|어떤.*(것|항목)/.test(
    s
  );
}

function normalizeLine(s: string) {
  return (s ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function linesFromEvidence(evs: Evidence[]) {
  const out: string[] = [];
  for (const e of evs) {
    if (e.block_type === "p") {
      const t = normalizeLine(e.content_text ?? "");
      if (t) out.push(t);
    } else if (e.block_type === "table_html") {
      // 현재 너희는 table_html을 “리스트 형태로 본문 출력”로 바꿔둔 상태라 했으니
      // 여기서는 html 자체를 파싱하지 않고, 존재만 표시(또는 이미 content_text로 들어오면 사용)
      const t = normalizeLine(e.content_text ?? "");
      if (t) out.push(t);
    }
  }
  return out;
}

function dedupeLines(lines: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l;
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * ✅ index.ts가 기대하는 시그니처 그대로
 * buildSummary(intent, evidenceAll, q)
 */
export function buildSummary(intent: string, evidenceAll: Evidence[], q: string) {
  const isCatalog = isCatalogQuestion(q);

  const raw = dedupeLines(linesFromEvidence(evidenceAll));

  if (!raw.length) return "";

  // 일반 질문: 짧게
  if (!isCatalog) {
    const max = 18;
    const picked = raw.slice(0, max);
    return picked.map((x) => (x.startsWith("- ") ? x : `- ${x}`)).join("\n");
  }

  // 카탈로그(전체/목록): 충분히 길게
  const maxLines = 90;
  const picked = raw.slice(0, maxLines);

  return [
    `[규정 검색 결과]`,
    ...picked.map((x) => (x.startsWith("- ") ? x : `- ${x}`)),
  ].join("\n");
}