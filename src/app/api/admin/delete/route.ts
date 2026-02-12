import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "hr-docs";

export async function POST(req: Request) {
  const { docId, user } = await req.json();

  if (!docId || !user) {
    return NextResponse.json({ error: "docId/user missing" }, { status: 400 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: doc, error: selErr } = await supabaseAdmin
    .from("documents")
    .select("id, storage_path")
    .eq("id", docId)
    .maybeSingle();

  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });
  if (!doc) return NextResponse.json({ error: "document not found" }, { status: 404 });

  if (doc.storage_path) {
    const { error: stErr } = await supabaseAdmin.storage.from(BUCKET).remove([doc.storage_path]);
    if (stErr) {
      return NextResponse.json({ error: `storage delete failed: ${stErr.message}` }, { status: 500 });
    }
  }

  const { error: delErr } = await supabaseAdmin.from("documents").delete().eq("id", docId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
