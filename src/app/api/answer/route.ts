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
  filenameHints: string[]; // documents.filename ilike 후보
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
const TOP_K = 4; // ✅ window fetch 제거: 최종 상위 chunk 개수
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
 * Routing (업로드된 파일 기반)
 * ---------------------------- */
function routeQuestion(q: string): Routed {
  const s = normalize(q);
  const sl = safeLower(s);

  // tokens base
  const baseTokens = normalize(q)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2);

  // 돈 질문 감지
  const isAnnualAllowance =
    sl.includes("연차") &&
    (sl.includes("수당") || sl.includes("정산") || sl.includes("지급") || sl.includes("얼마") || sl.includes("계산"));

  const isCondolenceMoney =
    sl.includes("경조금") ||
    sl.includes("부의금") ||
    sl.includes("축의금") ||
    sl.includes("조의금") ||
    (sl.includes("경조") && (sl.includes("금") || sl.includes("얼마") || sl.includes("지급") || sl.includes("금액")));

  // 0) 경조금(돈)
  if (isCondolenceMoney) {
    return {
      intent: "C",
      filenameHints: ["경조금지급기준", "경조금"],
      tokens: uniq(["경조금", "금액", "지급", "기준", "대상", "신청", "지급일", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["경조금", "금액", "지급", "원"],
    };
  }

  // 1) 연차수당(돈)
  if (isAnnualAllowance || hasAny(sl, ["연차수당", "연차비", "미사용", "정산"])) {
    return {
      intent: "B",
      filenameHints: ["연차수당지급기준", "연차수당"],
      tokens: uniq(["연차수당", "정산", "지급", "산정", "기준", "대상", "기본급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["연차수당", "정산", "산정", "기본급", "지급"],
    };
  }

  // 2) 프로젝트 수당
  if (hasAny(sl, ["프로젝트"]) && hasAny(sl, ["수당", "지급", "기준", "청구", "신청", "예시"])) {
    return {
      intent: "C",
      filenameHints: ["프로젝트 수당제도", "프로젝트 수당", "프로젝트"],
      tokens: uniq(["프로젝트", "수당", "상주", "연속", "청구", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["프로젝트", "수당", "지급"],
    };
  }

  // 3) 휴일근무 수당
  if (hasAny(sl, ["휴일근무", "공휴일", "토요일", "일요일"]) && hasAny(sl, ["수당", "지급", "금액", "계산", "신청"])) {
    return {
      intent: "C",
      filenameHints: ["휴일근무 수당", "휴일근무"],
      tokens: uniq(["휴일근무", "수당", "직급", "신청", "지급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["휴일근무", "수당", "지급", "직급"],
    };
  }

  // 4) 근무 OFF(심야)
  if (hasAny(sl, ["근무off", "근무 off", "오프", "off", "심야", "야근"]) && hasAny(sl, ["신청", "기준", "사용", "대상"])) {
    return {
      intent: "C",
      filenameHints: ["근무off제도", "근무off", "OFF"],
      tokens: uniq(["근무off", "심야", "22시", "4시간", "8시간", "익일", "신청", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["OFF", "심야", "4시간", "8시간", "22시"],
    };
  }

  // 5) 화환
  if (hasAny(sl, ["화환"])) {
    return {
      intent: "C",
      filenameHints: ["화환신청"],
      tokens: uniq(["화환", "신청", "전자결재", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["화환", "신청"],
    };
  }

  // 6) 제증명
  if (hasAny(sl, ["제증명", "증명서", "재직", "경력", "원천징수", "근로소득"])) {
    return {
      intent: "C",
      filenameHints: ["제증명서 발급 안내", "제증명서", "증명서"],
      tokens: uniq(["증명서", "재직증명서", "경력증명서", "신청", "발급", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["증명서", "발급", "신청"],
    };
  }

  // 7) 복리후생
  if (hasAny(sl, ["복리후생", "즐기go", "공부하go", "건강챙기go", "ott", "여행", "문화", "레포츠", "운동", "헬스", "검진", "chatgpt", "gemini"])) {
    return {
      intent: "C",
      filenameHints: ["선택적 복리후생 제도", "복리후생"],
      tokens: uniq(["복리후생", "공부하GO", "즐기GO", "건강챙기GO", "지원", "제외", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["지원", "대상", "신청", "불가", "제외", "GO"],
    };
  }

  // 8) 안식년
  if (hasAny(sl, ["안식년", "장기근속", "포상"])) {
    return {
      intent: "C",
      filenameHints: ["안식년_휴가", "안식년", "안식"],
      tokens: uniq(["안식년", "장기근속", "포상", "휴가", "절차", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["안식", "휴가", "기준"],
    };
  }

  // 9) 자산/장비
  if (hasAny(sl, ["노트북", "모니터", "데스크탑", "장비", "자산", "고장", "교체"])) {
    return {
      intent: "C",
      filenameHints: ["자산 및 장비 지급 기준", "자산", "장비"],
      tokens: uniq(["노트북", "모니터", "데스크탑", "지급", "교체", "고장", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["노트북", "모니터", "지급", "교체", "고장"],
    };
  }

  // 10) 인재추천 포상
  if (hasAny(sl, ["인재추천", "추천", "포상", "채용추천"])) {
    return {
      intent: "C",
      filenameHints: ["사내인재추천포상기준", "인재추천", "추천포상"],
      tokens: uniq(["인재추천", "추천", "포상", "금액", "지급", "자격", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["추천", "포상", "지급"],
    };
  }

  // 11) 휴가규정 - 연차
  if (hasAny(sl, ["연차", "반차", "시간연차", "이월", "차감", "선연차"])) {
    return {
      intent: "A",
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정"],
      tokens: uniq(["연차", "반차", "시간연차", "이월", "차감", "발생", "부여", "신청", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["연차", "반차", "시간연차"],
      sectionHeader: "📌 연차 휴가",
    };
  }

  // 휴가규정 - 경조휴가
  if (hasAny(sl, ["경조", "결혼", "조위", "부고", "장례", "출산", "배우자", "조부모", "할머니", "외할머니"])) {
    return {
      intent: "C",
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정"],
      tokens: uniq(["경조", "경조휴가", "결혼", "조위", "출산", "조부모", "첨부서류", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["경조", "휴가", "조위", "출산"],
      sectionHeader: "📌 경조 휴가",
    };
  }

  // 휴가규정 - 기타휴가
  if (hasAny(sl, ["민방위", "예비군", "공가", "병가", "직무교육"])) {
    return {
      intent: "C",
      filenameHints: ["휴가규정(연차,경조,공가)", "휴가규정"],
      tokens: uniq(["민방위", "예비군", "공가", "병가", "직무교육", "훈련", "증빙", ...baseTokens]).slice(0, MAX_TOKENS),
      mustContainAny: ["민방위", "예비군", "공가", "병가", "직무교육"],
      sectionHeader: "📌 기타 휴가",
    };
  }

  return { intent: "C", filenameHints: [], tokens: uniq(baseTokens).slice(0, MAX_TOKENS) };
}

/** -----------------------------
 * Doc IDs lookup
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
    for (const d of data as any[]) if (d?.id) out.push(d.id);
  }

  return uniq(out);
}

/** -----------------------------
 * 표 복원 + 클린
 * ---------------------------- */
function rebuildFlatTableWithContext(text: string): { rebuilt: string; hasTable: boolean } {
  const raw = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (raw.length < 5) return { rebuilt: (text ?? "").toString().trim(), hasTable: false };

  type Cand = { headers: string[]; kind?: "default" | "leaveStructured"; firstColAllow?: Set<string> };

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
    .replace(/^\s*분류\s*:\s*의도\s*[ABC]\s*\n?/gm, "") // ✅ 본문에 섞인 intent도 제거
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
 * Section clamp (휴가규정에서 섹션 섞임 방지)
 * ---------------------------- */
function clampToSection(text: string, header?: string | null) {
  if (!header) return text;
  const idx = text.indexOf(header);
  if (idx < 0) return text;
  const after = text.slice(idx);
  const nextIdx = after.slice(header.length).indexOf("📌 ");
  if (nextIdx < 0) return after.trim();
  return after.slice(0, header.length + nextIdx).trim();
}

/** -----------------------------
 * Final filter
 * ---------------------------- */
function filterFinalHits(hits: Hit[], mustContainAny?: string[]) {
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
    const clamped = clampToSection(f.text, sectionHeader);
    return { ...h, formatted: clamped, hasTable: f.hasTable };
  });

  // 출력은 본문 순서 유지
  formatted.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));

  let body = formatted.map((h) => h.formatted).join("\n\n────────────────────────\n\n");
  body = cleanText(body);

  const sourceLines = uniq(formatted.map((h) => `- ${h.filename} / 조각 ${h.chunk_index}`)).join("\n");
  return { answer: body + `\n\n[출처]\n${sourceLines}`, citations: formatted };
}

/** -----------------------------
 * Main
 *  - ✅ window fetch 제거: 문서 내 검색 결과에서 TOP_K만 선택
 * ---------------------------- */
export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await req.json();
    const question = normalize(body?.question ?? "");
    if (!question) return NextResponse.json({ error: "question missing" }, { status: 400 });

    // 1) Routing
    const routed = routeQuestion(question);
    const { intent, filenameHints, tokens, mustContainAny, sectionHeader } = routed;

    // 2) Candidate docs by filename
    const candidateDocIds = await findDocIdsByFilenameHints(supabaseAdmin, filenameHints, 5);

    // 3) Search within candidate docs to find best doc + top hits
    let bestDocId: string | null = null;
    let bestHits: RpcHit[] = [];
    let bestTopScore = -Infinity;

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

        const topScore = scored[0]?.score ?? -Infinity;
        if (topScore > bestTopScore) {
          bestTopScore = topScore;
          bestDocId = docId;
          bestHits = scored;
        }
      }
    }

    // 4) Fallback: global search (RPC)
    if (!bestDocId || !bestHits.length) {
      const first = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: filenameHints?.[0] ?? null,
        match_count: SEARCH_MATCH_COUNT,
        min_sim: SEARCH_MIN_SIM,
      });

      const globalHits: RpcHit[] = ((first.data as any) ?? []) as any;
      if (!globalHits.length) return NextResponse.json({ intent, answer: FALLBACK, chunks: [] });

      const scored = globalHits
        .map((h) => {
          const sim = Number(h.sim ?? 0);
          const score = calcScore(h.content ?? "", sim, tokens, mustContainAny);
          return { ...h, sim, score };
        })
        .sort((a: any, b: any) => b.score - a.score);

      bestDocId = scored[0]?.document_id ?? null;
      bestHits = scored;

      if (!bestDocId) return NextResponse.json({ intent, answer: FALLBACK, chunks: [] });
    }

    // 5) filename 확보
    const meta = await supabaseAdmin.from("documents").select("id, filename").eq("id", bestDocId).maybeSingle();
    const filename = ((meta.data as any)?.filename ?? "(unknown)") as string;

    // 6) TOP_K 선정 (관련도 기준 → 최종은 본문순 정렬은 buildAnswer에서)
    const topK = bestHits
      .slice(0, Math.max(TOP_K, 1))
      .map((h: any) => ({
        document_id: h.document_id,
        filename: h.filename ?? filename,
        chunk_index: Number(h.chunk_index ?? 0),
        content: h.content,
        sim: Number(h.sim ?? 0),
      })) as Hit[];

    // 7) 토픽 기반 필터(돈 질문 등) + 안전 보정
    let finalHits = filterFinalHits(topK, mustContainAny);
    if (!finalHits.length) finalHits = topK.slice(0, 1);

    const { answer, citations } = buildAnswer(intent, finalHits, sectionHeader ?? null);

    // ✅ UI가 기대하는 키 이름(chunks)로 내려줌
    return NextResponse.json({ intent, answer, chunks: citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
