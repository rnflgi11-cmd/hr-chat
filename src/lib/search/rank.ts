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

    // table
    if (r.kind === "table" && r.table_html) s += 6;

    return s;
  };
}

export function pickBestDocId(hits: Row[], scoreRow: (r: Row) => number) {
  const docScore = new Map<string, number>();
  for (const r of hits) docScore.set(r.document_id, (docScore.get(r.document_id) ?? 0) + scoreRow(r));

  let bestDocId = hits[0].document_id;
  let bestScore = -1;
  for (const [docId, s] of docScore.entries()) {
    if (s > bestScore) {
      bestScore = s;
      bestDocId = docId;
    }
  }
  return bestDocId;
}