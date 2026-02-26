// src/lib/search/extract.ts
import "server-only";
import type { Evidence } from "./types";

/**
 * index.ts는 extractAnswerFromBlocks(question, evidenceAll)을 호출한다.
 * evidenceAll 타입은 ./types Evidence[] 를 그대로 사용.
 *
 * 출력 정책:
 * - days: 단일 항목이면 "일수 + (맥락)"으로
 * - list: 표를 요약 목록으로
 * - criteria: 섹션형이면 섹션 답, 아니면 단일 행 기준 답
 * - 실패: FALLBACK
 */

export type QuestionKind = "days" | "list" | "criteria" | "unknown";

export type ExtractResult = {
  ok: boolean;
  type: QuestionKind;
  answer_md: string;
  used?: { filename?: string; row_text?: string; row?: Record<string, string> };
};

const FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀으로 문의해 주시기 바랍니다.";

/** ===== 질문 타입 3종(힌트용) ===== */
function classifyQuestion(q: string): QuestionKind {
  const s = normalizeText(q);
  if (/(종류|목록|리스트|항목|구분|전체|뭐가|뭐야|어떤)/.test(s) && /휴가/.test(s)) return "list";
  if (/(기준|조건|대상|첨부|서류|신청|비고|정의|절차|방법|시행일)/.test(s)) return "criteria";
  if (/(며칠|몇\s*일|일수|기간)/.test(s)) return "days";
  return "unknown";
}

