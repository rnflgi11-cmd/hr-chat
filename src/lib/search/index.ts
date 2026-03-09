// lib/search/index.ts
import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize, expandQueryTerms } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer, Evidence, Row } from "./types";
import { extractAnswerFromBlocks as tryExtractAnswer } from "./extract";
import { refineAnswerWithLlm } from "@/lib/llm";

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

async function tryPreferTopicDocumentHits(
  sb: Awaited<ReturnType<typeof retrieveCandidates>>["sb"],
  hits: Row[],
  question: string
): Promise<Row[]> {
  const q = question.replace(/\s+/g, " ").trim();
  const hints: string[] = [];

  if (/경조\s*휴가|경조휴가/.test(q)) hints.push("경조휴가", "경조 휴가", "경조");
  if (/안식년/.test(q)) hints.push("안식년");
  if (/화환/.test(q)) hints.push("화환");
  if (/프로젝트\s*수당|프로젝트수당/.test(q)) hints.push("프로젝트 수당", "프로젝트수당");

  const uniqHints = Array.from(new Set(hints)).filter(Boolean);
  if (!uniqHints.length) return hits;

  const ids = new Set<string>();
  for (const hint of uniqHints) {
    const { data } = await sb
      .from("documents")
      .select("id, filename")
      .ilike("filename", `%${hint}%`)
      .limit(20);

    for (const row of data ?? []) {
      if (row?.id) ids.add(row.id);
    }
  }

  if (!ids.size) return hits;
  const preferred = hits.filter((h) => ids.has(h.document_id));
  return preferred.length ? preferred : hits;
}

function normalizeLineKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/[\s:：·•()\[\]{}"'`]/g, "")
    .trim();
}

function dedupeAnswerLines(answer: string): string {
  const lines = answer.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  let inTable = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {

      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      inTable = true;
      out.push(line);
      continue;
    }

    if (inTable && /^[:\-\s|]+$/.test(line)) {
      out.push(line);
      continue;
    }

    if (inTable && !/^\|.*\|$/.test(line)) {
      inTable = false;
    }

    const key = normalizeLineKey(line);
    if (key.length >= 6 && seen.has(key)) continue;
    if (key.length >= 6) seen.add(key);
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeAnswer(answer: string): string {
  const normalized = (answer ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return dedupeAnswerLines(normalized);
}

function htmlTableToMarkdown(html: string): string {
  const rows = Array.from(html.matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((m) => m[0]);
  if (!rows.length) return "";

  const parsed = rows
    .map((row) =>
      Array.from(row.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)).map((m) =>
        (m[2] ?? "")
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/\|/g, "\\|")
          .replace(/\s+/g, " ")
          .trim()
      )
    )
    .filter((cells) => cells.some(Boolean));

  if (!parsed.length) return "";
  const width = Math.max(...parsed.map((r) => r.length));
  const normalized = parsed.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));

  const hasHeader = /<th[\s\S]*?>/i.test(rows[0]);
  const header = hasHeader ? normalized[0] : Array.from({ length: width }, (_, i) => `항목${i + 1}`);
  const body = hasHeader ? normalized.slice(1) : normalized;

  const head = `| ${header.join(" | ")} |`;
  const divider = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyLines = body.map((r) => `| ${r.join(" | ")} |`);

  return [head, divider, ...bodyLines].join("\n");
}

