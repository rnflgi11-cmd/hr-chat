import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES_PER_REQUEST = 30;

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 최소한의 sanitize (일단 table은 그대로 저장) */
function sanitizeTableHtml(html: string) {
  return html;
}

function normalizeText(s: string) {
  return (s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** HTML을 문단/표 블록으로 분해 (초보/안전 버전) */
function htmlToBlocks(html: string) {
  const $ = cheerio.load(html);
  const blocks: Array<{
    kind: "paragraph" | "table";
    text: string;
    table_html?: string;
  }> = [];

  const body = $("body");

  const addParagraph = (raw: string, prefix = "") => {
    const text = normalizeText(`${prefix}${raw}`);
    if (text) blocks.push({ kind: "paragraph", text });
  };

  const walkList = (listEl: any, depth: number, ordered: boolean) => {
    const list = $(listEl);
    const lis = list.children("li").toArray();

    lis.forEach((li, idx) => {
      const liNode = $(li);
      const lineNode = liNode.clone();
      lineNode.children("ul,ol").remove();

      const indent = " ".repeat(depth * 2);
      const marker = ordered ? `${idx + 1}. ` : "• ";
      const lineText = normalizeText(lineNode.text());
      if (lineText) addParagraph(lineText, `${indent}${marker}`);

      liNode.children("ul,ol").each((_, childList) => {
        const childTag = ((childList as any).tagName ?? "").toLowerCase();
        walkList(childList, depth + 1, childTag === "ol");
      });
    });
  };

  body.children().each((_, node) => {
    const $node = $(node);
    const tag = (node.tagName ?? "").toLowerCase();

    if (tag === "table") {
      const tableHtml = $.html(node);
      const tableText = normalizeText($node.text());
      if (tableText || tableHtml) {
        blocks.push({
          kind: "table",
          text: tableText,
          table_html: sanitizeTableHtml(tableHtml),
        });
      }
      return;
    }

    if (tag === "ul" || tag === "ol") {
      walkList(node as any, 0, tag === "ol");
      return;
    }

    if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "div", "section", "article"].includes(tag)) {
      addParagraph($node.text());
    }
  });

  if (!blocks.length) {
    const text = normalizeText(body.text());
    if (text) blocks.push({ kind: "paragraph", text });
  }

  return blocks;
}

/** formData에서 파일들 추출 (file / files / file[] 모두 대응) */
function getFilesFromForm(form: FormData): File[] {
  const files: File[] = [];

  for (const f of form.getAll("files")) if (f instanceof File) files.push(f);
  const f1 = form.get("file");
  if (f1 instanceof File) files.push(f1);
  for (const f of form.getAll("file[]")) if (f instanceof File) files.push(f);

  // 중복 제거
  const seen = new Set<string>();
  const uniq: File[] = [];
  for (const f of files) {
    const key = `${f.name}__${f.size}__${f.lastModified}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(f);
    }
  }
  return uniq;
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const form = await req.formData();

    const files = getFilesFromForm(form);
    if (!files.length) {
      return NextResponse.json(
        { error: "file required (formData key should be file OR files)" },
        { status: 400 }
      );
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `too many files. max ${MAX_FILES_PER_REQUEST}` },
        { status: 400 }
      );
    }

    const results: Array<{
      filename: string;
      ok: boolean;
      document_id?: string;
      blocks?: number;
      error?: string;
    }> = [];

    for (const file of files) {
      const lower = (file.name ?? "").toLowerCase();

      if (!lower.endsWith(".docx")) {
        results.push({ filename: file.name, ok: false, error: "only .docx supported" });
        continue;
      }

      try {
        const buf = Buffer.from(await file.arrayBuffer());

      // 같은 파일명 기존 문서가 있으면 이전 버전 정리(최신 업로드만 유지)
        const { data: existingDocs } = await sb
          .from("documents")
          .select("id")
          .eq("filename", file.name);

        const existingIds = (existingDocs ?? [])
          .map((d: { id?: unknown }) => d?.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);

        if (existingIds.length) {
          await sb.from("document_blocks").delete().in("document_id", existingIds);
          await sb.from("document_chunks").delete().in("document_id", existingIds);
          await sb.from("documents").delete().in("id", existingIds);
        }

        // DOCX -> HTML
        const { value: html } = await mammoth.convertToHtml(
          { buffer: buf },
          {
            styleMap: [
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
            ],
          }
        );

        // HTML -> blocks
        const blocks = htmlToBlocks(`<body>${html}</body>`);
        if (!blocks.length) {
          results.push({ filename: file.name, ok: false, error: "no text/table blocks detected" });
          continue;
        }
        
        // documents insert (스키마 호환: content_type / mime_type 모두 시도)
        const typed = file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const basePayload = {
          filename: file.name,
          size_bytes: buf.length,
          storage_path: `db-only/${Date.now()}_${file.name}`,
        };

        let doc: { id: string } | null = null;
        let e1: Error | null = null;

        const payloads = [
          { ...basePayload, content_type: typed },
          { ...basePayload, mime_type: typed },
          { filename: file.name, content_type: typed, size_bytes: buf.length },
          { filename: file.name, mime_type: typed, size_bytes: buf.length },
          { filename: file.name, content_type: typed },
          { filename: file.name, mime_type: typed },
          { filename: file.name },
        ];

        for (const payload of payloads) {
          const ins = await sb.from("documents").insert(payload).select("id").single();
          if (!ins.error && ins.data?.id) {
            doc = { id: String(ins.data.id) };
            e1 = null;
            break;
          }
          e1 = new Error(ins.error?.message ?? "documents insert failed");
        }

        if (!doc || e1) {
          results.push({ filename: file.name, ok: false, error: e1?.message ?? "documents insert failed" });
          continue;
        }

        // blocks insert (✅ 핵심: kind/text/table_html 로 저장)
        const rows = blocks.map((b, i) => ({
          document_id: doc.id,
          block_index: i,
          kind: b.kind,                 // ✅ block_type 아님
          text: b.text ?? null,         // ✅ content_text 아님
          table_html: b.kind === "table" ? (b.table_html ?? null) : null, // ✅ content_html 아님
        }));

        const { error: e2 } = await sb.from("document_blocks").insert(rows);
        if (e2) {
          await sb.from("documents").delete().eq("id", doc.id);
          results.push({ filename: file.name, ok: false, error: e2.message });
          continue;
        }

        results.push({
          filename: file.name,
          ok: true,
          document_id: doc.id,
          blocks: rows.length,
        });
      } catch (err: any) {
        results.push({ filename: file.name, ok: false, error: err?.message ?? "unknown error" });
      }
    }

    return NextResponse.json({
      ok: true,
      total: files.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "upload error" }, { status: 500 });
  }
}