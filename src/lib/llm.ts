import "server-only";
import type { Evidence } from "@/lib/search/types";

type LlmRefineInput = {
  question: string;
  intent: string;
  questionType: "direct" | "list" | "explain";
  evidence: Evidence[];
  fallbackDraft?: string;
};

export type LlmRefineResult = {
  answer: string | null;
  reason:
    | "disabled"
    | "missing_api_key"
    | "empty_input"
    | "api_error"
    | "bad_output_fallback"
    | "truncated_fallback"
    | "same_as_draft"
    | "applied";
  status?: number;
  error?: string;
};

const STRICT_FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

const HR_RULES_PROMPT = [
  "당신은 코비젼 인사팀 선임 HR 안내 담당자입니다.",
  "반드시 evidence 범위 안에서만 답변하세요.",
  "근거에 없는 내용/수치/표를 생성하지 마세요.",
  "질문과 무관한 제도, 표, 안내문은 절대 섞지 마세요.",
  "내부 판단 과정은 절대 출력하지 마세요.",
  "답변은 자연스러운 한국어 존댓말로 작성하세요.",
  "첫 문장에서 질문의 결론을 바로 말하세요.",
  "제목(예: ### 안내), 담당자 문의 문구, 같은 의미 반복 문장을 넣지 마세요.",
  "표는 질문이 목록/기준 비교를 요구할 때만 사용하고, 관련 행만 최소로 제시하세요.",
  "표를 사용하는 경우에도 표만 단독으로 내지 말고, 표 앞에 짧은 설명 1문장을 먼저 쓰세요.",
  `근거가 부족하면 정확히 아래 문구만 출력: ${STRICT_FALLBACK}`,
].join("\n");

function buildFallbackFromDraft(draft: string, questionType: LlmRefineInput["questionType"]): string {
  const lines = draft.split("\n").map((x) => x.trim()).filter(Boolean);
  const tableLines = lines.filter((x) => /^\|.*\|$/.test(x) || /^[:\-\s|]+$/.test(x));
  const textLines = lines.filter((x) => !/^\|.*\|$/.test(x) && !/^[:\-\s|]+$/.test(x));

  if (questionType === "direct") {
    const lead = textLines[0] ?? "질문하신 내용은 사내 규정 기준으로 확인됩니다.";
    const body = textLines.slice(1, 3);
    return [lead, ...body].join("\n\n").trim();
  }

  if (questionType === "explain") {
    const lead = textLines[0] ?? "질문하신 기준은 다음과 같이 적용됩니다.";
    const bullets = textLines.slice(1, 5).map((x) => `- ${x.replace(/^[-*]\s*/, "")}`);
    return [lead, ...bullets].join("\n").trim();
  }

  const lead = textLines[0] ?? "질문하신 항목은 아래와 같습니다.";
  const bullets = textLines.slice(1, 4).map((x) => `- ${x.replace(/^[-*]\s*/, "")}`);
  const table = tableLines.length ? ["아래 표는 관련 항목만 정리한 내용입니다.", ...tableLines] : [];
  return [lead, ...bullets, ...table].join("\n\n").trim();
}

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
    .slice(0, 20)
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

function normalizeModelName(model: string): string {
  return (model ?? "").replace(/^models\//, "").trim();
}

function buildGenerateEndpoint(apiVersion: "v1" | "v1beta", model: string, apiKey: string): string {
  return (
    `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(normalizeModelName(model))}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`
  );
}

async function resolveSupportedModel(apiKey: string, preferred: string): Promise<string> {
  const versions: Array<"v1" | "v1beta"> = ["v1", "v1beta"];
  const wanted = normalizeModelName(preferred);

  for (const v of versions) {
    const res = await fetch(`https://generativelanguage.googleapis.com/${v}/models?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) continue;
    const data = await res.json();
    const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = data?.models ?? [];
    const gen = models.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"));
    if (!gen.length) continue;

    const exact = gen.find((m) => normalizeModelName(m.name ?? "") === wanted);
    if (exact?.name) return normalizeModelName(exact.name);

    const preferredFlash = gen.find((m) => /flash/i.test(normalizeModelName(m.name ?? "")));
    if (preferredFlash?.name) return normalizeModelName(preferredFlash.name);

    if (gen[0]?.name) return normalizeModelName(gen[0].name);
  }

  return wanted;
}

function isBadModelOutput(out: string): boolean {
  const text = cleanText(out);
  if (!text) return true;

  if (/코비젼\s*HR\s*GPT\s*운영\s*프롬프트|STEP\s*1|STEP\s*2|내부\s*사고\s*과정/i.test(text)) {
    return true;
  }

 if (text.length < 28) return true;

  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const keys = lines.map((x) => x.toLowerCase().replace(/^[-*\d.)\s]+/, "").replace(/[\s:：·•()\[\]{}"'`]/g, ""));
  const uniq = new Set(keys);
  if (lines.length >= 6 && uniq.size / lines.length < 0.65) return true;

  return false;
}

