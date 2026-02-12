// src/app/api/answer/route.ts
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

const FALLBACK =
  '죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** STEP 1: intent */
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
    "프로젝트",
    "휴일근무",
    "평일심야",
  ];

  if (B.some((k) => s.includes(k))) return "B";
  if (A.some((k) => s.includes(k))) return "A";
  if (C.some((k) => s.includes(k))) return "C";
  return "C";
}

/** search tokens */
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
  if (q.includes("프로젝트")) force.push("프로젝트", "수당", "기준", "신청");
  if (q.includes("휴일근무")) force.push("휴일근무", "수당", "신청");
  if (q.includes("평일") && q.includes("심야")) force.push("평일", "심야", "근무off", "신청");

  return Array.from(new Set([...force, ...base])).slice(0, 12);
}

function pickFileHint(q: string, intent: "A" | "B" | "C"): string | null {
  const s = q.toLowerCase();

  if (intent === "A") return "연차";
  if (intent === "B") return "연차";

  if (s.includes("화환")) return "화환";
  if (s.includes("경조") || s.includes("결혼") || s.includes("조위") || s.includes("부고") || s.includes("장례"))
    return "경조";
  if (s.includes("출산") || s.includes("배우자")) return "휴가";
  if (s.includes("민방위") || s.includes("예비군")) return "휴가";
  if (s.includes("복리후생") || s.includes("건강검진") || s.includes("공부하go") || s.includes("즐기go"))
    return "복리후생";
  if (s.includes("증명서") || s.includes("재직")) return "증명";
  if (s.includes("프로젝트") && s.includes("수당")) return "프로젝트";
  if (s.includes("휴일근무")) return "휴일근무";

  return null;
}

/**
 * ✅ DOCX 표가 "셀 텍스트가 줄바꿈으로 풀린 형태"로 저장된 경우:
 * - 헤더 시퀀스를 찾고 N열씩 묶어서 Markdown 표로 복원
 * - 표 뒤에 딸려오는 다른 섹션(예: "기타")은 잘라내는 쪽으로 처리
 */
function rebuildFlatTableToMarkdownOnly(text: string): string | null {
  const rawLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 10) return null;

  const headerCandidates = [
    ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"],
    ["구분", "내용"],
    ["항목", "지원대상", "신청 기준일"],
    ["항목", "지원 대상", "신청 기준일"],
    ["구분", "기준", "포상 금액"],
    ["구분", "내용", "지급 비용", "비고"],
    ["구분", "내용", "지급비용", "비고"],
  ];

  function findHeaderIndex(headers: string[]) {
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

  const stopWords = new Set([
    "기타",
    "병역의무",
    "민방위",
    "예비군",
    "훈련",
    "증명서",
    "참고사항",
    "유의사항",
    "신청방법",
    "지급일",
    "지급시점",
  ]);

  for (const headers of headerCandidates) {
    const hIdx = findHeaderIndex(headers);
    if (hIdx === -1) continue;

    const cols = headers.length;
    const after = rawLines.slice(hIdx + headers.length);

    // 표 데이터가 시작된 이후, "기타/민방위/예비군..." 같은 섹션 시작 단어가 나오면 거기서 끊기
    let cut = after.length;
    for (let i = 0; i < after.length; i++) {
      const v = after[i];
      if (stopWords.has(v)) {
        cut = i;
        break;
      }
    }
    const afterCut = after.slice(0, cut);

    const rowCount = Math.floor(afterCut.length / cols);
    if (rowCount <= 0) continue;

    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(afterCut.slice(r * cols, r * cols + cols));
    }

    const md: string[] = [];
    md.push(`| ${headers.join(" | ")} |`);
    md.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      md.push(`| ${row.map((c) => c.replace(/\|/g, "｜")).join(" | ")} |`);
    }

    // ✅ 표만 반환 (앞/뒤 문장 섞지 않음)
    return md.join("\n");
  }

  return null;
}

