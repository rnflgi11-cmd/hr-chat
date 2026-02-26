// src/lib/search/extract.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Evidence } from "./types";

/**
 * ✅ Evidence 기반 4계층 라우팅 (A/B/C/D) 고정 출력
 *
 * A) Row-Answer    : 표에서 단일 행 정답(일수/조건) 추출 + (해당 행) 표로 근거 제시
 * B) Table-Answer  : 표 전체/부분을 마크다운 표로 출력
 * C) Section-Answer: 섹션 단위 텍스트 출력 + 표는 표로
 * D) Text-Quote    : 위 실패 시 관련 문장 2~5줄 인용(요약 금지)
 *
 * ⚠️ index.ts 결합 유지:
 * - export function extractAnswerFromBlocks(...)
 * - 입력 evidence block_type: "p" | "table_html"
 * - table은 content_html 없으면 무조건 실패 처리(table_ok=false)
 */

type Hint = "days" | "list" | "criteria" | "unknown";

export type Extracted = {
  ok: boolean;
  route: "A" | "B" | "C" | "D";
  hint: Hint;
  answer_md: string;
};

function normalize(s: string) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function tokenizeLoose(q: string) {
  const s = normalize(q).toLowerCase();
  const toks = s.match(/[가-힣a-z0-9]+/g) ?? [];
  const stop = new Set(["은", "는", "이", "가", "을", "를", "에", "의", "과", "와", "및", "또는", "좀", "얼마", "며칠", "몇", "어떻게"]);
  return toks.filter((t) => t.length >= 2 && !stop.has(t));
}

function detectHint(question: string): Hint {
  const s = normalize(question).toLowerCase();
  if (/(며칠|몇일|일수|기간|days?)/i.test(s)) return "days";
  if (/(목록|리스트|종류|항목|전체|표로|table|리스트업)/i.test(s)) return "list";
  if (/(기준|조건|대상|절차|방법|신청|제출|서류|언제부터|시행일|프로세스)/i.test(s)) return "criteria";
  return "unknown";
}

/** -----------------------------
 * HTML TABLE -> Markdown Table
 * ----------------------------- */

