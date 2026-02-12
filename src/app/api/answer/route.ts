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

/** 표를 "행 단위"로 보기 좋게 출력 (UI가 마크다운/고정폭을 몰라도 구조 유지) */
function formatRowsAsRecords(headers: string[], rows: string[][]): string {
  const head = `구분: ${headers.join(" / ")}`;
  const body = rows.map((row, idx) => {
    const pairs = headers.map((h, i) => `${h}: ${(row[i] ?? "").trim()}`).join(" / ");
    return `- ${idx + 1}) ${pairs}`;
  });
  return [head, ...body].join("\n");
}

/**
 * ✅ DOCX 표가 "셀 텍스트가 줄바꿈으로 풀린 형태"로 저장된 경우:
 * - 헤더 시퀀스를 찾고 N열씩 묶어서 "행 단위 레코드"로 복원
 * - 표 위 설명/표 아래 설명(유의/참고/절차)까지 같이 포함
 *
 * 반환: (표 위) + ([표] + 행단위 출력) + (표 아래)
 */
function rebuildFlatTableWithContext(text: string): string | null {
  const rawLines = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 10) return null;

  const headerCandidates: string[][] = [
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

  // 표 "데이터 영역" 계산은 멈추되, 이후 텍스트는 tail로 살려둠
  const sectionStarts = new Set([
    "기타",
    "참고사항",
    "유의사항",
    "신청방법",
    "신청 방법",
    "지급일",
    "지급시점",
    "사용 절차",
    "사용절차",
    "절차",
  ]);

  for (const headers of headerCandidates) {
    const hIdx = findHeaderIndex(headers);
    if (hIdx === -1) continue;

    const cols = headers.length;

    const before = rawLines.slice(0, hIdx).join("\n").trim();
    const after = rawLines.slice(hIdx + headers.length);

    let cutForRowCalc = after.length;
    for (let i = 0; i < after.length; i++) {
      if (sectionStarts.has(after[i])) {
        cutForRowCalc = i;
        break;
      }
    }

    const tableArea = after.slice(0, cutForRowCalc);
    const tail = after.slice(cutForRowCalc).join("\n").trim();

    // ✅ 핵심: “표 끝”을 더 똑똑하게 감지
    //  - rows를 만들다가, 다음에 들어올 값이 '섹션 제목' 같으면 중단
    //  - cols 단위로 묶되, 너무 이상한 데이터(빈칸 과다)면 중단
    const rows: string[][] = [];
    for (let i = 0; i + cols <= tableArea.length; i += cols) {
      const row = tableArea.slice(i, i + cols);

      // 빈값이 너무 많으면(> 절반) 표 종료로 판단
      const emptyCount = row.filter((v) => !String(v ?? "").trim()).length;
      if (emptyCount >= Math.ceil(cols / 2)) break;

      // "다음 행의 첫 셀"이 섹션 시작어면 종료
      const nextFirst = tableArea[i + cols] ?? "";
      if (sectionStarts.has(String(nextFirst))) {
        rows.push(row);
        break;
      }

      rows.push(row);
    }

    if (rows.length === 0) continue;

    const tableText = ["[표]", formatRowsAsRecords(headers, rows)].join("\n");

    const outParts: string[] = [];
    if (before) outParts.push(before);
    outParts.push(tableText);
    if (tail) outParts.push(tail);

    return outParts.join("\n\n").trim();
  }

  return null;
}

/** 최종 chunk 포맷 */
function formatChunkContent(content: string): string {
  const rebuilt = rebuildFlatTableWithContext(content);
  if (rebuilt) return rebuilt.trim();
  return (content ?? "").toString().trim();
}
function makeTablesAlwaysReadable(text: string): string {
  // Convert markdown-style tables to readable format
  // This is a simple pass-through as tables are already handled by rebuildFlatTableWithContext
  return text;
}

