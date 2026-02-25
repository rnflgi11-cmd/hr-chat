// src/lib/search/summarize.ts

export type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/* =========================
   HTML → TEXT 정리 유틸
========================= */

function decodeHtmlEntities(s: string) {
  return (s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s: string) {
  return decodeHtmlEntities(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   table_html → rows
========================= */

function tableHtmlToRows(html: string): string[][] {
  const h = decodeHtmlEntities(html ?? "");
  const trMatches = Array.from(
    h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)
  ).map((m) => m[1]);

  if (!trMatches.length) return [];

  const rows: string[][] = trMatches
    .map((tr) => {
      const cells = Array.from(
        tr.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)
      ).map((m) => stripTags(m[1]));
      return cells.filter(Boolean);
    })
    .filter((r) => r.length);

  return rows;
}

/* =========================
   표 전체를 리스트로 출력
========================= */

function formatTableAsList(rows: string[][]): string {
  if (!rows.length) return "";

  const header = rows[0];
  const body = rows.slice(1);

  const idx = (re: RegExp) => header.findIndex((h) => re.test(h));

  const iType = idx(/구분|유형|항목/);
  const iEvent = idx(/경조|내용|사유/);
  const iTarget = idx(/대상/);
  const iDays = idx(/일수|기간|휴가일/);
  const iMoney = idx(/금액|원|만원|지급/);
  const iNote = idx(/비고|참고/);
  const iDoc = idx(/첨부|서류|증빙|제출/);

  const pick = (r: string[], i: number) =>
    i >= 0 && i < r.length ? r[i] : "";

  const lines: string[] = [];

  for (const r of body) {
    const parts: string[] = [];

    const a = pick(r, iType);
    const b = pick(r, iEvent);
    const c = pick(r, iTarget);

    if (a) parts.push(a);
    if (b) parts.push(b);
    if (c) parts.push(c);

    const days = pick(r, iDays);
    const money = pick(r, iMoney);
    const note = pick(r, iNote);

    let tail = "";

if (days) tail += `: ${days}`;
else if (money) tail += `: ${money}`;

const doc = pick(r, iDoc);
if (doc) tail += ` / 첨부서류: ${doc}`;

if (note) tail += ` (${note})`;

    const head =
      parts.filter(Boolean).join(" · ").trim() ||
      r.slice(0, 4).join(" · ");

    lines.push(`- ${head}${tail}`);
  }

  return lines.join("\n");
}

/* =========================
   메인 요약 함수
========================= */

export function buildSummary(
  intent: string,
  hits: Evidence[],
  q: string
): string {
  const texts = hits
    .filter((h) => h.block_type === "p")
    .map((h) => clean(h.content_text ?? ""))
    .filter(Boolean);

  const table = hits.find(
    (h) =>
      h.block_type === "table_html" &&
      (h.content_html ?? "").trim()
  );
const isCatalog =
    /(뭐|무엇|종류|전체|목록|항목|정리|한눈에|다 알려|뭐 있어)/.test(q);

  let body = "";

  // 🔹 표가 있으면 표 전체를 리스트로 출력
  if (table?.content_html) {
    const rows = tableHtmlToRows(table.content_html);
    const list = formatTableAsList(rows);

    if (list) {
      body += "전체 항목\n";
      body += list;
    }
  }

  // 🔹 문단 출력 (범위 질문이면 더 많이, 중복 제거)
  if (texts.length) {
    const limit = isCatalog ? 60 : 12;

    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const t of texts) {
      const k = clean(t);
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(k);
      if (uniq.length >= limit) break;
    }

    // 표가 이미 출력됐고(경조휴가/프로젝트수당 등), 범위 질문이면 문단도 이어 붙임
    if (isCatalog && body.trim()) body += "\n\n";

    // 표가 없으면 기본으로 문단 출력
    // 범위 질문이면 표가 있어도 문단 출력
    if (!body.trim() || isCatalog) {
      body += uniq.map((t) => `- ${t}`).join("\n");
    }
  }

  if (!body.trim()) {
    body =
      "관련 규정 근거를 찾았지만 내용을 구성하지 못했습니다.\n" +
      "‘근거 원문 보기’를 확인해 주세요.";
  }

  const head = `[${intent || "규정 검색 결과"}]`;

  return `${head}\n\n${body}`.trim();
}