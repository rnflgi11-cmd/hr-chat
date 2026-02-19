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

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("emp_no", empNo)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.role !== "admin") throw new Error("forbidden");
}

type Role = "admin" | "user";
type BulkUser = { emp_no: string; name: string; role: Role };

function normalizeRole(v: any): Role {
  return String(v ?? "")
    .trim()
    .toLowerCase() === "admin"
    ? "admin"
    : "user";
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
      const role = normalizeRole(body?.role);

      if (!emp_no || !name) {
        return NextResponse.json(
          { error: "emp_no and name are required" },
          { status: 400 }
        );
      }

      const { data, error } = await supabaseAdmin
        .from("users")
        .upsert({ emp_no, name, role }, { onConflict: "emp_no" })
        .select("id, emp_no, name, role, created_at")
        .maybeSingle();

      if (error) throw error;
      return NextResponse.json({ ok: true, user: data });
    }

    // --------------------
    // BULK_UPSERT (CSV/일괄 등록)
    // body.users: [{ emp_no, name, role? }, ...]
    // --------------------
    if (action === "bulk_upsert") {
      const usersRaw: unknown = body?.users;
      const users: any[] = Array.isArray(usersRaw) ? usersRaw : [];

      if (users.length === 0) {
        return NextResponse.json({ error: "users required" }, { status: 400 });
      }

      // ✅ map 결과 타입을 확정해서 filter에서 u 타입이 흔들리지 않게
      const mapped: BulkUser[] = users.map((u: any): BulkUser => {
        const emp_no = (u?.emp_no ?? "").toString().trim();
        const name = (u?.name ?? "").toString().trim();
        const role = normalizeRole(u?.role);
        return { emp_no, name, role };
      });

      // ✅ filter 콜백 인자 타입을 명시(핵심)
      const normalized: BulkUser[] = mapped.filter(
        (u: BulkUser) => !!u.emp_no && !!u.name
      );

      if (normalized.length === 0) {
        return NextResponse.json(
          { error: "no valid users" },
          { status: 400 }
        );
      }

      // 입력 내 emp_no 중복 방지
      const seen = new Set<string>();
      for (const u of normalized) {
        if (seen.has(u.emp_no)) {
          return NextResponse.json(
            { error: `duplicate emp_no in input: ${u.emp_no}` },
            { status: 400 }
          );
        }
        seen.add(u.emp_no);
      }

      // insert/update 카운트(정확)
      const empNos: string[] = normalized.map((u) => u.emp_no);

      const { data: existedRows, error: existedErr } = await supabaseAdmin
        .from("users")
        .select("emp_no")
        .in("emp_no", empNos);

      if (existedErr) throw existedErr;

      const existed = new Set<string>(
        (((existedRows as Array<{ emp_no: string }>) ?? []) as Array<{
          emp_no: string;
        }>).map((x) => x.emp_no)
      );

      const inserted = normalized.filter((u) => !existed.has(u.emp_no)).length;
      const updated = normalized.length - inserted;

      const { error } = await supabaseAdmin
        .from("users")
        .upsert(normalized, { onConflict: "emp_no" });

      if (error) throw error;

      return NextResponse.json({
        ok: true,
        total: normalized.length,
        inserted,
        updated,
      });
    }

    // --------------------
    // UPDATE (id 기준)
    // --------------------
    if (action === "update") {
      const id = (body?.id ?? "").toString().trim();
      const patch: any = {};

      if (typeof body?.name === "string") patch.name = body.name.trim();
      if (body?.role !== undefined) patch.role = normalizeRole(body.role);

      if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      if (patch.name !== undefined && !patch.name) {
        return NextResponse.json(
          { error: "name cannot be empty" },
          { status: 400 }
        );
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
