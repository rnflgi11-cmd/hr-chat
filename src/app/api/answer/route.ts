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

type Hit = {
  id: string;
  document_id: string;
  block_index: number;
  kind: string;
  text: string | null;
  table_html: string | null;
};

function tokenize(q: string) {
  // 한글/영문/숫자 덩어리 토큰화
  const tokens = (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  // 너무 흔한/의미 약한 토큰 제거(검색 노이즈 줄임)
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
  ]);

  const cleaned = tokens.filter((t) => !stop.has(t));
  // 토큰이 너무 많으면 느려지니 상위 6개만
  return cleaned.slice(0, 6);
}

function escapeLikeTerm(t: string) {
  // PostgREST ilike 패턴에서 % _ 이스케이프
  return t.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const body = await req.json().catch(() => ({}));

    // 프론트는 question으로 보내고 있으니 둘 다 받기
    const q = (body?.q ?? body?.question ?? body?.text ?? body?.message ?? "")
      .toString()
      .trim();

    if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

    // 1) 토큰화해서 OR ILIKE 검색 (한국어 안정)
    const tokens = tokenize(q);
    const terms = tokens.length ? tokens : [q];

    const orFilters = terms
      .flatMap((t) => {
        const like = `%${escapeLikeTerm(t)}%`;
        return [`text.ilike.${like}`, `table_html.ilike.${like}`];
      })
      .join(",");

    const { data: hitsRaw, error: e1 } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .or(orFilters)
      .limit(40);

    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

    const hits = (hitsRaw ?? []) as Hit[];
    if (!hits.length) {
      return NextResponse.json({
        ok: true,
        blocks: [],
        message: FALLBACK,
        meta: { query: q, tokens, mode: "ilike_or" },
      });
    }

    // 2) 문서 pick: 가장 많이 hit된 문서(동률이면 더 앞에 나온 문서)
    const countByDoc = new Map<string, number>();
    for (const h of hits) countByDoc.set(h.document_id, (countByDoc.get(h.document_id) ?? 0) + 1);

    let bestDocId = hits[0].document_id;
    let bestCount = -1;
    for (const [docId, c] of countByDoc.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestDocId = docId;
      }
    }

    // 3) 파일명 조회 (documents에 filename 존재)
    const { data: doc, error: eDoc } = await sb
      .from("documents")
      .select("id, filename")
      .eq("id", bestDocId)
      .single();

    if (eDoc) return NextResponse.json({ error: eDoc.message }, { status: 500 });

    // 4) 주변 문맥 window 확장
    const topIndices = hits
      .filter((h) => h.document_id === bestDocId)
      .slice(0, 8)
      .map((h) => h.block_index);

    const minI = Math.max(0, Math.min(...topIndices) - 2);
    const maxI = Math.max(...topIndices) + 2;

    const { data: ctx, error: e2 } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .gte("block_index", minI)
      .lte("block_index", maxI)
      .order("block_index", { ascending: true });

    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

    const blocks = (ctx ?? []).map((b: any) => ({
      document_id: b.document_id,
      filename: doc.filename,
      block_id: b.id,
      block_index: b.block_index,
      kind: b.kind,
      text: b.text ?? null,
      table_html: b.table_html ?? null,
    }));

    return NextResponse.json({
      ok: true,
      blocks,
      meta: {
        query: q,
        tokens,
        picked_document: { id: bestDocId, filename: doc.filename, hitCount: bestCount },
        window: { from: minI, to: maxI },
        mode: "ilike_or",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "answer error" }, { status: 500 });
  }
}