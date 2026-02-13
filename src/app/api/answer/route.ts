// src/app/api/answer/route.ts
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** -----------------------------
 * Types
 * ---------------------------- */
type Intent = "A" | "B" | "C";

type Hit = {
  document_id: string;
  filename: string;
  chunk_index: number;
  content: string;
  sim?: number;
};

type RpcHit = {
  document_id: string;
  filename?: string | null;
  chunk_index: number;
  content: string;
  sim?: number | null;
};

type DocumentMeta = { id: string; filename: string | null };

const FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

/** -----------------------------
 * Config
 * ---------------------------- */
const SEARCH_MATCH_COUNT = 40;
const SEARCH_MIN_SIM = 0.12;
const POOL_MIN_SIM = 0.08;
const WINDOW = 2; // anchor 기준 앞뒤 조각 개수
const MAX_TOKENS = 14;

/** -----------------------------
 * Supabase
 * ---------------------------- */
function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** -----------------------------
 * Utilities
 * ---------------------------- */
function normalize(q: string) {
  return (q ?? "").toString().replace(/\s+/g, " ").trim();
}

function safeLower(s: string) {
  return (s ?? "").toString().toLowerCase();
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

/** -----------------------------
 * Intent (리팩토링 핵심)
 *  - 기존 문제: B에 "수당/지급"이 있어서 "프로젝트 수당"도 B로 빨려감
 *  - 해결: "프로젝트/휴일근무/심야" 같은 키워드는 C로 우선 분기
 * ---------------------------- */
function classifyIntent(q: string): Intent {
  const s = normalize(q);
  const sl = safeLower(s);

  // ✅ C-우선 키워드(수당이라는 단어가 있어도 여기로 보내야 함)
  const C_PRIMARY = [
    "프로젝트",
    "휴일근무",
    "평일심야",
    "심야",
    "화환",
    "경조",
    "결혼",
    "조위",
    "부고",
    "장례",
    "출산",
    "배우자",
    "공가",
    "민방위",
    "예비군",
    "건강검진",
    "가족돌봄",
    "특별휴가",
    "복리후생",
    "증명서",
    "재직",
  ];

  if (C_PRIMARY.some((k) => sl.includes(k.toLowerCase()))) return "C";

  // A: 연차휴가
  const A = ["연차", "반차", "시간연차", "이월", "차감", "연차 발생", "연차 부여", "연차 신청"];
  if (A.some((k) => s.includes(k))) return "A";

  // B: 연차수당/정산(✅ 여기서는 "수당/지급" 단독키워드 제거)
  const B = ["잔여연차", "연차수당", "연차비", "미사용 연차", "정산"];
  if (B.some((k) => s.includes(k))) return "B";

  // 나머지
  return "C";
}

/** -----------------------------
 * Token extraction
 * ---------------------------- */
function extractTokens(q: string): string[] {
  const s = normalize(q)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const base = s.split(" ").filter((w) => w.length >= 2);

  const force: string[] = [];
  const sl = safeLower(q);

  if (sl.includes("화환")) force.push("화환", "신청", "절차");
  if (sl.includes("경조")) force.push("경조", "휴가", "경조휴가");
  if (sl.includes("결혼")) force.push("결혼", "경조휴가");
  if (sl.includes("조위") || sl.includes("부고") || sl.includes("장례")) force.push("조위", "경조");
  if (sl.includes("출산")) force.push("출산", "휴가");
  if (sl.includes("배우자")) force.push("배우자", "출산", "휴가");
  if (sl.includes("민방위") || sl.includes("예비군")) force.push("민방위", "예비군", "공가", "휴가");

  // ✅ 프로젝트 수당: "연차수당" 쪽으로 빨리지 않도록 "프로젝트"를 강하게 넣고, "연차"는 넣지 않음
  if (sl.includes("프로젝트")) force.push("프로젝트", "프로젝트수당", "수당", "기준", "대상", "신청", "지급");

  if (sl.includes("휴일근무")) force.push("휴일근무", "수당", "신청", "지급");
  if (sl.includes("평일") && sl.includes("심야")) force.push("평일", "심야", "근무", "신청");

  return uniq([...force, ...base]).slice(0, MAX_TOKENS);
}

/** -----------------------------
 * File hint
 *  - B가 무조건 "연차" 힌트로 가면 프로젝트 질문도 연차 문서로 끌려갈 수 있음
 *  - classifyIntent에서 프로젝트는 C로 보내므로 여기서도 프로젝트/휴일근무 힌트를 선반영
 * ---------------------------- */
function pickFileHint(q: string, intent: Intent): string | null {
  const sl = safeLower(q);

  if (sl.includes("프로젝트")) return "프로젝트";
  if (sl.includes("휴일근무") || (sl.includes("평일") && sl.includes("심야"))) return "근무";

  if (intent === "A" || intent === "B") return "연차";

  if (sl.includes("화환")) return "화환";
  if (sl.includes("경조") || sl.includes("결혼") || sl.includes("조위") || sl.includes("부고") || sl.includes("장례"))
    return "경조";
  if (sl.includes("출산") || sl.includes("배우자")) return "휴가";
  if (sl.includes("민방위") || sl.includes("예비군")) return "휴가";
  if (sl.includes("복리후생") || sl.includes("건강검진")) return "복리후생";
  if (sl.includes("증명서") || sl.includes("재직")) return "증명";

  return null;
}

/** -----------------------------
 * (구 문서 대응) 표 복원기 + 텍스트 클린
 *  - 기존 구현 유지하되, 함수 분리/정리
 * ---------------------------- */
function rebuildFlatTableWithContext(text: string): { rebuilt: string; hasTable: boolean } {
  const raw = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (raw.length < 5) return { rebuilt: (text ?? "").toString().trim(), hasTable: false };

  type Cand = {
    headers: string[];
    kind?: "default" | "leaveStructured";
    firstColAllow?: Set<string>;
  };

  const cands: Cand[] = [
    {
      headers: ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"],
      kind: "default",
      firstColAllow: new Set(["경사", "조의"]),
    },
    { headers: ["구분", "유형", "내용", "휴가일수", "첨부서류", "비고"], kind: "leaveStructured" },
    { headers: ["구분", "내용"], kind: "default" },
  ];

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

    const isGroupTitle = (s: string) =>
      s.includes("휴가") && !s.includes("휴가일수") && !["구분", "유형", "내용", "비고"].includes(s);

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
      // 다음 표 헤더 or 마커 만나면 stop
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
      ...rows.map((r) => `| ${r.map((c) => c.replace(/\|/g, "｜").replace(/\n/g, " ")).join(" | ")} |`),
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

function cleanText(t: string) {
  return (t ?? "")
    .toString()
    .replace(/\[BUILD_MARK_[^\]]+\]/g, "")
    .replace(/분류[\s\S]*?의도\s*[ABC]\s*/g, "")
    .replace(/^\[[^\]]+\/\s*조각\s*\d+\]$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatChunkContent(content: string): { text: string; hasTable: boolean } {
  const rebuilt = rebuildFlatTableWithContext(content);
  const hasTable = rebuilt.hasTable || /```text[\s\S]*\|[\s\S]*```/m.test(content ?? "");
  return { text: (rebuilt.rebuilt || content || "").trim(), hasTable };
}

/** -----------------------------
 * Scoring
 * ---------------------------- */
function calcScore(h: RpcHit, tokens: string[]) {
  const content = (h.content ?? "").toString();
  const cl = safeLower(content);

  const tokenHit = tokens.filter((k) => cl.includes(safeLower(k))).length;
  const tokenRatio = tokenHit / Math.max(1, tokens.length);

  const sim = Number(h.sim ?? 0);

  // 점수: 토큰포함률(강) + sim(약)
  return tokenRatio * 10 + sim * 2;
}

/** -----------------------------
 * Fetch window chunks (본문 순서 유지)
 * ---------------------------- */
async function fetchDocumentMeta(supabaseAdmin: SupabaseClient, docId: string): Promise<DocumentMeta | null> {
  const { data } = await supabaseAdmin.from("documents").select("id, filename").eq("id", docId).maybeSingle();
  return (data as any) ?? null;
}

async function fetchWindowChunks(
  supabaseAdmin: SupabaseClient,
  docId: string,
  fromIdx: number,
  toIdx: number,
  filename: string
): Promise<Hit[] | null> {
  const { data, error } = await supabaseAdmin
    .from("document_chunks")
    .select("document_id, chunk_index, content")
    .eq("document_id", docId)
    .gte("chunk_index", fromIdx)
    .lte("chunk_index", toIdx)
    .order("chunk_index", { ascending: true });

  if (error || !data?.length) return null;

  return (data as any[]).map((c) => ({
    document_id: c.document_id,
    filename,
    chunk_index: c.chunk_index,
    content: c.content,
  }));
}

/** -----------------------------
 * Build answer
 * ---------------------------- */
function buildAnswer(intent: Intent, finalHits: Hit[]) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    return { ...h, formatted: f.text, hasTable: f.hasTable };
  });

  // ✅ 본문 순서 유지
  formatted.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));

  let body = formatted.map((h) => h.formatted).join("\n\n────────────────────────\n\n");
  body = cleanText(body);

  const sourceLines = uniq(formatted.map((h) => `- ${h.filename} / 조각 ${h.chunk_index}`)).join("\n");
  return { answer: body + `\n\n[출처]\n${sourceLines}`, citations: formatted };
}

