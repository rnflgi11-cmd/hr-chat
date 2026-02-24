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

/** 줄바꿈/공백 정규화 */
function normalizeNewlines(s: string) {
  return (s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** md table 셀 텍스트 정리 */
function cleanCell(s: string) {
  return normalizeNewlines(s)
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** HTML <table> -> Markdown table (cheerio 타입 이슈 방지 위해 element는 any) */
function tableToMarkdown($: cheerio.CheerioAPI, tableEl: any) {
  const $table = $(tableEl);

  // thead가 있으면 thead를 헤더로, 없으면 첫 tr을 헤더로
  let headerCells: string[] = [];
  const theadTh = $table.find("thead tr").first().find("th,td");
  if (theadTh.length > 0) {
    headerCells = theadTh.toArray().map((el) => cleanCell($(el).text()));
  } else {
    const firstRow = $table.find("tr").first().find("th,td");
    headerCells = firstRow.toArray().map((el) => cleanCell($(el).text()));
  }

  const hasHeader = headerCells.some((x) => x.length > 0);
  if (!hasHeader) return "";

  const colCount = headerCells.length;

  // body rows: tbody 우선, 없으면 첫 tr 제외한 나머지
  let bodyRows = $table.find("tbody tr");
  if (bodyRows.length === 0) bodyRows = $table.find("tr").slice(1);

  const rows: string[][] = bodyRows
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

  return normalizeNewlines([head, sep, body].filter(Boolean).join("\n"));
}

/**
 * HTML -> "줄바꿈/문단/리스트/표" 최대 보존 텍스트(+표는 MD 테이블)
 * - table -> md table로 치환
 * - br -> \n
 * - p/div/section/... -> 문단 끝에 \n
 * - ul/ol -> md list로 치환
 */
function htmlToTextPreserve(html: string) {
  const $ = cheerio.load(html ?? "");

  // 1) table을 md로 먼저 치환해서 구조 보존
  $("table").each((_, el) => {
    const md = tableToMarkdown($, el);
    if (md) {
      $(el).replaceWith(`<pre data-md-table="1">${md}</pre>`);
    } else {
      const t = normalizeNewlines($(el).text());
      $(el).replaceWith(`<div>${t}\n</div>`);
    }
  });

  // 2) br -> 개행
  $("br").replaceWith("\n");

  // 3) ul/ol 먼저 md list로 치환
  $("ul").each((_, ul) => {
    const items = $(ul)
      .find("> li")
      .toArray()
      .map((li) =>
        "- " + normalizeNewlines($(li).text()).replace(/\n+/g, " ").trim()
      )
      .filter(Boolean);
    $(ul).replaceWith(`<div>${items.join("\n")}\n</div>`);
  });

  $("ol").each((_, ol) => {
    const items = $(ol)
      .find("> li")
      .toArray()
      .map((li, idx) =>
        `${idx + 1}. ` +
        normalizeNewlines($(li).text()).replace(/\n+/g, " ").trim()
      )
      .filter(Boolean);
    $(ol).replaceWith(`<div>${items.join("\n")}\n</div>`);
  });

  // 4) 블록 요소 끝에 개행 넣기 (문단 유지)
  const blockSelectors = [
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ].join(",");

  $(blockSelectors).each((_, el) => {
    const $el = $(el);
    // md table pre는 그대로 둠(이미 md 블록)
    if ($el.is("pre") && $el.attr("data-md-table") === "1") return;
    $el.append("\n");
  });

  // 5) 최종 텍스트
  return normalizeNewlines($.root().text());
}

/** 의미 단위 chunk + 과대 문단은 size로 분할 */
function chunkTextSmart(text: string, size = CHUNK_SIZE) {
  const cleaned = normalizeNewlines(text);
  if (!cleaned) return [];

  const paras = cleaned
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  let buf = "";

  const flush = () => {
    const x = buf.trim();
    if (x) out.push(x);
    buf = "";
  };

  for (const p of paras) {
    if (p.length > size) {
      flush();
      const lines = p.split("\n").map((x) => x.trim()).filter(Boolean);
      let b = "";
      for (const line of (lines.length ? lines : [p])) {
        if (!b) b = line;
        else if ((b + "\n" + line).length <= size) b += "\n" + line;
        else {
          out.push(b);
          b = line;
        }
      }
      if (b) out.push(b);
      continue;
    }

    if (!buf) buf = p;
    else if ((buf + "\n\n" + p).length <= size) buf += "\n\n" + p;
    else {
      flush();
      buf = p;
    }
  }

  flush();
  return out;
}

async function fileToText(file: File) {
  const name = (file.name || "").toLowerCase();

  // DOCX
  if (name.endsWith(".docx")) {
    const ab = await file.arrayBuffer();
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: ab });
    return htmlToTextPreserve(html);
  }

  // TXT / MD
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return normalizeNewlines(await file.text());
  }

  // HTML
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    return htmlToTextPreserve(await file.text());
  }

  // fallback
  const fallback = await file.text().catch(() => "");
  return normalizeNewlines(fallback);
}

