import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function classifyIntent(q: string): "A" | "B" | "C" {
  const s = q.replace(/\s+/g, " ").trim();
  const A = ["연차", "반차", "시간연차", "이월", "차감", "연차 발생", "연차 부여", "연차 신청"];
  const B = ["잔여연차", "연차수당", "연차비", "미사용 연차", "정산", "지급", "수당"];
  if (B.some((k) => s.includes(k))) return "B";
  if (A.some((k) => s.includes(k))) return "A";
  return "C";
}

function pickFileHint(q: string): string | null {
  const s = q.toLowerCase();
  if (s.includes("화환")) return "화환";
  if (s.includes("경조") || s.includes("결혼") || s.includes("조위")) return "경조";
  if (s.includes("출산")) return "휴가";
  if (s.includes("민방위") || s.includes("예비군")) return "휴가";
  if (s.includes("연차")) return "연차";
  return null;
}

// 🔥 Word 느낌 재구성 함수
function formatLikeWord(text: string) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let result: string[] = [];

  for (let line of lines) {
    // 번호 목록 감지
    if (/^(\d+\.|\d+\)|[①-⑳]|■|▶|-)\s*/.test(line)) {
      result.push(line);
      continue;
    }

    // 구분/유형/대상 표 구조 감지
    if (line.includes("구분") && line.includes("유형")) {
      result.push("\n[표]\n" + line);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

const FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await req.json();
    const question: string = (body?.question ?? "").toString().trim();
    const user = body?.user;

    if (!question || !user) {
      return NextResponse.json({ error: "question/user missing" }, { status: 400 });
    }

    const intent = classifyIntent(question);
    const fileHint = pickFileHint(question);

    let { data: hits, error } = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question,
      tokens: [question],
      file_hint: fileHint,
      match_count: 5,
      min_sim: 0.12,
    });

    if (error) throw new Error(error.message);

    if (!hits || hits.length === 0) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens: [question],
        file_hint: null,
        match_count: 5,
        min_sim: 0.12,
      });
      hits = retry.data ?? [];
    }

    if (!hits || hits.length === 0) {
      return NextResponse.json({
        answer: `분류: 의도 ${intent}\n\n${FALLBACK}`,
      });
    }

    const top = hits.slice(0, 3);

    const formatted = top
      .map((h: any) => {
        const formattedText = formatLikeWord(h.content || "");
        return `\n[${h.filename}]\n${formattedText}`;
      })
      .join("\n\n────────────────────────\n");

    return NextResponse.json({
      answer: `분류: 의도 ${intent}\n\n${formatted}`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
