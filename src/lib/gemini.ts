import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Evidence } from "@/lib/search/types";

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

function tokenizeQuestion(question: string): string[] {
  return Array.from(
    new Set(
      (question.match(/[A-Za-z0-9가-힣]+/g) ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2)
        .filter((t) => !["알려줘", "알려", "기준", "절차", "방법", "문의", "규정"].includes(t))
    )
  );
}

function rankEvidence(question: string, hits: Evidence[]): Evidence[] {
  const terms = tokenizeQuestion(question);

  const scored = hits.map((e, idx) => {
    const body = `${e.content_text ?? ""}\n${e.content_html ?? ""}`.toLowerCase();
    let score = e.block_type === "table_html" ? 2 : 0;

    for (const term of terms) {
      if (body.includes(term)) score += Math.min(8, term.length);
    }

    if (/\d+\s*일/.test(body)) score += 3;
    if (/기준|조건|대상|절차|유의사항|휴가일수/.test(body)) score += 2;

    return { e, score, idx };
  });

  const sorted = scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return sorted.slice(0, 10).map((x) => x.e);
}

export async function generateGeminiAnswer(
  question: string,
  _draftAnswer: string,
  hits: Evidence[]
): Promise<string | null> {
  try {
    if (!genAI) return null;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    });

    const selectedHits = rankEvidence(question, hits);

    const evidenceText = selectedHits
      .slice(0, 8)
      .map((e, i) => {
        const content = e.block_type === "table_html" ? (e.content_html ?? "") : (e.content_text ?? "");
        return [
          `[#${i + 1}]`,
          `파일명: ${e.filename}`,
          `블록유형: ${e.block_type}`,
          "내용:",
          content,
        ].join("\n");
      })
      .join("\n\n---\n\n");

    const rules = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[코비젼 HR GPT 운영 프롬프트 v5.4 – 표 1:1 복제 보장형]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ Role
당신은 [코비젼] 인사팀 HR 안내 담당자입니다.
직원 질문에 대해 반드시 제공된 Knowledge Files(규정 근거)만 근거로 답변합니다.
추론, 일반 상식, 인터넷 정보는 절대 사용하지 않습니다.
파일에서 실제로 확인되지 않은 내용은 생성하지 않습니다.

■ STEP 1. 질문 의도 내부 분류 (출력 금지)
A. 연차휴가
B. 잔여연차 / 연차수당
C. 기타 휴가 및 복리후생

■ STEP 2. 문서 탐색 규칙
1) 파일명 앞 숫자는 무시
2) 확장자 무시
3) 동일 주제 파일이 여러 개면 최신 개정 파일 우선
4) 하나의 파일에 명확한 규정이 있으면 추가 탐색 중단
5) 실제로 확인하지 못한 내용 생성 금지

■ STEP 3. 원문 유지 규칙
- 규정에 없는 표현 생성 금지
- 문장 임의 요약/변형 금지
- 절차는 원문 순서 유지, "→" 흐름 유지
- 원문에 없는 단계/항목 추가 금지
- 과거 답변 재사용 금지

■ STEP 3-2. 표 원문 1:1 복제 절대 규칙
1) 표는 재작성이 아닌 복제
2) 열/행 개수, 열 제목, 순서 변경 금지
3) 열/행 추가 금지
4) 병합 셀은 동일 값 반복으로만 표현
5) 표 구조가 불명확하면 임의 구성 금지 후 Fallback

■ STEP 4. 출력 방식
1) 친절한 존댓말
2) 내부 탐색 과정 출력 금지
3) 숫자(일수/금액)는 원문 형태 유지
4) 절차는 원문 구조 그대로
5) 반드시 출처 표기
6) 표가 존재하면 답변 첫 출력은 표 전체

출처 표기 형식:
- PPT: 파일명 / 슬라이드 제목
- Excel: 파일명 / 시트명 / 표 제목
- PDF: 파일명 / 조항 번호
- Word: 파일명 / 항목명

■ STEP 5. 규정 충돌 시 우선순위
1) 취업규칙
2) 인사규정
3) 세부 매뉴얼
4) 기타 안내자료

■ STEP 6. 헛소리 금지
- 근거에 없는 내용/수치/표 생성 금지
- "보통", "일반적으로" 금지
- 추정/해석/확대 설명 금지

■ STEP 7. Fallback 조건
관련 규정이 근거에서 확인되지 않으면 아래 문구를 정확히 그대로 출력:
"죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다."

■ STEP 8. 내부 사고 과정 출력 금지
탐색 과정, 판단 근거, 내부 점검 문구, 의도 분류 결과를 절대 출력하지 않는다.

■ STEP 9. 연차 자동 계산 예외 규칙 (의도 A 한정)
연차 일수 자동 산정 질문일 때만 계산을 허용하고, 그 외에는 근거 원문만 사용.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    const prompt = `
${rules}

아래의 입력 근거만으로 답변하세요.
근거 블록에 없는 내용은 절대로 작성하지 마세요.

질문:
${question}

근거:
${evidenceText}

출력 요구사항:
- 최종 답변만 한국어 Markdown으로 출력
- 표 근거가 있으면 표를 답변 첫 부분에 전체 출력
- 마지막 줄에 출처를 "출처: 파일명 / 항목" 형식으로 표기
`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        topP: 0.1,
      },
    });
    const text = result.response.text().trim();

    return text || null;
  } catch (error) {
    console.error("Gemini error:", error);
    return null;
  }
}