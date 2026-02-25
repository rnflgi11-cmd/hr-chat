import type { Evidence, Row } from "./types";

export async function loadDocFilename(sb: any, docId: string) {
  const { data, error } = await sb
    .from("documents")
    .select("id, filename")
    .eq("id", docId)
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string; filename: string };
}

export async function buildWindowContext(params: {
  sb: any;
  q: string;
  bestDocId: string;
  hits: Row[];
  scoreRow: (r: Row) => number;
}) {
  const { sb, q, bestDocId, hits, scoreRow } = params;

  const isDayQuestion = /며칠|일수|몇일/.test(q);

  const bestInDoc = hits
    .filter((r) => r.document_id === bestDocId)
    .map((r) => ({ r, s: scoreRow(r) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);

  // 방어
  if (!bestInDoc.length) {
    const { data, error } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .order("block_index", { ascending: true })
      .limit(160);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  const baseIndices = bestInDoc.map((x) => x.r.block_index);
  let minI = Math.max(0, Math.min(...baseIndices) - 2);
  let maxI = Math.max(...baseIndices) + (isDayQuestion ? 8 : 3);

  const { data: ctx, error } = await sb
    .from("document_blocks")
    .select("id, document_id, block_index, kind, text, table_html")
    .eq("document_id", bestDocId)
    .gte("block_index", minI)
    .lte("block_index", maxI)
    .order("block_index", { ascending: true });

  if (error) throw new Error(error.message);
  return ctx ?? [];
}

export function toEvidence(filename: string, ctx: any[]): Evidence[] {
  const ev: Evidence[] = [];

  for (const b of ctx ?? []) {
    if (b.kind === "table" && (b.table_html ?? "").trim()) {
      // ✅ 표는 일단 "문자열"로만 보존(깨지지 않게)
      ev.push({
        filename,
        block_type: "table_html",
        content_text: (b.table_html ?? "").toString(),
        content_html: null,
      });
      continue;
    }

    const t = (b.text ?? "").toString().trim();
    if (t) {
      ev.push({
        filename,
        block_type: "p",
        content_text: t,
        content_html: null,
      });
    }
  }

  return ev.slice(0, 200);
}