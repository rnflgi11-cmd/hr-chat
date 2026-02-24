// src/app/api/answer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const FALLBACK =
  "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

type Row = {
  id: string;
  document_id: string;
  block_index: number;
  kind: string; // "paragraph" | "table" 등
  text: string | null;
  table_html: string | null;
  tsv: any; // tsvector (select에 포함 안 해도 되지만 스키마상 존재)
};

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

function tokenize(q: string) {
  const stop = new Set([
    "알려줘",
    "알려",
    "어떻게",
    "뭐야",
    "뭔가",
    "뭔지",
    "있어",
    "없어",
    "가능",
    "될까",
    "되나",
    "합니다",
    "해주세요",
    "주세요",
    "며칠",
    "몇일",
    "몇",
    "일",
    "기준",
    "절차",
    "방법",
    "종류",
  ]);

  const base = (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !stop.has(t));

  // 긴 토큰 우선 (정확도)
  const uniq = Array.from(new Set(base)).sort((a, b) => b.length - a.length);

  // 핵심 2~3개 (너무 많으면 일반 단어에 끌림)
  return uniq.slice(0, 3);
}

function buildWebsearchQuery(q: string) {
  // websearch_to_tsquery에 안전하게 넣기 위해 위험 문자 제거(최소)
  return q.replace(/[':()&|!]/g, " ").replace(/\s+/g, " ").trim();
}

// ILIKE fallback 시 % _ escaping
function escapeLike(s: string) {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const body = await req.json().catch(() => ({}));
    const q = (body?.q ?? body?.question ?? "").toString().trim();
    if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

    const terms = tokenize(q);
    const used = terms.length ? terms : [q];

    // -----------------------------
    // 1) FTS 1차 후보 수집 (tsv)
    // -----------------------------
    const webq = buildWebsearchQuery(q);

    let hits: Row[] = [];
    if (webq) {
      const { data, error } = await sb
        .from("document_blocks")
        .select("id, document_id, block_index, kind, text, table_html")
        // ✅ 핵심: tsv 기반 전문검색
        .textSearch("tsv", webq, { type: "websearch", config: "simple" })
        .limit(80);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      hits = (data ?? []) as Row[];
    }

    // -----------------------------
    // 2) FTS가 0이면 ILIKE fallback
    // -----------------------------
    if (!hits.length) {
      const all: Row[] = [];
      for (const t of used) {
        const like = `%${escapeLike(t)}%`;

        const { data, error } = await sb
          .from("document_blocks")
          .select("id, document_id, block_index, kind, text, table_html")
          .ilike("text", like)
          .limit(120);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (data?.length) all.push(...(data as Row[]));

        const { data: data2, error: error2 } = await sb
          .from("document_blocks")
          .select("id, document_id, block_index, kind, text, table_html")
          .ilike("table_html", like)
          .limit(120);
        if (error2) return NextResponse.json({ error: error2.message }, { status: 500 });
        if (data2?.length) all.push(...(data2 as Row[]));
      }

      const seen = new Set<string>();
      hits = [];
      for (const r of all) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          hits.push(r);
        }
      }
    }

    // 없으면 fallback answer
    if (!hits.length) {
      return NextResponse.json({
        ok: true,
        answer: {
          intent: "규정 검색 결과",
          summary: FALLBACK,
          evidence: [] as Evidence[],
          related_questions: [] as string[],
        },
      });
    }

    // -----------------------------
    // 3) 앱단 점수화 (FTS 후보 중에서 “정답 블록/문서” 선택)
    //    - 긴 토큰 포함 시 가중치 크게
    //    - 표(table) 약간 가산
    // -----------------------------
    function scoreRow(r: Row) {
  const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
  let s = 0;

  for (const t of used) {
    if (!t) continue;
    if (hay.includes(t)) s += 10 + Math.min(12, t.length * 2);
  }

  // 🔥 질문 전체 포함 시 가산
  const qCompact = q.replace(/\s+/g, "");
  const hayCompact = hay.replace(/\s+/g, "");
  if (qCompact.length >= 4 && hayCompact.includes(qCompact)) s += 25;

  // 🔥 "며칠/일수/몇일" 질문이면 숫자+일 포함 블록에 강한 가산
  if (/며칠|일수|몇일/.test(q)) {
    if (/\d+\s*일/.test(hay)) s += 40; // 🔥 핵심 가중치
  }

  // 🔥 "얼마/금액/수당" 질문이면 숫자+원 가산
  if (/얼마|금액|수당/.test(q)) {
    if (/\d+[,0-9]*\s*원/.test(hay)) s += 40;
  }

  if (r.kind === "table" && r.table_html) s += 6;

  return s;
}

    // 문서 점수 합산
    const docScore = new Map<string, number>();
    for (const r of hits) {
      docScore.set(r.document_id, (docScore.get(r.document_id) ?? 0) + scoreRow(r));
    }

    // best 문서 선택
    let bestDocId = hits[0].document_id;
    let bestScore = -1;
    for (const [docId, s] of docScore.entries()) {
      if (s > bestScore) {
        bestScore = s;
        bestDocId = docId;
      }
    }

    // 문서명
    const { data: doc, error: eDoc } = await sb
      .from("documents")
      .select("id, filename")
      .eq("id", bestDocId)
      .single();

    if (eDoc) return NextResponse.json({ error: eDoc.message }, { status: 500 });

    // best 문서에서 “가장 점수 높은 블록” 중심으로 window 확장
    // best 문서에서 window 확장 (기본: 상위 hit 주변)
// ✅ 며칠/일수 질문이면: 문서 내에서 "\d+일" 블록을 다시 찾아 그 주변을 보여준다.
const isDayQuestion = /며칠|일수|몇일/.test(q);

let minI = 0;
let maxI = 0;

// 1) 기본 window 후보 (상위 hit 기반)
const bestInDoc = hits
  .filter((r) => r.document_id === bestDocId)
  .map((r) => ({ r, s: scoreRow(r) }))
  .sort((a, b) => b.s - a.s)
  .slice(0, 6);

const baseIndices = bestInDoc.map((x) => x.r.block_index);
const baseMin = Math.max(0, Math.min(...baseIndices) - 2);
const baseMax = Math.max(...baseIndices) + 3;

// 2) "며칠/일수"면 숫자+일 블록을 문서에서 추가 탐색
if (isDayQuestion) {
  // 문서 내에서 '일'이 들어간 블록을 넓게 가져온 뒤 서버에서 정규식으로 걸러냄
  const { data: dayCand, error: dayErr } = await sb
    .from("document_blocks")
    .select("id, document_id, block_index, kind, text, table_html")
    .eq("document_id", bestDocId)
    .or("text.ilike.%일%,table_html.ilike.%일%")
    .order("block_index", { ascending: true })
    .limit(300);

  if (dayErr) return NextResponse.json({ error: dayErr.message }, { status: 500 });

  const regex = /\d+\s*일/;

  const matched = (dayCand ?? []).filter((r: any) => {
    const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
    return regex.test(hay);
  });

  // 숫자+일 블록이 있으면 그 주변을 우선
  if (matched.length > 0) {
    // "경조" 관련 단어가 같이 있으면 더 우선
    const weighted = matched
      .map((r: any) => {
        const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
        const bonus = /경조|조위|결혼|사망|부고|배우자|부모|자녀/.test(hay) ? 50 : 0;
        return { r, score: bonus + (r.kind === "table" ? 10 : 0) };
      })
      .sort((a: any, b: any) => b.score - a.score);

    const pivot = weighted[0].r.block_index;
    minI = Math.max(0, pivot - 3);
    maxI = pivot + 6; // 표는 아래로 조금 더
  } else {
    // 숫자+일 못 찾으면 기본 window
    minI = baseMin;
    maxI = baseMax;
  }
} else {
  // 기본 질문은 기존 window
  minI = baseMin;
  maxI = baseMax;
}

    const { data: ctx, error: e2 } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .gte("block_index", minI)
      .lte("block_index", maxI)
      .order("block_index", { ascending: true });

    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

    // evidence 변환 (프론트 AnswerRenderer가 읽는 형태)
    const evidence: Evidence[] = (ctx ?? []).map((b: any) => ({
      filename: doc.filename,
      block_type: b.kind === "table" ? "table_html" : "p",
      content_text: b.text ?? null,
      content_html: b.kind === "table" ? (b.table_html ?? null) : null,
    }));

    // intent는 최소 분류(룰 기반)
    const intent =
      /경조|조위|결혼|부고|사망/.test(q) ? "경조/경조휴가" :
      /연차|반차|휴가/.test(q) ? "휴가" :
      /수당|정산|지급/.test(q) ? "수당/정산" :
      "규정 검색 결과";

    return NextResponse.json({
      ok: true,
      answer: {
        intent,
        summary: "", // 렌더러에서 evidence 기반으로 사람답게 요약 중
        evidence,
        related_questions: [],
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "answer error" }, { status: 500 });
  }
}