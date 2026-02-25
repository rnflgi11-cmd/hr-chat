// search/context.ts
import { Evidence, Row } from "./types";

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
  isCatalog?: boolean; // ✅ 추가
}) {
  const { sb, q, bestDocId, hits, scoreRow, isCatalog } = params;

  // ✅ (핵심) 카탈로그 질문이면 문서에서 넓게 가져온다: 누락 방지
  if (isCatalog) {
    const { data, error } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .order("block_index", { ascending: true })
      .limit(500);

    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ---- 이하 기존 로직 유지 ----
  const isDayQuestion = /며칠|일수|몇일/.test(q);

  let minI = 0;
  let maxI = 0;

  const bestInDoc = hits
    .filter((r) => r.document_id === bestDocId)
    .map((r) => ({ r, s: scoreRow(r) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);

  // bestInDoc가 비는 경우 방어 (가끔 bestDocId만 잡히고 hits가 없을 수 있음)
  if (!bestInDoc.length) {
    const { data, error } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .order("block_index", { ascending: true })
      .limit(120);

    if (error) throw new Error(error.message);
    return data ?? [];
  }

  const baseIndices = bestInDoc.map((x) => x.r.block_index);
  const baseMin = Math.max(0, Math.min(...baseIndices) - 2);
  const baseMax = Math.max(...baseIndices) + 3;

  if (isDayQuestion) {
    const { data: dayCand, error: dayErr } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .eq("document_id", bestDocId)
      .or("text.ilike.%일%,table_html.ilike.%일%")
      .order("block_index", { ascending: true })
      .limit(300);

    if (dayErr) throw new Error(dayErr.message);

    const regex = /\d+\s*일/;
    const matched = (dayCand ?? []).filter((r: any) => {
      const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
      return regex.test(hay);
    });

    if (matched.length > 0) {
      const weighted = matched
        .map((r: any) => {
          const hay = `${r.text ?? ""}\n${r.table_html ?? ""}`;
          const bonus = /경조|조위|결혼|사망|부고|배우자|부모|자녀/.test(hay) ? 50 : 0;
          return { r, score: bonus + (r.kind === "table" ? 10 : 0) };
        })
        .sort((a: any, b: any) => b.score - a.score);

      const pivot = weighted[0].r.block_index;
      minI = Math.max(0, pivot - 3);
      maxI = pivot + 6;
    } else {
      minI = baseMin;
      maxI = baseMax;
    }
  } else {
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

  if (e2) throw new Error(e2.message);

  return ctx ?? [];
}

function cleanupCtx(rows: any[]) {
  const out: any[] = [];
  let prevWasTable = false;
  let dropBudget = 0;

  for (const r of rows) {
    const isTable = r.kind === "table" && (r.table_html ?? "").trim();
    const txt = (r.text ?? "").trim();

    if (isTable) {
      out.push(r);
      prevWasTable = true;
      dropBudget = 12;
      continue;
    }

    if (prevWasTable && dropBudget > 0) {
      if (txt.length <= 20) {
        dropBudget--;
        continue;
      }
      prevWasTable = false;
      dropBudget = 0;
    }

    out.push(r);
  }
  return out;
}

export function toEvidence(filename: string, ctx: any[]): Evidence[] {
  const cleaned = cleanupCtx(ctx);
  const ev = cleaned.map((b: any) => ({
    filename,
    block_type: b.kind === "table" ? "table_html" : "p",
    content_text: b.text ?? null,
    content_html: b.kind === "table" ? (b.table_html ?? null) : null,
  })) as Evidence[];

  // ✅ 카탈로그면 더 많이 넘겨도 괜찮지만, UI는 12개로 또 자름.
  // summarize용 evidenceAll은 여기서 너무 과하게 자르지 않는게 유리.
  return ev.slice(0, 80);
}