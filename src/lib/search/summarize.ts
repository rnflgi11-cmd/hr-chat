import type { Evidence } from "./types";

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function looksProcedure(q: string) {
  return /(절차|어떻게|방법|신청|제출|승인|기안|경로)/.test(q);
}
function looksDays(q: string) {
  return /(며칠|몇\s*일|일수|기간|휴가)/.test(q);
}
function looksMoney(q: string) {
  return /(얼마|금액|원|만원|수당|지원|지급|한도|정산)/.test(q);
}
function looksCriteria(q: string) {
  return /(기준|조건|대상|산정|적용|정의|가능|안식년|근속)/.test(q);
}

function isStepLine(t: string) {
  return /^(?:[①-⑳]|\d+\)|\d+\.|-|•|▶)\s*/.test(t);
}
function stripStepPrefix(t: string) {
  return t.replace(/^(?:[①-⑳]|\d+\)|\d+\.|-|•|▶)\s*/, "").trim();
}

function pickTitleFromHits(hits: Evidence[]) {
  // 문단 중 첫 줄을 제목으로
  const p = hits.find((h) => h.block_type === "p" && clean(h.content_text ?? ""));
  return clean(p?.content_text ?? "") || "안내";
}

/** 아주 단순 HTML entity decode (표에 &nbsp; 같은 거 방지) */
function decodeHtmlEntities(s: string) {
  return (s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** table_html -> markdown table (행 단위로 잘라서 “짤림” 방지) */
function tableHtmlToMarkdown(html: string, maxRows = 12) {
  const h = decodeHtmlEntities(html ?? "");
  if (!h.trim()) return "";

  // tr 단위로 split
  const trMatches = Array.from(h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((m) => m[1]);
  if (!trMatches.length) return "";

  const rows: string[][] = trMatches.map((tr) => {
    const cellMatches = Array.from(tr.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)).map(
      (m) =>
        clean(
          decodeHtmlEntities(m[1])
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
        )
    );
    return cellMatches.filter((c) => c !== "");
  }).filter((r) => r.length);

  if (!rows.length) return "";

  // 헤더 추정: 첫 row를 header로 사용 (대부분 이렇게 들어옴)
  const header = rows[0];
  const body = rows.slice(1, 1 + maxRows);

  const colCount = Math.max(header.length, ...(body.map(r => r.length)));
  const norm = (r: string[]) => {
    const rr = r.slice(0, colCount);
    while (rr.length < colCount) rr.push("");
    return rr.map((x) => x.replace(/\n+/g, " / "));
  };

  const H = norm(header);
  const B = body.map(norm);

  const sep = Array(colCount).fill("---");

  let md = "";
  md += `| ${H.join(" | ")} |\n`;
  md += `| ${sep.join(" | ")} |\n`;
  for (const r of B) md += `| ${r.join(" | ")} |\n`;

  if (rows.length - 1 > maxRows) {
    md += `\n…(표 행이 많아 ${maxRows}행까지만 표시, “근거 원문 보기”에서 전체 확인)\n`;
  }
  return md.trim();
}

function buildProcedureBody(texts: string[]) {
  const stepLines = texts.filter(isStepLine);
  const noticeLines = texts.filter((t) => /사규|예외|문의|안내|참고|지연/.test(t));
  const contactLines = texts.filter((t) => /담당자|☎|02-|@/.test(t));

  let body = "";

  if (stepLines.length) {
    body += "신청 절차\n";
    stepLines.slice(0, 8).forEach((t, i) => (body += `${i + 1}) ${stripStepPrefix(t)}\n`));
    body += "\n";
  }
  if (noticeLines.length) {
    body += "안내\n";
    Array.from(new Set(noticeLines)).slice(0, 6).forEach((t) => (body += `- ${stripStepPrefix(t)}\n`));
    body += "\n";
  }
  if (contactLines.length) {
    body += "담당자\n";
    Array.from(new Set(contactLines)).slice(0, 3).forEach((t) => (body += `- ${stripStepPrefix(t)}\n`));
    body += "\n";
  }

  return body.trim();
}

function buildCriteriaOrDaysOrMoneyBody(q: string, hits: Evidence[], texts: string[]) {
  const table = hits.find((h) => h.block_type === "table_html" && clean(h.content_html ?? ""));
  const mdTable = table?.content_html ? tableHtmlToMarkdown(table.content_html, looksDays(q) ? 14 : 12) : "";

  // 숫자/핵심 라인
  const keyLines = texts.filter((t) => {
    if (looksDays(q)) return /(\d+)\s*일|휴가일수|기간/.test(t);
    if (looksMoney(q)) return /(\d+[,\d]*)\s*(원|만원)|지급|한도|정산/.test(t);
    return /기준|조건|대상|산정|적용|근속|안식년/.test(t);
  });

  let body = "";

  if (looksDays(q)) body += "휴가 일수 안내\n";
  else if (looksMoney(q)) body += "금액/지급 기준 안내\n";
  else body += "기준/조건 안내\n";

  if (keyLines.length) {
    body += Array.from(new Set(keyLines)).slice(0, 8).map((t) => `- ${stripStepPrefix(t)}`).join("\n");
    body += "\n\n";
  }

  if (mdTable) {
    body += "관련 표\n";
    body += mdTable;
    body += "\n";
  }

  // ✅ p가 거의 없고 표도 없으면: 그래도 앞 문단이라도
  if (!body.trim()) {
    const first = texts.slice(0, 8).join("\n");
    body = first || "관련 규정 근거를 찾았지만 요약을 구성하지 못했습니다.";
  }

  return body.trim();
}

export function buildSummary(intent: string, hits: Evidence[], q: string = ""): string {
  const texts = (hits ?? [])
    .filter((h) => h.block_type === "p")
    .map((h) => clean(h.content_text ?? ""))
    .filter(Boolean);

  const title = pickTitleFromHits(hits);

  // 분기: 절차 vs 표/기준
  const body =
    looksProcedure(q) && !looksDays(q) && !looksMoney(q) && !looksCriteria(q)
      ? buildProcedureBody(texts) || buildCriteriaOrDaysOrMoneyBody(q, hits, texts)
      : buildCriteriaOrDaysOrMoneyBody(q, hits, texts);

  const head = `[${(intent ?? "규정").trim() || "규정"}]\n${title}`.trim();
  return `${head}\n\n${body}`.trim();
}