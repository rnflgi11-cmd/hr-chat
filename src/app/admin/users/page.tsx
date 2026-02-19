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

type BulkItem = {
  emp_no: string;
  name: string;
  role: "admin" | "user";
};

// --- CSV helpers ---
function normalizeRole(v: string): "admin" | "user" {
  const x = (v ?? "").trim().toLowerCase();
  return x === "admin" ? "admin" : "user";
}

function splitCsvLine(line: string): string[] {
  // 아주 가벼운 CSV 파서:
  // - 따옴표로 감싼 콤마 지원 ("HR001","홍길동","admin")
  // - 탭/세미콜론도 구분자로 허용
  const s = line.trim();
  if (!s) return [];

  // 탭/세미콜론이 많으면 그걸로
  const hasTab = s.includes("\t");
  const hasSemi = s.includes(";");

  if (hasTab && !s.includes(",")) return s.split("\t").map((x) => x.trim());
  if (hasSemi && !s.includes(",")) return s.split(";").map((x) => x.trim());

  // 기본: 콤마 + 따옴표 처리
  const out: string[] = [];
  let cur = "";
  let inQuote = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      // "" 이스케이프
      const next = s[i + 1];
      if (inQuote && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote && ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((x) => x.replace(/^"|"$/g, "").trim());
}

function parseCsvText(text: string): { items: BulkItem[]; errors: string[] } {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const errors: string[] = [];
  const items: BulkItem[] = [];
  const seen = new Set<string>();

  // 헤더 판단: 첫 줄에 emp_no / 사번 같은게 있으면 헤더로 스킵
  const first = lines[0] ?? "";
  const firstCols = splitCsvLine(first).map((x) => x.toLowerCase());
  const looksHeader =
    firstCols.includes("emp_no") ||
    firstCols.includes("empno") ||
    firstCols.includes("사번") ||
    firstCols.includes("name") ||
    firstCols.includes("이름") ||
    firstCols.includes("role") ||
    firstCols.includes("권한");

  const start = looksHeader ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const cols = splitCsvLine(line);

    const emp_no = (cols[0] ?? "").trim();
    const name = (cols[1] ?? "").trim();
    const role = normalizeRole(cols[2] ?? "");

    if (!emp_no || !name) {
      errors.push(`${i + 1}행: 사번/이름 누락 → "${line}"`);
      continue;
    }

    if (seen.has(emp_no)) {
      errors.push(`${i + 1}행: 사번 중복(파일 내) → ${emp_no}`);
      continue;
    }
    seen.add(emp_no);

    items.push({ emp_no, name, role });
  }

  return { items, errors };
}

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

  // CSV upload states
  const [csvName, setCsvName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState<BulkItem[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvResult, setCsvResult] = useState<string | null>(null);

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

  useEffect(() => {
    const { items, errors } = parseCsvText(csvText);
    setCsvPreview(items.slice(0, 20));
    setCsvErrors(errors);
  }, [csvText]);

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

  async function bulkUpsertFromCsv() {
    setCsvResult(null);
    const { items, errors } = parseCsvText(csvText);

    if (errors.length) {
      setCsvResult(`CSV에 오류가 ${errors.length}건 있습니다. 먼저 수정해 주세요.`);
      return;
    }
    if (items.length === 0) {
      setCsvResult("CSV에서 등록할 데이터가 없습니다.");
      return;
    }

    setLoading(true);
    setMsg(null);
    try {
      const json = await post({ action: "bulk_upsert", users: items });

      const total = json.total ?? items.length;
      const affected = json.affected ?? null;
      setCsvResult(
        `일괄 저장 완료! 총 ${total}건${
          affected ? ` (적용 ${affected}건)` : ""
        }`
      );

      // reset
      setCsvName(null);
      setCsvText("");
      await refresh("");
    } catch (e: any) {
      setCsvResult(e?.message ?? "일괄 저장 실패");
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

  async function onPickCsv(file: File | null) {
    setCsvResult(null);
    setCsvErrors([]);
    setCsvPreview([]);
    setCsvText("");
    setCsvName(file?.name ?? null);

    if (!file) return;

    // 안전: 용량 제한 (원하면 더 늘려도 됨)
    if (file.size > 2 * 1024 * 1024) {
      setCsvResult("CSV 파일이 너무 큽니다. (최대 2MB)");
      return;
    }

    const text = await file.text();
    setCsvText(text);
  }

  if (!user) return null;

  const optionClass = "bg-[#0e1628] text-white";

  const inputClass =
    "w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35";

  const selectClass =
    "w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-sky-400/35 appearance-none";

  const btnBase =
    "rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50";

  const btnPrimary =
    "rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-500/15 hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100";

  const card =
    "rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur";

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
        <div className={`mt-4 p-5 ${card}`}>
          <div>
            <div className="text-sm font-semibold">
              사용자 추가/권한 부여 (Upsert)
            </div>
            <div className="mt-1 text-xs text-white/55">
              사번/이름 등록 후 권한(user/admin)을 지정합니다.
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

          {/* ✅ CSV Upload */}
          <div className="mt-5 rounded-3xl bg-white/3 p-4 ring-1 ring-white/10">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-sm font-semibold">CSV로 사용자 일괄 등록</div>
                <div className="mt-1 text-xs text-white/55">
                  형식: <span className="font-semibold">emp_no,name,role</span>
                  (role은 user/admin, 생략 시 user). 헤더는 있어도 됩니다.
                </div>
              </div>

              <div className="flex items-center gap-2">
                <label className={`${btnBase} cursor-pointer`}>
                  CSV 선택
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => onPickCsv(e.target.files?.[0] ?? null)}
                    disabled={loading}
                  />
                </label>

                <button
                  className={btnPrimary}
                  onClick={bulkUpsertFromCsv}
                  disabled={loading || !csvText.trim() || csvErrors.length > 0}
                  title={
                    csvErrors.length
                      ? "오류를 먼저 수정해 주세요."
                      : !csvText.trim()
                      ? "CSV를 선택해 주세요."
                      : "일괄 저장"
                  }
                >
                  {loading ? "처리 중..." : "일괄 저장"}
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/60">
              <span className="rounded-full bg-white/6 px-2 py-1 ring-1 ring-white/10">
                파일: {csvName ?? "선택 안됨"}
              </span>
              <span className="rounded-full bg-white/6 px-2 py-1 ring-1 ring-white/10">
                미리보기: {csvPreview.length}건 (최대 20)
              </span>
              {csvErrors.length ? (
                <span className="rounded-full bg-rose-500/10 px-2 py-1 text-rose-200 ring-1 ring-rose-400/20">
                  오류 {csvErrors.length}건
                </span>
              ) : null}
            </div>

            {/* Preview table */}
            {csvPreview.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-2xl ring-1 ring-white/10">
                <div className="grid grid-cols-[180px_1fr_140px] gap-3 bg-white/5 px-4 py-2 text-xs text-white/55">
                  <div>사번</div>
                  <div>이름</div>
                  <div>권한</div>
                </div>
                <div className="divide-y divide-white/10 bg-white/2">
                  {csvPreview.map((u) => (
                    <div
                      key={u.emp_no}
                      className="grid grid-cols-[180px_1fr_140px] gap-3 px-4 py-2 text-sm"
                    >
                      <div className="truncate font-semibold text-white/90">
                        {u.emp_no}
                      </div>
                      <div className="truncate text-white/85">{u.name}</div>
                      <div className="text-white/80">{u.role}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {csvErrors.length > 0 && (
              <div className="mt-3 rounded-2xl bg-rose-500/10 p-3 text-xs text-rose-200 ring-1 ring-rose-400/20">
                <div className="font-semibold">CSV 입력 오류</div>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {csvErrors.slice(0, 8).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
                {csvErrors.length > 8 && (
                  <div className="mt-2 text-rose-200/80">
                    … 외 {csvErrors.length - 8}건
                  </div>
                )}
              </div>
            )}

            {csvResult && (
              <div className="mt-3 rounded-2xl bg-white/6 p-3 text-sm text-white/80 ring-1 ring-white/10">
                {csvResult}
              </div>
            )}
          </div>

          {msg && (
            <div className="mt-4 rounded-2xl bg-white/6 p-3 text-sm text-white/80 ring-1 ring-white/10">
              {msg}
            </div>
          )}
        </div>

        {/* Card: List */}
        <div className={`mt-4 flex min-h-0 flex-1 flex-col ${card}`}>
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
