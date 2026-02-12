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

  return Array.from(new Set([...force, ...base])).slice(0, 14);
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
 * DOCX 표가 "셀 텍스트가 줄바꿈으로 풀린 형태"로 저장된 경우:
 * - 헤더 시퀀스를 찾고 N열씩 묶어서 Markdown 표로 복원
 * - 표 아래 다른 섹션(기타/유의사항/신청방법 등)이 표 안으로 섞이지 않게 컷팅
 */
function rebuildFlatTableWithContext(text: string): { rebuilt: string; hasTable: boolean } {
  const rawLines = text
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 10) return { rebuilt: text.trim(), hasTable: false };

  // 표 헤더 후보
  const headerCandidates: { headers: string[]; firstColAllow?: Set<string> }[] = [
    {
      headers: ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"],
      firstColAllow: new Set(["경사", "조의"]),
    },
    { headers: ["구분", "내용"] },
    { headers: ["항목", "지원대상", "신청 기준일"] },
    { headers: ["항목", "지원 대상", "신청 기준일"] },
    { headers: ["구분", "기준", "포상 금액"] },
    { headers: ["구분", "내용", "지급 비용", "비고"] },
    { headers: ["구분", "내용", "지급비용", "비고"] },
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

  // 표 밑 섹션 시작 단어(표 row 계산은 여기서 멈춤)
  const sectionStarts = new Set([
    "기타",
    "참고사항",
    "유의사항",
    "신청방법",
    "신청 방법",
    "지급일",
    "지급 시점",
    "지급시점",
    "사용 절차",
    "사용절차",
    "필수 확인 사항",
    "포상 제외 대상",
    "포상 기준",
  ]);

  for (const cand of headerCandidates) {
    const headers = cand.headers;
    const hIdx = findHeaderIndex(headers);
    if (hIdx === -1) continue;

    const cols = headers.length;

    const before = rawLines.slice(0, hIdx).join("\n").trim();
    const after = rawLines.slice(hIdx + headers.length);

    // row 계산 범위 컷
    let cutForRowCalc = after.length;
    for (let i = 0; i < after.length; i++) {
      if (sectionStarts.has(after[i])) {
        cutForRowCalc = i;
        break;
      }
      // 표가 다시 시작되는 경우(헤더가 또 나오면)도 컷
      if (after[i] === headers[0] && after.slice(i, i + headers.length).every((v, k) => v === headers[k])) {
        cutForRowCalc = i;
        break;
      }
    }

    const tableArea = after.slice(0, cutForRowCalc);
    const tail = after.slice(cutForRowCalc).join("\n").trim();

    // 표 row 후보 생성(일단 cols 단위로 묶기)
    const rowCount = Math.floor(tableArea.length / cols);
    if (rowCount <= 0) continue;

    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r++) {
      const row = tableArea.slice(r * cols, r * cols + cols);
      rows.push(row);
    }

    // ✅ 경조휴가 표 같은 경우: 첫 컬럼 값이 경사/조의가 아니면 그 이후는 표가 아닌 꼬리로 판단(깨짐 방지)
    let rowsCut = rows.length;
    if (cand.firstColAllow) {
      for (let i = 0; i < rows.length; i++) {
        const c0 = (rows[i][0] ?? "").trim();
        if (c0 && !cand.firstColAllow.has(c0)) {
          rowsCut = i;
          break;
        }
      }
    }
    const safeRows = rows.slice(0, rowsCut);
    const extraTail =
      rowsCut < rows.length
        ? rows
            .slice(rowsCut)
            .flat()
            .join("\n")
            .trim()
        : "";

    if (!safeRows.length) continue;

    const md: string[] = [];
    md.push(`| ${headers.join(" | ")} |`);
    md.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of safeRows) {
      md.push(`| ${row.map((c) => (c ?? "").replace(/\|/g, "｜")).join(" | ")} |`);
    }

    const outParts: string[] = [];
    if (before) outParts.push(before);

    // ✅ 표는 반드시 codeblock으로 감싸서 UI에서 안 깨지게
    outParts.push("```text\n" + md.join("\n") + "\n```");

    // 표 아래 설명 유지(표 밖으로)
    const mergedTail = [tail, extraTail].filter(Boolean).join("\n").trim();
    if (mergedTail) outParts.push(mergedTail);

    return { rebuilt: outParts.join("\n\n").trim(), hasTable: true };
  }

  return { rebuilt: text.trim(), hasTable: false };
}

