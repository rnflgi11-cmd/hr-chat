import { retrieveCandidates } from "./retrieve";
import { pickAnchors, tokenize } from "./query";
import { applyTopicFilter, buildTopicQueryTerms, classifyTopic, type TopicProfile } from "./router";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer, Evidence, Row } from "./types";
import { getLlmRuntimeInfo, refineAnswerWithLlm } from "@/lib/llm";

type QuestionType = "direct" | "list" | "explain";

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
  topicHints: string[]
): Promise<Row[]> {
  const uniqHints = Array.from(new Set(topicHints)).filter(Boolean);
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
  const headerHint = /(구분|유형|대상|기준|절차|일수|휴가일수|수당|비고|항목|서류|조건|요건)/;
  const firstRowLooksLikeHeader = !hasHeader && normalized[0]?.some((c) => headerHint.test(c ?? ""));

  const header = hasHeader
    ? normalized[0]
    : firstRowLooksLikeHeader
      ? normalized[0]
      : Array.from({ length: width }, (_, i) => `컬럼${i + 1}`);

  const body = hasHeader || firstRowLooksLikeHeader ? normalized.slice(1) : normalized;

  const head = `| ${header.join(" | ")} |`;
  const divider = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyLines = body.map((r) => `| ${r.join(" | ")} |`);

  return [head, divider, ...bodyLines].join("\n");
}

