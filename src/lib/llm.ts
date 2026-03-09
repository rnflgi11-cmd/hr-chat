import "server-only";
import type { Evidence } from "@/lib/search/types";

type LlmRefineInput = {
  question: string;
  draftAnswer: string;
  intent: string;
  evidence: Evidence[];
};

export type LlmRefineResult = {
  answer: string | null;
  reason:
    | "disabled"
    | "missing_api_key"
    | "empty_input"
    | "api_error"
    | "bad_output_fallback"
    | "same_as_draft"
    | "applied";
};

const STRICT_FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

const HR_RULES_PROMPT = [
  "당신은 코비젼 인사팀 HR 안내 담당자입니다.",
  "반드시 evidence와 draft answer 범위 안에서만 답변하세요.",
  "근거에 없는 내용/수치/표를 생성하지 마세요.",
  "질문과 무관한 운영규칙 문구를 출력하지 마세요.",
  "내부 판단 과정은 절대 출력하지 마세요.",
  "답변은 자연스러운 한국어 존댓말로 작성하세요.",
  "단답형으로 끝내지 말고, 질문 의도에 맞는 핵심 설명을 포함하세요.",
  "draft answer의 항목 순서(제목/불릿/절차)를 임의로 바꾸지 마세요.",
  "표 근거가 있으면 표를 우선 제시하고, 이어 핵심 해설을 2~6개 bullet로 정리하세요.",
  `근거가 부족하면 정확히 아래 문구만 출력: ${STRICT_FALLBACK}`,
].join("\n");

function cleanText(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\t{2,}/g, "\t")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildEvidenceSnippet(evidence: Evidence[]): string {
  return evidence
    .slice(0, 12)
    .map((e, i) => {
      const text = cleanText(e.content_text);
      const html = cleanText(e.content_html);
      const body = e.block_type === "table_html" ? stripHtmlToText(html) : text || stripHtmlToText(html);

      return [
        `[#${i + 1}]`,
        `source: ${e.filename}`,
        `type: ${e.block_type}`,
        body,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function isLlmEnabled() {
  return process.env.ENABLE_LLM === "1" || process.env.ENABLE_LLM_ANSWER === "1";
}

export function getLlmRuntimeInfo() {
  const enabled = isLlmEnabled();
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  return { enabled, hasApiKey, model };
}

function normalizeForCompare(s: string): string {
  return cleanText(s)
    .toLowerCase()
    .replace(/[\s:：·•()\[\]{}"'`.,!?\-]/g, "")
    .trim();
}

function isBadModelOutput(out: string, draft: string): boolean {
  const text = cleanText(out);
  if (!text) return true;

  if (/코비젼\s*HR\s*GPT\s*운영\s*프롬프트|STEP\s*1|STEP\s*2|내부\s*사고\s*과정/i.test(text)) {
    return true;
  }

  if (text.length < 40 && draft.length > 220) return true;

  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const keys = lines.map((x) => x.toLowerCase().replace(/^[-*\d.)\s]+/, "").replace(/[\s:：·•()\[\]{}"'`]/g, ""));
  const uniq = new Set(keys);
  if (lines.length >= 6 && uniq.size / lines.length < 0.65) return true;

  return false;
}

export async function refineAnswerWithLlm(input: LlmRefineInput): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !isLlmEnabled()) return null;

  const model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  const draft = cleanText(input.draftAnswer);
  const evidence = buildEvidenceSnippet(input.evidence);

  if (!draft && !evidence) return null;

  const prompt = [
    HR_RULES_PROMPT,
    "",
    `질문: ${input.question}`,
    `의도: ${input.intent}`,
    "",
    "draft answer(최우선 보존 대상):",
    draft || "(없음)",
    "",
    "evidence:",
    evidence || "(없음)",
    "",
    "출력 지시:",
    "1) 최종 답변 Markdown 본문만 출력",
    "2) draft answer의 핵심 수치/절차/표를 보존하면서 문장을 자연스럽게 정리",
    "2-1) draft answer에 있는 절차/순서 번호는 원문 순서를 유지",
    "3) 같은 의미 반복 문장은 제거",
    "4) 답변 구조: 핵심요약 1문장 + 상세 bullet 2~6개 + (가능하면) 주의/예외 1~2개",
    "5) 마지막 줄에 '출처: 파일명' 형식으로 1~3개 표기",
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  const text = cleanText(
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p?.text ?? "")
      .join("\n")
  );

  if (isBadModelOutput(text, draft)) return draft || null;
  return text || draft || null;
}