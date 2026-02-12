import { NextResponse } from "next/server";
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
