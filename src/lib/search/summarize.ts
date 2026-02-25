// src/lib/search/summarize.ts
import type { Evidence } from "./types";

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function isStepLine(t: string) {
  return /^(?:[①-⑳]|\d+\)|\d+\.|-|•|▶)\s*/.test(t);
}
function stripStepPrefix(t: string) {
  return t.replace(/^(?:[①-⑳]|\d+\)|\d+\.|-|•|▶)\s*/, "").trim();
}
function pickTitle(texts: string[]) {
  const cand = texts
    .map(clean)
    .filter(Boolean)
    .filter((t) => t.length <= 60)
    .filter((t) => !isStepLine(t))
    .filter((t) => !/^담당자\s*[:：]/.test(t));
  return cand[0] || (texts[0] ? clean(texts[0]) : "안내");
}

function looksDaysQuestion(q: string) {
  return /(며칠|몇\s*일|일수|기간|휴가|반차|시간연차)/.test(q);
}
function looksMoneyQuestion(q: string) {
  return /(얼마|금액|원|만원|수당|지원|지급|한도|정산)/.test(q);
}

function stripHtmlToText(html: string) {
  // 아주 단순한 텍스트 변환(표를 “읽을 수 있게”만)
  return html
    .replace(/<\/(th|td|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildDaysOrMoneyBody(q: string, hits: Evidence[], texts: string[]) {
  // 표가 있으면 표를 본문으로 끌어올리는 게 핵심
  const table = hits.find((h) => h.block_type === "table_html" && (h.content_html ?? "").trim());
  const numberLines = texts.filter((t) => /(\d+)\s*일|(\d+[,\d]*)\s*(원|만원)/.test(t));

  let body = "";

  if (looksDaysQuestion(q)) {
    body += "안내\n";
    body += "- 경조휴가/기타휴가 “일수(기간)”는 사유/대상에 따라 다릅니다.\n";
    body += "- 아래 근거 표에서 해당 항목의 휴가일수를 확인해 주세요.\n\n";
  } else if (looksMoneyQuestion(q)) {
    body += "안내\n";
    body += "- 지급 금액/한도는 항목과 조건에 따라 다릅니다.\n";
    body += "- 아래 근거에서 해당 금액(원/만원) 기준을 확인해 주세요.\n\n";
  }

  // 숫자 라인이 문단에 있으면 먼저 보여주기
  if (numberLines.length) {
    body += "핵심 근거\n";
    Array.from(new Set(numberLines)).slice(0, 8).forEach((t) => {
      body += `- ${stripStepPrefix(t)}\n`;
    });
    body += "\n";
  }

  // 표가 있으면 텍스트로 변환해 일부라도 본문에 보여주기
  if (table?.content_html) {
    const tableText = stripHtmlToText(table.content_html);
    if (tableText) {
      body += "관련 표(요약)\n";
      // 너무 길면 앞부분만
      const lines = tableText.split("\n").map((x) => x.trim()).filter(Boolean);
      body += lines.slice(0, 18).join("\n");
      if (lines.length > 18) body += "\n…(이하 생략, 근거 원문에서 전체 표 확인)";
      body += "\n";
    }
  }

  // 그래도 비면 앞 문단
  if (!body.trim()) {
    const first = texts.slice(0, 6).join("\n");
    body = first ? first + "\n" : "관련 규정 근거를 찾았지만 요약을 구성하지 못했습니다.\n";
  }

  return body.trim();
}

function buildProcedureBody(texts: string[]) {
  const stepLines = texts
    .filter(isStepLine)
    .filter((t) => /전자|결재|신청|발주|제출|승인|도착|작성/.test(t));
  const noticeLines = texts.filter((t) => /사규|예외|문의|안내|참고|지연/.test(t));
  const contactLines = texts.filter((t) => /담당자|☎|02-|@/.test(t));

  let body = "";

  if (stepLines.length) {
    body += "신청 절차\n";
    stepLines.slice(0, 8).forEach((t, i) => {
      body += `${i + 1}) ${stripStepPrefix(t)}\n`;
    });
    body += "\n";
  }

  if (noticeLines.length) {
    body += "안내\n";
    Array.from(new Set(noticeLines))
      .slice(0, 5)
      .forEach((t) => (body += `- ${stripStepPrefix(t)}\n`));
    body += "\n";
  }

  if (contactLines.length) {
    body += "담당자\n";
    Array.from(new Set(contactLines))
      .slice(0, 3)
      .forEach((t) => (body += `- ${stripStepPrefix(t)}\n`));
    body += "\n";
  }

  if (!body.trim()) {
    const first = texts.slice(0, 6).join("\n");
    body = first ? first + "\n" : "관련 규정 근거를 찾았지만 요약을 구성하지 못했습니다.\n";
  }

  return body.trim();
}

// ✅ 시그니처 변경: q 추가
export function buildSummary(intent: string, hits: Evidence[], q: string = ""): string {
  const texts = (hits ?? [])
    .filter((h) => h.block_type === "p")
    .map((h) => clean(h.content_text ?? ""))
    .filter(Boolean);

  const title = pickTitle(texts);

  // 분기: 며칠/금액 질문이면 표/숫자 중심으로
  const isDays = looksDaysQuestion(q);
  const isMoney = looksMoneyQuestion(q);

  const body = (isDays || isMoney)
    ? buildDaysOrMoneyBody(q, hits, texts)
    : buildProcedureBody(texts);

  const head = `[${(intent ?? "규정").trim() || "규정"}]\n${title}`.trim();
  return `${head}\n\n${body}`.trim();
}