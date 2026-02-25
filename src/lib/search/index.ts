import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer, Evidence } from "./types";

/** 같은 문장 중복 제거 + p 우선 + table 1개 포함 */
function dedupeAndPrioritizeEvidence(evs: Evidence[], max = 12): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();

  const tables = evs.filter((e) => e.block_type === "table_html");
  const ps = evs.filter((e) => e.block_type === "p");

  for (const e of ps) {
    const key = (e.content_text ?? "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }

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

  // ✅ 검색 결과 자체가 없을 때
  if (!rawHits.length) {
    return { ok: true, answer: buildSummary(intent, [], q), hits: [], meta: { intent } };
  }

  // ✅ anchors 필터가 너무 빡세서 전부 날아가면 rawHits로 폴백
  let hits = filterByAnchors(rawHits, anchors);
  if (!hits.length) hits = rawHits;
  // ✅ intent가 휴가 관련이면, 휴가/연차/경조 관련 문서만 우선 고려
if (intent.includes("휴가")) {
  const filtered = hits.filter(h =>
    /휴가|연차|경조/.test(h.content_text ?? "")
  );
  if (filtered.length) hits = filtered;
}  

  const scoreRow = makeScorer({ q, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);

  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, q, bestDocId, hits, scoreRow });

  // ✅ 답변 생성용(전체 근거)
  const evidenceAll = toEvidence(doc.filename, ctx);
  const answer = buildSummary(intent, evidenceAll, q);

  // ✅ 화면 표시용(중복 제거 + 12개)
  const evidenceUi = dedupeAndPrioritizeEvidence(evidenceAll, 12);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}