/** ===== 텍스트 유틸 ===== */
function normalizeText(s: string): string {
  return (s ?? "")
    .replace(/\r/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function compact(s: string): string {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[\s\.,;:()\[\]{}<>/\\|"'!?~`@#$%^&*_+=-]/g, "");
}

const KOREAN_STOP = new Set([
  "은","는","이","가","을","를","에","에서","로","으로","과","와","및","또는","혹은",
  "좀","몇","며칠","일","수","알려줘","알려","궁금","해줘","나요","인가","어떻게",
  "기준","종류","목록","해당","관련","내용","규정","휴가",
]);

function tokenizeKo(q: string): string[] {
  const base = normalizeText(q);
  const rough = base.split(/[\s/]+/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const t of rough) {
    const tt = t.replace(/[^\p{L}\p{N}]+/gu, "").trim().toLowerCase();
    if (!tt) continue;
    if (KOREAN_STOP.has(tt)) continue;
    out.push(tt);
  }
  return Array.from(new Set(out));
}

function normalizeEventKeywords(q: string): string[] {
  const s = normalizeText(q);
  const keys: string[] = [];

  if (/경조/.test(s)) keys.push("경조");
  if (/부고|조의|조문|사망|돌아가|별세|상(을)?\s*당/.test(s)) keys.push("사망");

  if (/외할머니|외조모/.test(s)) keys.push("외조모");
  if (/외할아버지|외조부/.test(s)) keys.push("외조부");
  if (/할머니|조모/.test(s)) keys.push("조모");
  if (/할아버지|조부/.test(s)) keys.push("조부");
  if (/부모|아버지|어머니|부친|모친/.test(s)) keys.push("부모");
  if (/배우자|남편|아내|부인|처/.test(s)) keys.push("배우자");
  if (/자녀|아들|딸/.test(s)) keys.push("자녀");
  if (/형제|자매|형|동생|오빠|누나|언니/.test(s)) keys.push("형제자매");

  if (/본인.*결혼|결혼휴가|내.*결혼/.test(s)) keys.push("본인결혼");
  if (/자녀.*결혼/.test(s)) keys.push("자녀결혼");
  if (/배우자.*출산|아내.*출산|와이프.*출산|부인.*출산/.test(s)) keys.push("배우자출산");
  if (/출산휴가/.test(s)) keys.push("출산휴가");

  if (/예비군|민방위/.test(s)) keys.push("예비군민방위");
  if (/직무\s*교육|교육\s*참석|세미나|워크숍/.test(s)) keys.push("직무교육");
  if (/병가|질병|부상|진단서/.test(s)) keys.push("병가");
  if (/공가/.test(s)) keys.push("공가");

  return Array.from(new Set(keys));
}

/** ===== HTML table 파서 (cheerio 없이) ===== */
function decodeHtmlEntities(s: string): string {
  return (s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
function stripTags(html: string): string {
  const br = (html ?? "").replace(/<br\s*\/?>/gi, " ");
  const no = br.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(no);
}
function getAttrInt(attrs: string, name: string, def = 1): number {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)["']?`, "i"));
  const v = m ? parseInt(m[1], 10) : def;
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** <table> -> grid[][] (rowspan/colspan 대응) */
function tableHtmlToGrid(tableHtml: string): string[][] {
  const html = (tableHtml ?? "").toString();
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  const table = tableMatch ? tableMatch[0] : html;

  const trMatches = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const grid: string[][] = [];

  const pending: Array<Array<{ text: string; remainRows: number } | null>> = [];
  const ensurePendingRow = (r: number) => {
    while (pending.length <= r) pending.push([]);
  };

  for (let r = 0; r < trMatches.length; r++) {
    ensurePendingRow(r);
    const trHtml = trMatches[r];

    const cellMatches = trHtml.match(/<(td|th)([\s\S]*?)>([\s\S]*?)<\/\1>/gi) ?? [];
    const outRow: string[] = [];
    let c = 0;

    while (pending[r][c]) {
      outRow[c] = pending[r][c]!.text;
      pending[r][c]!.remainRows -= 1;
      if (pending[r][c]!.remainRows <= 0) pending[r][c] = null;
      c++;
    }

    for (const cellFull of cellMatches) {
      while (pending[r][c]) {
        outRow[c] = pending[r][c]!.text;
        pending[r][c]!.remainRows -= 1;
        if (pending[r][c]!.remainRows <= 0) pending[r][c] = null;
        c++;
      }

      const open = cellFull.match(/<(td|th)([\s\S]*?)>/i);
      const attrs = open ? open[2] ?? "" : "";
      const inner = cellFull
        .replace(/^(?:<td|<th)[\s\S]*?>/i, "")
        .replace(/<\/(?:td|th)>$/i, "");

      const text = normalizeText(stripTags(inner));
      const colspan = getAttrInt(attrs, "colspan", 1);
      const rowspan = getAttrInt(attrs, "rowspan", 1);

      for (let k = 0; k < colspan; k++) outRow[c + k] = text;

      if (rowspan > 1) {
        for (let rr = 1; rr < rowspan; rr++) {
          ensurePendingRow(r + rr);
          for (let k = 0; k < colspan; k++) {
            pending[r + rr][c + k] = { text, remainRows: 1 };
          }
        }
      }

      c += colspan;
    }

    while (pending[r][c]) {
      outRow[c] = pending[r][c]!.text;
      pending[r][c]!.remainRows -= 1;
      if (pending[r][c]!.remainRows <= 0) pending[r][c] = null;
      c++;
    }

    const trimmed = outRow.map((x) => normalizeText(x || ""));
    if (trimmed.some((x) => x.length > 0)) grid.push(trimmed);
  }

  return grid;
}

/** ===== 표 헤더/컬럼 ===== */
function findHeaderRow(grid: string[][]): { header: string[]; headerRowIndex: number } | null {
  const hints = ["구분","유형","내용","경조유형","휴가일수","일수","기간","첨부서류","서류","비고","기준","대상","유효기간"];
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const row = grid[i];
    const joined = row.map(compact).join(" ");
    let score = 0;
    for (const h of hints) if (joined.includes(compact(h))) score += 2;
    const shortCells = row.filter((x) => normalizeText(x).length > 0 && normalizeText(x).length <= 6).length;
    score += Math.min(3, shortCells);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  if (bestIdx < 0 || bestScore < 3) return null;
  return { header: grid[bestIdx].map((x) => normalizeText(x)), headerRowIndex: bestIdx };
}

function buildColMap(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const setIf = (key: string, patterns: RegExp[]) => {
    if (key in map) return;
    for (let i = 0; i < header.length; i++) {
      const h = header[i] || "";
      if (patterns.some((re) => re.test(h))) { map[key] = i; return; }
    }
  };

  setIf("category", [/^구분$/, /구분/]);
  setIf("type", [/^유형$/, /유형/, /경조유형/]);
  setIf("content", [/^내용$/, /내용/, /대상/]);
  setIf("days", [/휴가\s*일수/, /^일수$/, /기간/, /휴가\s*기간/]);
  setIf("valid", [/유효\s*기간/, /유효기간/]);
  setIf("docs", [/첨부\s*서류/, /제출\s*서류/, /서류/]);
  setIf("note", [/비고/, /참고/]);
  setIf("etc", [/기준/, /조건/]);

  return map;
}

function rowToObj(header: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  const n = Math.max(header.length, row.length);
  for (let i = 0; i < n; i++) {
    const k = normalizeText(header[i] ?? `col_${i + 1}`) || `col_${i + 1}`;
    const v = normalizeText(row[i] ?? "");
    obj[k] = v;
  }
  return obj;
}

function stringifyRow(obj: Record<string, string>): string {
  return Object.values(obj).map((v) => normalizeText(v)).filter(Boolean).join(" ");
}

function extractDaysValue(s: string): string | null {
  const t = normalizeText(s);
  const m1 = t.match(/(\d+(?:\.\d+)?)\s*일/g);
  if (m1 && m1.length) return m1.join(" ");
  const m2 = t.match(/(\d+(?:\.\d+)?)\s*시간/g);
  if (m2 && m2.length) return m2.join(" ");
  const m3 = t.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (m3) return `${m3[1]}일`;
  return null;
}

function scoreRow(qTokens: string[], normKeys: string[], rowText: string): number {
  const rt = normalizeText(rowText);
  const rc = compact(rt);
  let score = 0;

  for (const k of normKeys) {
    const kc = compact(k);
    if (kc && rc.includes(kc)) score += 15;
  }
  for (const t of qTokens) {
    const tc = compact(t);
    if (tc && rc.includes(tc)) score += 3;
  }
  if (normKeys.includes("사망") && /(사망|조위|조문|부고|별세)/.test(rt)) score += 6;
  if (normKeys.includes("배우자출산") && /(배우자|아내|남편|출산)/.test(rt)) score += 6;

  return score;
}

function pickBestRow(header: string[], bodyRows: string[][], q: string) {
  const qTokens = tokenizeKo(q);
  const normKeys = normalizeEventKeywords(q);
  let best: { row: string[]; obj: Record<string, string>; text: string; score: number } | null = null;

  for (const r of bodyRows) {
    const obj = rowToObj(header, r);
    const text = stringifyRow(obj);
    const sc = scoreRow(qTokens, normKeys, text);
    if (!best || sc > best.score) best = { row: r, obj, text, score: sc };
  }
  if (!best || best.score < 6) return null;
  return best;
}

/** ===== 섹션형 문서(시행일/대상/절차 등) ===== */
function buildSectionedCriteriaAnswer(blocks: Evidence[]): string | null {
  const ps = (blocks ?? [])
    .filter((b: any) => b.block_type === "p")
    .map((b: any) => normalizeText((b as any).content_text ?? ""))
    .filter(Boolean);

  const table = (blocks ?? []).find((b: any) => b.block_type === "table_html" && /<table[\s>]/i.test((b as any).content_html ?? ""));
  if (!ps.length && !table) return null;

  const hasSections =
    ps.some((x) => /시행일/.test(x)) &&
    ps.some((x) => /대상/.test(x)) &&
    ps.some((x) => /기준/.test(x)) &&
    ps.some((x) => /사용\s*절차|사용절차/.test(x));

  if (!hasSections) return null;

  const pickSection = (name: RegExp) => {
    const idx = ps.findIndex((x) => name.test(x));
    if (idx < 0) return [];
    const out: string[] = [];
    for (let i = idx + 1; i < ps.length; i++) {
      const line = ps[i];
      if (/시행일|대상|기준|사용\s*절차|사용절차/.test(line)) break;
      if (!line) continue;
      out.push(line);
    }
    return out;
  };

  const 시행일 = pickSection(/시행일/);
  const 대상 = pickSection(/대상/);
  const 사용절차 = pickSection(/사용\s*절차|사용절차/).filter((x) => /①|②|③|④|⑤|\d+\)|\d+\./.test(x));

  let 기준표 = "";
  if (table && (table as any).content_html) {
    const grid = tableHtmlToGrid((table as any).content_html);
    const headerInfo = findHeaderRow(grid);
    if (headerInfo) {
      const header = headerInfo.header;
      const body = grid.slice(headerInfo.headerRowIndex + 1).filter((r) => r.some((c) => normalizeText(c)));
      // Markdown 표
      기준표 = gridToMarkdownTable(header, body);
    }
  }

  const lines: string[] = [];
  lines.push(`## 기준`);

  if (시행일.length) {
    lines.push(`\n### 시행일`);
    lines.push(...시행일.map((x) => `- ${x.replace(/^•\s*/g, "")}`));
  }
  if (대상.length) {
    lines.push(`\n### 대상`);
    lines.push(...대상.map((x) => `- ${x.replace(/^•\s*/g, "")}`));
  }
  if (기준표) {
    lines.push(`\n### 기준`);
    lines.push(기준표);
  }
  if (사용절차.length) {
    lines.push(`\n### 사용 절차`);
    lines.push(...사용절차.map((x) => `- ${x}`));
  }

  return lines.join("\n");
}

/** ===== 마크다운 표 생성 ===== */
function escapePipe(s: string): string {
  return normalizeText(s).replace(/\|/g, "\\|");
}
function gridToMarkdownTable(header: string[], rows: string[][]): string {
  const cols = Math.max(1, header.length);
  const h = header.slice(0, cols).map(escapePipe);
  const sep = new Array(cols).fill("---");
  const body = rows.map((r) =>
    new Array(cols).fill("").map((_, i) => escapePipe(r[i] ?? "")).join(" | ")
  );
  return `| ${h.join(" | ")} |\n| ${sep.join(" | ")} |\n${body.map((x) => `| ${x} |`).join("\n")}`;
}

/** ===== list/days/criteria 출력 ===== */
function buildListAnswer(colMap: Record<string, number>, bodyRows: string[][]): string {
  const out: string[] = [];
  for (const r of bodyRows) {
    const type = normalizeText(r[colMap.type ?? -1] ?? "");
    const content = normalizeText(r[colMap.content ?? -1] ?? "");
    const daysRaw = normalizeText(r[colMap.days ?? -1] ?? "");
    const days = extractDaysValue(daysRaw) ?? (daysRaw ? daysRaw : "");
    const left = [type, content].filter(Boolean).join(" · ");
    if (!left) continue;
    out.push(`- ${left}${days ? ` — ${days}` : ""}`);
  }
  return out.length ? out.join("\n") : FALLBACK;
}

function buildDaysAnswer(colMap: Record<string, number>, row: string[]): string {
  const type = normalizeText(row[colMap.type ?? -1] ?? "");
  const content = normalizeText(row[colMap.content ?? -1] ?? "");
  const daysRaw = normalizeText(row[colMap.days ?? -1] ?? "");
  const days = extractDaysValue(daysRaw) ?? (daysRaw ? daysRaw : null);
  const valid = normalizeText(row[colMap.valid ?? -1] ?? "");

  if (!days) return FALLBACK;

  const ctx = [type, content].filter(Boolean).join(" · ");
  return `**${days}**${ctx ? ` (${ctx})` : ""}${valid ? `\n- 유효기간: ${valid}` : ""}`.trim();
}

function buildCriteriaRowAnswer(colMap: Record<string, number>, row: string[], rowObj: Record<string, string>): string {
  const type = normalizeText(row[colMap.type ?? -1] ?? "") || rowObj["유형"] || "";
  const content = normalizeText(row[colMap.content ?? -1] ?? "") || rowObj["내용"] || rowObj["대상"] || "";
  const daysRaw = normalizeText(row[colMap.days ?? -1] ?? "") || rowObj["휴가일수"] || rowObj["일수"] || "";
  const days = extractDaysValue(daysRaw) ?? (daysRaw ? daysRaw : "");
  const valid = normalizeText(row[colMap.valid ?? -1] ?? "") || rowObj["유효기간"] || "";
  const docs = normalizeText(row[colMap.docs ?? -1] ?? "") || rowObj["첨부서류"] || rowObj["제출서류"] || "";
  const note = normalizeText(row[colMap.note ?? -1] ?? "") || rowObj["비고"] || "";

  const lines: string[] = [];
  if (type) lines.push(`- 유형: ${type}`);
  if (content) lines.push(`- 내용/대상: ${content}`);
  if (days) lines.push(`- 기간/일수: ${days}`);
  if (valid) lines.push(`- 유효기간: ${valid}`);
  if (docs) lines.push(`- 첨부/제출 서류: ${docs}`);
  if (note) lines.push(`- 비고: ${note}`);
  return lines.length ? lines.join("\n") : FALLBACK;
}

/** ===== exported main ===== */
export function extractAnswerFromBlocks(question: string, blocks: Evidence[]): ExtractResult {
  const qType = classifyQuestion(question);

  // 섹션형 문서 우선
  if (qType === "criteria") {
    const sectioned = buildSectionedCriteriaAnswer(blocks);
    if (sectioned) return { ok: true, type: "criteria", answer_md: sectioned };
  }

  const tableBlocks = (blocks ?? []).filter(
    (b: any) => b.block_type === "table_html" && /<table[\s>]/i.test((b as any).content_html ?? "")
  );

  for (const b of tableBlocks) {
    const html = (b as any).content_html ?? "";
    let grid: string[][] = [];
    try {
      grid = tableHtmlToGrid(html);
    } catch {
      continue;
    }
    if (!grid.length) continue;

    const headerInfo = findHeaderRow(grid);
    if (!headerInfo) continue;

    const header = headerInfo.header;
    const colMap = buildColMap(header);

    const body = grid.slice(headerInfo.headerRowIndex + 1).filter((r) => r.some((c) => normalizeText(c)));
    if (!body.length) continue;

    if (qType === "list") {
      const md = buildListAnswer(colMap, body);
      if (md !== FALLBACK) return { ok: true, type: "list", answer_md: md, used: { filename: (b as any).filename } };
      continue;
    }

    const best = pickBestRow(header, body, question);
    if (!best) continue;

    if (qType === "days") {
      const md = buildDaysAnswer(colMap, best.row);
      if (md !== FALLBACK) return { ok: true, type: "days", answer_md: md, used: { filename: (b as any).filename, row_text: best.text, row: best.obj } };
      continue;
    }

    // criteria (row 기반)
    const md = buildCriteriaRowAnswer(colMap, best.row, best.obj);
    if (md !== FALLBACK) return { ok: true, type: "criteria", answer_md: md, used: { filename: (b as any).filename, row_text: best.text, row: best.obj } };
  }

  return { ok: false, type: qType, answer_md: FALLBACK };
}