// src/lib/search/context.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Evidence } from "./types";

/**
 * ⚠️ index.ts 결합 유지:
 * - export: buildWindowContext, loadDocFilename, toEvidence
 * - toEvidence 시그니처: toEvidence(filename, ctx)
 * - Evidence 타입은 반드시 ./types 의 Evidence 를 사용 (중요!)
 *
 * ✅ 표준화 강제:
 * - table_html: content_html 없으면 table_ok=false (extract에서 A/B/C에 절대 못 타게)
 * - text는 content_text로 통일(p/li/bullet/html text 모두 합침) + block_type="p"
 */

export type ContextBlock = {
  document_id: string;
  filename: string;
  chunk_index: number;
  open_url?: string;

  block_type?: string; // p / li / bullet / table_html / ...
  content_text?: string;
  content_html?: string;

  sim?: number;
  score?: number;

  raw?: any;
};

export type DocInfo = {
  id: string;
  filename: string;
  open_url?: string;
};

function normalizeText(rawText: string) {
  const t = (rawText || "").replace(/\r/g, "").trim();
  if (!t) return "";
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripHtmlToText(html: string) {
  const s = (html || "")
    .replace(/\r/g, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<\s*p[^>]*>/gi, "")
    .replace(/<\/\s*li\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\/\s*(div|section|article|ul|ol)\s*>/gi, "\n")
    .replace(/<\s*(div|section|article|ul|ol)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");

  return normalizeText(s);
}

function isProbablyHtml(s: string) {
  const x = (s || "").trim();
  return x.startsWith("<") && x.includes(">");
}

function isProbablyTableHtml(html: string) {
  const s = (html || "").toLowerCase();
  return s.includes("<table") || s.includes("<tr") || s.includes("<td") || s.includes("<th");
}

/**
 * documents 테이블에서 filename/open_url 로드
 */
export async function loadDocFilename(sb: SupabaseClient, documentId: string): Promise<DocInfo> {
  const { data, error } = await sb
    .from("documents")
    .select("id, filename, open_url, url, public_url")
    .eq("id", documentId)
    .maybeSingle();

  if (error || !data) {
    return { id: documentId, filename: "Unknown", open_url: undefined };
  }

  const filename = (data.filename ?? "Unknown").toString();
  const open_url = (data.open_url ?? data.url ?? data.public_url ?? "").toString() || undefined;

  return { id: (data.id ?? documentId).toString(), filename, open_url };
}

/**
 * buildWindowContext:
 * - bestDocId 문서에서 hits 기준 주변 chunk window 구성
 */
export async function buildWindowContext({
  sb,
  q,
  bestDocId,
  hits,
  scoreRow,
}: {
  sb: SupabaseClient;
  q: string;
  bestDocId: string;
  hits: any[];
  scoreRow: (h: any) => number;
}): Promise<ContextBlock[]> {
  const docHits = (hits || []).filter((h) => (h?.document_id ?? h?.doc_id ?? "") === bestDocId);

  const scored = docHits
    .map((h) => ({
      h,
      s: typeof h?.score === "number" ? h.score : typeof h?.sim === "number" ? h.sim : scoreRow(h),
      idx: Number.isFinite(Number(h?.chunk_index))
        ? Number(h.chunk_index)
        : Number.isFinite(Number(h?.idx))
          ? Number(h.idx)
          : 0,
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);

  const anchors = scored.map((x) => x.idx);

  const want = new Set<number>();
  for (const a of anchors) {
    for (let k = -2; k <= 2; k++) want.add(a + k);
  }

  const chunkIdxs = Array.from(want)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  if (!chunkIdxs.length) return [];

  const { data, error } = await sb
    .from("document_chunks")
    .select("document_id, chunk_index, block_type, content_text, content_html, content, html, text, sim, score")
    .eq("document_id", bestDocId)
    .in("chunk_index", chunkIdxs);

  if (error || !data) return [];

  const doc = await loadDocFilename(sb, bestDocId);

  const blocks: ContextBlock[] = (data as any[])
    .map((r) => {
      const block_type = (r.block_type ?? "").toString();

      const content_html =
        typeof r.content_html === "string"
          ? r.content_html
          : typeof r.html === "string"
            ? r.html
            : typeof r.content === "string" && isProbablyHtml(r.content)
              ? r.content
              : undefined;

      const content_text =
        typeof r.content_text === "string"
          ? r.content_text
          : typeof r.text === "string"
            ? r.text
            : typeof r.content === "string" && !isProbablyHtml(r.content)
              ? r.content
              : undefined;

      return {
        document_id: bestDocId,
        filename: doc.filename,
        open_url: doc.open_url,
        chunk_index: Number(r.chunk_index ?? 0),
        block_type,
        content_text,
        content_html,
        sim: typeof r.sim === "number" ? r.sim : undefined,
        score: typeof r.score === "number" ? r.score : undefined,
        raw: r,
      };
    })
    .sort((a, b) => a.chunk_index - b.chunk_index);

  return blocks;
}

/**
 * ✅ 핵심: Evidence 표준화 (반드시 ./types Evidence로 반환)
 * - UI dedupe가 보는 block_type을 "p" / "table_html"로 유지
 * - table_html은 content_html 없으면 table_ok=false
 * - text는 모두 content_text로 통일 + block_type="p"
 */
export function toEvidence(filename: string, ctx: ContextBlock[]): Evidence[] {
  const blocks = Array.isArray(ctx) ? ctx : [];
  const out: Evidence[] = [];

  for (const b of blocks) {
    const bt = (b?.block_type ?? "").toString().toLowerCase();

    const html = (b?.content_html ?? "").toString().trim();
    const looksTable = bt.includes("table") || (html && isProbablyTableHtml(html));

    if (looksTable) {
      out.push({
        document_id: b.document_id,
        filename: b.filename || filename,
        chunk_index: Number.isFinite(Number(b.chunk_index)) ? Number(b.chunk_index) : 0,
        open_url: b.open_url,
        block_type: "table_html",
        content_html: html || undefined,
        table_ok: !!html, // ✅ 없으면 false -> extract에서 A/B/C 실패
        sim: b.sim,
        score: b.score,
      } as Evidence);
      continue;
    }

    let text = "";
    if (html && isProbablyHtml(html)) {
      text = stripHtmlToText(html);
    } else {
      const cand = (b?.content_text ?? "").toString();
      text = isProbablyHtml(cand) ? stripHtmlToText(cand) : normalizeText(cand);
    }

    const content_text = normalizeText(text);

out.push({
  id: `${b.document_id}:${Number.isFinite(Number(b.chunk_index)) ? Number(b.chunk_index) : 0}:t`, // ✅
  document_id: b.document_id,
  filename: b.filename || filename,
  chunk_index: Number.isFinite(Number(b.chunk_index)) ? Number(b.chunk_index) : 0,
  open_url: b.open_url,
  block_type: "table_html",
  content_html: html || undefined,
  table_ok: !!html,
  sim: b.sim,
  score: b.score,
} as unknown as Evidence); // ✅ 여기!

  out.sort((a: any, b: any) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
  return out;
}
}
