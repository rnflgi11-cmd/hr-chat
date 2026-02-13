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
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

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
    "경조", "결혼", "조위", "출산", "배우자", "공가", "민방위", "예비군", "건강검진",
    "가족돌봄", "특별휴가", "화환", "복리후생", "증명서", "재직", "프로젝트",
    "휴일근무", "평일심야",
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

  return Array.from(new Set([...force, ...base])).slice(0, 14);
}

function pickFileHint(q: string, intent: "A" | "B" | "C"): string | null {
  const s = q.toLowerCase();
  if (intent === "A") return "연차";
  if (intent === "B") return "연차";
  if (s.includes("화환")) return "화환";
  if (s.includes("경조") || s.includes("결혼") || s.includes("조위") || s.includes("부고") || s.includes("장례")) return "경조";
  if (s.includes("출산") || s.includes("배우자")) return "휴가";
  if (s.includes("민방위") || s.includes("예비군")) return "휴가";
  if (s.includes("복리후생") || s.includes("건강검진")) return "복리후생";
  if (s.includes("증명서") || s.includes("재직")) return "증명";
  return null;
}

/** ✅ 표 복원기 개선 버전 */
function rebuildFlatTableWithContext(text: string): { rebuilt: string; hasTable: boolean } {
  const raw = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (raw.length < 5) return { rebuilt: (text ?? "").toString().trim(), hasTable: false };

  type Cand = {
    headers: string[];
    kind?: "default" | "leave6" | "leaveStructured";
    firstColAllow?: Set<string>;
  };

  const cands: Cand[] = [
    { headers: ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"], kind: "default", firstColAllow: new Set(["경사", "조의"]) },
    { headers: ["구분", "유형", "내용", "휴가일수", "첨부서류", "비고"], kind: "leaveStructured" },
    { headers: ["구분", "내용"], kind: "default" },
  ];

  const sectionStarts = new Set(["참고사항", "유의사항", "신청방법", "지급일", "사용절차", "✅", "📌"]);
  const isDivider = (s: string) => /^[─-]{5,}$/.test(s.replace(/\s+/g, ""));

  function matchHeaderAt(i: number): Cand | null {
    for (const cand of cands) {
      const h = cand.headers;
      if (i + h.length > raw.length) continue;
      if (h.every((header, idx) => raw[i + idx] === header)) return cand;
    }
    return null;
  }

  function parseLeaveStructured(lines: string[]): string[][] {
    const rows: string[][] = [];
    let currentGroup = "";
    let buf: string[] = [];

    const isGroupTitle = (s: string) => s.includes("휴가") && !s.includes("휴가일수") && !["구분", "유형", "내용", "비고"].includes(s);

    for (const s of lines) {
      if (isDivider(s) || ["구분", "유형", "내용", "휴가일수", "첨부서류", "비고"].includes(s)) continue;

      if (isGroupTitle(s)) {
        if (buf.length > 0 && currentGroup) {
          while (buf.length < 5) buf.push("");
          rows.push([currentGroup, ...buf.slice(0, 5)]);
        }
        currentGroup = s;
        buf = [];
        continue;
      }

      if (!currentGroup) continue;
      buf.push(s);

      if (buf.length >= 5) {
        rows.push([currentGroup, ...buf.slice(0, 5)]);
        buf = buf.slice(5);
      }
    }
    if (buf.length > 0 && currentGroup) {
      const lastRow = [currentGroup];
      for (let i = 0; i < 5; i++) lastRow.push(buf[i] || "");
      rows.push(lastRow);
    }
    return rows;
  }

  function parseTable(from: number, cand: Cand): { md: string; consumedUntil: number; hasTable: boolean } {
    const cols = cand.headers.length;
    let i = from + cols;
    const cells: string[] = [];

    while (i < raw.length) {
      if (matchHeaderAt(i) || raw[i].startsWith("✅") || raw[i].startsWith("📌")) break;
      cells.push(raw[i]);
      i++;
    }

    let rows: string[][] = [];
    if (cand.kind === "leaveStructured") {
      rows = parseLeaveStructured(cells);
    } else {
      const rowCount = Math.floor(cells.length / cols);
      for (let r = 0; r < rowCount; r++) {
        const row = cells.slice(r * cols, r * cols + cols);
        if (cand.firstColAllow && !cand.firstColAllow.has(row[0])) break;
        rows.push(row);
      }
    }

    if (!rows.length) return { md: "", consumedUntil: from + 1, hasTable: false };

    const mdLines = [
      `| ${cand.headers.join(" | ")} |`,
      `| ${cand.headers.map(() => "---").join(" | ")} |`,
      ...rows.map(r => `| ${r.map(c => c.replace(/\|/g, "｜").replace(/\n/g, " ")).join(" | ")} |`)
    ];

    return { md: "```text\n" + mdLines.join("\n") + "\n```", consumedUntil: i, hasTable: true };
  }

  const out: string[] = [];
  let idx = 0;
  let foundAny = false;

  while (idx < raw.length) {
    const cand = matchHeaderAt(idx);
    if (!cand) {
      out.push(raw[idx]);
      idx++;
      continue;
    }
    const parsed = parseTable(idx, cand);
    if (!parsed.hasTable) {
      out.push(raw[idx]);
      idx++;
    } else {
      foundAny = true;
      out.push(parsed.md);
      idx = parsed.consumedUntil;
    }
  }

  return { rebuilt: out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(), hasTable: foundAny };
}

/** 기타 유틸리티 함수 */
function cleanText(t: string) {
  return (t ?? "").toString()
    .replace(/\[BUILD_MARK_[^\]]+\]/g, "")
    .replace(/분류[\s\S]*?의도\s*[ABC]\s*/g, "")
    .replace(/^\[[^\]]+\/\s*조각\s*\d+\]$/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}


