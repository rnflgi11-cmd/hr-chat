import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "hr-docs";
const SIGNED_URL_EXPIRES_IN = 60 * 10; // 10분

function canPreview(filename: string) {
  const lower = filename.toLowerCase();
  return (
    lower.endsWith(".pdf") ||
    lower.endsWith(".docx") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp")
  );
}

function normalizeCell(c: string): string {
  const plain = c
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r/g, "")
    .trim();

  // markdown table cell 안전화
  return plain
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" <br> ")
    .replace(/\|/g, "\\|");
}


function getTableCellSet(html: string): Set<string> {
  const cells = html.match(/<(td|th)[\s\S]*?<\/\1>/gi) ?? [];
  const out = new Set<string>();
  for (const c of cells) {
    const v = normalizeCell(c).replace(/\s*<br>\s*/g, " ").trim();
    if (v) out.add(v);
  }
  return out;
}

function toMarkdownTable(html: string): string {
  const tr = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const rows = tr
    .map((row) => {
      const cells = row.match(/<(td|th)[\s\S]*?<\/\1>/gi) ?? [];
      return cells.map(normalizeCell);
    })
    .filter((r) => r.some(Boolean));

  if (!rows.length) return "";

  const header = rows[0];
  const body = rows.slice(1);
  const cols = Math.max(1, header.length);
  const lines = [
    `| ${new Array(cols).fill("").map((_, i) => header[i] ?? "").join(" | ")} |`,
    ...body.map((r) =>
      `| ${new Array(cols)
        .fill("")
        .map((_, i) => r[i] ?? "")
        .join(" | ")} |`
    ),
  ];

  return lines.join("\n");
}


// ✅ 관리자 체크: 프론트에서 headers["x-user"] = JSON.stringify(user) 로 전달
function isAdmin(req: NextRequest) {
  const raw = req.headers.get("x-user");
  if (!raw) return false;
  try {
    const u = JSON.parse(raw);
    return u?.role === "admin";
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const docId = req.nextUrl.searchParams.get("docId")?.trim();

  // 단건 원문 조회 모드: /api/admin/docs?docId=<id>
  if (docId) {
    const { data: doc, error: docErr } = await supabaseAdmin
      .from("documents")
      .select("id, filename")
      .eq("id", docId)
      .single();

    if (docErr || !doc) {
      return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });
    }

    const { data: blocks, error } = await supabaseAdmin
      .from("document_blocks")
      .select("block_index, kind, text, table_html")
      .eq("document_id", docId)
      .order("block_index", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const lines: string[] = [];
    const tableCells = new Set<string>();

    for (const b of blocks ?? []) {
      if (b.kind === "table" && b.table_html) {
        const table = toMarkdownTable(b.table_html);
        if (table) lines.push(table);
        for (const c of getTableCellSet(b.table_html)) tableCells.add(c);
        continue;
      }

      const text = (b.text ?? "").toString().trim();
      if (!text) continue;

      const compact = text.replace(/\s+/g, " ").trim();
      if (compact.length <= 40 && tableCells.has(compact)) continue; // 표 셀 중복 텍스트 제거

      lines.push(text);
    }

    return NextResponse.json({
      ok: true,
      id: docId,
      filename: doc.filename,
      markdown: lines.join("\n\n"),
      block_count: (blocks ?? []).length,
    });
  }

  // 기존 목록 조회 모드
    const { data, error } = await supabaseAdmin
    .from("documents")
    .select("id, filename, content_type, size_bytes, created_at, storage_path")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const docs = await Promise.all(
    (data ?? []).map(async (d) => {
      const preview = canPreview(d.filename);

      if (!d.storage_path) {
        return { ...d, open_url: null, can_preview: preview };
      }

      const { data: signed, error: sErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(d.storage_path, SIGNED_URL_EXPIRES_IN);

      return {
        ...d,
        open_url: sErr ? null : signed?.signedUrl ?? null,
        can_preview: preview,
      };
    })
  );

  return NextResponse.json({ docs });
}

/**
 * ✅ 일괄 삭제
 * body: { ids: string[] }
 * - document_chunks 삭제
 * - documents 삭제
 * - storage 파일 삭제
 * - 관리자만 가능
 */
export async function DELETE(req: NextRequest) {
  try {
    if (!isAdmin(req)) {
      return NextResponse.json({ error: "관리자만 삭제 가능합니다." }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];

    if (!ids.length) {
      return NextResponse.json({ error: "ids가 비었습니다." }, { status: 400 });
    }

    // 1) storage_path 확보
    const { data: docs, error: fetchErr } = await supabaseAdmin
      .from("documents")
      .select("id, storage_path")
      .in("id", ids);

    if (fetchErr) {
      return NextResponse.json(
        { error: `documents fetch failed: ${fetchErr.message}` },
        { status: 500 }
      );
    }

    const paths = (docs ?? [])
      .map((d) => d.storage_path)
      .filter((p): p is string => !!p);

    // 2) chunks 삭제
    const { error: chunkErr } = await supabaseAdmin
      .from("document_chunks")
      .delete()
      .in("document_id", ids);

    if (chunkErr) {
      return NextResponse.json(
        { error: `chunk delete failed: ${chunkErr.message}` },
        { status: 500 }
      );
    }

    // 3) documents 삭제
    const { error: docErr } = await supabaseAdmin.from("documents").delete().in("id", ids);

    if (docErr) {
      return NextResponse.json(
        { error: `documents delete failed: ${docErr.message}` },
        { status: 500 }
      );
    }

    // 4) storage 파일 삭제 (실패해도 DB는 이미 삭제됐을 수 있음)
    let deletedStorageFiles = 0;
    let storageError: string | null = null;

    if (paths.length) {
      const { data: removed, error: stErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .remove(paths);

      if (stErr) storageError = stErr.message;
      else deletedStorageFiles = Array.isArray(removed) ? removed.length : 0;
    }

    return NextResponse.json({
      ok: true,
      deleted_documents: ids.length,
      deleted_storage_files: deletedStorageFiles,
      storage_error: storageError,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}

