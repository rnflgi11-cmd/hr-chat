import "server-only";
import type { Evidence } from "@/lib/search/types";

type LlmRefineInput = {
  question: string;
  draftAnswer: string;
  intent: string;
  evidence: Evidence[];
};

const STRICT_FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

const HR_RULES_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[코비젼 HR GPT 운영 프롬프트 v5.4 – 표 1:1 복제 보장형]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ Role
당신은 [코비젼] 인사팀 HR 안내 담당자입니다.
직원 질문에 대해 반드시 제공된 evidence(규정 근거)와 draft answer만 근거로 답변합니다.
추론, 일반 상식, 인터넷 정보는 절대 사용하지 않습니다.

■ STEP 1. 질문 의도 내부 분류 (출력 금지)
A. 연차휴가
B. 잔여연차 / 연차수당
C. 기타 휴가 및 복리후생

■ STEP 2. 문서 탐색 규칙
이 단계는 이미 시스템이 수행했습니다. 당신은 전달된 evidence만 사용하세요.
실제로 확인하지 못한 내용 생성 금지.

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
6) 표 근거가 존재하면 답변 첫 출력은 표 전체

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
관련 규정이 evidence에서 확인되지 않으면 아래 문구를 정확히 그대로 출력:
"${STRICT_FALLBACK}"

■ STEP 8. 내부 사고 과정 출력 금지
탐색 과정, 판단 근거, 내부 점검 문구, 의도 분류 결과를 절대 출력하지 않는다.

■ STEP 9. 연차 자동 계산 예외 규칙 (의도 A 한정)
연차 일수 자동 산정 질문일 때만 계산을 허용하고, 그 외에는 근거 원문만 사용.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

function buildEvidenceSnippet(evidence: Evidence[]): string {
  return evidence
    .slice(0, 10)
    .map((e, i) => {
      const text = (e.content_text ?? "").replace(/\s+/g, " ").trim();
      const html = (e.content_html ?? "").replace(/\s+/g, " ").trim();
      return `${i + 1}. [${e.block_type}] ${text || html}`;
    })
    .join("\n");
}

function isLlmEnabled() {
  return process.env.ENABLE_LLM === "1" || process.env.ENABLE_LLM_ANSWER === "1";
}

export async function refineAnswerWithLlm(input: LlmRefineInput): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !isLlmEnabled()) return null;

  const model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";

  const prompt = [
    HR_RULES_PROMPT,
    "질문:",
    input.question,
    "",
    "의도:",
    input.intent,
    "",
    "draft answer:",
    input.draftAnswer,
    "",
    "evidence:",
    buildEvidenceSnippet(input.evidence),
    "",
    "출력 요구사항:",
    "- 최종 답변 Markdown 본문만 출력",
    "- 내부 분류/사고과정/점검 문구 출력 금지",
    "- evidence와 draft answer 범위 밖 정보 생성 금지",
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
        },
      }),
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p?.text ?? "")
    .join("\n")
    .trim();

  return text || null;
}