/** -----------------------------
 * Main
 * ---------------------------- */
export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await req.json();
    const question = normalize(body?.question ?? "");
    if (!question) return NextResponse.json({ error: "question missing" }, { status: 400 });

    const intent = classifyIntent(question);
    const tokens = extractTokens(question);
    const fileHint = pickFileHint(question, intent);

    // 1) 1차 검색 (힌트 적용)
    const first = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question,
      tokens,
      file_hint: fileHint,
      match_count: SEARCH_MATCH_COUNT,
      min_sim: SEARCH_MIN_SIM,
    });

    let hits: RpcHit[] | null = (first.data as any) ?? null;

    // 1-2) fallback: file_hint 제거
    if (!hits?.length) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: null,
        match_count: SEARCH_MATCH_COUNT,
        min_sim: SEARCH_MIN_SIM,
      });
      hits = (retry.data as any) ?? null;
    }

    if (!hits?.length) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    // 2) best doc 기준 pool 확장
    const bestDocId = hits[0].document_id;
    const poolRes = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId,
      q: question,
      tokens,
      match_count: SEARCH_MATCH_COUNT,
      min_sim: POOL_MIN_SIM,
    });

    const pool: RpcHit[] = ((poolRes.data as any) ?? hits) as any;

    // 3) scoring + anchor 선정
    const scored = pool
      .map((h) => ({ ...h, score: calcScore(h, tokens) }))
      .sort((a: any, b: any) => b.score - a.score);

    const anchor = scored[0];
    if (!anchor?.document_id) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    const anchorIdx = Number(anchor.chunk_index ?? 0);
    const fromIdx = Math.max(0, anchorIdx - WINDOW);
    const toIdx = anchorIdx + WINDOW;

    // 4) filename 확보 + window fetch
    const meta = await fetchDocumentMeta(supabaseAdmin, anchor.document_id);
    const filename = meta?.filename ?? anchor.filename ?? "(unknown)";

    const windowChunks = await fetchWindowChunks(supabaseAdmin, anchor.document_id, fromIdx, toIdx, filename);

    let finalHits: Hit[] = [];
    if (windowChunks?.length) {
      finalHits = windowChunks;
    } else {
      // fallback: scored 상위 10개를 본문순으로
      finalHits = scored
        .slice(0, 10)
        .map((h: any) => ({
          document_id: h.document_id,
          filename: h.filename ?? filename,
          chunk_index: h.chunk_index,
          content: h.content,
          sim: Number(h.sim ?? 0),
        }))
        .sort((a, b) => a.chunk_index - b.chunk_index);
    }

    const { answer, citations } = buildAnswer(intent, finalHits);
    return NextResponse.json({ intent, answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
