import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Hit = {
  document_id: string;
  filename: string;
  chunk_index: number;
  content: string;
  sim?: number;
};

const FALLBACK = "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀으로 문의해 주시기 바랍니다.";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** ✅ 표와 일반 텍스트를 통합 복원하는 핵심 함수 */
function rebuildUnifiedContent(hits: Hit[]): string {
  // 1. 모든 조각의 내용을 하나로 합침 (조각 간 분절 문제 해결)
  const fullText = hits.map(h => h.content).join("\n");
  const rawLines = fullText.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  let result = "";
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // --- [경조휴가 표 처리] ---
    if (line === "구분" && rawLines[i+1] === "경조유형") {
      const headers = ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"];
      result += "\n\n```text\n| " + headers.join(" | ") + " |\n| " + headers.map(() => "---").join(" | ") + " |\n";
      i += 6; // 헤더 건너뛰기
      
      let cells: string[] = [];
      while (i < rawLines.length && !rawLines[i].startsWith("✅") && !rawLines[i].startsWith("📌")) {
        cells.push(rawLines[i]);
        if (cells.length === 6) {
          result += `| ${cells.join(" | ")} |\n`;
          cells = [];
        }
        i++;
      }
      result += "```\n";
      continue;
    }

    // --- [기타휴가/공가 표 처리 - 훈련 기간 문제 해결] ---
    if (line === "구분" && rawLines[i+1] === "유형" && rawLines[i+2] === "내용") {
      const headers = ["구분", "유형", "내용", "휴가일수", "첨부서류", "비고"];
      result += "\n\n```text\n| " + headers.join(" | ") + " |\n| " + headers.map(() => "---").join(" | ") + " |\n";
      i += 6;

      let currentGroup = "";
      let rowBuffer: string[] = [];
      const groups = ["법정·의무 휴가", "직무·회사관련 휴가", "개인사유 휴가"];

      while (i < rawLines.length && !rawLines[i].startsWith("✅") && !rawLines[i].startsWith("📌")) {
        const val = rawLines[i];
        if (groups.includes(val)) {
          if (rowBuffer.length > 0) result += `| ${currentGroup} | ${rowBuffer.join(" ").padEnd(5, "|").replace(/ /g, " | ")} |\n`;
          currentGroup = val;
          rowBuffer = [];
        } else {
          rowBuffer.push(val);
          // 데이터가 5개 모이거나 다음이 그룹명이면 행 생성
          const next = rawLines[i+1];
          if (rowBuffer.length >= 5 || (next && groups.includes(next))) {
            const row = [currentGroup];
            for(let j=0; j<5; j++) row.push(rowBuffer[j] || "");
            result += `| ${row.join(" | ")} |\n`;
            rowBuffer = rowBuffer.slice(5);
          }
        }
        i++;
      }
      result += "```\n";
      continue;
    }

    // --- [일반 텍스트 처리] ---
    if (line.startsWith("●") || line.startsWith("◊") || line.startsWith("※") || line.startsWith("✅") || line.startsWith("📌")) {
      result += "\n" + line;
    } else {
      result += " " + line;
    }
    i++;
  }

  return result.trim();
}

export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { question } = await req.json();

    // 1. 단순 키워드 추출 및 검색
    const tokens = question.split(" ").filter((w: string) => w.length > 1);
    let { data: hits } = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question, tokens, match_count: 15, min_sim: 0.1
    });

    if (!hits || hits.length === 0) return NextResponse.json({ answer: FALLBACK });

    // 2. 통합 복원 로직 실행
    const answerBody = rebuildUnifiedContent(hits);
    const sourceInfo = `\n\n[출처]\n- ${hits[0].filename}`;

    return NextResponse.json({
      answer: answerBody + sourceInfo,
      citations: hits
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}