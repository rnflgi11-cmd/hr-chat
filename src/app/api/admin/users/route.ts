import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("supabaseUrl is required.");
  if (!serviceKey) throw new Error("supabaseServiceRoleKey is required.");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireAdmin(supabaseAdmin: SupabaseClient, body: any) {
  const empNo = (body?.user?.emp_no ?? "").toString().trim();
  if (!empNo) throw new Error("forbidden");

  // ✅ 로컬스토리지 role 믿지 않고 DB에서 확인
  const { data, error } = await supabaseAdmin.from("users").select("role").eq("emp_no", empNo).maybeSingle();
  if (error) throw error;
  if (!data || data.role !== "admin") throw new Error("forbidden");
}

export async function POST(req: Request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await req.json();

    await requireAdmin(supabaseAdmin, body);

    const action = (body?.action ?? "list").toString();

    // --------------------
    // LIST
    // --------------------
    if (action === "list") {
      const q = (body?.q ?? "").toString().trim();
      let query = supabaseAdmin
        .from("users")
        .select("id, emp_no, name, role, created_at")
        .order("created_at", { ascending: false })
        .limit(500);

      if (q) query = query.or(`emp_no.ilike.%${q}%,name.ilike.%${q}%`);

      const { data, error } = await query;
      if (error) throw error;

      return NextResponse.json({ users: data ?? [] });
    }

    // --------------------
    // UPSERT (사번 기준 생성/수정)
    // --------------------
    if (action === "upsert") {
      const emp_no = (body?.emp_no ?? "").toString().trim();
      const name = (body?.name ?? "").toString().trim();
      const role = (body?.role ?? "user").toString().trim();

      if (!emp_no || !name) return NextResponse.json({ error: "emp_no and name are required" }, { status: 400 });
      if (!["admin", "user"].includes(role)) return NextResponse.json({ error: "role must be admin|user" }, { status: 400 });

      const { data, error } = await supabaseAdmin
        .from("users")
        .upsert({ emp_no, name, role }, { onConflict: "emp_no" })
        .select("id, emp_no, name, role, created_at")
        .maybeSingle();

      if (error) throw error;
      return NextResponse.json({ ok: true, user: data });
    }

    // --------------------
    // UPDATE (id 기준)
    // --------------------
    if (action === "update") {
      const id = (body?.id ?? "").toString().trim();
      const patch: any = {};
      if (typeof body?.name === "string") patch.name = body.name.trim();
      if (typeof body?.role === "string") patch.role = body.role.trim();

      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      if (patch.role && !["admin", "user"].includes(patch.role)) {
        return NextResponse.json({ error: "role must be admin|user" }, { status: 400 });
      }
      if (patch.name !== undefined && !patch.name) {
        return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin
        .from("users")
        .update(patch)
        .eq("id", id)
        .select("id, emp_no, name, role, created_at")
        .maybeSingle();

      if (error) throw error;
      return NextResponse.json({ ok: true, user: data });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e: any) {
    const msg = e?.message ?? "server error";
    const code = msg === "forbidden" ? 403 : 500;
    return NextResponse.json({ error: msg }, { status: code });
  }
}
