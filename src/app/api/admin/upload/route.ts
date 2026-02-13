// src/app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ✅ 버킷명
const BUCKET = "hr-docs";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * ✅ 표/문단/리스트 단위로 “의미 덩어리”를 우선 나누고,
 * 너무 긴 덩어리는 size 기준으로 추가 분할
 */
function chunkTextSmart(text: string, size = 1200) {
  const cleaned = (text ?? "").replace(/\r/g, "").trim();
  if (!cleaned) return [];

  // 코드블록/구분선 기준으로 먼저 덩어리화
  const blocks = cleaned
    .split(/\n{2,}/g) // 빈 줄 2개 이상을 “단락”으로
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const b of blocks) {
    if (b.length <= size) {
      chunks.push(b);
      continue;
    }
    // 너무 긴 단락은 강제 분할
    for (let i = 0; i < b.length; i += size) {
      const part = b.slice(i, i + size).trim();
      if (part) chunks.push(part);
    }
  }

  return chunks;
}

function normalizeInline(s: string) {
  return (s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mdEscapeCell(s: string) {
  return normalizeInline(s).replace(/\|/g, "｜");
}

function htmlTableToMarkdown($: cheerio.CheerioAPI, tableEl: any) {
  const $table = $(tableEl);

  const rows: string[][] = [];
  let hasHeaderTh = false;

  $table.find("tr").each((_, tr) => {
    const $tr = $(tr);
    const cells: string[] = [];

    const ths = $tr.find("th");
    if (ths.length > 0) hasHeaderTh = true;

    $tr.find("th, td").each((__, td) => {
      const $td = $(td);

      // 셀 내부 줄바꿈 유지: <br>를 \n으로 바꾼 후 텍스트 추출
      $td.find("br").replaceWith("\n");

      const text = $td.text();
      const cleaned = text
        .split("\n")
        .map((x) => normalizeInline(x))
        .filter(Boolean)
        .join(" / "); // 셀 내부 줄바꿈은 " / "로 보존 (원하면 "\n"로 바꿔도 됨)

      cells.push(mdEscapeCell(cleaned));
    });

    if (cells.some((c) => c.length > 0)) rows.push(cells);
  });

  if (!rows.length) return "";

  const maxCols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const rr = r.slice(0);
    while (rr.length < maxCols) rr.push("");
    return rr;
  });

  const header = norm[0];
  const body = hasHeaderTh ? norm.slice(1) : norm.slice(1);

  const md: string[] = [];
  md.push(`| ${header.join(" | ")} |`);
  md.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of body) md.push(`| ${r.join(" | ")} |`);

  return "```text\n" + md.join("\n") + "\n```";
}

function htmlToTextKeepingTables(html: string) {
  const $ = cheerio.load(html);

  // ✅ 표를 Markdown으로 치환
  $("table").each((_, el) => {
    const md = htmlTableToMarkdown($, el);
    if (md) {
      $(el).replaceWith(`\n\n${md}\n\n`);
    } else {
      // 빈 표면 제거
      $(el).remove();
    }
  });

  // 문단/리스트 줄바꿈 유지용 처리
  $("p").each((_, el) => {
    const t = normalizeInline($(el).text());
    $(el).text(t ? t : "");
    if (t) $(el).after("\n");
  });

  $("li").each((_, el) => {
    const t = normalizeInline($(el).text());
    $(el).text(t ? `- ${t}` : "");
    if (t) $(el).after("\n");
  });

  // 전체 텍스트
  const text = $(("body") as any).text();

  // 공백/줄바꿈 정리 (표 코드블록은 이미 포함됨)
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const userRaw = formData.get("user") as string | null;

    if (!file || !userRaw) {
      return NextResponse.json({ error: "파일 또는 사용자 정보 누락" }, { status: 400 });
    }

    const user = JSON.parse(userRaw);
    if (user.role !== "admin") {
      return NextResponse.json({ error: "관리자만 업로드 가능" }, { status: 403 });
    }

    // ✅ DOCX 강제 체크
    const lower = file.name.toLowerCase().trim();
    if (!lower.endsWith(".docx")) {
      return NextResponse.json(
        { error: "DOCX(.docx) 파일만 업로드 가능합니다. Word(.docx)로 저장 후 업로드해 주세요." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1) Storage 업로드
    const ext = "docx";
    const storagePath = `docs/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType:
          file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json({ error: `storage upload failed: ${uploadError.message}` }, { status: 500 });
    }

    // 2) documents 테이블 저장
    const { data: docInsert, error: docError } = await supabaseAdmin
      .from("documents")
      .insert({
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
        storage_path: storagePath,
      })
      .select("id, filename")
      .single();

    if (docError || !docInsert?.id) {
      return NextResponse.json({ error: `documents insert failed: ${docError?.message ?? "unknown"}` }, { status: 500 });
    }

    // ✅ 3) DOCX → HTML 변환 (표 보존)
    const { value: html } = await mammoth.convertToHtml(
      { buffer },
      {
        // 필요하면 스타일 맵을 추가로 줄 수 있음. 기본으로도 표는 <table>로 잘 나옵니다.
        // styleMap: [],
      }
    );

    // ✅ 4) HTML → (표는 Markdown) + 본문 텍스트 생성
    const text = htmlToTextKeepingTables(html);

    if (!text) {
      return NextResponse.json({ error: "문서에서 텍스트를 추출하지 못했습니다." }, { status: 500 });
    }

    // ✅ 5) chunk 분리 → document_chunks 저장
    const chunks = chunkTextSmart(text, 1200);

    const rows = chunks.map((content, idx) => ({
      document_id: docInsert.id,
      chunk_index: idx,
      content,
    }));

    const { error: chunkError } = await supabaseAdmin.from("document_chunks").insert(rows);

    if (chunkError) {
      return NextResponse.json({ error: `chunk insert failed: ${chunkError.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      filename: docInsert.filename,
      chunks: rows.length,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "업로드 중 오류 발생" }, { status: 500 });
  }
}
