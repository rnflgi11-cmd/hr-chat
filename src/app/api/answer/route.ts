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
  /** filename ilike 힌트(복수) */
  filenameHints: string[];
  /** 검색 토큰 */
  tokens: string[];
  /** 최종 출력에서 남길 핵심 키워드(없으면 필터링 약하게) */
  mustContainAny?: string[];
  /** 휴가규정(13번) 같은 "대형 문서"에서 섹션을 좁힐 때 쓰는 헤더 */
  sectionHeader?: string | null;
};

const FALLBACK =
  "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다.";

/** -----------------------------
 * Config
 * ---------------------------- */
const SEARCH_MATCH_COUNT = 40;
const SEARCH_MIN_SIM = 0.1;
const WINDOW = 2; // anchor 기준 앞뒤 조각 개수
const MAX_TOKENS = 16;

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
 * Routing (핵심)
 *  - 업로드된 파일들이 "주제별 분리"되어 있으니
 *    질문을 토픽으로 라우팅해서 후보 문서(1~3개)만 검색한다.
 * ---------------------------- */
function routeQuestion(q: string): Routed {
  const s = normalize(q);
  const sl = safeLower(s);

  // ----- Intent 기본값
  let intent: Intent = "C";

  // ----- 토큰 기본
  const baseTokens = normalize(q)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2);

  // ----- 돈 질문 감지
  const isAnnualAllowance =
    sl.includes("연차") &&
    (sl.includes("수당") || sl.includes("정산") || sl.includes("지급") || sl.includes("얼마") || sl.includes("계산"));

  const isCondolenceMoney =
    sl.includes("경조금") ||
    sl.includes("부의금") ||
    sl.includes("축의금") ||
    sl.includes("조의금") ||
    (sl.includes("경조") && (sl.includes("금") || sl.includes("얼마") || sl.includes("지급") || sl.includes("금액")));

  // ----- 각 토픽 라우팅 (파일명 기반)
  // 업로드된 실제 문서 기준:
  // - 3_경조금지급기준.docx: 경조금 금액/기준/신청/지급일 등 :contentReference[oaicite:1]{index=1}
  // - 7_연차수당지급기준.docx: 연차수당 계산/대상/시기 :contentReference[oaicite:2]{index=2}
  // - 10_프로젝트 수당제도.docx: 프로젝트 수당 기준/예시/지급 :contentReference[oaicite:3]{index=3}
  // - 11_휴일근무 수당.docx: 휴일근무 수당 금액/시간/신청 :contentReference[oaicite:4]{index=4}
  // - 9_근무off제도 매뉴얼.docx: 심야 근무 OFF :contentReference[oaicite:5]{index=5}
  // - 12_화환신청.docx: 화환 신청 절차 :contentReference[oaicite:6]{index=6}
  // - 8_제증명서 발급 안내.docx: 재직/경력 증명 :contentReference[oaicite:7]{index=7}
  // - 5_선택적 복리후생 제도.docx: 복리후생/즐기GO/공부하GO/건강챙기GO :contentReference[oaicite:8]{index=8}
  // - 1_안식년_휴가.docx: 안식년 휴가 기준/절차 :contentReference[oaicite:9]{index=9}
  // - 2_자산 및 장비 지급 기준.docx: 노트북/모니터 지급/교체 :contentReference[oaicite:10]{index=10}
  // - 13_휴가규정(연차,경조,공가).docx: 연차/경조휴가/기타휴가 :contentReference[oaicite:11]{index=11}

  // 0) 경조금(돈) 최우선
  if (isCondolenceMoney) {
    intent = "C";
    return {
      intent,
      filenameHints: ["경조금지급기준", "경조금"],
      tokens: uniq(["경조금", "금액", "지급", "기준", "대상", "신청", "지급일", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["경조금", "금액", "지급", "원"],
    };
  }

  // 1) 연차수당(돈)
  if (isAnnualAllowance || hasAny(sl, ["연차수당", "연차비", "미사용", "정산"])) {
    intent = "B";
    return {
      intent,
      filenameHints: ["연차수당지급기준", "연차수당"],
      tokens: uniq(["연차수당", "정산", "지급", "산정", "기준", "대상", "기본급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["연차수당", "정산", "산정", "기본급", "지급"],
    };
  }

  // 2) 프로젝트 수당
  if (hasAny(sl, ["프로젝트", "상주", "pm팀", "개발자"]) && hasAny(sl, ["수당", "지급", "기준", "청구", "신청", "예시"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["프로젝트 수당제도", "프로젝트 수당", "프로젝트"],
      tokens: uniq(["프로젝트", "수당", "상주", "연속", "3일", "청구", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["프로젝트", "수당", "상주", "연속", "지급"],
    };
  }

  // 3) 휴일근무 수당
  if (hasAny(sl, ["휴일근무", "공휴일", "토요일", "일요일"]) && hasAny(sl, ["수당", "지급", "금액", "계산", "신청"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["휴일근무 수당", "휴일근무"],
      tokens: uniq(["휴일근무", "수당", "4시간", "직급", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["휴일근무", "수당", "직급", "지급"],
    };
  }

  // 4) 근무 OFF (심야)
  if (hasAny(sl, ["근무off", "근무 off", "오프", "off", "심야", "야근"]) && hasAny(sl, ["신청", "기준", "사용", "대상"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["근무off제도", "근무off", "근무off제", "OFF"],
      tokens: uniq(["근무off", "심야", "22시", "4시간", "8시간", "익일", "신청", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["근무", "OFF", "4시간", "8시간", "22시"],
    };
  }

  // 5) 화환 신청
  if (hasAny(sl, ["화환"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["화환신청"],
      tokens: uniq(["화환", "신청", "전자결재", "신청서", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["화환", "신청"],
    };
  }

  // 6) 제증명서
  if (hasAny(sl, ["제증명", "증명서", "재직", "경력", "원천징수", "근로소득"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["제증명서 발급 안내", "제증명서", "증명서"],
      tokens: uniq(["증명서", "재직증명서", "경력증명서", "신청", "발급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["증명서", "발급", "신청"],
    };
  }

  // 7) 선택적 복리후생
  if (hasAny(sl, ["복리후생", "즐기go", "공부하go", "건강챙기go", "ott", "여행", "문화", "테마파크", "레포츠", "운동", "헬스", "검진", "chatgpt", "gemini"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["선택적 복리후생 제도", "복리후생"],
      tokens: uniq(["복리후생", "공부하GO", "즐기GO", "건강챙기GO", "지원", "제외", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["지원", "대상", "신청", "불가", "제외", "GO"],
    };
  }

  // 8) 안식년 휴가
  if (hasAny(sl, ["안식년", "장기근속", "포상"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["안식년_휴가", "안식년", "안식"],
      tokens: uniq(["안식년", "장기근속", "포상", "휴가", "유효기간", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["안식", "휴가", "기준", "유효기간"],
    };
  }

  // 9) 자산/장비(노트북/모니터)
  if (hasAny(sl, ["노트북", "모니터", "데스크탑", "장비", "자산", "고장", "교체"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["자산 및 장비 지급 기준", "IT자산", "자산"],
      tokens: uniq(["노트북", "모니터", "데스크탑", "지급", "교체", "고장", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["노트북", "모니터", "지급", "교체", "고장"],
    };
  }

  // 10) 인재추천 포상
  if (hasAny(sl, ["인재추천", "추천", "포상", "채용추천"])) {
    intent = "C";
    return {
      intent,
      filenameHints: ["사내인재추천포상기준", "인재추천", "추천포상"],
      tokens: uniq(["인재추천", "추천", "포상", "금액", "지급", "자격", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["추천", "포상", "지급"],
    };
  }

  // 11) 휴가규정(연차/경조휴가/기타휴가)
  // 연차/경조/공가/민방위/예비군/병가 등은 13번 문서로 라우팅
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

  // 디폴트: 전체 검색 (하지만 file hint는 약하게)
  return {
    intent,
    filenameHints: [],
    tokens: uniq(baseTokens).slice(0, MAX_TOKENS),
  };
}

/** -----------------------------
 * Doc ID lookup by filename hints
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
 * 표 복원 + 클린 (네 기존 로직 유지)
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
 * Scoring (문서 내 검색 결과용)
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

  // sim은 약하게, 토큰 일치 + must 키워드 보너스를 강하게
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
 * Section clamp (13번 휴가규정 같은 문서에서만)
 *  - "📌 연차 휴가" / "📌 경조 휴가" / "📌 기타 휴가"
 * ---------------------------- */
function clampToSection(text: string, header?: string | null) {
  if (!header) return text;
  const idx = text.indexOf(header);
  if (idx < 0) return text;
  const after = text.slice(idx);
  // 다음 섹션 시작점("📌 ") 기준으로 잘라냄
  const nextIdx = after.slice(header.length).indexOf("📌 ");
  if (nextIdx < 0) return after;
  return after.slice(0, header.length + nextIdx).trim();
}

/** -----------------------------
 * Final hit filtering
 *  - mustContainAny 있으면 해당 키워드가 있는 chunk 위주로 남김
 * ---------------------------- */
function filterFinalHits(question: string, hits: Hit[], mustContainAny?: string[]) {
  if (!mustContainAny?.length) return hits;

  const filtered = hits.filter((h) => mustContainAny.some((k) => safeLower(h.content).includes(safeLower(k))));
  return filtered.length ? filtered : hits;
}

/** -----------------------------
 * Build answer
 * ---------------------------- */
function buildAnswer(intent: Intent, finalHits: Hit[], sectionHeader?: string | null) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    // 휴가규정 섹션 클램프(있을 때만)
    const clamped = clampToSection(f.text, sectionHeader);
    return { ...h, formatted: clamped, hasTable: f.hasTable };
  });

  // 본문 순서 유지
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

    // ✅ 1) 라우팅(토픽 기반)
    const routed = routeQuestion(question);
    const { intent, filenameHints, tokens, mustContainAny, sectionHeader } = routed;

    // ✅ 2) 후보 문서 ID 선정(파일명 기준)
    let candidateDocIds = await findDocIdsByFilenameHints(supabaseAdmin, filenameHints, 5);

    // 후보가 없으면 전체 검색 fallback(기존 rpc 사용)
    let bestDocId: string | null = null;
    let bestAnchor: { docId: string; chunk_index: number; content: string; sim: number } | null = null;

    // ✅ 3) 후보 문서들 "문서 내부 검색"으로 best anchor 뽑기
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

        if (!bestAnchor || top.score > (bestAnchor as any).score) {
          bestDocId = docId;
          bestAnchor = {
            docId,
            chunk_index: Number(top.chunk_index ?? 0),
            content: top.content,
            sim: Number(top.sim ?? 0),
            // @ts-ignore
            score: top.score,
          };
        }
      }
    }

    // ✅ 4) 후보문서 기반으로 못 잡으면: 기존 전체 검색 RPC fallback
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
        // @ts-ignore
        score: top.score,
      };
    }

    if (!bestDocId || !bestAnchor) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    // ✅ 5) anchor 주변 window fetch (하지만 최종 필터로 "딸려오는 섹션" 제거)
    const meta = await fetchDocumentMeta(supabaseAdmin, bestDocId);
    const filename = meta?.filename ?? "(unknown)";

    const fromIdx = Math.max(0, bestAnchor.chunk_index - WINDOW);
    const toIdx = bestAnchor.chunk_index + WINDOW;

    const windowChunks = await fetchWindowChunks(supabaseAdmin, bestDocId, fromIdx, toIdx, filename);
    if (!windowChunks?.length) return NextResponse.json({ intent, answer: FALLBACK, citations: [] });

    // ✅ 6) 토픽 기반 최종 필터 (돈 질문/경조금 등은 관련 chunk만 남김)
    let finalHits = filterFinalHits(question, windowChunks, mustContainAny);

    // 그래도 너무 짧아지면 anchor만이라도 포함
    if (!finalHits.length) {
      finalHits = [windowChunks.find((h) => h.chunk_index === bestAnchor!.chunk_index) ?? windowChunks[0]];
    }

    const { answer, citations } = buildAnswer(intent, finalHits, sectionHeader ?? null);
    return NextResponse.json({ intent, answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
