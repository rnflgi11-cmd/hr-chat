import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function classifyIntent(q: string): "A" | "B" | "C" {
  const s = q.replace(/\s+/g, " ").trim();
  const A = ["연차", "반차", "시간연차", "이월", "차감", "연차 발생", "연차 부여", "연차 신청"];
  const B = ["잔여연차", "연차수당", "연차비", "미사용 연차", "정산", "지급", "수당"];
  const C = [
    "경조",
    "결혼",
    "조위",
    "출산",
    "배우자",
    "공가",
    "민방위",
    "예비군",
    "건강검진",
    "가족돌봄",
    "특별휴가",
    "화환",
    "복리후생",
    "증명서",
    "재직",
  ];
  if (B.some((k) => s.includes(k))) return "B";
  if (A.some((k) => s.includes(k))) return "A";
  if (C.some((k) => s.includes(k))) return "C";
  return "C";
}

function extractTokens(q: string): string[] {
  const s = q
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = s.split(" ").filter((w) => w.length >= 2);

  const force: string[] = [];
  if (q.includes("화환")) force.push("화환", "신청", "절차");
  if (q.includes("경조")) force.push("경조", "휴가", "경조휴가");
  if (q.includes("결혼")) force.push("결혼", "경조휴가");
  if (q.includes("조위") || q.includes("부고") || q.includes("장례")) force.push("조위", "경조");
  if (q.includes("출산")) force.push("출산", "휴가");
  if (q.includes("배우자")) force.push("배우자", "출산", "휴가");
  if (q.includes("민방위") || q.includes("예비군")) force.push("민방위", "예비군", "공가", "휴가");

  return Array.from(new Set([...force, ...base])).slice(0, 12);
}

function pickFileHint(q: string, intent: "A" | "B" | "C"): string | null {
  const s = q.toLowerCase();
  if (intent === "A") return "연차";
  if (intent === "B") return "연차";
  if (s.includes("화환")) return "화환";
  if (s.includes("경조") || s.includes("결혼") || s.includes("조위") || s.includes("부고") || s.includes("장례"))
    return "경조";
  if (s.includes("출산") || s.includes("배우자") || s.includes("민방위") || s.includes("예비군")) return "휴가";
  if (s.includes("복리후생") || s.includes("건강검진")) return "복리후생";
  if (s.includes("증명서") || s.includes("재직")) return "증명";
  return null;
}

const FALLBACK =
  '죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.';

type Hit = {
  document_id: string;
  filename: string;
  chunk_index: number;
  content: string;
  sim?: number;
};

/**
 * ✅ (핵심) DOCX에서 "표 셀들이 줄바꿈으로 풀려 저장"된 경우,
 *  - 헤더 라인을 찾고
 *  - N열씩 묶어서 Markdown 표로 복원
 */
