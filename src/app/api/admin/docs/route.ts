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

export async function GET() {
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
