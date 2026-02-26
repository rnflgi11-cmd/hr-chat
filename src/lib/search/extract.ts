// src/lib/search/extract.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Evidence } from "./types";

type Hint = "days" | "list" | "criteria" | "unknown";

export type Extracted = {
  ok: boolean;
  route: "A" | "B" | "C" | "D";
  hint: Hint;
  answer_md: string;
};

function norm(s: string) {
  return (s || "").replace(/\r/g, "").trim();
}

function detectHint(q: string): Hint {
  const s = norm(q);
  if (/(며칠|몇일|일수|기간)/.test(s)) return "days";
  if (/(목록|리스트|종류|항목|전체|표로)/.test(s)) return "list";
  if (/(기준|조건|대상|절차|방법|신청|서류|시행일)/.test(s)) return "criteria";
  return "unknown";
}

function tokens(q: string) {
  const s = norm(q).toLowerCase();
  const toks = s.match(/[가-힣a-z0-9]+/g) ?? [];
  const stop = new Set(["은","는","이","가","을","를","에","의","과","와","및","또는","좀","얼마","며칠","몇","어떻게"]);
  return toks.filter(t => t.length >= 2 && !stop.has(t));
}

/** -------------------------
 * Markdown table helpers
 * ------------------------- */
function mdTable(headers: string[], rows: string[][]) {
  const esc = (x: string) => (x || "").replace(/\|/g, "\\|");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(r => `| ${r.map(esc).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/** -------------------------
 * HTML table parser (기존 방식)
 * ------------------------- */
function decodeEntitiesBasic(s: string) {
  return (s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function stripTags(s: string) {
  return norm((s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}
function parseHtmlTable(html: string): { headers: string[]; rows: string[][] } | null {
  const raw = (html || "").trim();
  if (!raw) return null;

  const trs = raw.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi);
  if (!trs?.length) return null;

  const rows: string[][] = [];
  for (const tr of trs) {
    const cells = tr.match(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
    if (!cells.length) continue;
    const vals = cells.map(c => {
      const inner = c.replace(/^(<(td|th)\b[^>]*>)/i, "").replace(/<\/(td|th)>$/i, "");
      return norm(decodeEntitiesBasic(stripTags(inner)));
    });
    if (vals.some(v => v)) rows.push(vals);
  }
  if (!rows.length) return null;

  const firstHasTh = /<th\b/i.test(trs[0]);
  const headers = rows[0].map(h => h || "");
  const body = firstHasTh ? rows.slice(1) : rows.slice(1);

  const colCount = Math.max(1, headers.length);
  const H = headers.slice(0, colCount).map((h,i)=> (h.trim()?h:`컬럼${i+1}`));
  const R = body.map(r => {
    const rr = r.slice(0,colCount);
    while (rr.length < colCount) rr.push("");
    return rr;
  });

  return { headers: H, rows: R };
}

/** -------------------------
 * ✅ NEW: “줄로 풀린 표 텍스트” 복원 파서
 *  - 예: 구분/경조유형/대상/휴가일수/첨부서류/비고 가 줄로 나오면
 *        이후 N개씩 끊어서 행으로 재구성
 * ------------------------- */
const KNOWN_HEADERS = [
  "구분",
  "경조유형",
  "대상",
  "휴가일수",
  "첨부서류",
  "비고",
];

function parseFlatTableFromText(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = norm(text)
    .split(/\n+/)
    .map(l => norm(l).replace(/^[•\-–—]\s*/,"")) // bullet 제거
    .filter(Boolean);

  if (!lines.length) return null;

  // 헤더 시작 위치 찾기: KNOWN_HEADERS가 연속으로 등장하는 구간
  for (let i = 0; i < lines.length; i++) {
    // i부터 헤더를 뽑아보기
    const maybe = lines.slice(i, i + KNOWN_HEADERS.length);
    // 완전 일치 또는 포함 일치 허용
    const ok = KNOWN_HEADERS.every((h, idx) => (maybe[idx] || "").includes(h));
    if (!ok) continue;

    const headers = KNOWN_HEADERS.slice(); // 고정 6컬럼
    const colCount = headers.length;

    const rest = lines.slice(i + colCount);
    // rest를 colCount 단위로 끊어서 행 구성
    const rows: string[][] = [];
    for (let j = 0; j + colCount - 1 < rest.length; j += colCount) {
      const row = rest.slice(j, j + colCount);
      // 중간에 또 헤더가 나오면 종료
      if (row[0]?.includes("구분") && row[1]?.includes("경조")) break;
      // 너무 빈 행은 스킵
      if (!row.some(x => x && x.trim())) continue;
      rows.push(row);
      // 안전장치: 너무 길면 컷
      if (rows.length >= 60) break;
    }

    if (rows.length) return { headers, rows };
  }

  return null;
}

/** -------------------------
 * Evidence helpers
 * ------------------------- */
function topTableEvidence(evs: Evidence[]) {
  // table_html + content_html 있으면 우선
  return evs.find(e => e.block_type === "table_html" && !!(e as any).content_html && (e as any).table_ok !== false) ?? null;
}
function textEvidence(evs: Evidence[]) {
  return evs
    .filter(e => e.block_type === "p" && !!(e as any).content_text)
    .map(e => ({ e, text: (e as any).content_text as string }));
}

function rowScore(headers: string[], row: string[], qToks: string[]) {
  const joined = norm([...headers, ...row].join(" ")).toLowerCase();
  let sc = 0;
  for (const t of qToks) if (joined.includes(t)) sc += 3;
  if (/\d+\s*일/.test(joined) || /\b\d+\b/.test(joined)) sc += 1;
  return sc;
}

function pickBestRow(t: { headers: string[]; rows: string[][] }, question: string) {
  const qToks = tokens(question);
  let bestIdx = -1;
  let bestSc = -999;
  for (let i=0;i<t.rows.length;i++){
    const sc = rowScore(t.headers, t.rows[i], qToks);
    if (sc > bestSc) { bestSc = sc; bestIdx = i; }
  }
  return bestIdx >= 0 ? { idx: bestIdx, score: bestSc, row: t.rows[bestIdx] } : null;
}

function extractDaysFromRow(headers: string[], row: string[]) {
  // 휴가일수 컬럼 우선
  const idx = headers.findIndex(h => h.includes("휴가일수"));
  if (idx >= 0 && row[idx]) {
    const c = row[idx];
    const m = c.match(/(\d+)\s*일/);
    if (m) return `${m[1]}일`;
    const n = c.match(/\b(\d+)\b/);
    if (n) return `${n[1]}일`;
  }
  // fallback: 전체 셀에서 찾기
  for (const c of row) {
    const m = c.match(/(\d+)\s*일/);
    if (m) return `${m[1]}일`;
  }
  for (const c of row) {
    const n = c.match(/\b(\d+)\b/);
    if (n) return `${n[1]}일`;
  }
  return null;
}

/** -------------------------
 * Routing
 * ------------------------- */
function routeA(question: string, evs: Evidence[]) {
  // 1) HTML table 우선
  const tEv = topTableEvidence(evs);
  if (tEv) {
    const t = parseHtmlTable((tEv as any).content_html);
    if (t) {
      const best = pickBestRow(t, question);
      if (best && best.score >= 2) {
        const days = extractDaysFromRow(t.headers, best.row);
        if (days) {
          const one = mdTable(t.headers, [best.row]);
          return {
            answer_md:
              `규정 표 기준으로 해당 항목의 휴가/기간은 **${days}** 입니다.\n\n` +
              `근거(해당 행):\n\n${one}\n\n- 출처: ${tEv.filename}`,
          };
        }
      }
    }
  }

  // 2) ✅ fallback: “줄로 풀린 표” 텍스트에서 복원
  const texts = textEvidence(evs);
  for (const te of texts.slice(0, 6)) {
    const t = parseFlatTableFromText(te.text);
    if (!t) continue;
    const best = pickBestRow(t, question);
    if (!best || best.score < 1) continue; // 텍스트표는 임계 완화
    const days = extractDaysFromRow(t.headers, best.row);
    if (!days) continue;

    const one = mdTable(t.headers, [best.row]);
    return {
      answer_md:
        `경조휴가는 사유에 따라 다릅니다. 질문과 가장 관련된 항목 기준으로 **${days}** 입니다.\n\n` +
        `근거(해당 행):\n\n${one}\n\n- 출처: ${te.e.filename}`,
    };
  }

  return null;
}

function routeB(_question: string, evs: Evidence[]) {
  // 1) HTML table 우선
  const tEv = topTableEvidence(evs);
  if (tEv) {
    const t = parseHtmlTable((tEv as any).content_html);
    if (t) {
      const rows = t.rows.slice(0, 30);
      return {
        answer_md:
          `경조휴가는 사유별로 상이합니다. 아래 표를 확인해 주세요.\n\n` +
          `${mdTable(t.headers, rows)}\n\n- 출처: ${tEv.filename}`,
      };
    }
  }

  // 2) ✅ fallback: 텍스트에서 표 복원
  const texts = textEvidence(evs);
  for (const te of texts.slice(0, 6)) {
    const t = parseFlatTableFromText(te.text);
    if (!t) continue;
    const rows = t.rows.slice(0, 30);
    return {
      answer_md:
        `경조휴가는 사유별로 상이합니다. 아래 표를 확인해 주세요.\n\n` +
        `${mdTable(t.headers, rows)}\n\n- 출처: ${te.e.filename}`,
    };
  }

  return null;
}

function routeD(question: string, evs: Evidence[]) {
  const qToks = tokens(question);
  const texts = textEvidence(evs);

  if (!texts.length) {
    return {
      answer_md:
        `죄송합니다. 현재 검색된 근거에서 질문에 답할 만한 문장을 안정적으로 찾지 못했습니다.\n` +
        `질문을 조금 더 구체적으로(대상/상황/키워드 포함) 다시 입력해 주세요.`,
    };
  }

  // 관련 라인 2~5줄 인용
  let best = texts[0];
  let bestSc = -999;
  for (const t of texts.slice(0, 6)) {
    const joined = norm(t.text).toLowerCase();
    let sc = 0;
    for (const tok of qToks) if (joined.includes(tok)) sc += 3;
    if (sc > bestSc) { bestSc = sc; best = t; }
  }

  const lines = norm(best.text)
    .split(/\n+/)
    .map(l => norm(l))
    .filter(Boolean);

  const picked: string[] = [];
  for (const l of lines) {
    const lo = l.toLowerCase();
    if (qToks.length === 0 || qToks.some(t => lo.includes(t))) {
      picked.push(l);
      if (picked.length >= 5) break;
    }
  }
  while (picked.length < 2 && picked.length < lines.length) picked.push(lines[picked.length]);

  const quote = picked.slice(0, 5).map(l => `> ${l}`).join("\n");
  return { answer_md: `아래는 관련 근거 문장 인용입니다(요약 없이 원문 문장 기반).\n\n${quote}\n\n- 출처: ${best.e.filename}` };
}

/**
 * ✅ index.ts가 호출하는 엔트리포인트 유지
 */
export function extractAnswerFromBlocks(question: string, evidenceAll: Evidence[]): Extracted {
  const hint = detectHint(question);
  const evs = Array.isArray(evidenceAll) ? evidenceAll : [];

  // A: days 질문이면 우선 행정답 시도
  if (hint === "days") {
    const a = routeA(question, evs);
    if (a) return { ok: true, route: "A", hint, answer_md: a.answer_md };
    // 행정답 실패하면 표라도 보여주기(B)
    const b = routeB(question, evs);
    if (b) return { ok: true, route: "B", hint, answer_md: b.answer_md };
  }

  // list면 표 우선
  if (hint === "list") {
    const b = routeB(question, evs);
    if (b) return { ok: true, route: "B", hint, answer_md: b.answer_md };
  }

  // criteria/unknown: 표가 있으면 표, 없으면 인용
  const b2 = routeB(question, evs);
  if (b2) return { ok: true, route: "B", hint, answer_md: b2.answer_md };

  const d = routeD(question, evs);
  return { ok: true, route: "D", hint, answer_md: d.answer_md };
}