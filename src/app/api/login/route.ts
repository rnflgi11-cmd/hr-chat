// src/app/api/login/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const empNo = String(body.empNo ?? "").trim();
  const name = String(body.name ?? "").trim();

  if (!empNo || !name) {
    return NextResponse.json(
      { error: "empNo and name required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("emp_no, name, role")
    .eq("emp_no", empNo)
    .eq("name", name)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "일치하는 사용자를 찾을 수 없습니다." },
      { status: 401 }
    );
  }

  // ✅ 프론트에서 쓰는 세션 형태로 변환해서 내려줌
  return NextResponse.json({
    user: {
      empNo: data.emp_no,
      name: data.name,
      role: (data.role ?? "user") as "admin" | "user",
    },
  });
}
