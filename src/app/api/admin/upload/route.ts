import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES_PER_REQUEST = 30; // 한 번에 너무 많이 업로드 방지(필요하면 늘려도 됨)

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

/** HTML을 문단/표 블록으로 분해 (초보/안전 버전: 타입 꼬임 방지) */
function htmlToBlocks(html: string) {
  const $ = cheerio.load(html);
  const blocks: Array<{
    type: "p" | "table_html";
    text: string;
    html?: string;
  }> = [];

  const body = $("body");

  // ✅ 가장 단순/안전: body 아래의 table, p만 순서대로 수집
  // (mammoth가 div로 감싸도 body.find가 다 잡아줌)
  const elements = body.find("table, p").toArray();

  for (const el of elements as any[]) {
    const tag = (el as any).tagName?.toLowerCase?.() ?? "";

    if (tag === "table") {
      const tableHtml = $.html(el);
      const tableText = $(el).text().replace(/\r/g, "").trim();

      // table이 완전 비어있진 않게
      if ((tableText && tableText.length > 0) || (tableHtml && tableHtml.length > 0)) {
        blocks.push({
          type: "table_html",
          text: tableText,
          html: sanitizeTableHtml(tableHtml),
        });
      }
    } else {
      // p 문단
      const text = $(el).text().replace(/\r/g, "").trim();
      if (text) blocks.push({ type: "p", text });
    }
  }

  // ✅ 정말 특이 케이스: table/p가 하나도 안 잡히면 body 전체 텍스트를 1개 문단으로
  if (!blocks.length) {
    const text = body.text().replace(/\r/g, "").trim();
    if (text) blocks.push({ type: "p", text });
  }

  return blocks;
}

/** formData에서 파일들 추출 (file / files / file[] 모두 대응) */
function getFilesFromForm(form: FormData): File[] {
  const files: File[] = [];

  // 1) files (복수)
  for (const f of form.getAll("files")) {
    if (f instanceof File) files.push(f);
  }

  // 2) file (단수)
  const f1 = form.get("file");
  if (f1 instanceof File) files.push(f1);

  // 3) file[] 형태
  for (const f of form.getAll("file[]")) {
    if (f instanceof File) files.push(f);
  }

  // 중복 제거(같은 파일 객체가 여러 키에 들어온 경우)
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

      // DOCX만 지원 (표 보존)
      if (!lower.endsWith(".docx")) {
        results.push({
          filename: file.name,
          ok: false,
          error: "only .docx supported",
        });
        continue;
      }

      try {
        const buf = Buffer.from(await file.arrayBuffer());

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
          results.push({
            filename: file.name,
            ok: false,
            error: "no text/table blocks detected",
          });
          continue;
        }

        // documents insert
        const { data: doc, error: e1 } = await sb
          .from("documents")
          .insert({ filename: file.name, mime: file.type })
          .select("*")
          .single();

        if (e1) {
          results.push({ filename: file.name, ok: false, error: e1.message });
          continue;
        }

        // blocks insert
        const rows = blocks.map((b, i) => ({
          document_id: doc.id,
          block_index: i,
          block_type: b.type,
          content_text: b.text,
          content_html: b.type === "table_html" ? b.html : null,
        }));

        const { error: e2 } = await sb.from("document_blocks").insert(rows);
        if (e2) {
          // 문서만 들어가고 블록이 실패하면 문서도 정리
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
        results.push({
          filename: file.name,
          ok: false,
          error: err?.message ?? "unknown error",
        });
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
    return NextResponse.json(
      { error: err?.message ?? "upload error" },
      { status: 500 }
    );
  }
}