function isLikelyTruncatedOutput(out: string): boolean {
  const text = cleanText(out);
  if (!text) return true;

  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (!last) return true;

  if (/\d{4}\s*년\s*\d{1,2}\s*월$/.test(last)) return true;
  if (/\d{1,2}\s*월\s*\d{1,2}\s*일$/.test(last)) return true;
  if (/^(##+\s*)?[가-힣A-Za-z0-9\s]+:$/.test(last)) return true;

  const endsCleanly = /[.!?。…]|니다$|습니다$|요$/.test(last);
  if (!endsCleanly && last.length <= 20) return true;

  return false;
}

function isTooShortForType(out: string, questionType: LlmRefineInput["questionType"]): boolean {
  const text = cleanText(out);
  if (!text) return true;

  const plainLines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const sentenceCount = (text.match(/[.!?。…]|니다\b|습니다\b|해요\b/g) ?? []).length;
  const nonTableLines = plainLines.filter((x) => !/^\|.*\|$/.test(x) && !/^[:\-\s|]+$/.test(x));

  if (questionType === "direct") return sentenceCount < 2 || nonTableLines.length < 2;
  if (questionType === "explain") return nonTableLines.length < 3;
  if (questionType === "list") return nonTableLines.length < 2;
  return false;
}

export async function refineAnswerWithLlm(input: LlmRefineInput): Promise<LlmRefineResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isLlmEnabled()) return { answer: null, reason: "disabled" };
  if (!apiKey) return { answer: null, reason: "missing_api_key" };

  const preferredModel = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  const model = await resolveSupportedModel(apiKey, preferredModel);
  const fallbackDraft = cleanText(input.fallbackDraft);
  const fallbackDetailed = buildFallbackFromDraft(fallbackDraft, input.questionType);
  const evidence = buildEvidenceSnippet(input.evidence);

  if (!evidence) return { answer: null, reason: "empty_input" };

  const prompt = [
    HR_RULES_PROMPT,
    "",
    `질문: ${input.question}`,
    `의도: ${input.intent}`,
    `질문유형: ${input.questionType}`,
    "",
    "evidence:",
    evidence || "(없음)",
    "",
    "출력 지시:",
    "1) 최종 답변 Markdown 본문만 출력",
    "2) direct 유형: 첫 문장에서 결론을 말하고, 이어서 2~4문장으로 자연스럽게 설명",
    "3) list 유형: 짧은 서문 1문장 후, 필요한 경우에만 목록 또는 표를 사용",
    "4) explain 유형: 결론 1문장 + 핵심 기준 2~5개(짧은 bullet 또는 문단)",
    "5) 표를 쓴 경우: 표 앞 1문장 + 표 뒤 핵심 설명 2~4개를 반드시 포함",
    "6) 질문과 직접 관련 없는 항목/제도는 제외",
    "7) 출처 표기는 선택 사항이며, 강제로 넣지 않아도 됨",
    "8) 문장을 중간에 끊지 말고 완결형으로 끝낼 것",
  ].join("\n");

  const endpointV1 = buildGenerateEndpoint("v1", model, apiKey);
  const endpointV1beta = buildGenerateEndpoint("v1beta", model, apiKey);
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.28,
      topP: 0.85,
      maxOutputTokens: 1024,
    },
  };

  let res = await fetch(endpointV1, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status === 404) {
    res = await fetch(endpointV1beta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 250));
    const retryEndpoint = res.status === 404 ? endpointV1beta : endpointV1;
    res = await fetch(retryEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    const errText = cleanText(await res.text());
    return {
      answer: null,
      reason: "api_error",
      status: res.status,
      error: errText.slice(0, 240) || "gemini_api_error",
    };
  }

  const data = await res.json();
  const text = cleanText(
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p?.text ?? "")
      .join("\n")
  );

  if (isBadModelOutput(text) || isLikelyTruncatedOutput(text) || isTooShortForType(text, input.questionType)) {
    return { answer: fallbackDetailed || fallbackDraft || null, reason: "bad_output_fallback" };
  }

  const answer = text || fallbackDetailed || fallbackDraft || null;
  if (!answer) return { answer: null, reason: "empty_input" };

  if (fallbackDraft && normalizeForCompare(answer) === normalizeForCompare(fallbackDraft)) {
    return { answer, reason: "same_as_draft" };
  }

  return { answer, reason: "applied" };
}