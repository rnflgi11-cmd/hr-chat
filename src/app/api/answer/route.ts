// src/app/api/answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { searchAnswer } from "@/lib/search"; // 너희 경로에 맞게
import { generateGeminiAnswer } from "@/lib/gemini";

const FALLBACK =
  "현재 규정 검색 서비스(Supabase) 연결이 불안정하여 답변을 생성하지 못했습니다.\n\n" +
  "- 잠시 후 다시 시도해 주세요.\n" +
  "- 계속 발생하면 인사팀에 문의해 주세요.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ✅ debug=1 이면 후보(hits) 미리보기(meta에) 같이 내려줌
    const debug = req.nextUrl.searchParams.get("debug") === "1";

    const body = await req.json();
    const q = (body?.q ?? body?.question ?? "").toString().trim();

    if (!q) {
      return NextResponse.json({
        ok: true,
        answer: "질문을 입력해 주세요.",
        hits: [],
        meta: { intent: "", debug },
      });
    }

    const result = await searchAnswer(q);

    const enableLLM = process.env.ENABLE_LLM === "1";

if (enableLLM && result?.hits?.length) {
  const gemini = await generateGeminiAnswer(
    q,
    result.answer,
    result.hits
  );

  if (gemini) {
    result.answer = gemini;
  }
}

    if (debug) {
      const previews = (result.hits ?? []).slice(0, 12).map((h: any) => {
        const text = (h.content_text ?? "").toString().replace(/\s+/g, " ").slice(0, 140);
        const html = (h.content_html ?? "").toString().replace(/\s+/g, " ").slice(0, 140);
        return `${h.filename ?? ""} | ${h.block_type}: ${text || html}`;
      });

      return NextResponse.json({
        ...result,
        meta: {
          ...(result.meta ?? {}),
          debug: true,
          top_hit_preview: previews,
        },
      });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { ok: true, answer: FALLBACK, hits: [], meta: { intent: "" } },
      { status: 200 }
    );
  }
}