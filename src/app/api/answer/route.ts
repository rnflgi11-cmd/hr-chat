// src/app/api/answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { searchAnswer } from "@/lib/search/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const q = (body?.q ?? body?.question ?? "").toString().trim();
    if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

    const out = await searchAnswer(q);
    return NextResponse.json(out);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "answer error" }, { status: 500 });
  }
}