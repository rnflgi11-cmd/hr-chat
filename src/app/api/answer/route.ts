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
 * ✅ 표 복원기 (멀티-표 + 기타휴가 표 전용)
 * - 경조휴가 표: 단순 6컬럼 묶기
 * - 기타휴가(구분/유형/내용/휴가일수/첨부서류/비고) 표: "휴가 카테고리" 그룹 기반 전용 파서
 * - consumedUntil은 반드시 i(실제로 읽은 끝)로: 표 뒤 내용 누락 방지
 */
function rebuildFlatTableWithContext(text: string): { rebuilt: string; hasTable: boolean } {
  const raw = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);

  if (raw.length < 8) return { rebuilt: (text ?? "").toString().trim(), hasTable: false };

  type Cand = {
    headers: string[];
    kind?: "default" | "leave6" | "leaveStructured";
    firstColAllow?: Set<string>;
  };

  const cands: Cand[] = [
    // 경조휴가
    {
      headers: ["구분", "경조유형", "대상", "휴가일수", "첨부서류", "비고"],
      kind: "default",
      firstColAllow: new Set(["경사", "조의"]),
    },

    // ✅ 기타휴가(공가 포함) - 스샷 형태
    {
      headers: ["구분", "유형", "내용", "휴가일수", "첨부서류", "비고"],
      kind: "leaveStructured",
    },

    // 기타 후보
    { headers: ["구분", "내용"], kind: "default" },
    { headers: ["항목", "지원대상", "신청 기준일"], kind: "default" },
    { headers: ["항목", "지원 대상", "신청 기준일"], kind: "default" },
    { headers: ["구분", "기준", "포상 금액"], kind: "default" },
    { headers: ["구분", "내용", "지급 비용", "비고"], kind: "default" },
    { headers: ["구분", "내용", "지급비용", "비고"], kind: "default" },
  ];

  const sectionStarts = new Set([
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

  const startsWithMarker = (s: string) => s.startsWith("✅") || s.startsWith("📌");
  const isDivider = (s: string) => /^[─-]{5,}$/.test((s ?? "").replace(/\s+/g, ""));

  function matchHeaderAt(i: number): Cand | null {
    const sorted = [...cands].sort((a, b) => b.headers.length - a.headers.length);
    for (const cand of sorted) {
      const h = cand.headers;
      if (i + h.length > raw.length) continue;
      let ok = true;
      for (let k = 0; k < h.length; k++) {
        if (raw[i + k] !== h[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return cand;
    }
    return null;
  }

  function rowsFromCellsDefault(cells: string[], cols: number, cand: Cand): string[][] {
    if (cells.length % cols !== 0) {
      while (cells.length % cols !== 0) cells.push("");
    }

    const rowCount = Math.floor(cells.length / cols);
    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r++) rows.push(cells.slice(r * cols, r * cols + cols));

    if (cand.firstColAllow) {
      let cut = rows.length;
      for (let r = 0; r < rows.length; r++) {
        const c0 = (rows[r][0] ?? "").trim();
        if (c0 && !cand.firstColAllow.has(c0)) {
          cut = r;
          break;
        }
      }
      return rows.slice(0, cut);
    }

    return rows;
  }

  // (옵션) leave6가 필요한 경우 대비해 남겨둠
  function rowsFromCellsLeave6(cells: string[], cols: number): string[][] {
    const firstSet = new Set(["기타", "공가", "경사", "조의"]);
    let prevFirst = "";
    let row: string[] = [];
    const rows: string[][] = [];

    const pushRow = (r: string[]) => {
      const out = [...r];
      while (out.length < cols) out.push("");
      rows.push(out.slice(0, cols));
      prevFirst = out[0] ?? prevFirst;
    };

    for (const cell of cells) {
      const v = (cell ?? "").trim();
      if (!v) continue;
      if (isDivider(v)) continue;

      if (firstSet.has(v)) {
        if (row.length > 0) pushRow(row);
        row = [v];
        continue;
      }

      if (row.length === 0) row = prevFirst ? [prevFirst, v] : [v];
      else row.push(v);

      if (row.length >= cols) {
        pushRow(row.slice(0, cols));
        row = row.slice(cols);
      }
    }

    if (row.length > 0) pushRow(row);
    return rows.filter((r) => r.filter((x) => (x ?? "").trim()).length >= 3);
  }

  // ✅ 스샷의 “기타휴가 표” 전용: "휴가 카테고리(법정·의무 휴가 ...)"를 구분으로 잡고 5개씩 행 구성
  function parseLeaveStructured(lines: string[]): string[][] {
    const rows: string[][] = [];

    const isHeaderWord = (s: string) =>
      s === "구분" || s === "유형" || s === "내용" || s === "휴가일수" || s === "첨부서류" || s === "비고";

    const isGroupTitle = (s: string) => s.includes("휴가") && !s.includes("휴가일수");

    let currentGroup = "";
    let buf: string[] = [];

    for (const rawLine of lines) {
      const s = (rawLine ?? "").trim();
      if (!s) continue;
      if (isDivider(s)) continue;
      if (isHeaderWord(s)) continue;

      // ✅ 구분(카테고리) 전환
      if (isGroupTitle(s)) {
        currentGroup = s;
        buf = [];
        continue;
      }

      if (!currentGroup) continue;

      buf.push(s);

      // 유형/내용/휴가일수/첨부서류/비고 = 5개
      if (buf.length >= 5) {
        const [type, content, days, doc, note] = buf.slice(0, 5);
        rows.push([currentGroup, type, content, days, doc, note]);
        buf = buf.slice(5);
      }
    }

    return rows;
  }

  function parseTable(from: number, cand: Cand): { md: string; consumedUntil: number; hasTable: boolean } {
    const headers = cand.headers;
    const cols = headers.length;

    let i = from + cols;
    const cells: string[] = [];

    while (i < raw.length) {
      const line = raw[i];

      if (matchHeaderAt(i)) break;
      if (startsWithMarker(line)) break;

      // ✅ leaveStructured/leave6는 표 내부에 섹션 성격 텍스트가 섞일 수 있어 섹션 컷을 약하게
      if (cand.kind !== "leave6" && cand.kind !== "leaveStructured" && sectionStarts.has(line)) break;

      cells.push(line);
      i++;
    }

    if (cells.length < cols) return { md: "", consumedUntil: from + 1, hasTable: false };

    let rows: string[][] = [];
    if (cand.kind === "leaveStructured" && cols === 6) {
      rows = parseLeaveStructured(cells);
    } else if (cand.kind === "leave6" && cols === 6) {
      rows = rowsFromCellsLeave6([...cells], cols);
    } else {
      rows = rowsFromCellsDefault([...cells], cols, cand);
    }

    if (!rows.length) return { md: "", consumedUntil: from + 1, hasTable: false };

    const mdLines: string[] = [];
    mdLines.push(`| ${headers.join(" | ")} |`);
    mdLines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const r of rows) {
      mdLines.push(`| ${r.map((c) => (c ?? "").replace(/\|/g, "｜")).join(" | ")} |`);
    }

    // ✅ 핵심: 실제로 읽은 끝(i)까지 소비해야 뒤 내용이 표 밖으로 떨어지지 않음
    const consumedUntil = i;

    return { md: "```text\n" + mdLines.join("\n") + "\n```", consumedUntil, hasTable: true };
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
      continue;
    }

    foundAny = true;
    out.push(parsed.md);
    idx = parsed.consumedUntil;
  }

  return { rebuilt: out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(), hasTable: foundAny };
}

/** 표(마크다운 |...|)가 있으면 codeblock으로 감싸기 */
function wrapAnyMarkdownTableAsCodeblock(text: string): string {
  const lines = (text ?? "").toString().split("\n");
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
  return (t ?? "")
    .toString()
    .replace(/\[BUILD_MARK_[^\]]+\]/g, "")
    .replace(/분류[\s\u00A0\u200B]*[:：][\s\u00A0\u200B]*의도[\s\u00A0\u200B]*[ABC]\s*/g, "")
    .replace(/^\[[^\]]+\/\s*조각\s*\d+\]$/gm, "")
    .replace(/^📌.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 최종 chunk 포맷: 표 복원 + 표는 codeblock 고정 */
function formatChunkContent(content: string): { text: string; hasTable: boolean } {
  const rebuilt = rebuildFlatTableWithContext(content);
  if (rebuilt.hasTable) return { text: rebuilt.rebuilt.trim(), hasTable: true };

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
  const h = (fileHint ?? "").toLowerCase();
  return f.includes(h) ? 0.5 : 0;
}

function buildAnswer(intent: "A" | "B" | "C", finalHits: Hit[]) {
  const formatted = finalHits.map((h) => {
    const f = formatChunkContent(h.content ?? "");
    return { ...h, formatted: f.text, hasTable: f.hasTable };
  });

  formatted.sort((a, b) => Number(b.hasTable) - Number(a.hasTable));

  let body = formatted.map((h) => h.formatted).join("\n\n────────────────────────\n\n");
  body = cleanText(body);

  const citations = formatted.map((h) => ({ filename: h.filename, chunk_index: h.chunk_index }));
  const sourceLines = citations.map((c) => `- ${c.filename} / 조각 ${c.chunk_index}`).join("\n");

  const out = body + (sourceLines ? `\n\n[출처]\n${sourceLines}` : "");
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
      match_count: 40,
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
        match_count: 40,
        min_sim: 0.12,
      });
      hits = (retry.data ?? []) as any[];
    }

    if (!hits.length) {
      return NextResponse.json({ intent, answer: FALLBACK, citations: [] });
    }

    // 3) 문서 점수 집계
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
      return NextResponse.json({ intent, answer: FALLBACK, citations: [] });
    }

    // 4) 문서 락 후 재검색
    const { data: lockedHits, error: lockErr } = await supabaseAdmin.rpc("search_chunks_in_document", {
      doc_id: bestDocId,
      q: question,
      tokens,
      match_count: 40,
      min_sim: 0.08,
    });
    if (lockErr) throw new Error(lockErr.message);

    const pool = ((lockedHits && lockedHits.length ? lockedHits : hits) ?? []) as any[];

    // 5) 토큰 포함률 + 길이로 최종 랭킹
    const scored = pool
      .map((h) => {
        const rate = tokenHitRate(tokens, h.content ?? "");
        const len = (h.content ?? "").toString().length;
        const sim = typeof h.sim === "number" ? h.sim : 0;
        const score = rate * 10 + sim * 2 + Math.min(1.5, len / 1500);
        return { ...h, rate, score };
      })
      .sort((a, b) => b.score - a.score);

    // 6) 표가 있으면 넉넉히 선택(조각 분절 대응)
    const top = scored.slice(0, 16);
    const tableFirst = top.find((h) => rebuildFlatTableWithContext(h.content ?? "").hasTable);

    let finalHits: Hit[] = [];
    if (tableFirst) {
      const picked = [tableFirst, ...top.filter((x) => x !== tableFirst)].slice(0, 12);
      finalHits = picked.map((h) => ({
        document_id: h.document_id,
        filename: h.filename,
        chunk_index: h.chunk_index,
        content: h.content,
        sim: h.sim,
      }));
    } else {
      finalHits = scored.slice(0, 8).map((h) => ({
        document_id: h.document_id,
        filename: h.filename,
        chunk_index: h.chunk_index,
        content: h.content,
        sim: h.sim,
      }));
    }

    const { answer, citations } = buildAnswer(intent, finalHits);
    return NextResponse.json({ intent, answer, citations });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