function ensureTableFirstAnswer(question: string, answer: string, evidence: Evidence[]): string {
  if (/^\|.*\|$/m.test(answer)) return answer;

  const shouldPreferTable = /(경조|기타\s*휴가|기타휴가|프로젝트\s*수당|프로젝트수당|기준|일수|종류)/.test(question);
  if (!shouldPreferTable) return answer;

  const table = evidence.find((e) => e.block_type === "table_html" && (e.content_html ?? "").trim());
  if (!table) return answer;

  const mdTable = htmlTableToMarkdown(table.content_html ?? "");
  if (!mdTable) return answer;

  return ["### 기준표", mdTable, answer].filter(Boolean).join("\n\n");
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

function applyCondolenceLeaveStrictFilter(question: string, hits: Row[]): Row[] {
  if (!/경조\s*휴가|경조휴가/.test(question)) return hits;

  const includeCore = /(경조\s*휴가|경조휴가|경조유형|조의|조문|부고|사망|결혼)/;
  const includeDays = /(\d+\s*일|휴가일수|일수|근속\s*2년|근속2년)/;
  const excludeNoise = /(안식년|선연차|프로젝트\s*수당|프로젝트수당|수당\s*정산|화환\s*신청|화환신청)/;

  const strict = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return includeCore.test(hay) && includeDays.test(hay) && !excludeNoise.test(hay);
  });
  if (strict.length) return strict;

  const coreOnly = hits.filter((h) => {
    const hay = `${h.text ?? ""}
${h.table_html ?? ""}`;
    return includeCore.test(hay) && !excludeNoise.test(hay);
  });

  return coreOnly.length ? coreOnly : hits;
}

function applyEtcLeaveStrictFilter(question: string, hits: Row[]): Row[] {
  const q = question.replace(/\s+/g, " ").trim();

  // "기타휴가" 또는 기타휴가 대표 키워드가 있는 경우
  const isEtc =
    /기타\s*휴가|기타휴가/.test(q) ||
    /(예비군|민방위|병역의무|직무\s*교육|교육\s*참석|병가)/.test(q);

  if (!isEtc) return hits;

  const includeEtc = /(기타|병역의무|민방위|예비군|직무\s*교육|교육\s*참석|병가|훈련\s*증명서|연차\s*차감\s*없음|사전\s*기안)/;
  const excludeCondolence = /(경조|결혼|조사|사망|부고|조의|조문|출산|조위금|경조금)/;

  // 기타휴가 관련 내용 + 경조 노이즈 제외
  const strict = hits.filter((h) => {
    const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
    return includeEtc.test(hay) && !excludeCondolence.test(hay);
  });
  if (strict.length) return strict;

  // 그래도 없으면: 기타 키워드만 포함된 블록 우선
  const etcOnly = hits.filter((h) => {
    const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
    return includeEtc.test(hay);
  });
  if (etcOnly.length) return etcOnly;

  // 마지막으로: 경조 노이즈만이라도 빼기
  const softened = hits.filter((h) => {
    const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
    return !excludeCondolence.test(hay);
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
    "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

  const terms = tokenize(question);
  const used0 = terms.length ? terms : [question];
  const used = expandQueryTerms(question, used0);

  const anchors = pickAnchors(used);

  const { sb, hits: rawHits0 } = await retrieveCandidates(question, used);
  const rawHits1 = await tryPreferDocumentHits(sb, rawHits0, preferredDocHint);
  const rawHits = await tryPreferTopicDocumentHits(sb, rawHits1, question);

  if (!rawHits.length) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }

  let hits = filterByAnchors(rawHits, anchors);
  if (!hits.length) hits = rawHits;

  if (/휴가/.test(intent)) {
    // ✅ table 블록(text=null)도 포함되도록 text + table_html 모두 검사
    const filtered = hits
      .filter((h: Row) => /휴가|연차|경조/.test(`${h.text ?? ""}
${h.table_html ?? ""}`))
      .filter((h: Row) => !/구독|OTT|넷플릭스|유튜브|리디북스|티빙/.test(`${h.text ?? ""}
${h.table_html ?? ""}`));
    if (filtered.length) hits = filtered;
  }

  hits = applyWreathSafetyFilter(question, hits);
  hits = applyCondolenceLeaveStrictFilter(question, hits);
  hits = applyEtcLeaveStrictFilter(question, hits);
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

  const llmAnswer = await refineAnswerWithLlm({
    question,
    draftAnswer: (draftedAnswer ?? "").trim(),
    intent,
    evidence: normalizedEvidence,
  });

  const rawAnswer = (llmAnswer ?? draftedAnswer ?? "").trim() || noResultFallback;
  const answer = normalizeAnswer(
    ensureTableFirstAnswer(question, rawAnswer, normalizedEvidence)
  );

  const evidenceUi = dedupeAndPrioritizeEvidence(normalizedEvidence, 12);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    llm_hits: normalizedEvidence.slice(0, 24),
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}
