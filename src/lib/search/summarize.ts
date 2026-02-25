import { Evidence } from "./types";

const FALLBACK =
  "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

export function buildSummary(intent: string, evidence: Evidence[]) {
  if (!evidence.length) return FALLBACK;

  const head = `[${intent}]`;

  // 1️⃣ 번호가 붙은 절차 블록 우선
  const steps = evidence.filter(
    (e) =>
      e.block_type === "p" &&
      /^\d+[\.\)]/.test((e.content_text ?? "").trim())
  );

  if (steps.length) {
    const joined = steps
      .slice(0, 5)
      .map((s) => s.content_text)
      .join("\n");

    return `${head}\n${joined}`;
  }

  // 2️⃣ 일반 문단
  const p = evidence.find(
    (e) => e.block_type === "p" && (e.content_text ?? "").trim()
  );

  const hasTable = evidence.some(
    (e) => e.block_type === "table_html" && (e.content_html ?? "").trim()
  );

  if (p && hasTable) return `${head}\n${p.content_text}\n\n아래 표를 참고하세요.`;
  if (p) return `${head}\n${p.content_text}`;
  if (hasTable) return `${head}\n아래 표를 참고하세요.`;

  return `${head}\n관련 근거를 찾았습니다. 근거 원문을 확인하세요.`;
}