/** 표(마크다운 |...|)가 있으면 codeblock으로 감싸기 */
function wrapAnyMarkdownTableAsCodeblock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  let buf: string[] = [];
  let inTable = false;

  const flush = () => {
    if (buf.length) {
      out.push("```text\n" + buf.join("\n") + "\n```");
      buf = [];
    }
  };

  for (const l of lines) {
    const t = l.trim();
    const isTableLine = t.startsWith("|") && t.endsWith("|");
    if (isTableLine) {
      inTable = true;
      buf.push(t);
      continue;
    }
    if (inTable) {
      flush();
      inTable = false;
    }
    out.push(l);
  }
  if (inTable) flush();

  return out.join("\n").trim();
}

/** build mark, 중복 분류, 조각 헤더 등 출력용 정리 */
function cleanText(t: string) {
  return t
    .replace(/\[BUILD_MARK_[^\]]+\]/g, "")
    .replace(/^분류:\s*의도\s*[ABC]\s*$/gm, "")
    .replace(/^(분류:\s*의도\s*[ABC]\s*)+/gm, "")
    .replace(/^\[[^\]]+\/\s*조각\s*\d+\]$/gm, "")
    .replace(/^📌.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 최종 chunk 포맷: 표 복원 + 표는 codeblock 고정 */
function formatChunkContent(content: string): { text: string; hasTable: boolean } {
  const rebuilt = rebuildFlatTableWithContext(content);
  if (rebuilt.hasTable) return { text: rebuilt.rebuilt.trim(), hasTable: true };

  // 일반 chunk인데 마크다운 표가 포함된 경우도 codeblock 처리
  const wrapped = wrapAnyMarkdownTableAsCodeblock((content ?? "").toString().trim());
  return { text: wrapped, hasTable: wrapped.includes("```text\n|") };
}

function tokenHitRate(tokens: string[], content: string) {
  const lower = (content ?? "").toLowerCase();
  const hit = tokens.filter((k) => lower.includes(k.toLowerCase())).length;
  return hit / Math.max(1, tokens.length);
}

function filenameBoost(fileHint: string | null, filename: string) {
  if (!fileHint) return 0;
  const f = (filename ?? "").toLowerCase();
  const h = fileHint.toLowerCase();
  return f.includes(h) ? 0.5 : 0; // 문서 선택시 강하게 가중
}

function buildAnswer(intent: "A" | "B" | "C", finalHits: Hit[]) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    return { ...h, formatted: f.text, hasTable: f.hasTable };
  });

  formatted.sort((a, b) => Number(b.hasTable) - Number(a.hasTable));

  let body = formatted.map((h) => h.formatted).join("\n\n────────────────────────\n\n");
  body = cleanText(body);

  // ✅ (추가) 본문에 섞여 들어온 "분류: 의도 X" 라인은 전부 제거
  // (맨 위 타이틀은 아래에서 다시 넣으니 문제 없음)
  body = body.replace(/^분류:\s*의도\s*[ABC]\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

  const citations = formatted.map((h) => ({ filename: h.filename, chunk_index: h.chunk_index }));
  const sourceLines = citations.map((c) => `- ${c.filename} / 조각 ${c.chunk_index}`).join("\n");

  const out =
    `분류: 의도 ${intent}\n\n` +
    body +
    (sourceLines ? `\n\n[출처]\n${sourceLines}` : "");

  return { answer: out.trim(), citations };
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

    // 1) 1차 검색(힌트 포함)
    let { data: hits, error } = await supabaseAdmin.rpc("search_chunks_text_v3", {
      q: question,
      tokens,
      file_hint: fileHint,
      match_count: 18,
      min_sim: 0.12,
    });
    if (error) throw new Error(error.message);
    hits = (hits ?? []) as any[];

    // 2) 힌트 실패 시 2차 검색(힌트 제거)
    if (!hits.length) {
      const retry = await supabaseAdmin.rpc("search_chunks_text_v3", {
        q: question,
        tokens,
        file_hint: null,
        match_count: 18,
        min_sim: 0.12,
      });
      hits = (retry.data ?? []) as any[];
    }

    if (!hits.length) {
      return NextResponse.json({ answer: `분류: 의도 ${intent}\n\n${FALLBACK}`, citations: [] });
    }

    // 3) 문서 점수 집계 (sim + count + filename 힌트 가중)
    const scoreByDoc = new Map<string, { sum: number; count: number; filename: string }>();
    for (const h of hits) {
      const key = h.document_id;
      const cur = scoreByDoc.get(key) ?? { sum: 0, count: 0, filename: h.filename };
      const sim = typeof h.sim === "number" ? h.sim : 0;
      cur.sum += sim;
      cur.count += 1;
      cur.filename = h.filename;
      scoreByDoc.set(key, cur);
    }

    const rankedDocs = Array.from(scoreByDoc.entries())
      .map(([docId, v]) => ({
        docId,
        filename: v.filename,
        score: v.sum + v.count * 0.15 + filenameBoost(fileHint, v.filename),
      }))
      .sort((a, b) => b.score - a.score);

    const bestDocId = rankedDocs[0]?.docId;
    if (!bestDocId) {
      return NextResponse.json({ answer: `분류: 의도 ${intent}\n\n${FALLBACK}`, citations: [] });
    }

    // 4) 문서 락 후 재검색(잡탕 제거 핵심)
    const { data: lockedHits, error: lockErr } = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId,
      q: question,
      tokens,
      match_count: 22,
      min_sim: 0.10,
    });
    if (lockErr) throw new Error(lockErr.message);

    const pool = ((lockedHits && lockedHits.length ? lockedHits : hits) ?? []) as any[];

    // 5) 토큰 포함률 + 길이로 최종 랭킹 (정확도 상승)
    const scored = pool
      .map((h) => {
        const rate = tokenHitRate(tokens, h.content ?? "");
        const len = (h.content ?? "").toString().length;
        const sim = typeof h.sim === "number" ? h.sim : 0;
        // ✅ 토큰 포함률을 가장 크게 반영, sim은 보조
        const score = rate * 10 + sim * 2 + Math.min(1.5, len / 1500);
        return { ...h, rate, score };
      })
      .sort((a, b) => b.score - a.score);

    // 6) 표가 잡히면 표 chunk를 포함하도록 더 넉넉히 선택
    const top = scored.slice(0, 10);
    const tableFirst = top.find((h) => rebuildFlatTableWithContext(h.content ?? "").hasTable);
    let finalHits: Hit[] = [];

    if (tableFirst) {
      // ✅ 표가 있는 문서면 표 중심으로 4~6개만 뽑아도 충분
      const picked = [tableFirst, ...top.filter((x) => x !== tableFirst)].slice(0, 5);
      finalHits = picked.map((h) => ({
        document_id: h.document_id,
        filename: h.filename,
        chunk_index: h.chunk_index,
        content: h.content,
        sim: h.sim,
      }));
    } else {
      finalHits = scored.slice(0, 4).map((h) => ({
        document_id: h.document_id,
        filename: h.filename,
        chunk_index: h.chunk_index,
        content: h.content,
        sim: h.sim,
      }));
    }

    const { answer, citations } = buildAnswer(intent, finalHits);
    return NextResponse.json({ answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
