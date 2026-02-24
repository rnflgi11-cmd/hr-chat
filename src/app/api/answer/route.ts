import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function detectIntent(q: string) {
  if (/(연차|반차|시간연차|이월|촉진|발생|부여|안식년)/i.test(q)) return "휴가";
  if (/(경조|결혼|조의|부고|장례|출산|배우자|경조금)/i.test(q)) return "경조";
  if (/(예비군|민방위|병역|훈련)/i.test(q)) return "병역";
  if (/(증명서|경력증명서|재직증명서)/i.test(q)) return "증명서";
  if (/(자산|장비|지급|구매|사무용품)/i.test(q)) return "자산/구매";
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

  const top = (hits ?? []).slice(0, 4);

  const answer = {
    intent,
    summary:
      top.length === 0
        ? "규정집에서 질문과 직접 일치하는 근거를 찾지 못했어요. 다른 키워드로 다시 질문해 주세요."
        : `(${intent}) 관련 규정 근거를 찾았어요. 아래 근거(표/문단)를 확인해 주세요.`,
    evidence: top.map((h: any) => ({
      filename: h.filename,
      block_type: h.block_type,
      content_text: h.content_text,
      content_html: h.content_html,
    })),
    related_questions:
      intent === "휴가"
        ? ["안식년 기준은?", "연차 발생 기준은?", "연차 이월 기준은?"]
        : intent === "경조"
        ? ["경조휴가 일수는?", "경조금 지급 기준은?", "화환 신청 방법은?"]
        : intent === "자산/구매"
        ? ["자산/장비 지급 기준은?", "사무용품 구매 절차는?", "반납/회수 기준은?"]
        : ["신청 절차는 어떻게 돼?", "예외 케이스가 있어?", "필요 서류는 뭐야?"],
  };

  return NextResponse.json({ ok: true, answer });
}