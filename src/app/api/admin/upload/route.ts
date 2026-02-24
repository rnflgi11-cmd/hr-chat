// src/app/api/upload/route.ts
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

/** Windows/Mac 줄바꿈 등 정규화 */
function normalizeNewlines(s: string) {
  return (s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown 표 렌더링을 위한 셀 텍스트 정리 */
function cleanCell(s: string) {
  return normalizeNewlines(s)
    .replace(/\|/g, "\\|") // md table pipe escape
    .replace(/\n+/g, " ") // 셀 내부 줄바꿈은 공백으로
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** HTML <table> -> Markdown table */
function tableToMarkdown($: cheerio.CheerioAPI, tableEl: cheerio.Element) {
  const $table = $(tableEl);

  // thead > th, 또는 첫 tr의 th/td를 헤더로
  let headerCells: string[] = [];
  const theadTh = $table.find("thead tr").first().find("th,td");
  if (theadTh.length > 0) {
    headerCells = theadTh
      .toArray()
      .map((el) => cleanCell($(el).text()));
  } else {
    const firstRow = $table.find("tr").first().find("th,td");
    headerCells = firstRow
      .toArray()
      .map((el) => cleanCell($(el).text()));
  }

  // 헤더가 비었으면 표 포기(텍스트로)
  const hasHeader = headerCells.some((x) => x.length > 0);
  if (!hasHeader) return "";

  const colCount = headerCells.length;

  // body rows: thead 다음 tr부터, 또는 첫 tr 제외한 나머지
  let bodyRows = $table.find("tbody tr");
  if (bodyRows.length === 0) bodyRows = $table.find("tr").slice(1);

  const rows: string[][] = bodyRows
    .toArray()
    .map((tr) => {
      const tds = $(tr).find("td,th").toArray();
      const row = tds.map((el) => cleanCell($(el).text()));
      // 열 수 맞추기
      while (row.length < colCount) row.push("");
      return row.slice(0, colCount);
    })
    .filter((r) => r.join("").trim().length > 0);

  // md 구성
  const head = `| ${headerCells.join(" | ")} |`;
  const sep = `| ${headerCells.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

  return normalizeNewlines([head, sep, body].filter(Boolean).join("\n"));
}

/**
 * HTML -> "줄바꿈 보존" 텍스트/마크다운 변환
 * - p/div/br/section 등 문단 단위 개행
 * - ul/ol/li 리스트 처리
 * - table을 markdown table로 변환
 */
function htmlToTextPreserve(html: string) {
  const $ = cheerio.load(html ?? "", { decodeEntities: true });

  // 1) table을 markdown으로 먼저 바꿔서 자리 고정
  $("table").each((_, el) => {
    const md = tableToMarkdown($, el);
    if (md) {
      // 표를 md 블록으로 치환
      $(el).replaceWith(`<pre data-md-table="1">${md}</pre>`);
    } else {
      // 표 헤더 추출 실패 시: 그냥 텍스트로
      const t = normalizeNewlines($(el).text());
      $(el).replaceWith(`<div>${t}</div>`);
    }
  });

  // 2) br은 개행
  $("br").replaceWith("\n");

  // 3) 블록 요소 끝에 개행 넣기 (문단 유지)
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
    "tr", // 표가 md로 치환되면 pre 안이라 괜찮지만, 혹시 남는 경우 대비
  ].join(",");

  $(blockSelectors).each((_, el) => {
    const $el = $(el);
    // 이미 pre(md table)면 건드리지 말자
    if ($el.is("pre") && $el.attr("data-md-table") === "1") return;
    // 블록 끝에 개행을 부여
    $el.append("\n");
  });

  // 4) 리스트를 마크다운처럼
  // ul/li -> "- item"
  $("ul").each((_, ul) => {
    const items = $(ul)
      .find("> li")
      .toArray()
      .map((li) => "- " + normalizeNewlines($(li).text()).replace(/\n+/g, " ").trim())
      .filter(Boolean);
    $(ul).replaceWith(`<div>${items.join("\n")}\n</div>`);
  });

  // ol/li -> "1. item"
  $("ol").each((_, ol) => {
    const items = $(ol)
      .find("> li")
      .toArray()
      .map((li, idx) => `${idx + 1}. ` + normalizeNewlines($(li).text()).replace(/\n+/g, " ").trim())
      .filter(Boolean);
    $(ol).replaceWith(`<div>${items.join("\n")}\n</div>`);
  });

  // 5) 최종 텍스트
  const text = normalizeNewlines($.root().text());
  return text;
}

/** 의미 단위 chunk + 과대 문단은 size로 분할 */
function chunkTextSmart(text: string, size = CHUNK_SIZE) {
  const cleaned = normalizeNewlines(text);
  if (!cleaned) return [];

  // 문단 기준 분리
  const paras = cleaned.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);

  const out: string[] = [];
  let buf = "";

  const flush = () => {
    const x = buf.trim();
    if (x) out.push(x);
    buf = "";
  };

  for (const p of paras) {
    // 너무 긴 문단은 줄 단위/길이로 분할
    if (p.length > size) {
      // 먼저 버퍼 비우고
      flush();

      // 줄 단위로 나눠서 size 맞추기
      const lines = p.split("\n").map((x) => x.trim()).filter(Boolean);
      let b = "";
      for (const line of lines.length ? lines : [p]) {
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

    // 버퍼에 합치기
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

    // mammoth: docx -> html
    const { value: html } = await mammoth.convertToHtml(
      { arrayBuffer: ab },
      {
        // 필요 시 문단/표 관련 styleMap을 여기에 추가 가능
        // styleMap: [],
      }
    );

    const text = htmlToTextPreserve(html);
    return text;
  }

  // TXT / MD
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    const t = await file.text();
    return normalizeNewlines(t);
  }

  // HTML
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const t = await file.text();
    return htmlToTextPreserve(t);
  }

  // 그 외: 그냥 text() (최소 동작)
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
        // 1) 파일 저장 (원본 보관)
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

        // 2) DB documents row
        const ins = await supabaseAdmin
          .from("documents")
          .insert({
            filename,
            storage_path: key,
          })
          .select("id")
          .single();

        if (ins.error || !ins.data?.id) {
          // 업로드된 파일 롤백
          await supabaseAdmin.storage.from(BUCKET).remove([key]).catch(() => {});
          results.push({
            filename,
            ok: false,
            error: `documents insert 실패: ${ins.error?.message ?? "unknown"}`,
          });
          continue;
        }

        const docId = ins.data.id as string;

        // 3) 텍스트 추출 (줄바꿈/표/문단 보존 강화)
        const extracted = await fileToText(file);

        // 4) 청크
        const chunks = chunkTextSmart(extracted, CHUNK_SIZE);

        if (chunks.length === 0) {
  // 문서/스토리지 롤백
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
        results.push({
          filename,
          ok: false,
          error: e?.message ?? "알 수 없는 오류",
        });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "서버 오류" }, { status: 500 });
  }
}
