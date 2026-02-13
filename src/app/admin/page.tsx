"use client";

import { useEffect, useMemo, useState } from "react";
import { clearSessionUser, loadSessionUser } from "@/lib/auth";

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
  const [q, setQ] = useState("");

  // add form
  const [newEmp, setNewEmp] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      window.location.href = "/";
      return;
    }
    if (user.role !== "admin") {
      window.location.href = "/chat";
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function api(body: any) {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, user }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "요청 실패");
    return json;
  }

  async function refresh() {
    setLoading(true);
    setMsg(null);
    try {
      const json = await api({ action: "list", q });
      setRows((json.users ?? []) as UserRow[]);
    } catch (e: any) {
      setMsg(e?.message ?? "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  async function createOrUpsert() {
    setMsg(null);
    const emp_no = newEmp.trim();
    const name = newName.trim();
    if (!emp_no || !name) {
      setMsg("사번/이름을 입력해 주세요.");
      return;
    }
    setLoading(true);
    try {
      await api({ action: "upsert", emp_no, name, role: newRole });
      setNewEmp("");
      setNewName("");
      setNewRole("user");
      await refresh();
      setMsg("저장 완료!");
    } catch (e: any) {
      setMsg(e?.message ?? "저장 실패");
    } finally {
      setLoading(false);
    }
  }

  async function updateRow(id: string, patch: Partial<Pick<UserRow, "name" | "role">>) {
    setMsg(null);
    setLoading(true);
    try {
      await api({ action: "update", id, ...patch });
      await refresh();
      setMsg("변경 완료!");
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
  };

  const header: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid #f1f5f9",
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
    fontWeight: 900,
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
    background: "#fff",
  };

  const section: React.CSSProperties = { padding: 16 };

  const h2: React.CSSProperties = { fontSize: 14, fontWeight: 900, marginBottom: 10 };

  const tableWrap: React.CSSProperties = {
    border: "1px solid #eef2f7",
    borderRadius: 14,
    overflow: "hidden",
  };

  const th: React.CSSProperties = {
    textAlign: "left",
    fontSize: 12,
    color: "#6b7280",
    padding: "10px 12px",
    background: "#f9fafb",
    borderBottom: "1px solid #eef2f7",
    whiteSpace: "nowrap",
  };

  const td: React.CSSProperties = {
    fontSize: 13,
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    verticalAlign: "top",
  };

  const smallBtn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: loading ? "not-allowed" : "pointer",
    fontWeight: 900,
    fontSize: 12,
  };

  const select: React.CSSProperties = {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 13,
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
              <a href="/chat" style={btn}>
                채팅
              </a>
              <button onClick={logout} style={btn}>
                로그아웃
              </button>
            </div>
          </div>

          <div style={section}>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={h2}>사용자 추가/권한 부여 (Upsert)</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "180px 1fr 140px 120px",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <input
                    value={newEmp}
                    onChange={(e) => setNewEmp(e.target.value)}
                    placeholder="사번 (예: HR001)"
                    style={input}
                  />
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="이름"
                    style={input}
                  />
                  <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)} style={select}>
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                  <button onClick={createOrUpsert} disabled={loading} style={primaryBtn}>
                    {loading ? "처리 중..." : "저장"}
                  </button>
                </div>
                {msg && <div style={{ fontSize: 13, color: msg.includes("완료") ? "#065f46" : "#b91c1c" }}>{msg}</div>}
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="사번/이름 검색"
                  style={{ ...input, maxWidth: 340 }}
                />
                <button onClick={refresh} disabled={loading} style={smallBtn}>
                  {loading ? "불러오는 중..." : "검색"}
                </button>
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  최대 500명 표시 · 최근 생성 순
                </div>
              </div>

              <div style={tableWrap}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>사번</th>
                      <th style={th}>이름</th>
                      <th style={th}>권한</th>
                      <th style={th}>생성일</th>
                      <th style={th}>작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td style={{ ...td, color: "#6b7280" }} colSpan={5}>
                          {loading ? "불러오는 중..." : "표시할 사용자가 없습니다."}
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <AdminRow
                          key={r.id}
                          row={r}
                          loading={loading}
                          onSave={(patch) => updateRow(r.id, patch)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "#9ca3af" }}>
          © Covision HR Demo
        </div>
      </div>
    </div>
  );
}

function AdminRow({
  row,
  loading,
  onSave,
}: {
  row: UserRow;
  loading: boolean;
  onSave: (patch: Partial<Pick<UserRow, "name" | "role">>) => void;
}) {
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<UserRow["role"]>(row.role);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(row.name);
    setRole(row.role);
    setDirty(false);
  }, [row.id, row.name, row.role]);

  const inputMini: React.CSSProperties = {
    width: "100%",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    padding: "8px 10px",
    outline: "none",
    fontSize: 13,
    background: "#fff",
  };

  const select: React.CSSProperties = {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 13,
    background: "#fff",
  };

  const saveBtn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: dirty ? "1px solid #111827" : "1px solid #e5e7eb",
    background: dirty ? "#111827" : "#fff",
    color: dirty ? "#fff" : "#111827",
    cursor: loading ? "not-allowed" : dirty ? "pointer" : "default",
    fontWeight: 900,
    fontSize: 12,
    opacity: loading ? 0.8 : 1,
  };

  const td: React.CSSProperties = {
    fontSize: 13,
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    verticalAlign: "top",
  };

  return (
    <tr>
      <td style={td}>
        <div style={{ fontWeight: 900 }}>{row.emp_no}</div>
      </td>

      <td style={td}>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          style={inputMini}
        />
      </td>

      <td style={td}>
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value as any);
            setDirty(true);
          }}
          style={select}
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </td>

      <td style={td}>
        <div style={{ fontSize: 12, color: "#6b7280" }}>{new Date(row.created_at).toLocaleString()}</div>
      </td>

      <td style={td}>
        <button
          disabled={!dirty || loading}
          style={saveBtn}
          onClick={() => onSave({ name: name.trim(), role })}
        >
          저장
        </button>
      </td>
    </tr>
  );
}
