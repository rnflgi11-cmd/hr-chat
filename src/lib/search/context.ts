// src/lib/search/context.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * ⚠️ index.ts와의 결합 유지:
 * - export: buildWindowContext, loadDocFilename, toEvidence
 * - toEvidence 시그니처: toEvidence(filename, ctx)
 * - Evidence block_type: "p" | "table_html" (UI dedupe가 이걸 봄)
 *
 * ✅ 이번 리팩토링의 목적(출력 안정화)을 위해 toEvidence에서 표준화 강제:
 * - table_html: content_html 없으면 table_ok=false로 내려서 extract에서 무조건 실패 처리
 * - text는 content_text로 통일 (p/li/bullet 다 합치기) + block_type은 모두 "p"로 강제
 */

export type ContextBlock = {
  document_id: string;
  filename: string;
  chunk_index: number;
  open_url?: string;

  // 원본 형태(문서마다 다름)
  block_type?: string; // p / li / bullet / table_html / ...
  content_text?: string;
  content_html?: string;

  // 랭킹 메타
  sim?: number;
  score?: number;

  // 디버그
  raw?: any;
};

export type DocInfo = {
  id: string;
  filename: string;
  open_url?: string;
};

export type Evidence = {
  document_id?: string;
  filename: string;
  chunk_index: number;
  open_url?: string;

  // ✅ index.ts UI가 사용하는 값 유지
  block_type: "p" | "table_html";

  // 표준 payload
  content_text?: string; // for "p"
  content_html?: string; // for "table_html"

  // ✅ table 검증
  table_ok?: boolean;

  sim?: number;
  score?: number;

  raw?: any;
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
 * - 테이블/컬럼명이 다를 수 있어 최대한 관용적으로 처리
 */
export async function loadDocFilename(sb: SupabaseClient, documentId: string): Promise<DocInfo> {
  // 1) documents 테이블 가정
  const { data, error } = await sb
    .from("documents")
    .select("id, filename, open_url, url, public_url")
    .eq("id", documentId)
    .maybeSingle();

  if (error || !data) {
    // fallback: 최소 정보
    return { id: documentId, filename: "Unknown", open_url: undefined };
  }

  const filename = (data.filename ?? "Unknown").toString();
  const open_url = (data.open_url ?? data.url ?? data.public_url ?? "").toString() || undefined;

  return { id: data.id?.toString?.() ?? documentId, filename, open_url };
}

/**
 * buildWindowContext:
 * - bestDocId 문서에서 hits 기준으로 주변 chunk들을 묶어서 context blocks 생성
 * - retrieve/rank 구조를 흔들지 않는 선에서 “안정적으로” window를 구성
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
  // bestDocId 히트만 뽑아서 상위 chunk_index 수집
  const docHits = (hits || []).filter((h) => (h?.document_id ?? h?.doc_id ?? "") === bestDocId);

  // 점수 기준 상위 6개 chunk를 anchor로
  const scored = docHits
    .map((h) => ({
      h,
      s: typeof h?.score === "number" ? h.score : typeof h?.sim === "number" ? h.sim : scoreRow(h),
      idx: Number.isFinite(Number(h?.chunk_index)) ? Number(h.chunk_index) : Number.isFinite(Number(h?.idx)) ? Number(h.idx) : 0,
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);

  const anchors = scored.map((x) => x.idx);

  // window: anchor ±2
  const want = new Set<number>();
  for (const a of anchors) {
    for (let k = -2; k <= 2; k++) want.add(a + k);
  }

  const chunkIdxs = Array.from(want)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  if (!chunkIdxs.length) return [];

  // document_chunks에서 가져오기 (컬럼명 관용 처리)
  const { data, error } = await sb
    .from("document_chunks")
    .select("document_id, chunk_index, block_type, content_text, content_html, content, html, text, sim, score")
    .eq("document_id", bestDocId)
    .in("chunk_index", chunkIdxs);

  if (error || !data) return [];

  // filename/open_url는 별도 로드해서 주입
  const doc = await loadDocFilename(sb, bestDocId);

  // 정렬
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
 * ✅ 핵심: Evidence 표준화
 * - index.ts의 dedupeAndPrioritizeEvidence가 "p" / "table_html"을 기대하므로 그 값은 유지
 * - 하지만 문서마다 p/li/bullet 섞이는 문제를 여기서 제거한다:
 *    - text는 전부 block_type="p"로 통일 + content_text에 합쳐서 넣기
 *    - table은 block_type="table_html" 유지 + content_html 필수(없으면 table_ok=false)
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
        table_ok: !!html, // html 없으면 false
        sim: b.sim,
        score: b.score,
        raw: b.raw ?? b,
      });
      continue;
    }

    // text 표준화
    let text = "";
    const html2 = (b?.content_html ?? "").toString().trim();

    if (html2 && isProbablyHtml(html2)) text = stripHtmlToText(html2);
    else {
      const cand = (b?.content_text ?? "").toString();
      text = isProbablyHtml(cand) ? stripHtmlToText(cand) : normalizeText(cand);
    }

    const content_text = normalizeText(text);

    out.push({
      document_id: b.document_id,
      filename: b.filename || filename,
      chunk_index: Number.isFinite(Number(b.chunk_index)) ? Number(b.chunk_index) : 0,
      open_url: b.open_url,
      block_type: "p",
      content_text: content_text || undefined,
      sim: b.sim,
      score: b.score,
      raw: b.raw ?? b,
    });
  }

  out.sort((a, b) => a.chunk_index - b.chunk_index);
  return out; // ✅ 무조건 반환 (undefined 경로 없음)
}