"use client";

import { useEffect, useMemo, useState } from "react";
import { loadSessionUser, clearSessionUser } from "@/lib/auth";

type UserRow = {
  id: string;
  emp_no: string;
  name: string;
  role: "admin" | "user";
  created_at: string;
};

export default function AdminUsersPage() {
  const user = useMemo(() => (typeof window !== "undefined" ? loadSessionUser() : null), []);
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

    // ✅ JSON 파싱 안전하게 (빈 응답/에러 응답 대비)
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

  async function updateRow(id: string, patch: Partial<Pick<UserRow, "name" | "role">>) {
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

  function logout() {
    clearSessionUser();
    window.location.href = "/";
  }

  // ---- UI 스타일(너 문서관리 페이지 톤 맞춤) ----
  const pageWrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f9fafb 0%, #ffffff 60%, #f9fafb 100%)",
    padding: 16,
  };
  const shell: React.CSSProperties = { maxWidth: 980, margin: "24px auto" };
  const card: React.CSSProperties = {
    border: "1px solid #eef2f7",
    borderRadius: 16,
    background: "#fff",
    boxShadow: "0 10px 30px rgba(0,0,0,0.05)",
    padding: 16,
  };
  const header: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 12,
    borderBottom: "1px solid #f1f5f9",
    marginBottom: 14,
  };
  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    fontSize: 12,
    color: "#374151",
    background: "#fff",
    whiteSpace: "nowrap",
  };
  const btn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 13,
    textDecoration: "none",
    display: "inline-block",
  };
  const primaryBtn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #111827",
    background: "#111827",
    color: "#fff",
    cursor: loading ? "not-allowed" : "pointer",
    fontWeight: 900,
    opacity: loading ? 0.85 : 1,
    whiteSpace: "nowrap",
  };
  const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "10px 12px",
    outline: "none",
    fontSize: 14,
  };
  const select: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "10px 12px",
    outline: "none",
    fontSize: 14,
    background: "#fff",
  };

  if (!user) return null;

  return (
    <div style={pageWrap}>
      <div style={shell}>
        <div style={card}>
          <div style={header}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>관리자 · 사용자 관리</div>
              <div style={{ marginTop: 4, color: "#6b7280", fontSize: 12 }}>
                사번/이름 등록 및 관리자 권한 부여
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={pill}>👤 {user.name} · {user.emp_no} · {user.role}</div>
              <a href="/chat" style={btn}>채팅</a>
              <a href="/admin" style={btn}>문서관리</a>
              <button onClick={logout} style={btn}>로그아웃</button>
            </div>
          </div>

          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ fontWeight: 900 }}>사용자 추가/권한 부여 (Upsert)</div>

            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 160px 120px", gap: 10 }}>
              <input value={empNo} onChange={(e) => setEmpNo(e.target.value)} placeholder="사번 (예: HR001)" style={input} />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" style={input} />
              <select value={role} onChange={(e) => setRole(e.target.value as any)} style={select}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button onClick={upsert} disabled={loading} style={primaryBtn}>
                {loading ? "처리 중..." : "저장"}
              </button>
            </div>

            {msg && (
              <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "10px 12px", fontSize: 13 }}>
                {msg}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900 }}>사용자 목록</div>
              <div style={{ display: "flex", gap: 8, width: 420, maxWidth: "100%" }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="사번/이름 검색" style={input} />
                <button onClick={() => refresh()} disabled={loading} style={btn}>검색</button>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #f1f5f9" }} />

            {rows.length === 0 ? (
              <div style={{ color: "#6b7280", padding: "10px 2px" }}>
                {loading ? "불러오는 중..." : "표시할 사용자가 없습니다."}
              </div>
            ) : (
              <div style={{ display: "grid" }}>
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 160px 120px", gap: 10, padding: "10px 4px", color: "#6b7280", fontSize: 12 }}>
                  <div>사번</div><div>이름</div><div>권한</div><div>작업</div>
                </div>

                {rows.map((r) => (
                  <Row key={r.id} r={r} loading={loading} onSave={updateRow} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "#9ca3af" }}>© Covision HR Demo</div>
      </div>
    </div>
  );
}

function Row({
  r,
  loading,
  onSave,
}: {
  r: UserRow;
  loading: boolean;
  onSave: (id: string, patch: Partial<Pick<UserRow, "name" | "role">>) => void;
}) {
  const [name, setName] = useState(r.name);
  const [role, setRole] = useState<UserRow["role"]>(r.role);
  const dirty = name.trim() !== r.name || role !== r.role;

  const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "10px 12px",
    outline: "none",
    fontSize: 14,
  };
  const select: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "10px 12px",
    outline: "none",
    fontSize: 14,
    background: "#fff",
  };
  const btn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: dirty ? "1px solid #111827" : "1px solid #e5e7eb",
    background: dirty ? "#111827" : "#fff",
    color: dirty ? "#fff" : "#111827",
    cursor: loading ? "not-allowed" : dirty ? "pointer" : "default",
    fontWeight: 900,
    fontSize: 13,
    opacity: loading ? 0.75 : 1,
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 160px 120px", gap: 10, padding: "10px 4px", borderTop: "1px solid #f3f4f6", alignItems: "center" }}>
      <div style={{ fontWeight: 900 }}>{r.emp_no}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} style={input} disabled={loading} />
      <select value={role} onChange={(e) => setRole(e.target.value as any)} style={select} disabled={loading}>
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
      <button disabled={!dirty || loading} style={btn} onClick={() => onSave(r.id, { name: name.trim(), role })}>
        저장
      </button>
    </div>
  );
}
