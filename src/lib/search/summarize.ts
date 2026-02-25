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

  // 🔹 표가 없으면 문단 기반 출력
  if (!body.trim() && texts.length) {
    body += texts.slice(0, 12).map((t) => `- ${t}`).join("\n");
  }

  if (!body.trim()) {
    body =
      "관련 규정 근거를 찾았지만 내용을 구성하지 못했습니다.\n" +
      "‘근거 원문 보기’를 확인해 주세요.";
  }

  const head = `[${intent || "규정 검색 결과"}]`;

  return `${head}\n\n${body}`.trim();
}