import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: Request) {
  const { empNo, name } = await req.json();

  if (!empNo || !name) {
    return NextResponse.json({ error: "empNo and name required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, emp_no, name, role")
    .eq("emp_no", empNo)
    .eq("name", name)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "일치하는 사용자를 찾을 수 없습니다." }, { status: 401 });

  return NextResponse.json({ user: data });
}
