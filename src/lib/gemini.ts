import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Evidence } from "@/lib/search/types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function generateGeminiAnswer(
  question: string,
  draftAnswer: string,
  hits: Evidence[]
) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    });

    const evidenceText = hits
      .slice(0, 8)
      .map((e, i) => {
        const content =
          e.block_type === "table_html"
            ? e.content_html
            : e.content_text;

        return `[#${i + 1}] ${e.filename}\n${content}`;
      })
      .join("\n\n");

    const prompt = `
코비젼 HR 규정 챗봇입니다.

반드시 아래 근거 문서만 사용해서 답변하세요.

질문:
${question}

검색 초안:
${draftAnswer}

근거:
${evidenceText}

규칙:
- 근거에 없는 내용은 추측하지 마세요
- 표는 표 형태로 유지하세요
- HR 규정 답변처럼 간결하게 작성하세요
`;

    const result = await model.generateContent(prompt);

    const text = result.response.text();

    return text;
  } catch (err) {
    console.error("Gemini error:", err);
    return null;
  }
}