/** 본문을 "섹션 단위"로 잘라서 질문과 가장 관련 높은 섹션만 남기기 */
function pickBestSectionByTokens(content: string, mustTokens: string[]): string {
  const blocks = content
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length <= 1) return content.trim();

  const score = (txt: string) => {
    const lower = txt.toLowerCase();
    const hit = mustTokens.filter((k) => lower.includes(k.toLowerCase())).length;
    // 표/헤더가 있는 블록이면 가점
    const hasTable =
      (txt.includes("|") && txt.includes("---")) ||
      txt.includes("구분") ||
      txt.includes("경조유형") ||
      txt.includes("휴가일수");
    return hit + (hasTable ? 2 : 0) + Math.min(1, txt.length / 2000);
  };

  const ranked = blocks
    .map((b) => ({ b, s: score(b) }))
    .sort((a, b) => b.s - a.s);

  // 가장 관련 높은 1~2개만 (너무 길게 붙지 않게)
  const top = ranked.slice(0, 2).map((x) => x.b);

  return top.join("\n\n").trim();
}

/** 최종 chunk 포맷: (1) 표 복원 가능하면 표만 출력, (2) 아니면 섹션에서 가장 관련 높은 부분만 */
function formatChunkContent(content: string, mustTokens: string[]): string {
  // 1) "한 줄씩 풀린 표"를 Markdown 표로 복원 (표만 반환)
  const rebuiltTableOnly = rebuildFlatTableToMarkdownOnly(content);
  if (rebuiltTableOnly) return rebuiltTableOnly.trim();

  // 2) 이미 Markdown 표가 들어있는 경우: 표가 있는 블록만 선택되도록 섹션 선택
  const best = pickBestSectionByTokens(content, mustTokens);

  // 3) 마지막: 그냥 원문
  return best.trim();
}

function toAnswer(hits: Hit[], intent: "A" | "B" | "C", mustTokens: string[]) {
  // 길고 구조적인 것을 우선 (표/섹션 우선)
  const sorted = [...hits].sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));

  const body =
    `분류: 의도 ${intent}\n\n` +
    sorted
      .map((h) => {
        const formatted = formatChunkContent((h.content ?? "").toString(), mustTokens);
        return `📌 ${h.filename}\n${formatted}\n\n출처: ${h.filename} / 조각 ${h.chunk_index}`;
      })
      .join("\n\n────────────────────────\n\n");

  const citations = sorted.map((h) => ({ filename: h.filename, chunk_index: h.chunk_index }));
  return { text: body.trim(), citations };
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

    // fallback 재검색
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

    // 2) 문서락(가장 잘 맞는 문서 1개)
    const scoreByDoc = new Map<string, { sum: number; count: number; filename: string }>();
    for (const h of hits as any[]) {
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

    // 3) 선택된 문서 안에서만 재검색(잡탕 제거)
    const { data: lockedHits, error: lockErr } = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId,
      q: question,
      tokens,
      match_count: 12,
      min_sim: 0.10,
    });
    if (lockErr) throw new Error(lockErr.message);

    const pool = (lockedHits && lockedHits.length ? lockedHits : hits) as any[];

    // 4) 질문 토큰 포함률로 재정렬 (엉뚱한 섹션 섞임 최소화)
    const must = extractTokens(question);
    function tokenHitRate(t: string) {
      const lower = (t ?? "").toLowerCase();
      const hit = must.filter((k) => lower.includes(k.toLowerCase())).length;
      return hit / Math.max(1, must.length);
    }

    const scored = pool
      .map((h) => ({ ...h, rate: tokenHitRate(h.content ?? "") }))
      .sort((a, b) => (b.rate - a.rate) || ((b.content?.length ?? 0) - (a.content?.length ?? 0)));

    const finalHits: Hit[] = scored.slice(0, 3).map((h) => ({
      document_id: h.document_id,
      filename: h.filename,
      chunk_index: h.chunk_index,
      content: h.content,
      sim: h.sim,
    }));

    const { text, citations } = toAnswer(finalHits, intent, must);
    return NextResponse.json({ answer: text, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