function formatChunkContent(content: string): { text: string; hasTable: boolean } {
  const rebuilt = rebuildFlatTableWithContext(content);
  return { text: rebuilt.rebuilt.trim(), hasTable: rebuilt.hasTable };
}

function tokenHitRate(tokens: string[], content: string) {
  const lower = (content ?? "").toLowerCase();
  return tokens.filter((k) => lower.includes(k.toLowerCase())).length / Math.max(1, tokens.length);
}

function buildAnswer(intent: "A" | "B" | "C", finalHits: Hit[]) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    return { ...h, formatted: f.text, hasTable: f.hasTable };
  });


  formatted.sort((a, b) => Number(b.hasTable) - Number(a.hasTable));

  let body = formatted.map((h) => h.formatted).join("\n\n────────────────────────\n\n");
  body = cleanText(body);

  const sourceLines = Array.from(new Set(formatted.map(h => `- ${h.filename} / 조각 ${h.chunk_index}`))).join("\n");
  return { answer: body + `\n\n[출처]\n${sourceLines}`, citations: formatted };
}

export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await req.json();
    const question = (body?.question ?? "").toString().trim();
    if (!question) return NextResponse.json({ error: "question missing" }, { status: 400 });

    const intent = classifyIntent(question);
    const tokens = extractTokens(question);
    const fileHint = pickFileHint(question, intent);


    let { data: hits, error } = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question, tokens, file_hint: fileHint, match_count: 40, min_sim: 0.12,
    });
    if (!hits?.length) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question, tokens, file_hint: null, match_count: 40, min_sim: 0.12,
      });
      hits = retry.data;
    }
    if (!hits?.length) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    const bestDocId = hits[0].document_id;
    const { data: pool } = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId, q: question, tokens, match_count: 40, min_sim: 0.08,
    });


    const scored = (pool || hits).map((h: any) => ({
      ...h,
      score: tokenHitRate(tokens, h.content) * 10 + (h.sim || 0) * 2
    })).sort((a: any, b: any) => b.score - a.score);

    const finalHits = scored.slice(0, 10);
    const { answer, citations } = buildAnswer(intent, finalHits);
    return NextResponse.json({ intent, answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
