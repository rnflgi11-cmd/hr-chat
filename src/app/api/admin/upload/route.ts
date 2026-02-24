// src/app/api/admin/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import mammoth from "mammoth";
import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "hr-docs";
const MAX_FILES_PER_REQUEST = 30;
const CHUNK_SIZE = 1200;

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function safeStorageKey(originalName: string) {
  const dot = originalName.lastIndexOf(".");
  const ext = dot >= 0 ? originalName.slice(dot).toLowerCase() : "";
  const rand = Math.random().toString(16).slice(2);
  const ts = Date.now();
  return `${ts}_${rand}${ext || ".bin"}`;
}

function normalizeNewlines(s: string) {
  return (s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanCell(s: string) {
  return normalizeNewlines(s)
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function tableToMarkdown($: cheerio.CheerioAPI, tableEl: any) {
  const $table = $(tableEl);

  let headerCells: string[] = [];
  const theadTh = $table.find("thead tr").first().find("th,td");

  if (theadTh.length > 0) {
    headerCells = theadTh.toArray().map((el) => cleanCell($(el).text()));
  } else {
    const firstRow = $table.find("tr").first().find("th,td");
    headerCells = firstRow.toArray().map((el) => cleanCell($(el).text()));
  }

  if (!headerCells.some((x) => x.length > 0)) return "";

  const colCount = headerCells.length;

  let bodyRows = $table.find("tbody tr");
  if (bodyRows.length === 0) bodyRows = $table.find("tr").slice(1);

  const rows = bodyRows
    .toArray()
    .map((tr) => {
      const tds = $(tr).find("td,th").toArray();
      const row = tds.map((el) => cleanCell($(el).text()));
      while (row.length < colCount) row.push("");
      return row.slice(0, colCount);
    })
    .filter((r) => r.join("").trim().length > 0);

  const head = `| ${headerCells.join(" | ")} |`;
  const sep = `| ${headerCells.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

  return normalizeNewlines([head, sep, body].join("\n"));
}

/**
 * ✅ 핵심 변경:
 * - table -> markdown 으로 만든 뒤 DOM에는 토큰만 남긴다
 * - $.root().text() 이후 토큰을 markdown으로 치환해서 표 원형을 보존한다
 */
function htmlToTextPreserve(html: string) {
  const $ = cheerio.load(html ?? "");

  const tableMds: string[] = [];

  $("table").each((i, el) => {
    const md = tableToMarkdown($, el);
    if (md) {
      tableMds.push(md);
      // 토큰은 공백 정리에도 살아남게 "문자열"로 삽입
      $(el).replaceWith(`\n\n[[__TABLE_${tableMds.length - 1}__]]\n\n`);
    } else {
      // 표 변환 실패 시에는 그냥 텍스트로 남김
      $(el).replaceWith("\n");
    }
  });

  $("br").replaceWith("\n");

  // ⚠️ cheerio .text()가 공백/줄바꿈을 정리하더라도, 토큰은 남는다
  let text = normalizeNewlines($.root().text());

  // 마지막에 토큰을 "원본 markdown 표"로 치환 (표는 여기서 완전히 복원)
  for (let i = 0; i < tableMds.length; i++) {
    const token = `[[__TABLE_${i}__]]`;
    // 토큰 주변이 붙어버릴 수 있어 앞뒤에 줄을 충분히 확보
    text = text.split(token).join(`\n\n${tableMds[i]}\n\n`);
  }

  return normalizeNewlines(text);
}

function chunkTextSmart(text: string, size = CHUNK_SIZE) {
  const cleaned = normalizeNewlines(text);
  if (!cleaned) return [];

  const paras = cleaned.split(/\n{2,}/g).filter(Boolean);

  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };

  for (const p of paras) {
    if ((buf + "\n\n" + p).length > size) {
      flush();
      buf = p;
    } else {
      buf += (buf ? "\n\n" : "") + p;
    }
  }

  flush();
  return out;
}

async function fileToText(file: File, fileBuf: Buffer) {
  const name = (file.name || "").toLowerCase();

  // DOCX
  if (name.endsWith(".docx")) {
    const { value: html } = await mammoth.convertToHtml({ buffer: fileBuf });
    return htmlToTextPreserve(html);
  }

  // HTML
  const text = fileBuf.toString("utf-8");
  if (name.endsWith(".html") || name.endsWith(".htm")) return htmlToTextPreserve(text);

  // TXT etc
  return normalizeNewlines(text);
}

export async function POST(req: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const form = await req.formData();
    const files = form.getAll("files") as File[];

    if (!files.length) {
      return NextResponse.json({ error: "업로드할 파일이 없습니다." }, { status: 400 });
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `한 번에 최대 ${MAX_FILES_PER_REQUEST}개까지 업로드할 수 있어요.` },
        { status: 400 }
      );
    }

    const results: any[] = [];

    for (const file of files) {
      const filename = file.name;

      try {
        const ab = await file.arrayBuffer();
        const fileBuf = Buffer.from(ab);

        const key = safeStorageKey(filename);

        const up = await supabaseAdmin.storage.from(BUCKET).upload(key, fileBuf, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

        if (up.error) {
          results.push({ filename, ok: false, error: up.error.message });
          continue;
        }

        const ins = await supabaseAdmin
          .from("documents")
          .insert({
            filename,
            storage_path: key,
            content_type: file.type || null,
            size_bytes: file.size ?? null,
          })
          .select("id")
          .single();

        if (ins.error || !ins.data?.id) {
          try {
            await supabaseAdmin.storage.from(BUCKET).remove([key]);
          } catch {}
          results.push({
            filename,
            ok: false,
            error: ins.error?.message ?? "documents insert 실패",
          });
          continue;
        }

        const docId = ins.data.id;

        const extracted = await fileToText(file, fileBuf);
        const chunks = chunkTextSmart(extracted);

        if (!chunks.length) {
          try {
            await supabaseAdmin.from("documents").delete().eq("id", docId);
          } catch {}
          try {
            await supabaseAdmin.storage.from(BUCKET).remove([key]);
          } catch {}
          results.push({ filename, ok: false, error: "텍스트를 추출하지 못했어요." });
          continue;
        }

        const rows = chunks.map((content, idx) => ({
          document_id: docId,
          chunk_index: idx,
          content,
        }));

        const insChunks = await supabaseAdmin.from("document_chunks").insert(rows);

        if (insChunks.error) {
          results.push({ filename, ok: false, error: insChunks.error.message });
          continue;
        }

        results.push({ filename, ok: true, document_id: docId, chunks: rows.length });
      } catch (e: any) {
        results.push({ filename, ok: false, error: e?.message ?? "알 수 없는 오류" });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "서버 오류" }, { status: 500 });
  }
}