// src/app/api/answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// 아주 단순 의도 분류(초보용). 나중에 더 늘리면 됨.
function detectIntent(q: string) {
  if (/(연차|반차|시간연차|이월|촉진|발생|부여)/i.test(q)) return "연차";
  if (/(경조|결혼|조의|부고|장례|출산|배우자)/i.test(q)) return "경조";
  if (/(예비군|민방위|병역|훈련)/i.test(q)) return "병역";
  if (/(증명서|경력증명서|재직증명서)/i.test(q)) return "증명서";
  return "일반";
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const question = (body?.question ?? "").toString().trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const intent = detectIntent(question);
  const sb = sbAdmin();

  const { data: hits, error } = await sb.rpc("search_blocks", {
    q: question,
    limit_n: 8,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // “LLM처럼 보이는 구조” = 요약 + 근거 + 관련질문
  const top = (hits ?? []).slice(0, 3);

  const summary =
    top.length === 0
      ? "규정집에서 질문과 직접 일치하는 근거를 찾지 못했어요. 다른 키워드로 다시 질문해 주세요."
      : `(${intent}) 관련 규정 근거를 찾았어요. 아래 근거(표/문단)를 확인해 주세요.`;

  return NextResponse.json({
    ok: true,
    answer: {
      intent,
      summary,
      evidence: top.map((h: any) => ({
        filename: h.filename,
        block_type: h.block_type,
        content_text: h.content_text,
        content_html: h.content_html,
      })),
      related_questions:
        intent === "연차"
          ? ["연차 발생 기준은?", "시간연차는 어떻게 차감돼?", "연차 이월 기준은?"]
          : intent === "경조"
          ? ["경조휴가 일수는?", "경조금 지급 기준은?", "화환 신청 방법은?"]
          : intent === "병역"
          ? ["예비군/민방위는 연차 차감돼?", "증빙서류는 뭐야?", "공가로 처리돼?"]
          : ["신청 절차는 어떻게 돼?", "예외 케이스가 있어?", "필요 서류는 뭐야?"],
    },
  });
}