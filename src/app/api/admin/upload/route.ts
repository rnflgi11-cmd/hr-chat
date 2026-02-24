// src/app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 아주 기본적인 sanitize (운영에서는 더 강화 가능) */
function sanitizeTableHtml(html: string) {
  // 일단은 table을 그대로 저장 (script 같은 건 mammoth 결과에 거의 없음)
  return html;
}

/** mammoth HTML을 문단/표 블록으로 분해 */
function htmlToBlocks(html: string) {
  const $ = cheerio.load(html);
  const blocks: Array<{
    type: "p" | "table_html";
    text: string;
    html?: string;
  }> = [];

  $("body")
    .children()
    .each((_, el) => {
      const tag = (el as any).tagName?.toLowerCase?.() ?? "";

      if (tag === "table") {
        const tableHtml = $.html(el);
        const tableText = $(el).text().replace(/\r/g, "").trim();
        blocks.push({
          type: "table_html",
          text: tableText,
          html: sanitizeTableHtml(tableHtml),
        });
        return;
      }

      // 문단(줄바꿈 보존용으로 text만 저장)
      const text = $(el).text().replace(/\r/g, "").trim();
      if (text) blocks.push({ type: "p", text });
    });

  return blocks;
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const form = await req.formData();
    const file = form.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    // ✅ 일단 DOCX만 지원(표 보존 최우선)
    const name = file.name.toLowerCase();
    if (!name.endsWith(".docx")) {
      return NextResponse.json(
        { error: "현재는 .docx만 업로드 지원합니다. (표 보존용)" },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // 1) DOCX -> HTML (표 유지)
    const { value: html } = await mammoth.convertToHtml(
      { buffer: buf },
      {
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
        ],
      }
    );

    // 2) HTML -> blocks
    const blocks = htmlToBlocks(`<body>${html}</body>`);
    if (!blocks.length) {
      return NextResponse.json({ error: "문서에서 텍스트를 찾지 못했어요." }, { status: 400 });
    }

    // 3) documents 저장
    const { data: doc, error: e1 } = await sb
      .from("documents")
      .insert({ filename: file.name, mime: file.type })
      .select("*")
      .single();

    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

    // 4) document_blocks 저장
    const rows = blocks.map((b, i) => ({
      document_id: doc.id,
      block_index: i,
      block_type: b.type,
      content_text: b.text,
      content_html: b.type === "table_html" ? b.html : null,
    }));

    const { error: e2 } = await sb.from("document_blocks").insert(rows);
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      document_id: doc.id,
      blocks: rows.length,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "upload error" }, { status: 500 });
  }
}