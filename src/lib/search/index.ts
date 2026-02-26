// lib/search/index.ts
import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize, expandQueryTerms } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer, Evidence, Row } from "./types";
import { extractAnswerFromBlocks as tryExtractAnswer } from "./extract";

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
    const noResultFallback =
    "질문과 정확히 일치하는 규정 근거를 찾지 못했습니다. 질문을 조금 더 구체적으로 입력해 주세요.\n" +
    "예) '경조휴가 부모상 일수', '기타휴가 병가 기준'";

  const terms = tokenize(q);
  const used0 = terms.length ? terms : [q];
  const used = expandQueryTerms(q, used0);

  const anchors = pickAnchors(used);

  const { sb, hits: rawHits } = await retrieveCandidates(q, used);

  if (!rawHits.length) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }

  let hits = filterByAnchors(rawHits, anchors);
  if (!hits.length) hits = rawHits;

  if (/휴가/.test(intent)) {
    const filtered = hits
      .filter((h: Row) => /휴가|연차|경조/.test(h.text ?? ""))
      .filter((h: Row) => !/구독|OTT|넷플릭스|유튜브|리디북스|티빙/.test(h.text ?? ""));
    if (filtered.length) hits = filtered;
  }

  const scoreRow = makeScorer({ q, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);
  if (!bestDocId) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }
  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, bestDocId, hits, scoreRow });

  const evidenceAll = toEvidence(doc.filename, ctx);
  const normalizedEvidence = evidenceAll.map(e => ({ ...e, table_ok: e.table_ok ?? false }));

  // ✅ 정답 추출 우선 (핵심)
  const extracted = tryExtractAnswer(q, normalizedEvidence);

  const answer = extracted?.ok
    ? extracted.answer_md
    : buildSummary(intent, normalizedEvidence, q);

  const evidenceUi = dedupeAndPrioritizeEvidence(normalizedEvidence, 12);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}
