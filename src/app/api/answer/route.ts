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
function rebuildFlatTableWithContext(text: string): string | null {
  const rawLines = text
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
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
        if (rawLines[i + j] !== headers[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  // 표 다음에 붙는 “다른 섹션 시작”을 만나면 표 rows 계산을 끊기 위한 stop 신호
  // (단, 표 아래 설명은 살려야 하니까 "표 데이터 계산"만 끊고, 나머지는 아래에 그대로 붙임)
  const sectionStarts = new Set([
    "기타", "참고사항", "유의사항", "신청방법", "지급일", "지급시점", "사용 절차", "사용절차",
  ]);

  for (const headers of headerCandidates) {
    const hIdx = findHeaderIndex(headers);
    if (hIdx === -1) continue;

    const cols = headers.length;

    // ✅ 표 위쪽(제목/설명) 보존
    const before = rawLines.slice(0, hIdx).join("\n").trim();

    const after = rawLines.slice(hIdx + headers.length);

    // 표 데이터는 “연속 cols 묶음”으로만 계산
    // 그런데 표 아래에 유의/기타 등이 붙으면, 그 지점부터는 row 계산을 멈춰야 함
    let cutForRowCalc = after.length;
    for (let i = 0; i < after.length; i++) {
      if (sectionStarts.has(after[i])) { cutForRowCalc = i; break; }
    }

    const tableArea = after.slice(0, cutForRowCalc);
    const tail = after.slice(cutForRowCalc).join("\n").trim(); // ✅ 표 아래 설명 보존

    const rowCount = Math.floor(tableArea.length / cols);
    if (rowCount <= 0) continue;

    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r++) {
      rows.push(tableArea.slice(r * cols, r * cols + cols));
    }

    const md: string[] = [];
    md.push(`| ${headers.join(" | ")} |`);
    md.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      md.push(`| ${row.map((c) => c.replace(/\|/g, "｜")).join(" | ")} |`);
    }

    // ✅ 결과: (표 위) + (표) + (표 아래)
    const outParts = [];
    if (before) outParts.push(before);
    outParts.push(md.join("\n"));
    if (tail) outParts.push(tail);

    return outParts.join("\n\n").trim();
  }

  return null;
}

/** ✅ Markdown 표를 "항상 보이는" 고정폭 텍스트 표로 변환 */
function mdTableToPlain(md: string): string {
  const lines = md.split("\n").map((l) => l.trim());
  const tableLines = lines.filter((l) => l.startsWith("|") && l.endsWith("|"));
  if (tableLines.length < 3) return md;

  const rows = tableLines.map((l) =>
    l
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim())
  );

  const header = rows[0];
  const body = rows.slice(2);

  const colCount = header.length;
  const widths = new Array(colCount).fill(0);

  const all = [header, ...body];
  for (const r of all) {
    for (let i = 0; i < colCount; i++) {
      const v = (r[i] ?? "").toString();
      widths[i] = Math.max(widths[i], v.length);
    }
  }

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const joinRow = (r: string[]) =>
    "│ " + r.map((c, i) => pad((c ?? "").toString(), widths[i])).join(" │ ") + " │";

  const top = "┌ " + widths.map((w) => "─".repeat(w)).join(" ┬ ") + " ┐";
  const mid = "├ " + widths.map((w) => "─".repeat(w)).join(" ┼ ") + " ┤";
  const bot = "└ " + widths.map((w) => "─".repeat(w)).join(" ┴ ") + " ┘";

  const out: string[] = [];
  out.push(top);
  out.push(joinRow(header));
  out.push(mid);
  for (const r of body) out.push(joinRow(r));
  out.push(bot);
  return out.join("\n");
}

/** 문서 내 마크다운 표 블록을 전부 plain table로 치환 */
function makeTablesAlwaysReadable(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  let inTable = false;

  const flush = () => {
    if (buf.length) {
      const md = buf.join("\n");
      out.push(mdTableToPlain(md));
      buf = [];
    }
  };

  for (const l of lines) {
    const t = l.trim();
    const isTableLine = t.startsWith("|") && t.endsWith("|");
    if (isTableLine) {
      inTable = true;
      buf.push(t);
    } else {
      if (inTable) {
        flush();
        inTable = false;
      }
      out.push(l);
    }
  }
  if (inTable) flush();

  return out.join("\n").trim();
}

/** 최종 chunk 포맷 */
function formatChunkContent(content: string): string {
  const rebuilt = rebuildFlatTableWithContext(content);
  const text = (rebuilt ?? content).trim();
  return makeTablesAlwaysReadable(text);
}

function toAnswer(hits: Hit[], intent: "A" | "B" | "C") {
  // 길고 구조적인 것을 우선
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

    // ✅ 질문 토큰 포함률 기반으로 chunk를 재정렬/필터하여 "기타" 등 엉뚱한 섹션 섞임을 줄임
    const must = extractTokens(question);
    function tokenHitRate(t: string) {
      const lower = (t ?? "").toLowerCase();
      const hit = must.filter((k) => lower.includes(k.toLowerCase())).length;
      return hit / Math.max(1, must.length);
    }

    const scored = pool
      .map((h) => ({ ...h, rate: tokenHitRate(h.content ?? "") }))
      .sort((a, b) => (b.rate - a.rate) || ((b.content?.length ?? 0) - (a.content?.length ?? 0)));

    const finalHits: Hit[] = scored.slice(0, 4).map((h) => ({
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