function stripNoiseLines(text: string): string {
  const lines = (text ?? "")
    .toString()
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trimEnd());

  const cleaned: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    // 1) 빌드 마크 제거
    if (t.startsWith("[BUILD_MARK_")) continue;

    // 2) 분류 반복 제거
    if (/^분류:\s*의도\s*[ABC]\s*$/u.test(t)) continue;

    // 3) 내부 조각 헤더 제거: [파일명 / 조각 n]
    if (/^\[[^\]]+\/\s*조각\s*\d+\]$/u.test(t)) continue;

    // 4) 파일명 라인 제거 (📌 포함 가능)
    //    예: "📌 13_휴가규정(연차,경조,공가).docx"
    if (/[0-9]+_.+\.(docx|pptx|pdf|xlsx)$/iu.test(t)) continue;
    if (/^📌\s*.+\.(docx|pptx|pdf|xlsx)$/iu.test(t)) continue;

    cleaned.push(line);
  }

  // 앞/뒤 공백 줄 정리
  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatAnswerForUser(raw: string): string {
  // 표 재구성 → 표 가독화(plain) → 노이즈 제거
  const rebuilt = rebuildFlatTableWithContext(raw);
  const base = rebuilt ? rebuilt : raw;
  const readable = makeTablesAlwaysReadable(base);
  return stripNoiseLines(readable);
}
/**
 * ✅ 답변은 "베스트 chunk 기준 앞/뒤 1개"만 붙임
 * - 이유: 지금처럼 문서가 길면 다른 섹션이 섞여서 망가짐
 * - 표/절차는 보통 인접 chunk에 이어져 있는 경우가 많아서 이게 제일 안정적
 */
function pickContiguousHits(best: Hit, pool: Hit[]): Hit[] {
  const sameDoc = pool
    .filter((h) => h.document_id === best.document_id)
    .sort((a, b) => a.chunk_index - b.chunk_index);

  const idx = sameDoc.findIndex((h) => h.chunk_index === best.chunk_index);
  if (idx < 0) return [best];

  const picked: Hit[] = [];
  if (sameDoc[idx - 1]) picked.push(sameDoc[idx - 1]);
  picked.push(sameDoc[idx]);
  if (sameDoc[idx + 1]) picked.push(sameDoc[idx + 1]);

  // 중복 제거
  const seen = new Set<string>();
  return picked.filter((h) => {
    const key = `${h.document_id}:${h.chunk_index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toAnswer(hits: Hit[], intent: "A" | "B" | "C") {
  // 길고 구조적인 것을 우선
  const sorted = [...hits].sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));

  // ✅ 본문: 파일/조각 헤더 없이 “원문 내용”만 이어붙이기
  const parts = sorted
    .map((h) => formatAnswerForUser((h.content ?? "").toString()))
    .filter((t) => t.length > 0);

  let body = `분류: 의도 ${intent}\n\n` + parts.join("\n\n────────────────────────\n\n");

  // ✅ 출처는 맨 아래에만
  const citations = sorted.map((h) => ({ filename: h.filename, chunk_index: h.chunk_index }));
  if (citations.length > 0) {
    body +=
      "\n\n[출처]\n" +
      citations.map((c) => `- ${c.filename} / 조각 ${c.chunk_index}`).join("\n");
  }

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
      match_count: 12,
      min_sim: 0.12,
    });
    if (error) throw new Error(error.message);

    // fallback 재검색
    if (!hits || hits.length === 0) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: null,
        match_count: 12,
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

    // 4) 베스트 chunk 1개 고르고, 그 주변(앞/뒤 1개)만 출력
    const sortedBySim = [...pool].sort((a: any, b: any) => (b.sim ?? 0) - (a.sim ?? 0));
    const best: Hit = {
      document_id: sortedBySim[0].document_id,
      filename: sortedBySim[0].filename,
      chunk_index: sortedBySim[0].chunk_index,
      content: sortedBySim[0].content,
      sim: sortedBySim[0].sim,
    };

    const finalHits = pickContiguousHits(best, pool as Hit[]);

    const { text: answer, citations } = toAnswer(finalHits, intent);

    return NextResponse.json({
      answer,
      citations,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
