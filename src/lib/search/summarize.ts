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

// ✅ index.ts가 쓰는 시그니처 그대로 유지: buildSummary(intent, evidence) -> string
export function buildSummary(intent: string, hits: Evidence[]): string {
  const texts = (hits ?? [])
    .filter((h) => h.block_type === "p")
    .map((h) => clean(h.content_text ?? ""))
    .filter(Boolean);

  const title = pickTitle(texts);

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

  const head = `[${(intent ?? "규정").trim() || "규정"}]\n${title}`.trim();
  return `${head}\n\n${body.trim()}`.trim();
}