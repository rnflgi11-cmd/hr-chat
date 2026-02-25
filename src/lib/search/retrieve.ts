import { createClient } from "@supabase/supabase-js";
import { Row } from "./types";
import { buildWebsearchQuery, escapeLike } from "./query";


function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function retrieveCandidates(q: string, used: string[]) {
  const sb = supabaseAdmin();
  const webq = buildWebsearchQuery(q);

  let hits: Row[] = [];

  if (webq) {
    const { data, error } = await sb
      .from("document_blocks")
      .select("id, document_id, block_index, kind, text, table_html")
      .textSearch("tsv", webq, { type: "websearch", config: "simple" })
      .limit(80);

    if (error) throw new Error(error.message);
    hits = (data ?? []) as Row[];
  }

  if (!hits.length) {
    const all: Row[] = [];
    for (const t of used) {
      const like = `%${escapeLike(t)}%`;

      const { data, error } = await sb
        .from("document_blocks")
        .select("id, document_id, block_index, kind, text, table_html")
        .ilike("text", like)
        .limit(120);
      if (error) throw new Error(error.message);
      if (data?.length) all.push(...(data as Row[]));

      const { data: data2, error: error2 } = await sb
        .from("document_blocks")
        .select("id, document_id, block_index, kind, text, table_html")
        .ilike("table_html", like)
        .limit(120);
      if (error2) throw new Error(error2.message);
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

  return { sb, hits };
}