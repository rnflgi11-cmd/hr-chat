import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Evidence } from "@/lib/search/types";

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function generateGeminiAnswer(
  question: string,
  draftAnswer: string,
  hits: Evidence[]
): Promise<string | null> {
  try {
    if (!genAI) return null;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    });

    const evidenceText = hits
      .slice(0, 8)
      .map((e, i) => {
        const content =
          e.block_type === "table_html"
            ? (e.content_html ?? "")
            : (e.content_text ?? "");

        return `[#${i + 1}] 파일명: ${e.filename}\n내용:\n${content}`;
      })
      .join("\n\n---\n\n");

    const prompt = `
당신은 코비전 HR 규정 안내 챗봇입니다.
반드시 아래 근거 문서만 사용해서 답변하세요.

질문:
${question}

검색 초안:
${draftAnswer}

근거:
${evidenceText}

규칙:
1. 질문과 직접 관련된 정보만 먼저 답변한다.
2. 표 전체를 출력하지 말고 해당되는 항목만 발췌한다.
3. 근거에 없는 내용은 추측하지 않는다.
4. 첫 문장은 핵심 답을 짧게 말한다.
5. 마지막에는 "참고: 파일명" 형식으로 표시한다.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    return text || null;
  } catch (error) {
    console.error("Gemini error:", error);
    return null;
  }
}