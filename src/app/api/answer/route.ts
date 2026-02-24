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
  kind: string;
  text: string | null;
  table_html: string | null;
};

function tokenize(q: string) {
  const stop = new Set([
    "알려줘","알려","어떻게","뭐야","뭔가","뭔지","있어","없어","가능","될까","되나",
    "합니다","해주세요","주세요","며칠","몇일","몇","일","기준","절차","방법","종류"
  ]);

  const base = (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !stop.has(t));

  // 긴 토큰 우선 정렬
  const uniq = Array.from(new Set(base)).sort((a, b) => b.length - a.length);

  // 핵심 토큰 2개만 사용(안정성↑, 속도↑)
  return uniq.slice(0, 2);
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const body = await req.json().catch(() => ({}));
    const q = (body?.q ?? body?.question ?? "").toString().trim();
    if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

    const terms = tokenize(q);
    const used = terms.length ? terms : [q];

    // ✅ OR 조합을 피하고, 핵심 토큰 1~2개를 순차적으로 “넓게” 가져온 뒤 서버에서 합침
    const all: Row[] = [];
    for (const t of used) {
      const like = `%${t}%`;
      const { data, error } = await sb
        .from("document_blocks")
        .select("id, document_id, block_index, kind, text, table_html")
        .ilike("text", like)
        .limit(120);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.length) all.push(...(data as Row[]));

      // 표에도 토큰이 있을 수 있으니 table_html도 한 번 더 (table 위주 문서 대비)
      const { data: data2, error: error2 } = await sb
        .from("document_blocks")
        .select("id, document_id, block_index, kind, text, table_html")
        .ilike("table_html", like)
        .limit(120);

      if (error2) return NextResponse.json({ error: error2.message }, { status: 500 });
      if (data2?.length) all.push(...(data2 as Row[]));
    }

    // 중복 제거(id 기준)
    const seen = new Set<string>();
    const hits: Row[] = [];
    for (const r of all) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        hits.push(r);
      }
    }

    if (!hits.length) {
      return NextResponse.json({
        ok: true,
        blocks: [],
        message: FALLBACK,
        meta: { query: q, used_terms: used, mode: "ilike_multi" },
      });
    }

    // 문서 점수화: 사용한 토큰이 text/table_html에 포함되면 점수 부여 (길수록 가중치↑)
    function scoreRow(r: Row) {
      const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
      let s = 0;
      for (const t of used) {
        if (hay.includes(t)) s += 5 + Math.min(8, t.length); // 긴 토큰 우대
      }
      if (r.kind === "table" && r.table_html) s += 2;
      return s;
    }

    const docScore = new Map<string, number>();
    for (const r of hits) {
      const s = scoreRow(r);
      docScore.set(r.document_id, (docScore.get(r.document_id) ?? 0) + s);
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

    // 상위 hit들의 index 기반 window 확장
    const bestIndices = hits
      .filter((r) => r.document_id === bestDocId)
      .sort((a, b) => scoreRow(b) - scoreRow(a))
      .slice(0, 6)
      .map((r) => r.block_index);

    const minI = Math.max(0, Math.min(...bestIndices) - 2);
    const maxI = Math.max(...bestIndices) + 2;

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
        used_terms: used,
        picked_document: { id: bestDocId, filename: doc.filename, score: bestScore },
        window: { from: minI, to: maxI },
        mode: "ilike_multi",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "answer error" }, { status: 500 });
  }
}