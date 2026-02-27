// lib/search/index.ts
import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize, expandQueryTerms } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer, Evidence, Row } from "./types";
import { extractAnswerFromBlocks as tryExtractAnswer } from "./extract";

type QuestionContext = {
  cleanedQuestion: string;
  preferredDocHint?: string;
};

function parseQuestionContext(q: string): QuestionContext {
  const m = q.match(/^\s*\[([^\]]+)\]\s*/);
  if (!m) return { cleanedQuestion: q.trim() };
  const preferredDocHint = m[1]?.trim();
  const cleanedQuestion = q.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  return {
    cleanedQuestion: cleanedQuestion || q.trim(),
    preferredDocHint: preferredDocHint || undefined,
  };
}

async function tryPreferDocumentHits(
  sb: Awaited<ReturnType<typeof retrieveCandidates>>["sb"],
  hits: Row[],
  preferredDocHint?: string
): Promise<Row[]> {
  if (!preferredDocHint) return hits;

  const hint = preferredDocHint
    .replace(/\.docx?$|\.pdf$/gi, "")
    .replace(/^\d+[_-]*/, "")
    .trim();

  if (!hint) return hits;

  const { data } = await sb
    .from("documents")
    .select("id, filename")
    .ilike("filename", `%${hint}%`)
    .limit(10);

  const ids = new Set((data ?? []).map((d) => d.id));
  if (!ids.size) return hits;

  const preferred = hits.filter((h) => ids.has(h.document_id));
  return preferred.length ? preferred : hits;
}

function formatAnswerStyle(question: string, answer: string): string {
  const raw = (answer ?? "").trim();
  if (!raw) return raw;
  if (/^Q\.|^##\s/m.test(raw)) return raw;

    // 일수/기준/절차형 질문은 원문 순서를 최대한 보존
  if (/(며칠|일수|기준|절차|안식년|경조|화환|연차)/.test(question)) {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
      const key = line.replace(/\s+/g, " ").trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(line.trim());
    }
    return deduped.join("\n");
  }
  
  const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);
  const bullets = lines.filter((x) => x.startsWith("- "));
  if (!bullets.length) return raw;

  const conditions = bullets.filter((x) => /(대상|조건|가능|불가|기준|해당)/.test(x));
  const procedures = bullets.filter((x) => /(신청|절차|경로|결재|보고|요청)/.test(x));
  const cautions = bullets.filter((x) => /(유의|주의|제외|예외|중복|미지급|소멸)/.test(x));
  const remains = bullets.filter(
    (x) => !conditions.includes(x) && !procedures.includes(x) && !cautions.includes(x)
  );

  const out: string[] = [];
  out.push(`Q. ${question.trim()}`);
  out.push("\nA. 관련 규정을 기준으로 핵심 내용을 정리하면 다음과 같습니다.");

  if (conditions.length) {
    out.push("\n신청 조건/적용 기준:");
    out.push(...conditions);
  }
  if (procedures.length) {
    out.push("\n신청 절차:");
    out.push(...procedures);
  }
  if (cautions.length) {
    out.push("\n유의 사항:");
    out.push(...cautions);
  }
  if (remains.length) {
    out.push("\n추가 확인 사항:");
    out.push(...remains);
  }

  return out.join("\n");
}

function applyWreathSafetyFilter(question: string, hits: Row[]): Row[] {
  if (!/화환/.test(question)) return hits;

  const includeRe = /(화환|발주|신청서|도착|배송)/;
  const excludeRe = /(경조금|조위금|근속\s*2년|근속2년)/;

  const preferred = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return includeRe.test(hay) && !excludeRe.test(hay);
  });
  if (preferred.length) return preferred;

  const includeOnly = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return includeRe.test(hay);
  });
  if (includeOnly.length) return includeOnly;

  const softened = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return !excludeRe.test(hay);
  });

  return softened.length ? softened : hits;
}