function decodeEntitiesBasic(s: string) {
  return (s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s: string) {
  return normalize((s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

function parseHtmlTable(html: string): { headers: string[]; rows: string[][] } | null {
  const raw = (html || "").trim();
  if (!raw) return null;

  const trMatches = raw.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi);
  if (!trMatches || trMatches.length === 0) return null;

  const rows: string[][] = [];
  for (const tr of trMatches) {
    const cellMatches = tr.match(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
    if (!cellMatches.length) continue;

    const cells = cellMatches.map((c) => {
      const inner = c.replace(/^(<(td|th)\b[^>]*>)/i, "").replace(/<\/(td|th)>$/i, "");
      return normalize(decodeEntitiesBasic(stripTags(inner)));
    });

    if (cells.some((x) => x && x.trim().length > 0)) rows.push(cells);
  }

  if (!rows.length) return null;

  const firstHasTh = /<th\b/i.test(trMatches[0]);
  let headers = firstHasTh ? rows[0] : rows[0];
  let body = firstHasTh ? rows.slice(1) : rows.slice(1);

  const colCount = Math.max(1, headers.length);
  headers = headers.slice(0, colCount).map((h, i) => (h && h.trim() ? h : `컬럼${i + 1}`));

  body = body.map((r) => {
    const rr = r.slice(0, colCount);
    while (rr.length < colCount) rr.push("");
    return rr;
  });

  return { headers, rows: body };
}

function toMarkdownTable(t: { headers: string[]; rows: string[][] }) {
  const esc = (s: string) => (s || "").replace(/\|/g, "\\|");
  const head = `| ${t.headers.map(esc).join(" | ")} |`;
  const sep = `| ${t.headers.map(() => "---").join(" | ")} |`;
  const body = t.rows.map((r) => `| ${r.map(esc).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/** -----------------------------
 * Routing helpers
 * ----------------------------- */

function pickTopTableEvidence(evs: Evidence[]) {
  // content_html 없으면 “무조건 실패 처리” 규칙
  return evs.find((e) => e.block_type === "table_html" && !!e.content_html && e.table_ok !== false) ?? null;
}

function gatherTextEvidence(evs: Evidence[]) {
  return evs
    .filter((e) => e.block_type === "p" && !!e.content_text)
    .map((e) => ({ e, text: e.content_text as string }));
}

function scoreRow(row: string[], headers: string[], tokens: string[]) {
  const joined = normalize([...headers, ...row].join(" ")).toLowerCase();
  let sc = 0;
  for (const t of tokens) if (joined.includes(t)) sc += 3;
  if (/\d+\s*일/.test(joined) || /\b\d+\b/.test(joined)) sc += 1;
  if (joined.length < 10) sc -= 2;
  return sc;
}

function quoteLines(text: string, tokens: string[], min = 2, max = 5) {
  const lines = normalize(text)
    .split(/\n+/)
    .map(normalize)
    .filter(Boolean);

  if (!lines.length) return [];

  const picked: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    const hit = tokens.length === 0 ? i < max : tokens.some((t) => l.includes(t));
    if (!hit) continue;
    picked.push(lines[i]);
    used.add(i);
    if (picked.length >= max) break;
  }

  if (picked.length < min) {
    for (let i = 0; i < lines.length && picked.length < min; i++) {
      if (used.has(i)) continue;
      picked.push(lines[i]);
      used.add(i);
    }
  }

  return picked.slice(0, max);
}

/** -----------------------------
 * A) Row-Answer
 * ----------------------------- */
function routeA(question: string, evs: Evidence[]) {
  const tblEv = pickTopTableEvidence(evs);
  if (!tblEv) return null;

  const parsed = parseHtmlTable(tblEv.content_html!);
  if (!parsed) return null;

  const tokens = tokenizeLoose(question);

  let bestIdx = -1;
  let bestScore = -999;
  for (let i = 0; i < parsed.rows.length; i++) {
    const sc = scoreRow(parsed.rows[i], parsed.headers, tokens);
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 2) return null;

  const bestRow = parsed.rows[bestIdx];

  // daysValue 추출
  let daysValue: string | null = null;
  for (const c of bestRow) {
    const m = c.match(/(\d+)\s*일/);
    if (m) {
      daysValue = `${m[1]}일`;
      break;
    }
  }
  if (!daysValue) {
    for (const c of bestRow) {
      const m = c.match(/\b(\d+)\b/);
      if (m) {
        daysValue = `${m[1]}일`;
        break;
      }
    }
  }
  if (!daysValue) return null;

  // 근거 표(해당 행만)
  const oneRowMd = toMarkdownTable({ headers: parsed.headers, rows: [bestRow] });

  const answer_md =
    `규정 표 기준으로 해당 항목의 휴가/기간은 **${daysValue}** 입니다.\n\n` +
    `근거(해당 행):\n\n` +
    oneRowMd +
    `\n\n- 출처: ${tblEv.filename}`;

  return { answer_md };
}

/** -----------------------------
 * B) Table-Answer
 * ----------------------------- */
function routeB(_question: string, evs: Evidence[]) {
  const tblEv = pickTopTableEvidence(evs);
  if (!tblEv) return null;

  const parsed = parseHtmlTable(tblEv.content_html!);
  if (!parsed) return null;

  const maxRows = 30;
  const rows = parsed.rows.slice(0, maxRows);
  const md = toMarkdownTable({ headers: parsed.headers, rows });

  const more =
    parsed.rows.length > maxRows
      ? `\n\n(표가 길어 상위 ${maxRows}행까지만 표시했습니다. 전체가 필요하면 “전체 표 보여줘”라고 질문해 주세요.)`
      : "";

  const answer_md = `아래는 관련 규정 표입니다.\n\n${md}${more}\n\n- 출처: ${tblEv.filename}`;
  return { answer_md };
}

/** -----------------------------
 * C) Section-Answer
 * ----------------------------- */
function extractSections(text: string) {
  const lines = normalize(text).split(/\n+/).map(normalize).filter(Boolean);

  const isHeader = (l: string) =>
    /^(\d+\.\s+|[가-힣]\.\s+|■\s*|◆\s*|▶\s*|※\s*|\[[^\]]+\]\s*)/.test(l) ||
    /(시행일|대상|절차|방법|신청|서류|기준|조건)\s*[:：]/.test(l);

  const toTitle = (l: string) =>
    l
      .replace(/^(\d+\.\s+|[가-힣]\.\s+|■\s*|◆\s*|▶\s*|※\s*)/, "")
      .replace(/[:：]\s*$/, "")
      .trim();

  const sections: { title: string; body: string[] }[] = [];
  let curTitle = "관련 내용";
  let curBody: string[] = [];

  for (const l of lines) {
    if (isHeader(l) && curBody.length > 0) {
      sections.push({ title: curTitle, body: curBody });
      curTitle = toTitle(l) || "관련 내용";
      curBody = [];
      continue;
    }
    if (isHeader(l) && curBody.length === 0) {
      curTitle = toTitle(l) || curTitle;
      continue;
    }
    curBody.push(l);
  }
  if (curBody.length) sections.push({ title: curTitle, body: curBody });

  // 너무 많으면 합치기
  if (sections.length > 8) {
    const head = sections.slice(0, 6);
    const tail = sections.slice(6).flatMap((s) => [`[${s.title}]`, ...s.body]);
    head.push({ title: "추가 관련 내용", body: tail });
    return head;
  }

  return sections;
}

function routeC(question: string, evs: Evidence[]) {
  const texts = gatherTextEvidence(evs);
  if (!texts.length) return null;

  const tokens = tokenizeLoose(question);

  // 상위 2개 텍스트만 사용 (너무 길어지는 것 방지 + 안정)
  const top = texts.slice(0, 2);

  const blocks: string[] = [];
  const sources = new Set<string>();

  for (const t of top) {
    const sections = extractSections(t.text);

    const scored = sections
      .map((s) => {
        const joined = normalize([s.title, ...s.body].join(" ")).toLowerCase();
        const sc = tokens.reduce((acc, tok) => (joined.includes(tok) ? acc + 2 : acc), 0);
        return { s, sc };
      })
      .sort((a, b) => b.sc - a.sc);

    const picked = scored.slice(0, 4).map((x) => x.s);

    for (const s of picked) {
      const body = s.body.slice(0, 12).join("\n");
      blocks.push(`### ${s.title}\n${body}`);
    }

    sources.add(t.e.filename);
  }

  if (!blocks.length) return null;

  // 표가 있으면 표는 표로 추가
  let tableAppend = "";
  const tblEv = pickTopTableEvidence(evs);
  if (tblEv) {
    const parsed = parseHtmlTable(tblEv.content_html!);
    if (parsed) {
      const rows = parsed.rows.slice(0, 20);
      const md = toMarkdownTable({ headers: parsed.headers, rows });
      tableAppend = `\n\n---\n\n### 관련 표\n\n${md}\n\n- 표 출처: ${tblEv.filename}`;
    }
  }

  const answer_md =
    `아래는 질문과 관련된 규정 내용을 **섹션 단위로** 제공합니다.\n\n` +
    blocks.join("\n\n") +
    `\n\n- 출처: ${Array.from(sources).join(", ")}` +
    tableAppend;

  return { answer_md };
}

/** -----------------------------
 * D) Text-Quote (요약 금지)
 * ----------------------------- */
function routeD(question: string, evs: Evidence[]) {
  const texts = gatherTextEvidence(evs);
  const tokens = tokenizeLoose(question);

  if (!texts.length) {
    return {
      answer_md:
        `죄송합니다. 현재 검색된 근거에서 질문에 답할 만한 문장을 안정적으로 찾지 못했습니다.\n\n` +
        `가능하면 질문을 조금 더 구체적으로(대상/상황/키워드 포함) 다시 입력해 주세요.`,
    };
  }

  // 가장 관련 높은 text 선택
  let best = texts[0];
  let bestScore = -999;

  for (const t of texts.slice(0, 6)) {
    const joined = normalize(t.text).toLowerCase();
    let sc = 0;
    for (const tok of tokens) if (joined.includes(tok)) sc += 3;
    if (t.text.length > 80) sc += 1;
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }

  const lines = quoteLines(best.text, tokens, 2, 5);
  const quote = lines.map((l) => `> ${l}`).join("\n");

  return {
    answer_md: `아래는 관련 근거 문장 인용입니다(요약 없이 원문 문장 기반).\n\n${quote}\n\n- 출처: ${best.e.filename}`,
  };
}

/**
 * ✅ index.ts에서 쓰는 엔트리포인트 (이 이름/형태 유지 필수)
 */
export function extractAnswerFromBlocks(question: string, evidenceAll: Evidence[]): Extracted {
  const hint = detectHint(question);
  const evs = Array.isArray(evidenceAll) ? evidenceAll : [];

  const hasOkTable = !!pickTopTableEvidence(evs);

  // 1) A: days 힌트 + table + 단일행에서 일수 추출 가능
  if (hint === "days" && hasOkTable) {
    const a = routeA(question, evs);
    if (a) return { ok: true, route: "A", hint, answer_md: a.answer_md };
  }

  // 2) B: list 힌트 + table
  if (hint === "list" && hasOkTable) {
    const b = routeB(question, evs);
    if (b) return { ok: true, route: "B", hint, answer_md: b.answer_md };
  }

  // 3) C: criteria or unknown (섹션 가능성) — text 섹션 + table은 표로
  if (hint === "criteria" || hint === "unknown") {
    const c = routeC(question, evs);
    if (c) return { ok: true, route: "C", hint, answer_md: c.answer_md };
  }

  // 4) B(보조): unknown인데 table만 강하게 잡히면 표 출력
  if (hasOkTable) {
    const b2 = routeB(question, evs);
    if (b2) return { ok: true, route: "B", hint, answer_md: b2.answer_md };
  }

  // 5) D: 최후 — 2~5줄 인용(요약 금지)
  const d = routeD(question, evs);
  return { ok: true, route: "D", hint, answer_md: d.answer_md };
}