import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ✅ 여기 버킷명만 본인 버킷명으로 맞추세요 (관리자 업로드 화면에서 쓰던 버킷)
const BUCKET = "hr-docs";

function chunkText(text: string, size = 1000) {
  const cleaned = text.replace(/\r/g, "").trim();
  const chunks: string[] = [];
  for (let i = 0; i < cleaned.length; i += size) {
    chunks.push(cleaned.slice(i, i + size));
  }
  return chunks.filter((c) => c.trim().length > 0);
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

    // 1) Storage 업로드 (파일명은 한글 안전하게 ASCII path로)
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

    // 3) DOCX 텍스트 추출
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || "").trim();

    if (!text) {
      return NextResponse.json({ error: "문서에서 텍스트를 추출하지 못했습니다." }, { status: 500 });
    }

    // 4) chunk 분리 → document_chunks 저장
    const chunks = chunkText(text, 1000);

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
    return NextResponse.json(
      { error: err?.message ?? "업로드 중 오류 발생" },
      { status: 500 }
    );
  }
}