function applyLeaveDaysSafetyFilter(question: string, hits: Row[]): Row[] {
  if (!/(며칠|몇\s*일|일수|기간)/.test(question)) return hits;
  if (!/(경조|경조\s*휴가|휴가)/.test(question)) return hits;

  const withDays = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return /(\d+\s*일|휴가일수|일수|근속\s*2년|근속2년)/.test(hay);
  });
  if (withDays.length) return withDays;

  const withoutCautionOnly = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return !/(유의사항|사전\s*휴가\s*신청\s*사유|사후\s*휴가\s*신청\s*사유)/.test(hay);
  });

  return withoutCautionOnly.length ? withoutCautionOnly : hits;
}

function tryAnnualLeaveEstimator(question: string): SearchAnswer | null {
  const q = question.replace(/\s+/g, " ").trim();
  if (!/입사/.test(q) || !/연차/.test(q)) return null;
  if (!/(올해|금년|이번\s*해|지금|몇\s*개|며칠|일수)/.test(q)) return null;

  const yearMatch = q.match(/(19\d{2}|20\d{2})\s*년/);
  if (!yearMatch) return null;
  const joinYear = Number(yearMatch[1]);
  if (!Number.isFinite(joinYear)) return null;

  const monthMatch = q.match(/(19\d{2}|20\d{2})\s*년\s*(\d{1,2})\s*월/);
  const joinMonth = monthMatch ? Number(monthMatch[2]) : null;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const yearsCompleted = currentYear - joinYear;

  let estimate = 0;
  let basis = "";

  if (yearsCompleted <= 0) {
    if (joinMonth && joinMonth >= 1 && joinMonth <= 12) {
      estimate = Math.max(0, Math.min(11, currentMonth - joinMonth));
      basis = `1년 미만 월 개근 기준(입사월 ${joinMonth}월 반영, 최대 11일)`;
    } else {
      estimate = 11;
      basis = "1년 미만 월 개근 기준(최대 11일, 정확 계산에는 입사월 필요)";
    }
  } else {
    estimate = 15 + Math.floor((yearsCompleted - 1) / 2);
    estimate = Math.min(25, estimate);
    basis = "근속 1년 이상: 15일 + 2년마다 1일 가산(최대 25일)";
  }

  const answer = [
    "## 연차 계산(추정)",
    `- 입사연도: ${joinYear}년`,
    `- 기준연도: ${currentYear}년`,
    `- 추정 연차: **${estimate}일**`,
    `- 계산 기준: ${basis}`,
    "- 안내: 최종 연차는 회사 취업규칙/회계연도 기준, 입사일(월/일), 소진/이월 정책에 따라 달라질 수 있습니다.",
  ].join("\n");

  return {
    ok: true,
    answer,
    hits: [],
    meta: { intent: "연차 계산" },
  };
}

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
  const { cleanedQuestion, preferredDocHint } = parseQuestionContext(q);
  const question = cleanedQuestion || q;
  const intent = inferIntent(question);
  
  const annualLeave = tryAnnualLeaveEstimator(question);
  if (annualLeave) return annualLeave;

  const noResultFallback =
    "질문과 정확히 일치하는 규정 근거를 찾지 못했습니다. 질문을 조금 더 구체적으로 입력해 주세요.\n" +
    "예) '경조휴가 부모상 일수', '기타휴가 병가 기준'";

  const terms = tokenize(question);
  const used0 = terms.length ? terms : [question];
  const used = expandQueryTerms(question, used0);

  const anchors = pickAnchors(used);

  const { sb, hits: rawHits0 } = await retrieveCandidates(question, used);
  const rawHits = await tryPreferDocumentHits(sb, rawHits0, preferredDocHint);

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

  hits = applyWreathSafetyFilter(question, hits);
  hits = applyLeaveDaysSafetyFilter(question, hits);

  const scoreRow = makeScorer({ q: question, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);
  if (!bestDocId) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }
  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, bestDocId, hits, scoreRow });

  const evidenceAll = toEvidence(doc.filename, ctx);
  const normalizedEvidence = evidenceAll.map((e) => ({ ...e, table_ok: e.table_ok ?? false }));

  const extracted = tryExtractAnswer(question, normalizedEvidence);

 const draftedAnswer = extracted?.ok
    ? extracted.answer_md
    : buildSummary(intent, normalizedEvidence, question);

  const answer = formatAnswerStyle(question, (draftedAnswer ?? "").trim() || noResultFallback);

  const evidenceUi = dedupeAndPrioritizeEvidence(normalizedEvidence, 12);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}
