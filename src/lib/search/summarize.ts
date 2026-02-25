import { Evidence } from "./types";

const FALLBACK =
  "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

export function buildSummary(intent: string, evidence: Evidence[]) {
  if (!evidence.length) return FALLBACK;

  const p = evidence.find((e) => e.block_type === "p" && (e.content_text ?? "").trim());
  const hasTable = evidence.some((e) => e.block_type === "table_html" && (e.content_html ?? "").trim());

  const head = `[${intent}]`;

  if (p && hasTable) return `${head}\n${p.content_text}\n\n아래 표를 참고하세요.`;
  if (p) return `${head}\n${p.content_text}`;
  if (hasTable) return `${head}\n아래 표를 참고하세요.`;

  return `${head}\n관련 근거를 찾았습니다. 근거 원문을 확인하세요.`;
}