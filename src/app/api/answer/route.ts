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

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const body = await req.json().catch(() => ({}));
    const q =
  (body?.q ??
    body?.message ??
    body?.question ??
    body?.text ??
    body?.prompt ??
    body?.input ??
    "") // 여기까지 모두 허용
    .toString()
    .trim();

if (!q) {
  return NextResponse.json(
    { error: "q is required", received_keys: Object.keys(body ?? {}) },
    { status: 400 }
  );
}

    // 1) tsv 기반 FTS: document_blocks만으로 1차 hit
    // websearch 문법을 흉내내기 위해 간단히 공백을 & 로 바꿈
    const fts = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t: string) => t.replace(/[':()&|!]/g, "")) // tsquery 깨지는 문자 최소 제거
      .filter(Boolean)
      .join(" & ");

    const { data: hits, error: e1 } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .textSearch("tsv", fts, { type: "plain" })
      .limit(14);

    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

    if (!hits || hits.length === 0) {
      return NextResponse.json({ ok: true, blocks: [], message: FALLBACK });
    }

    // 2) 문서 pick: 가장 많이 hit된 문서
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

    // 3) 파일명 조회
    const { data: doc, error: eDoc } = await sb
      .from("documents")
      .select("id, filename")
      .eq("id", bestDocId)
      .single();

    if (eDoc) return NextResponse.json({ error: eDoc.message }, { status: 500 });

    // 4) 주변 문맥 window 확장
    const topIndices = hits
      .filter((h) => h.document_id === bestDocId)
      .slice(0, 5)
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
        picked_document: { id: bestDocId, filename: doc.filename, hitCount: bestCount },
        window: { from: minI, to: maxI },
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "answer error" }, { status: 500 });
  }
}