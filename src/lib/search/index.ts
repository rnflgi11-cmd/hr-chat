// search/index.ts
import { retrieveCandidates } from "./retrieve";
import { buildSummary } from "./summarize";
import { inferIntent, pickAnchors, tokenize, expandQueryTerms } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { SearchAnswer, Evidence } from "./types";
import { tryExtractAnswer } from "./extract";

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

/** ✅ 카탈로그(전체/목록) 질문 판별: context 범위를 넓히는 용도 */
function isCatalogQuestion(q: string) {
  const s = (q ?? "").trim();
  if (!s) return false;
  return /뭐가\s*있어|목록|전체|항목|종류|리스트|제도|복리후생|기타휴가|지원.*(항목|제도)|어떤.*(것|항목)/.test(
    s
  );
}

export async function searchAnswer(q: string): Promise<SearchAnswer> {
  const intent = inferIntent(q);

  const terms = tokenize(q);
  const used0 = terms.length ? terms : [q];
  const used = expandQueryTerms(q, used0);

  const anchors = pickAnchors(used);

  // ✅ retrieveCandidates는 (q, used) 시그니처를 그대로 유지한다고 가정 (너 코드 기준)
  const { sb, hits: rawHits } = await retrieveCandidates(q, used);

  console.log("RAW_HITS", rawHits.length);

  // ✅ 검색 결과 자체가 없을 때
  if (!rawHits.length) {
    return { ok: true, answer: buildSummary(intent, [], q), hits: [], meta: { intent } };
  }

  // ✅ anchors 필터가 너무 빡세서 전부 날아가면 rawHits로 폴백
  let hits = filterByAnchors(rawHits, anchors);
  if (!hits.length) hits = rawHits;

  // ✅ intent가 휴가 관련이면, 휴가/연차/경조 관련 문서만 우선 고려 (기존 로직 유지)
  if (/휴가/.test(intent)) {
    const filtered = hits
      .filter((h: any) => /휴가|연차|경조/.test(h.text ?? ""))
      .filter((h: any) => !/구독|OTT|넷플릭스|유튜브|리디북스|티빙/.test(h.text ?? ""));
    if (filtered.length) hits = filtered;
  }

  const scoreRow = makeScorer({ q, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);

  const doc = await loadDocFilename(sb, bestDocId);

  // ✅ 카탈로그면 context에서 문서 범위를 넓힘
  const isCatalog = isCatalogQuestion(q);

  const ctx = await buildWindowContext({
    sb,
    q,
    bestDocId,
    hits,
    scoreRow,
    isCatalog,
  });

  // ✅ 답변 생성용(전체 근거)
 const evidenceAll = toEvidence(doc.filename, ctx);

const extracted = tryExtractAnswer(intent, q, evidenceAll);
const answer = extracted ?? buildSummary(intent, evidenceAll, q);

  // ✅ 화면 표시용(중복 제거 + 12개)
  const evidenceUi = dedupeAndPrioritizeEvidence(evidenceAll, 12);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}