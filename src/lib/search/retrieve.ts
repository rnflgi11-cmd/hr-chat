// lib/search/retrieve.ts
import { supabaseAdmin as sb } from "../supabaseAdmin";
import type { Row } from "./types";

export async function retrieveCandidates(q: string, used: string[]) {
  const terms = Array.from(
    new Set(
      (used?.length ? used : [q])
        .map((s) => (s ?? "").toString().trim())
        .filter(Boolean)
    )
  ).slice(0, 12);

  const orParts: string[] = [];

  for (const t of terms) {
    if (t.length <= 1) continue;
    const esc = t.replace(/%/g, "\\%").replace(/_/g, "\\_");
    orParts.push(`text.ilike.%${esc}%`);
    orParts.push(`table_html.ilike.%${esc}%`);
  }

  if (!orParts.length) {
    const esc = (q ?? "").replace(/%/g, "\\%").replace(/_/g, "\\_");
    orParts.push(`text.ilike.%${esc}%`);
    orParts.push(`table_html.ilike.%${esc}%`);
  }

  const { data, error } = await sb
    .from("document_blocks")
    .select("id, document_id, block_index, kind, text, table_html")
    .or(orParts.join(","))
    .order("document_id", { ascending: true })
    .order("block_index", { ascending: true })
    .limit(900);

  if (error) throw new Error(error.message);

  const hits = (data ?? []) as Row[];

  return { sb, hits };
}