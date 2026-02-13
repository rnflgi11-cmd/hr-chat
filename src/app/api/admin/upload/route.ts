// src/app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function chunkTextSmart(text: string, size = 1200) {
  const cleaned = (text ?? "").replace(/\r/g, "").trim();
  if (!cleaned) return [];

  const blocks = cleaned
    .split(/\n{2,}/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const b of blocks) {
    if (b.length <= size) {
      chunks.push(b);
      continue;
    }
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
      $td.find("br").replaceWith("\n");

      const text = $td.text();
      const cleaned = text
        .split("\n")
        .map((x) => normalizeInline(x))
        .filter(Boolean)
        .join(" / ");

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

  $("table").each((_, el) => {
    const md = htmlTableToMarkdown($, el);
    if (md) $(el).replaceWith(`\n\n${md}\n\n`);
    else $(el).remove();
  });

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

  const text = $(("body") as any).text();
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function isDocx(name: string) {
  return name.toLowerCase().trim().endsWith(".docx");
}

export async function POST(req: NextRequest) {
  const supabaseAdmin = getSupabaseAdmin();

  try {
    const formData = await req.formData();
    const userRaw = formData.get("user") as string | null;

    // ✅ 다중 파일
    const files = formData.getAll("file").filter(Boolean) as File[];

    if (!userRaw) {
      return NextResponse.json({ error: "사용자 정보 누락" }, { status: 400 });
    }
    if (!files.length) {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }

    const user = JSON.parse(userRaw);
    if (user.role !== "admin") {
      return NextResponse.json({ error: "관리자만 업로드 가능" }, { status: 403 });
    }

    // ✅ 파일별 결과 누적
    const results: Array<{
      filename: string;
      ok: boolean;
      error?: string;
      document_id?: string;
      chunks?: number;
    }> = [];

    // 너무 많은 파일을 한 번에 올릴 때 방어 (원하면 숫자 조절)
    if (files.length > 30) {
      return NextResponse.json({ error: "한 번에 최대 30개 파일까지 업로드 가능합니다." }, { status: 400 });
    }

    for (const file of files) {
      try {
        // 0) docx 체크
        if (!isDocx(file.name)) {
          results.push({
            filename: file.name,
            ok: false,
            error: "DOCX(.docx) 파일만 업로드 가능합니다. Word(.docx)로 저장 후 업로드해 주세요.",
          });
          continue;
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 1) Storage 업로드
        const storagePath = `docs/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${Math.random()
          .toString(16)
          .slice(2)}.docx`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(storagePath, buffer, {
            contentType:
              file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            upsert: false,
          });

        if (uploadError) {
          results.push({ filename: file.name, ok: false, error: `storage upload failed: ${uploadError.message}` });
          continue;
        }

        // 2) documents insert
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
          // storage 업로드는 됐는데 documents 실패 → storage 롤백 시도
          await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
          results.push({ filename: file.name, ok: false, error: `documents insert failed: ${docError?.message ?? "unknown"}` });
          continue;
        }

        // 3) DOCX → HTML (표 보존)
        const { value: html } = await mammoth.convertToHtml({ buffer });

        // 4) HTML → text (표는 MD)
        const text = htmlToTextKeepingTables(html);
        if (!text) {
          // documents까지 만들어졌으면 정리(롤백)
          await supabaseAdmin.from("document_chunks").delete().eq("document_id", docInsert.id).catch(() => {});
          await supabaseAdmin.from("documents").delete().eq("id", docInsert.id).catch(() => {});
          await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
          results.push({ filename: file.name, ok: false, error: "문서에서 텍스트를 추출하지 못했습니다." });
          continue;
        }

        // 5) chunk insert
        const chunks = chunkTextSmart(text, 1200);
        const rows = chunks.map((content, idx) => ({
          document_id: docInsert.id,
          chunk_index: idx,
          content,
        }));

        const { error: chunkError } = await supabaseAdmin.from("document_chunks").insert(rows);

        if (chunkError) {
          // 실패 시 정리(롤백)
          await supabaseAdmin.from("document_chunks").delete().eq("document_id", docInsert.id).catch(() => {});
          await supabaseAdmin.from("documents").delete().eq("id", docInsert.id).catch(() => {});
          await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
          results.push({ filename: file.name, ok: false, error: `chunk insert failed: ${chunkError.message}` });
          continue;
        }

        results.push({
          filename: file.name,
          ok: true,
          document_id: docInsert.id,
          chunks: rows.length,
        });
      } catch (e: any) {
        results.push({ filename: file.name, ok: false, error: e?.message ?? "업로드 중 오류" });
      }
    }

    const success = results.filter((r) => r.ok).length;
    const fail = results.length - success;

    return NextResponse.json({
      ok: fail === 0,
      summary: { total: results.length, success, fail },
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "업로드 중 오류 발생" }, { status: 500 });
  }
}
