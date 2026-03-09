import { NextResponse } from "next/server";
import { searchAnswer } from "@/lib/search";

const FALLBACK =
  "현재 규정 검색 서비스(Supabase) 연결이 불안정하여 답변을 생성하지 못했습니다.\n\n" +
  "- 잠시 후 다시 시도해 주세요.\n" +
  "- 계속 발생하면 인사팀에 문의해 주세요.";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const q = (body?.q ?? body?.question ?? "").toString().trim();

    if (!q) {
      return NextResponse.json({
        ok: true,
        answer: "질문을 입력해 주세요.",
        hits: [],
        meta: { intent: "" },
      });
    }

    const result = await searchAnswer(q);

    const enableLLM = process.env.ENABLE_LLM === "1";

    const safeResult = { ...result };
    delete safeResult.llm_hits;

    return NextResponse.json(safeResult);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { ok: true, answer: FALLBACK, hits: [], meta: { intent: "" } },
      { status: 200 }
    );
  }
}