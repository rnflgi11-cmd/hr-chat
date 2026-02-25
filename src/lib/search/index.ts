import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer } from "./types";

import type { Evidence } from "./types";

function clampEvidence(evs: Evidence[], max = 10): Evidence[] {
  return (evs ?? []).slice(0, Math.max(0, max));
}

/** 같은 문장/비슷한 문장 중복 제거 + p 우선 + table 1개 포함 */
function dedupeAndPrioritizeEvidence(evs: Evidence[], max = 12): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();

  // table_html 하나는 보존(있으면)
  const tables = evs.filter((e) => e.block_type === "table_html");
  const ps = evs.filter((e) => e.block_type === "p");

  // p 먼저: 중복 제거
  for (const e of ps) {
    const key = (e.content_text ?? "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }

  // table 1개만 뒤에 추가 (이미 out가 꽉 차면 마지막 하나 교체)
  if (tables.length) {
    const t = tables[0];
    if (out.length < max) out.push(t);
    else out[max - 1] = t;
  }

  return out.slice(0, max);
}

export async function searchAnswer(q: string): Promise<SearchAnswer> {
  const intent = inferIntent(q);
  const terms = tokenize(q);
  const used = terms.length ? terms : [q];
  const anchors = pickAnchors(used);

  const { sb, hits: rawHits } = await retrieveCandidates(q, used);

  if (!rawHits.length) {
    return { ok: true, answer: buildSummary(intent, [], q), hits: [], meta: { intent } };
  }

  const hits = filterByAnchors(rawHits, anchors);
  const scoreRow = makeScorer({ q, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);

  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, q, bestDocId, hits, scoreRow });

// ✅ hits는 보기 좋게 줄여서 내려보내기 (근거 폭발 방지)
const evidenceAll = toEvidence(doc.filename, ctx);      // ✅ 답변 생성용(전체)
const answer = buildSummary(intent, evidenceAll, q);    // ✅ 전체로 답변 만들기

const evidenceUi = evidenceAll.slice(0, 12);            // ✅ 화면 표시용(12개만)

return {
  ok: true,
  answer,
  hits: evidenceUi,
  meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
};

}