export async function POST(req: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const form = await req.formData();
    const files = form.getAll("files") as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "업로드할 파일이 없습니다." }, { status: 400 });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `한 번에 최대 ${MAX_FILES_PER_REQUEST}개까지 업로드할 수 있어요.` },
        { status: 400 }
      );
    }

    const results: Array<{
      filename: string;
      ok: boolean;
      document_id?: string;
      chunks?: number;
      error?: string;
    }> = [];

    for (const file of files) {
      const filename = file.name;

      try {
        // 1) storage 업로드
        const key = `${Date.now()}_${Math.random().toString(16).slice(2)}_${filename}`;
        const fileBuf = Buffer.from(await file.arrayBuffer());

        const up = await supabaseAdmin.storage.from(BUCKET).upload(key, fileBuf, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

        if (up.error) {
          results.push({ filename, ok: false, error: `스토리지 업로드 실패: ${up.error.message}` });
          continue;
        }

        // 2) documents row
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
          // storage 롤백
          try {
            await supabaseAdmin.storage.from(BUCKET).remove([key]);
          } catch {}
          results.push({
            filename,
            ok: false,
            error: `documents insert 실패: ${ins.error?.message ?? "unknown"}`,
          });
          continue;
        }

        const docId = ins.data.id as string;

        // 3) 텍스트 추출(보존 강화)
        const extracted = await fileToText(file);

        // 4) 청크
        const chunks = chunkTextSmart(extracted, CHUNK_SIZE);

        if (chunks.length === 0) {
          // 문서/스토리지 롤백 (supabase v2는 builder에 .catch 못 붙임)
          try {
            await supabaseAdmin.from("documents").delete().eq("id", docId);
          } catch {}
          try {
            await supabaseAdmin.storage.from(BUCKET).remove([key]);
          } catch {}

          results.push({ filename, ok: false, error: "텍스트를 추출하지 못했어요." });
          continue;
        }

        // 5) document_chunks insert
        const rows = chunks.map((content, idx) => ({
          document_id: docId,
          chunk_index: idx,
          content,
        }));

        const insChunks = await supabaseAdmin.from("document_chunks").insert(rows);

        if (insChunks.error) {
          // 롤백: chunks -> documents -> storage
          try {
            await supabaseAdmin.from("document_chunks").delete().eq("document_id", docId);
          } catch {}
          try {
            await supabaseAdmin.from("documents").delete().eq("id", docId);
          } catch {}
          try {
            await supabaseAdmin.storage.from(BUCKET).remove([key]);
          } catch {}

          results.push({
            filename,
            ok: false,
            error: `document_chunks insert 실패: ${insChunks.error.message}`,
          });
          continue;
        }

        results.push({
          filename,
          ok: true,
          document_id: docId,
          chunks: rows.length,
        });
      } catch (e: any) {
        results.push({ filename, ok: false, error: e?.message ?? "알 수 없는 오류" });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "서버 오류" }, { status: 500 });
  }
}