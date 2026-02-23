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

type Routed = {
  intent: Intent;
  filenameHints: string[];
  tokens: string[];
  mustContainAny?: string[];
  sectionHeader?: string | null;
};

const FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

/** -----------------------------
 * Config
 * ---------------------------- */
const SEARCH_MATCH_COUNT = 40;
const SEARCH_MIN_SIM = 0.1;
const WINDOW = 2;
const MAX_TOKENS = 16;

// ✅ 표가 길 때만 안전장치 (원하면 999로 늘려도 됨)
const MAX_TABLE_ROWS = 80;

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
function hasAny(sl: string, kws: string[]) {
  return kws.some((k) => sl.includes(k.toLowerCase()));
}

/** -----------------------------
 * Routing
 * ---------------------------- */
function routeQuestion(q: string): Routed {
  const s = normalize(q);
  const sl = safeLower(s);

  let intent: Intent = "C";

  const baseTokens = normalize(q)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2);

  const isAnnualAllowance =
    sl.includes("연차") &&
    (sl.includes("수당") || sl.includes("정산") || sl.includes("지급") || sl.includes("얼마") || sl.includes("계산"));

  const isCondolenceMoney =
    sl.includes("경조금") ||
    sl.includes("부의금") ||
    sl.includes("축의금") ||
    sl.includes("조의금") ||
    (sl.includes("경조") && (sl.includes("금") || sl.includes("얼마") || sl.includes("지급") || sl.includes("금액")));

  if (isCondolenceMoney) {
    intent = "C";
    return {
      intent,
      filenameHints: ["경조금지급기준", "경조금"],
      tokens: uniq(["경조금", "금액", "지급", "기준", "대상", "신청", "지급일", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["경조금", "금액", "지급", "원"],
    };
  }

  if (isAnnualAllowance || hasAny(sl, ["연차수당", "연차비", "미사용", "정산"])) {
    intent = "B";
    return {
      intent,
      filenameHints: ["연차수당지급기준", "연차수당"],
      tokens: uniq(["연차수당", "정산", "지급", "산정", "기준", "대상", "기본급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["연차수당", "정산", "산정", "기본급", "지급"],
    };
  }

  if (hasAny(sl, ["프로젝트", "상주", "pm팀", "개발자"]) && hasAny(sl, ["수당", "지급", "기준", "청구", "신청", "예시"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["프로젝트 수당제도", "프로젝트 수당", "프로젝트"],
      tokens: uniq(["프로젝트", "수당", "상주", "연속", "3일", "청구", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["프로젝트", "수당", "상주", "연속", "지급"],
    };
  }

  
  if (hasAny(sl, ["휴일근무", "공휴일", "토요일", "일요일"]) && hasAny(sl, ["수당", "지급", "금액", "계산", "신청"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["휴일근무 수당", "휴일근무"],
      tokens: uniq(["휴일근무", "수당", "4시간", "직급", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["휴일근무", "수당", "직급", "지급"],
    };
  }


  if (hasAny(sl, ["근무off", "근무 off", "오프", "off", "심야", "야근"]) && hasAny(sl, ["신청", "기준", "사용", "대상"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["근무off제도", "근무off", "근무off제", "OFF"],
      tokens: uniq(["근무off", "심야", "22시", "4시간", "8시간", "익일", "신청", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["근무", "OFF", "4시간", "8시간", "22시"],
    };
  }

  if (hasAny(sl, ["화환"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["화환신청"],
      tokens: uniq(["화환", "신청", "전자결재", "신청서", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["화환", "신청"],
    };
  }

  if (hasAny(sl, ["제증명", "증명서", "재직", "경력", "원천징수", "근로소득"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["제증명서 발급 안내", "제증명서", "증명서"],
      tokens: uniq(["증명서", "재직증명서", "경력증명서", "신청", "발급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["증명서", "발급", "신청"],
    };
  }

  if (
    hasAny(sl, [
      "복리후생",
      "즐기go",
      "공부하go",
      "건강챙기go",
      "ott",
      "여행",
      "문화",
      "테마파크",
      "레포츠",
      "운동",
      "헬스",
      "검진",
      "chatgpt",
      "gemini",
    ])
  ) {
    intent = "C";
    return {
      intent,
      filenameHints: ["선택적 복리후생 제도", "복리후생"],
      tokens: uniq(["복리후생", "공부하GO", "즐기GO", "건강챙기GO", "지원", "제외", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["지원", "대상", "신청", "불가", "제외", "GO"],
    };
  }

  if (hasAny(sl, ["안식년", "장기근속", "포상"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["안식년_휴가", "안식년", "안식"],
      tokens: uniq(["안식년", "장기근속", "포상", "휴가", "유효기간", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["안식", "휴가", "기준", "유효기간"],
    };
  }

  if (hasAny(sl, ["노트북", "모니터", "데스크탑", "장비", "자산", "고장", "교체"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["자산 및 장비 지급 기준", "IT자산", "자산"],
      tokens: uniq(["노트북", "모니터", "데스크탑", "지급", "교체", "고장", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["노트북", "모니터", "지급", "교체", "고장"],
    };
  }

  if (hasAny(sl, ["인재추천", "추천", "포상", "채용추천"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["사내인재추천포상기준", "인재추천", "추천포상"],
      tokens: uniq(["인재추천", "추천", "포상", "금액", "지급", "자격", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["추천", "포상", "지급"],
    };
  }

  if (hasAny(sl, ["연차", "반차", "시간연차", "이월", "차감", "선연차"])) {
    intent = "A";
    return {
      intent,
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정", "휴가규정("],
      tokens: uniq(["연차", "반차", "시간연차", "이월", "차감", "발생", "부여", "신청", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["연차", "반차", "시간연차"],
      sectionHeader: "📌 연차 휴가",
    };
  }

  if (hasAny(sl, ["경조", "결혼", "조위", "부고", "장례", "출산", "배우자", "조부모", "할머니", "외할머니"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정", "휴가규정("],
      tokens: uniq(["경조", "경조휴가", "결혼", "조위", "출산", "조부모", "첨부서류", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["경조", "휴가", "조위", "출산"],
      sectionHeader: "📌 경조 휴가",
    };
  }

  if (hasAny(sl, ["민방위", "예비군", "공가", "병가", "직무교육"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정", "휴가규정("],
      tokens: uniq(["민방위", "예비군", "공가", "병가", "직무교육", "훈련", "증빙", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["민방위", "예비군", "공가", "병가", "직무교육"],
      sectionHeader: "📌 기타 휴가",
    };
  }

  return {
    intent,
    filenameHints: [],
    tokens: uniq(baseTokens).slice(0, MAX_TOKENS),
  };
}

/** -----------------------------
 * Doc ID lookup
 * ---------------------------- */
async function findDocIdsByFilenameHints(
  supabaseAdmin: SupabaseClient,
  hints: string[],
  limitPerHint = 5
): Promise<string[]> {
  if (!hints?.length) return [];
  const out: string[] = [];

  for (const hint of hints) {
    const { data, error } = await supabaseAdmin
      .from("documents")
      .select("id, filename")
      .ilike("filename", `%${hint}%`)
      .limit(limitPerHint);

    if (error || !data?.length) continue;
    for (const d of data as any[]) {
      if (d?.id) out.push(d.id);
    }
  }

  return uniq(out);
}

/** -----------------------------
 * 표 복원 + 클린
 * ✅ 변경점: 코드펜스(```text) 제거하고 "마크다운 표"로만 출력
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

    return { md: mdLines.join("\n"), consumedUntil: i, hasTable: true };
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
    .replace(/```text\s*/g, "")
    .replace(/```\s*/g, "")
    .replace(/─{5,}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatChunkContent(content: string): { text: string; hasTable: boolean } {
  const rebuilt = rebuildFlatTableWithContext(content);
  const hasTable = rebuilt.hasTable || /\|\s*---\s*\|/.test(content ?? "");
  return { text: (rebuilt.rebuilt || content || "").trim(), hasTable };
}

/** -----------------------------
 * 발췌 정책(LLM 없이 AI처럼 보이게)
 * ✅ 핵심: 표는 "절대 발췌/자르지 않고" 전체 유지
 *         텍스트만 키워드 주변으로 발췌
 * ---------------------------- */
function extractRelevantLines(text: string, tokens: string[], mustContainAny?: string[]) {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  if (!lines.length) return "";

  // 표 인식(조금 넉넉하게)
  const isMarkdownTable = lines.some((l) => l.trim().startsWith("|")) && lines.some((l) => /\|\s*---\s*\|/.test(l));

  if (isMarkdownTable) {
    const headerIdx = lines.findIndex((l) => l.trim().startsWith("|"));
    const header = headerIdx >= 0 ? lines[headerIdx] : lines[0];
    const divider = lines.find((l) => /\|\s*---\s*\|/.test(l)) ?? "| --- |";

    // row는 '|'로 시작하는 것만
    const rows = lines.filter((l) => l.trim().startsWith("|") && l !== header && l !== divider);

    // ✅ 표는 전체 유지 (너무 길 때만 제한)
    const keepRows = rows.length > MAX_TABLE_ROWS ? rows.slice(0, MAX_TABLE_ROWS) : rows;

    let table = [header, divider, ...keepRows].join("\n");
    if (rows.length > MAX_TABLE_ROWS) {
      table += `\n\n(표가 길어 일부 행만 표시했습니다. 더 구체적으로 질문하면 해당 항목 위주로 안내할게요.)`;
    }
    return table;
  }

  const kws = uniq([...(mustContainAny ?? []), ...(tokens ?? [])]).filter((x) => (x ?? "").toString().trim().length >= 2);
  if (!kws.length) return lines.slice(0, 12).join("\n");

  // 일반 텍스트: 매칭 줄 + 앞뒤 1줄
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ll = safeLower(lines[i]);
    const hit = kws.some((k) => ll.includes(safeLower(k)));
    if (!hit) continue;

    if (i - 1 >= 0) out.push(lines[i - 1]);
    out.push(lines[i]);
    if (i + 1 < lines.length) out.push(lines[i + 1]);
  }

  const compact = uniq(out).join("\n").trim();
  return compact || lines.slice(0, 12).join("\n");
}

/** -----------------------------
 * Scoring
 * ---------------------------- */
function calcScore(content: string, sim: number, tokens: string[], mustContainAny?: string[]) {
  const cl = safeLower(content);

  const tokenHit = tokens.filter((k) => cl.includes(safeLower(k))).length;
  const tokenRatio = tokenHit / Math.max(1, tokens.length);

  const mustBonus =
    mustContainAny && mustContainAny.length
      ? mustContainAny.some((k) => cl.includes(safeLower(k)))
        ? 2.0
        : -0.5
      : 0;

  return tokenRatio * 10 + sim * 2 + mustBonus;
}

/** -----------------------------
 * Fetch doc meta + chunks
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
 * Section clamp
 * ---------------------------- */
function clampToSection(text: string, header?: string | null) {
  if (!header) return text;
  const idx = text.indexOf(header);
  if (idx < 0) return text;
  const after = text.slice(idx);
  const nextIdx = after.slice(header.length).indexOf("📌 ");
  if (nextIdx < 0) return after;
  return after.slice(0, header.length + nextIdx).trim();
}

/** -----------------------------
 * Final hit filtering
 * ---------------------------- */
function filterFinalHits(question: string, hits: Hit[], mustContainAny?: string[]) {
  if (!mustContainAny?.length) return hits;
  const filtered = hits.filter((h) => mustContainAny.some((k) => safeLower(h.content).includes(safeLower(k))));
  return filtered.length ? filtered : hits;
}

/** -----------------------------
 * Build answer
 * ---------------------------- */
function buildAnswer(
  intent: Intent,
  finalHits: Hit[],
  sectionHeader?: string | null,
  tokens: string[] = [],
  mustContainAny?: string[]
) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    const clamped = clampToSection(f.text, sectionHeader);
    const extracted = extractRelevantLines(clamped, tokens, mustContainAny);
    return { ...h, formatted: extracted, hasTable: f.hasTable };
  });

  formatted.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));

  let body = formatted.map((h) => h.formatted).join("\n\n");
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

    const routed = routeQuestion(question);
    const { intent, filenameHints, tokens, mustContainAny, sectionHeader } = routed;

    const candidateDocIds = await findDocIdsByFilenameHints(supabaseAdmin, filenameHints, 5);

    let bestDocId: string | null = null;
    let bestAnchor: { docId: string; chunk_index: number; content: string; sim: number; score?: number } | null = null;

    if (candidateDocIds.length) {
      for (const docId of candidateDocIds) {
        const res = await supabaseAdmin.rpc("search_chunks_in_document", {
          doc_id: docId,
          q: question,
          tokens,
          match_count: SEARCH_MATCH_COUNT,
          min_sim: SEARCH_MIN_SIM,
        });

        const hits: RpcHit[] = ((res.data as any) ?? []) as any;
        if (!hits.length) continue;

        const scored = hits
          .map((h) => {
            const sim = Number(h.sim ?? 0);
            const score = calcScore(h.content ?? "", sim, tokens, mustContainAny);
            return { ...h, sim, score };
          })
          .sort((a: any, b: any) => b.score - a.score);

        const top = scored[0];
        if (!top) continue;

        if (!bestAnchor || top.score > (bestAnchor.score ?? -999999)) {
          bestDocId = docId;
          bestAnchor = {
            docId,
            chunk_index: Number(top.chunk_index ?? 0),
            content: top.content,
            sim: Number(top.sim ?? 0),
            score: Number(top.score ?? 0),
          };
        }
      }
    }

    if (!bestDocId || !bestAnchor) {
      const first = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: filenameHints?.[0] ?? null,
        match_count: SEARCH_MATCH_COUNT,
        min_sim: SEARCH_MIN_SIM,
      });

      const globalHits: RpcHit[] = ((first.data as any) ?? []) as any;
      if (!globalHits.length) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

      const scored = globalHits
        .map((h) => {
          const sim = Number(h.sim ?? 0);
          const score = calcScore(h.content ?? "", sim, tokens, mustContainAny);
          return { ...h, sim, score };
        })
        .sort((a: any, b: any) => b.score - a.score);

      const top = scored[0];
      if (!top?.document_id) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

      bestDocId = top.document_id;
      bestAnchor = {
        docId: top.document_id,
        chunk_index: Number(top.chunk_index ?? 0),
        content: top.content,
        sim: Number(top.sim ?? 0),
        score: Number((top as any).score ?? 0),
      };
    }

    if (!bestDocId || !bestAnchor) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    const meta = await fetchDocumentMeta(supabaseAdmin, bestDocId);
    const filename = meta?.filename ?? "(unknown)";

    const fromIdx = Math.max(0, bestAnchor.chunk_index - WINDOW);
    const toIdx = bestAnchor.chunk_index + WINDOW;

    const windowChunks = await fetchWindowChunks(supabaseAdmin, bestDocId, fromIdx, toIdx, filename);
    if (!windowChunks?.length) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    let finalHits = filterFinalHits(question, windowChunks, mustContainAny);
    if (!finalHits.length) {
      finalHits = [windowChunks.find((h) => h.chunk_index === bestAnchor!.chunk_index) ?? windowChunks[0]];
    }

    const { answer, citations } = buildAnswer(intent, finalHits, sectionHeader ?? null, tokens, mustContainAny);
    return NextResponse.json({ intent, answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}