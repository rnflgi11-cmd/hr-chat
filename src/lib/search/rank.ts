import { Row } from "./types";
import { GENERIC_TERMS } from "./query";

export function filterByAnchors(hits: Row[], anchors: string[]) {
  if (!anchors.length) return hits;
  const filtered = hits.filter((r) => {
    const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
    return anchors.some((a) => hay.includes(a));
  });
  return filtered.length ? filtered : hits;
}

export function makeScorer(params: { q: string; used: string[]; anchors: string[] }) {
  const { q, used, anchors } = params;

  return function scoreRow(r: Row) {
    const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
    let s = 0;

    // anchors: 강하게
    for (const a of anchors) if (a && hay.includes(a)) s += 40 + Math.min(30, a.length * 3);

    // used: 약하게 (generic 더 약하게)
    for (const t of used) {
      if (!t) continue;
      if (!hay.includes(t)) continue;
      if (GENERIC_TERMS.has(t)) s += 2;
      else s += 10 + Math.min(12, t.length * 2);
    }

    // patterns
    if (/며칠|일수|몇일/.test(q) && /\d+\s*일/.test(hay)) s += 35;
    if (/얼마|금액|수당/.test(q) && /\d+[,0-9]*\s*원/.test(hay)) s += 35;

        // 화환 질문은 관련 표현을 강하게 우대하고, 경조금 표 패턴은 감점
    if (/화환/.test(q)) {
      if (/(화환|발주|신청서|도착|배송)/.test(hay)) s += 45;
      if (/(경조금|조위금|근속\s*2년|근속2년)/.test(hay)) s -= 35;
    }

    // table
    if (r.kind === "table" && r.table_html) s += 6;

    return s;
  };
}

export function pickBestDocId(
  hits: Row[],
  scoreRow: (r: Row) => number
): string {
  const scoreMap = new Map<string, number[]>();

  for (const h of hits) {
    const s = scoreRow(h);
    const arr = scoreMap.get(h.document_id) ?? [];
    arr.push(s);
    scoreMap.set(h.document_id, arr);
  }

  let bestDocId = "";
  let bestScore = -Infinity;

  for (const [docId, scoresRaw] of scoreMap.entries()) {
    const scores = [...scoresRaw].sort((a, b) => b - a);
    const top1 = scores[0] ?? -Infinity;
    const top3 = scores.slice(0, 3);
    const top3Avg = top3.length
      ? top3.reduce((sum, x) => sum + x, 0) / top3.length
      : -Infinity;

    // 문서 길이/히트 수 편향을 줄이기 위해 상위 히트 중심으로 집계
    const docScore = top1 * 0.7 + top3Avg * 0.3;

    if (docScore > bestScore) {
      bestScore = docScore;
      bestDocId = docId;
    }
  }

  return bestDocId;
}