"use client";

import AdminNav from "@/components/AdminNav";
import { useEffect, useMemo, useState } from "react";
import { loadSessionUser } from "@/lib/auth";

type UserRow = {
  id: string;
  emp_no: string;
  name: string;
  role: "admin" | "user";
  created_at: string;
};

export default function AdminUsersPage() {
  const user = useMemo(
    () => (typeof window !== "undefined" ? loadSessionUser() : null),
    []
  );

  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [q, setQ] = useState("");

  // upsert form
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");

  useEffect(() => {
    if (!user) {
      window.location.href = "/";
      return;
    }
    if (user.role !== "admin") {
      window.location.href = "/chat";
      return;
    }
    refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function post(body: any) {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, user }),
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(json.error ?? `요청 실패 (${res.status})`);
    return json;
  }

  async function refresh(nextQ?: string) {
    setLoading(true);
    setMsg(null);
    try {
      const json = await post({ action: "list", q: nextQ ?? q });
      setRows(json.users ?? []);
    } catch (e: any) {
      setMsg(e?.message ?? "불러오기 실패");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function upsert() {
    const e = empNo.trim();
    const n = name.trim();
    if (!e || !n) {
      setMsg("사번/이름을 입력해 주세요.");
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await post({ action: "upsert", emp_no: e, name: n, role });
      setEmpNo("");
      setName("");
      setRole("user");
      setMsg("저장 완료!");
      await refresh("");
    } catch (e: any) {
      setMsg(e?.message ?? "저장 실패");
    } finally {
      setLoading(false);
    }
  }

  async function updateRow(
    id: string,
    patch: Partial<Pick<UserRow, "name" | "role">>
  ) {
    setLoading(true);
    setMsg(null);
    try {
      await post({ action: "update", id, ...patch });
      setMsg("변경 완료!");
      await refresh();
    } catch (e: any) {
      setMsg(e?.message ?? "변경 실패");
    } finally {
      setLoading(false);
    }
  }

  if (!user) return null;

  // ✅ 드롭다운(option) 다크 배경용
  const optionClass = "bg-[#0e1628] text-white";

  const inputClass =
    "w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35";

  // ✅ select에 appearance-none 추가 (브라우저 기본 스타일 충돌 완화)
  const selectClass =
    "w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-sky-400/35 appearance-none";

  const btnBase =
    "rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50";

  const btnPrimary =
    "rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-500/15 hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100";

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0b1220] via-[#0e1628] to-[#0b1220] text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
              <div className="flex h-full w-full items-center justify-center text-lg font-bold">
                HR
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">
                관리자 · 사용자 관리
              </div>
              <div className="mt-0.5 text-xs text-white/55">
                사번/이름 등록 및 관리자 권한 부여
              </div>
            </div>
          </div>

          <AdminNav current="users" />
        </div>

        {/* Card: Upsert */}
        <div className="mt-4 rounded-3xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-sm font-semibold">
                사용자 추가/권한 부여 (Upsert)
              </div>
              <div className="mt-1 text-xs text-white/55">
                사번/이름 등록 후 권한(user/admin)을 지정합니다.
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[220px_1fr_180px_120px]">
            <input
              value={empNo}
              onChange={(e) => setEmpNo(e.target.value)}
              placeholder="사번 (예: HR001)"
              className={inputClass}
              disabled={loading}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름"
              className={inputClass}
              disabled={loading}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
              className={selectClass}
              disabled={loading}
            >
              <option value="user" className={optionClass}>
                user
              </option>
              <option value="admin" className={optionClass}>
                admin
              </option>
            </select>
            <button onClick={upsert} disabled={loading} className={btnPrimary}>
              {loading ? "처리 중..." : "저장"}
            </button>
          </div>

          {msg && (
            <div className="mt-4 rounded-2xl bg-white/6 p-3 text-sm text-white/80 ring-1 ring-white/10">
              {msg}
            </div>
          )}
        </div>

        {/* Card: List */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-semibold">사용자 목록</div>

            <div className="flex w-full gap-2 sm:w-[460px]">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="사번/이름 검색"
                className={inputClass}
                disabled={loading}
              />
              <button
                onClick={() => refresh()}
                disabled={loading}
                className={btnBase}
              >
                검색
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {rows.length === 0 ? (
              <div className="py-4 text-sm text-white/55">
                {loading ? "불러오는 중..." : "표시할 사용자가 없습니다."}
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl ring-1 ring-white/10">
                {/* header row */}
                <div className="grid grid-cols-[180px_1fr_160px_120px] gap-3 bg-white/5 px-4 py-3 text-xs text-white/55">
                  <div>사번</div>
                  <div>이름</div>
                  <div>권한</div>
                  <div>작업</div>
                </div>

                <div className="divide-y divide-white/10 bg-white/2">
                  {rows.map((r) => (
                    <Row
                      key={r.id}
                      r={r}
                      loading={loading}
                      onSave={updateRow}
                      optionClass={optionClass}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 text-center text-xs text-white/45">
          © Covision HR Demo
        </div>
      </div>
    </div>
  );
}

function Row({
  r,
  loading,
  onSave,
  optionClass,
}: {
  r: UserRow;
  loading: boolean;
  onSave: (id: string, patch: Partial<Pick<UserRow, "name" | "role">>) => void;
  optionClass: string;
}) {
  const [name, setName] = useState(r.name);
  const [role, setRole] = useState<UserRow["role"]>(r.role);
  const dirty = name.trim() !== r.name || role !== r.role;

  const inputClass =
    "w-full rounded-2xl bg-white/5 px-4 py-2.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-sky-400/35 disabled:opacity-60";

  // ✅ 여기도 appearance-none 추가
  const selectClass =
    "w-full rounded-2xl bg-white/5 px-4 py-2.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-sky-400/35 disabled:opacity-60 appearance-none";

  const btn = [
    "rounded-2xl px-3 py-2 text-xs font-semibold ring-1 transition disabled:opacity-50",
    dirty
      ? "bg-gradient-to-r from-indigo-500 to-sky-500 text-white ring-white/10 hover:brightness-110"
      : "bg-white/6 text-white/70 ring-white/10",
  ].join(" ");

  return (
    <div className="grid grid-cols-[180px_1fr_160px_120px] gap-3 px-4 py-3 items-center">
      <div className="truncate font-semibold text-white/90">{r.emp_no}</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={inputClass}
        disabled={loading}
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as any)}
        className={selectClass}
        disabled={loading}
      >
        <option value="user" className={optionClass}>
          user
        </option>
        <option value="admin" className={optionClass}>
          admin
        </option>
      </select>
      <button
        disabled={!dirty || loading}
        className={btn}
        onClick={() => onSave(r.id, { name: name.trim(), role })}
      >
        저장
      </button>
    </div>
  );
}