function removeRepeatedListBelowTable(answer: string): string {
  const lines = answer.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    if (/^[\-•]?\s*[^\n]{1,60}\s*[—–-]\s*[^\n]+$/.test(t)) continue;
    if ((t.match(/[—–-]/g) ?? []).length >= 2 && t.length <= 120) continue;
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function enrichTooShortAnswer(answer: string, fallbackDetailed: string, preferTable: boolean, evidence: Evidence[]): string {
  const compact = (answer ?? "").replace(/\s+/g, " ").trim();
  const nonTableLines = (answer ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x && !/^\|.*\|$/.test(x) && !/^[:\-\s|]+$/.test(x));

  const tooShort = compact.length < 80 || nonTableLines.length <= 1;
  if (!tooShort) return answer;

  const detailed = (fallbackDetailed ?? "").trim();
  if (!detailed) return answer;

  return normalizeAnswer(ensureTableFirstAnswer(preferTable, detailed, evidence));
}

function shouldUseSummaryFallback(answer: string, llmApplied: boolean): boolean {
  const compact = (answer ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return true;
  if (compact.length < 20) return true;
  if (compact.length < 40) return true;
  if (!llmApplied && compact.length < 56) return true;
  return false;
}

function hasOnlyTable(answer: string): boolean {
  const lines = (answer ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return true;
  const nonTable = lines.filter((x) => !/^\|.*\|$/.test(x) && !/^[:\-\s|]+$/.test(x));
  return nonTable.length <= 1;
}

function normalizeLooseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[|,:：·•()\[\]{}"'`.-]/g, "")
    .trim();
}

function removeTableEchoLines(answer: string, markdownTable: string): string {
  const tableLines = markdownTable
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => /^\|.*\|$/.test(x) && !/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/.test(x));

    const tableCells = new Set(
    tableLines
      .flatMap((line) => line.split("|").map((x) => normalizeLooseText(x)))
      .filter((x) => x.length >= 2)
  );

  if (!tableCells.size) return answer;

    const out: string[] = [];
  for (const raw of answer.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (/^#{1,4}\s/.test(line) || /^[-*]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
      out.push(raw);
      continue;
    }

    const key = normalizeLooseText(line);
    if (!key) continue;
    const matched = Array.from(tableCells).filter((cell) => key.includes(cell) || cell.includes(key)).length;
    if (matched >= 2) continue;

     out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ensureTableFirstAnswer(preferTable: boolean, answer: string, evidence: Evidence[]): string {
  if (!preferTable) return answer;

  if (/^\|.*\|$/m.test(answer)) {
    const tableBlock = answer
      .split("\n")
      .filter((line) => /^\|.*\|$/.test(line.trim()))
      .join("\n");
    if (!tableBlock) return answer;
    return removeTableEchoLines(removeRepeatedListBelowTable(answer), tableBlock);
  }

  const table = evidence.find((e) => e.block_type === "table_html" && (e.content_html ?? "").trim());
  if (!table) return answer;

  const mdTable = htmlTableToMarkdown(table.content_html ?? "");
  if (!mdTable) return answer;

  const cleanedAnswer = removeTableEchoLines(removeRepeatedListBelowTable(answer), mdTable);
  return ["### 기준표", mdTable, cleanedAnswer].filter(Boolean).join("\n\n");
}

function applyLeaveDaysSafetyFilter(question: string, hits: Row[]): Row[] {
  if (!/(며칠|몇\s*일|일수|기간)/.test(question)) return hits;
  if (!/(경조|경조\s*휴가|휴가)/.test(question)) return hits;

  const withDays = hits.filter((h) => {
  const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
    return /(\d+\s*일|휴가일수|일수|근속\s*2년|근속2년)/.test(hay);
  });
  if (withDays.length) return withDays;

  const withoutCautionOnly = hits.filter((h) => {
    const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
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

function dedupeAndPrioritizeEvidence(evs: Evidence[], max = 12): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();

  for (const e of evs) {
    const key = e.block_type === "table_html"
      ? (e.content_html ?? "").replace(/\s+/g, " ").trim()
      : (e.content_text ?? "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }

  return out;
}

function detectQuestionType(question: string): QuestionType {
  if (/(종류|목록|리스트|항목|무엇이|뭐가|알려줘)/.test(question)) return "list";
  if (/(기준|조건|요건|절차|방법|왜|설명)/.test(question)) return "explain";
  return "direct";
}

function toKeywords(question: string, topic: TopicProfile): string[] {
  return Array.from(new Set([
    ...tokenize(question),
    ...tokenize(topic.queryTerms.join(" ")),
  ])).filter((x) => x.length >= 2);
}

function filterEvidenceForQuestion(evidence: Evidence[], question: string, topic: TopicProfile): Evidence[] {
  const include = topic.answerInclude ?? topic.include;
  const exclude = topic.answerExclude ?? topic.exclude;
  const keys = toKeywords(question, topic);

  const scored = evidence.map((e) => {
    const body = e.block_type === "table_html"
      ? (e.content_html ?? "")
      : (e.content_text ?? "");
    let score = 0;
    const plain = body.replace(/<[^>]+>/g, " ");
    if (include?.test(plain)) score += 8;
    if (exclude?.test(plain)) score -= 10;
    for (const k of keys) if (plain.toLowerCase().includes(k.toLowerCase())) score += 2;
    if (/문의|담당|연락처|참고|안내\s*문|본\s*규정/.test(plain)) score -= 3;
    if (/(기타휴가|경조|안식년|프로젝트\s*수당)/.test(question) && !include?.test(plain)) score -= 2;
    return { e, score };
  });

  const filtered = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);

  return filtered.length ? filtered : evidence;
}

async function buildSupplementalEvidenceFromHits(
  sb: Awaited<ReturnType<typeof retrieveCandidates>>["sb"],
  hits: Row[],
  scoreRow: (h: Row) => number,
  maxDocs = 4,
  maxBlocks = 48
): Promise<Evidence[]> {
  const scored = hits
    .map((h) => ({ h, score: scoreRow(h) }))
    .sort((a, b) => b.score - a.score);

  const docIds = Array.from(new Set(scored.map((x) => x.h.document_id))).slice(0, maxDocs);
  if (!docIds.length) return [];

  const { data: docs } = await sb.from("documents").select("id, filename").in("id", docIds);
  const nameById = new Map((docs ?? []).map((d) => [d.id, d.filename || "Unknown"]));

  const selected = scored
    .filter((x) => docIds.includes(x.h.document_id))
    .slice(0, maxBlocks)
    .map((x) => x.h)
    .sort((a, b) => a.block_index - b.block_index);

  return selected.map((h) => ({
    filename: nameById.get(h.document_id) ?? "Unknown",
    block_type: (h.kind ?? "").toLowerCase().includes("table") ? "table_html" : "p",
    content_text: h.text,
    content_html: h.table_html,
    table_ok: Boolean(h.table_html),
  }));
}

function lineScoreForQuestion(line: string, question: string): number {
  const qTerms = tokenize(question).filter((t) => t.length >= 2);
  const hay = line.toLowerCase();
  let score = 0;
  for (const t of qTerms) {
    if (hay.includes(t.toLowerCase())) score += 3;
  }
  if (/일수|기준|절차|신청|대상|유효기간|첨부서류|비고/.test(line)) score += 2;
  if (/문의|담당|연락처/.test(line)) score -= 2;
  return score;
}

function buildTopicDraftAnswer(topic: TopicProfile, question: string, evidence: Evidence[]): string {
  const table = evidence.find((e) => e.block_type === "table_html" && (e.content_html ?? "").trim());
  const mdTable = table ? htmlTableToMarkdown(table.content_html ?? "") : "";

  const include = topic.answerInclude ?? topic.include ?? /./;
  const exclude = topic.answerExclude ?? topic.exclude;
  const lines = evidence
    .filter((e) => e.block_type === "p")
    .map((e) => (e.content_text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => include.test(line) && !(exclude?.test(line) ?? false))
    .filter((line) => !/^(📌|✅|■|\[).*$/.test(line))
    .map((line) => line.replace(/^[•●◊✅📌■]\s*/, ""))
    .filter((line) => line.length >= 4)
    .filter((line) => !/^문의[:：]?/.test(line))
    .filter((line) => !/^\[.*\]$/.test(line))
    .map((line) => ({ line, score: lineScoreForQuestion(line, question) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topic.maxBullets)
    .map((x) => x.line);

  const lead = lines[0]
    ? `핵심은 ${lines[0]}`
    : `${topic.intent} 기준은 사내 규정 근거로 확인됩니다.`;
  const support = lines.slice(1, 5).map((line) => `- ${line}`).join("\n");

  return [lead, support, mdTable ? `참고 가능한 기준표입니다.\n${mdTable}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export async function searchAnswer(q: string): Promise<SearchAnswer> {
  const { cleanedQuestion, preferredDocHint } = parseQuestionContext(q);
  const question = cleanedQuestion || q;
  const topic = classifyTopic(question);
  const intent = topic.intent;
  
  const annualLeave = tryAnnualLeaveEstimator(question);
  if (annualLeave) return annualLeave;

  const noResultFallback =
    "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

  const terms = tokenize(question);
  const used0 = terms.length ? terms : [question];
  const used = buildTopicQueryTerms(question, used0, topic);
  const anchors = pickAnchors(used);

  const { sb, hits: rawHits0 } = await retrieveCandidates(question, used);
  const rawHits1 = await tryPreferDocumentHits(sb, rawHits0, preferredDocHint);
  const rawHits = await tryPreferTopicDocumentHits(sb, rawHits1, topic.docHints);

  if (!rawHits.length) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }

  let hits = filterByAnchors(rawHits, anchors);
  if (!hits.length) hits = rawHits;

  hits = applyTopicFilter(hits, topic);
  if (topic.key === "condolence_leave") hits = applyLeaveDaysSafetyFilter(question, hits);

  const scoreRow = makeScorer({ q: question, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);
  if (!bestDocId) {
    return { ok: true, answer: noResultFallback, hits: [], meta: { intent } };
  }

  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, bestDocId, hits, scoreRow });

  const windowEvidence = toEvidence(doc.filename, ctx);
  const supplementalEvidence = await buildSupplementalEvidenceFromHits(sb, hits, scoreRow, 4, 60);
  const evidenceAll = [...windowEvidence, ...supplementalEvidence];
  const normalizedEvidence = evidenceAll.map((e) => ({ ...e, table_ok: e.table_ok ?? false }));

  const questionType = detectQuestionType(question);
  const selectedEvidence = filterEvidenceForQuestion(normalizedEvidence, question, topic);

  const fallbackDraft = buildTopicDraftAnswer(topic, question, selectedEvidence) || buildSummary(intent, selectedEvidence, question);

const llmRuntime = getLlmRuntimeInfo();

const llmResult = await refineAnswerWithLlm({
  question,
  intent,
  questionType,
  evidence: selectedEvidence,
  fallbackDraft: fallbackDraft.trim(),
});

  const llmAnswer = llmResult?.answer ?? null;

  const llmApplied = Boolean(
    llmAnswer &&
      llmAnswer.trim() &&
      llmResult?.reason === "applied" &&
      llmRuntime.enabled &&
      llmRuntime.hasApiKey
);

  const rawAnswer = (llmAnswer ?? "").trim() || fallbackDraft || noResultFallback;
  const normalized0 = normalizeAnswer(
    questionType === "list" ? ensureTableFirstAnswer(topic.preferTable, rawAnswer, selectedEvidence) : rawAnswer
  );
  const normalized = hasOnlyTable(normalized0)
    ? normalizeAnswer([buildSummary(intent, selectedEvidence, question), normalized0].filter(Boolean).join("\n\n"))
    : normalized0;
  const detailedFallback = buildSummary(intent, selectedEvidence, question);
  const answer = shouldUseSummaryFallback(normalized, llmApplied)
    ? enrichTooShortAnswer(normalized, detailedFallback, questionType === "list" && topic.preferTable, selectedEvidence)
    : normalized;

  const evidenceUi = dedupeAndPrioritizeEvidence(selectedEvidence, 16);

  return {
    ok: true,
    answer,
    hits: evidenceUi,
    llm_hits: selectedEvidence.slice(0, 40),
    meta: {
      intent,
      best_doc_id: bestDocId,
      best_filename: doc.filename,
      llm_enabled: llmRuntime.enabled,
      llm_has_api_key: llmRuntime.hasApiKey,
      llm_model: llmRuntime.model,
      llm_applied: llmApplied,
      llm_reason: llmResult?.reason,
      llm_status: llmResult?.status,
      llm_error: llmResult?.error,
      build_ref: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.NODE_ENV,
    },
  };
}