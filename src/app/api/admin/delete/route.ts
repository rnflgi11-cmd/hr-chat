import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "hr-docs";

function parseUser(req: NextRequest, bodyUser: any) {
  // 1) 기존 호환: body.user
  if (bodyUser && typeof bodyUser === "object") return bodyUser;

  // 2) 권장: header x-user
  const raw = req.headers.get("x-user");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isAdminUser(user: any) {
  return user?.role === "admin";
}

async function deleteDocsByIds(ids: string[]) {
  // 1) storage_path 확보
  const { data: docs, error: fetchErr } = await supabaseAdmin
    .from("documents")
    .select("id, storage_path")
    .in("id", ids);

  if (fetchErr) {
    return { ok: false as const, error: `documents fetch failed: ${fetchErr.message}` };
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
    return { ok: false as const, error: `chunk delete failed: ${chunkErr.message}` };
  }

  // 3) documents 삭제
  const { error: docErr } = await supabaseAdmin.from("documents").delete().in("id", ids);
  if (docErr) {
    return { ok: false as const, error: `documents delete failed: ${docErr.message}` };
  }

  // 4) storage 삭제 (실패해도 DB는 이미 삭제됐을 수 있으니 결과로 반환)
  let deletedStorageFiles = 0;
  let storageError: string | null = null;

  if (paths.length) {
    const { data: removed, error: stErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
    if (stErr) storageError = stErr.message;
    else deletedStorageFiles = Array.isArray(removed) ? removed.length : 0;
  }

  return {
    ok: true as const,
    deleted_documents: ids.length,
    deleted_storage_files: deletedStorageFiles,
    storage_error: storageError,
  };
}

/**
 * ✅ 기존 UI 호환: 단일 삭제 (POST)
 * body: { docId, user? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const docId = body?.docId;
    const user = parseUser(req, body?.user);

    if (!docId) {
      return NextResponse.json({ error: "docId missing" }, { status: 400 });
    }
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const result = await deleteDocsByIds([docId]);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      deleted_documents: result.deleted_documents,
      deleted_storage_files: result.deleted_storage_files,
      storage_error: result.storage_error,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}

/**
 * ✅ 일괄 삭제 (DELETE)
 * body: { ids: string[], user? }
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    const user = parseUser(req, body?.user);

    if (!ids.length) {
      return NextResponse.json({ error: "ids missing" }, { status: 400 });
    }
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const result = await deleteDocsByIds(ids);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      deleted_documents: result.deleted_documents,
      deleted_storage_files: result.deleted_storage_files,
      storage_error: result.storage_error,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "server error" }, { status: 500 });
  }
}