function rebuildFlatTableToMarkdown(text: string): string | null {
  const rawLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 10) return null;

  // 흔한 표 헤더 후보(회사 규정에서 자주 나오는 컬럼)
  const headerCandidates = [
    ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"], // 경조휴가
    ["구분", "내용"], // 간단 2열
    ["항목", "지원대상", "신청기준일"], // 복리후생류
    ["구분", "기준", "포상 금액"], // 포상
    ["구분", "내용", "지급 비용", "비고"], // 수당류
  ];

  function findHeaderIndex(headers: string[]) {
    // 연속으로 헤더가 나열된 구간을 찾기
    for (let i = 0; i <= rawLines.length - headers.length; i++) {
      let ok = true;
      for (let j = 0; j < headers.length; j++) {
        if (rawLines[i + j] !== headers[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  for (const headers of headerCandidates) {
    const hIdx = findHeaderIndex(headers);
    if (hIdx === -1) continue;

    const after = rawLines.slice(hIdx + headers.length);
    const cols = headers.length;

    // 최소 1행 이상이 나와야 표라고 판단
    if (after.length < cols) continue;

    // rows로 쪼개기(나머지가 딱 안 맞아도, 가능한 만큼만 표로 만듦)
    const rowCount = Math.floor(after.length / cols);
    if (rowCount <= 0) continue;

    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(after.slice(r * cols, r * cols + cols));
    }

    // Markdown 표 생성
    const md: string[] = [];
    md.push(`| ${headers.join(" | ")} |`);
    md.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      md.push(`| ${row.map((c) => c.replace(/\|/g, "｜")).join(" | ")} |`);
    }

    // 표 앞에 남은 텍스트(제목/설명)가 있으면 위에 붙이고
    // 표 뒤에 남은 텍스트(각주/추가설명)가 있으면 아래에 붙임
    const beforePart = rawLines.slice(0, hIdx).join("\n");
    const used = rowCount * cols;
    const tail = after.slice(used).join("\n");

    const out = [
      beforePart ? beforePart : null,
      md.join("\n"),
      tail ? tail : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    return out;
  }

  return null;
}

function formatChunkContent(content: string): string {
  const rebuilt = rebuildFlatTableToMarkdown(content);
  return (rebuilt ?? content).trim();
}

function toAnswer(hits: Hit[], intent: "A" | "B" | "C") {
  // ✅ 표가 있으면 표가 먼저 보이도록: 가장 “길고 구조적인” chunk를 앞에 배치
  const sorted = [...hits].sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));

  const body =
    `분류: 의도 ${intent}\n\n` +
    sorted
      .map((h) => {
        const formatted = formatChunkContent((h.content ?? "").toString());
        return `[${h.filename} / 조각 ${h.chunk_index}]\n${formatted}`;
      })
      .join("\n\n────────────────────────\n\n");

  const citations = sorted.map((h) => ({ filename: h.filename, chunk_index: h.chunk_index }));
  return { text: body, citations };
}

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
    const tokens = extractTokens(question);
    const fileHint = pickFileHint(question, intent);

    // 1) 전체 문서에서 후보 찾기
    let { data: hits, error } = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question,
      tokens,
      file_hint: fileHint,
      match_count: 10,
      min_sim: 0.12,
    });
    if (error) throw new Error(error.message);

    if (!hits || hits.length === 0) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: null,
        match_count: 10,
        min_sim: 0.12,
      });
      hits = retry.data ?? [];
    }

    if (!hits || hits.length === 0) {
      return NextResponse.json({ answer: `분류: 의도 ${intent}\n\n${FALLBACK}`, citations: [] });
    }

    // 2) 문서락(가장 잘 맞는 문서 1개 고름)
    const scoreByDoc = new Map<string, { sum: number; count: number; filename: string }>();
    for (const h of hits as Hit[]) {
      const key = h.document_id;
      const cur = scoreByDoc.get(key) ?? { sum: 0, count: 0, filename: h.filename };
      const sim = typeof h.sim === "number" ? h.sim : 0;
      cur.sum += sim;
      cur.count += 1;
      cur.filename = h.filename;
      scoreByDoc.set(key, cur);
    }

    const rankedDocs = Array.from(scoreByDoc.entries())
      .map(([docId, v]) => ({ docId, filename: v.filename, score: v.sum + v.count * 0.15 }))
      .sort((a, b) => b.score - a.score);

    const bestDocId = rankedDocs[0]?.docId;
    if (!bestDocId) {
      return NextResponse.json({ answer: `분류: 의도 ${intent}\n\n${FALLBACK}`, citations: [] });
    }

    // 3) 선택된 문서 안에서만 재검색(잡탕 제거 유지)
    const { data: lockedHits, error: lockErr } = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId,
      q: question,
      tokens,
      match_count: 10,
      min_sim: 0.10,
    });
    if (lockErr) throw new Error(lockErr.message);

    const finalHits: Hit[] =
      (lockedHits && lockedHits.length ? lockedHits : hits)
        .slice(0, 6) // ✅ 출력 품질 위해 4 → 6으로 증가(예시/비고 누락 감소)
        .map((h: any) => ({
          document_id: h.document_id,
          filename: h.filename,
          chunk_index: h.chunk_index,
          content: h.content,
          sim: h.sim,
        }));

    const { text, citations } = toAnswer(finalHits, intent);
    return NextResponse.json({ answer: text, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
