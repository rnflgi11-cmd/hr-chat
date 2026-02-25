// src/app/api/answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { searchAnswer } from "@/lib/search"; // 너희 경로에 맞게

const FALLBACK =
  "현재 규정 검색 서비스(Supabase) 연결이 불안정하여 답변을 생성하지 못했습니다.\n\n" +
  "- 잠시 후 다시 시도해 주세요.\n" +
  "- 계속 발생하면 인사팀에 문의해 주세요.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const q = (body?.q ?? body?.question ?? "").toString().trim();

    if (!q) {
      return NextResponse.json({ ok: true, answer: "질문을 입력해 주세요.", hits: [], meta: { intent: "" } });
    }

    const result = await searchAnswer(q);
    return NextResponse.json(result);
  } catch (err: any) {
    // ✅ HTML(Cloudflare 502 페이지) 같은 게 화면에 박히는 걸 방지
    return NextResponse.json(
      { ok: true, answer: FALLBACK, hits: [], meta: { intent: "" } },
      { status: 200 }
    );
  }
}