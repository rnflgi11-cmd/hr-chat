import "server-only";
import type { Evidence } from "@/lib/search/types";

type LlmRefineInput = {
  question: string;
  draftAnswer: string;
  intent: string;
  evidence: Evidence[];
};

function buildEvidenceSnippet(evidence: Evidence[]): string {
  return evidence
    .slice(0, 8)
    .map((e, i) => {
      const text = (e.content_text ?? "").replace(/\s+/g, " ").trim();
      const html = (e.content_html ?? "").replace(/\s+/g, " ").trim();
      return `${i + 1}. [${e.block_type}] ${text || html}`;
    })
    .join("\n");
}

export async function refineAnswerWithLlm(input: LlmRefineInput): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (process.env.ENABLE_LLM_ANSWER !== "1") return null;

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const system = [
    "당신은 사내 HR 규정 답변 도우미입니다.",
    "반드시 제공된 근거(evidence)와 draft answer 안에서만 답하세요.",
    "근거에 없는 사실은 절대 추가하지 마세요.",
    "질문이 '종류/기준/절차'라면 핵심을 먼저 짧게 요약하고, 이어서 원문 항목을 최대한 보존해 정리하세요.",
    "표 정보가 있으면 Markdown 표를 유지하거나 재구성하세요.",
  ].join("\n");

  const user = [
    `질문: ${input.question}`,
    `의도: ${input.intent}`,
    "",
    "draft answer:",
    input.draftAnswer,
    "",
    "evidence:",
    buildEvidenceSnippet(input.evidence),
    "",
    "요구사항: 최종 답변만 Markdown으로 출력",
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}
