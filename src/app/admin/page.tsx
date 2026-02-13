"use client";

import { useEffect, useMemo, useState } from "react";
import { loadSessionUser } from "@/lib/auth";

type Doc = {
  id: string;
  filename: string;
  created_at: string;
  content_type: string | null;
  size_bytes: number | null;
  open_url?: string | null;
  can_preview?: boolean;
};

export default function AdminPage() {
  const user = useMemo(() => (typeof window !== "undefined" ? loadSessionUser() : null), []);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  // ✅ 체크박스 선택 상태
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

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

  async function refresh() {
    const res = await fetch("/api/admin/docs");
    const json = await res.json();
    const nextDocs: Doc[] = json.docs ?? [];
    setDocs(nextDocs);

    // ✅ 문서 목록 갱신 시, 존재하지 않는 id 선택 제거
    setSelected((prev) => {
      const idSet = new Set(nextDocs.map((d) => d.id));
      const next: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (v && idSet.has(id)) next[id] = true;
      }
      return next;
    });
  }

  async function upload() {
    if (!files || files.length === 0) {
      setMsg("파일을 선택해 주세요.");
      return;
    }
    setBusy(true);
    setMsg("업로드 중...");

    try {
      const form = new FormData();
      files.forEach((file) => form.append("file", file));
      form.append("user", JSON.stringify(user));

      const res = await fetch("/api/admin/upload", { method: "POST", body: form });
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "업로드 실패");
        return;
      }
      setMsg("업로드 완료!");
      setFiles([]);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(docId: string) {
    if (!confirm("정말 삭제할까요? (스토리지/DB에서 삭제됩니다)")) return;

    setBusy(true);
    setMsg("삭제 중...");

    try {
      const res = await fetch("/api/admin/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, user }),
      });
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "삭제 실패");
        return;
      }

      // ✅ 선택 상태에서도 제거
      setSelected((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });

      setMsg("삭제 완료!");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // ✅ 전체 선택/해제(현재 필터 결과 기준)
  function selectAll(list: Doc[]) {
    setSelected((prev) => {
      const next = { ...prev };
      list.forEach((d) => (next[d.id] = true));
      return next;
    });
  }

  function clearAll(list: Doc[]) {
    setSelected((prev) => {
      const next = { ...prev };
      list.forEach((d) => delete next[d.id]);
      return next;
    });
  }

  // ✅ 선택 일괄 삭제
  async function removeSelected(ids: string[]) {
    if (ids.length === 0) return;
    if (!confirm(`선택한 ${ids.length}개 문서를 삭제할까요?\n(스토리지 + DB(chunks 포함)에서 삭제)`)) return;

    setBusy(true);
    setMsg("선택 문서 삭제 중...");

    try {
      const res = await fetch("/api/admin/delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, user }),
      });
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "삭제 실패");
        return;
      }

      const extra = json.storage_error ? ` (storage 일부 실패: ${json.storage_error})` : "";
      setMsg(`삭제 완료! 문서 ${json.deleted_documents ?? ids.length}건${extra}`);
      setSelected({});
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return docs;
    return docs.filter((d) => d.filename.toLowerCase().includes(t));
  }, [docs, q]);

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
    alignItems: "flex-start",
    marginBottom: 14,
  };

  const btn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: busy ? "not-allowed" : "pointer",
    fontWeight: 800,
    fontSize: 13,
    opacity: busy ? 0.75 : 1,
  };

  const primaryBtn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #111827",
    background: "#111827",
    color: "#fff",
    cursor: busy ? "not-allowed" : "pointer",
    fontWeight: 900,
    opacity: busy ? 0.85 : 1,
    whiteSpace: "nowrap",
  };

  const dangerBtn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #fecaca",
    background: "#fff",
    color: "#b91c1c",
    cursor: busy ? "not-allowed" : "pointer",
    fontWeight: 900,
    fontSize: 13,
    opacity: busy ? 0.75 : 1,
  };

  const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "10px 12px",
    outline: "none",
    fontSize: 14,

  };

  if (!user) return null;

  return (
    <div style={pageWrap}>
      <div style={shell}>
        <div style={{ ...card, paddingBottom: 12 }}>
          <div style={header}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>관리자 · 문서 업로드</div>
              <div style={{ marginTop: 6, color: "#6b7280", fontSize: 12 }}>
                👤 {user.name} ({user.emp_no}) · 권한: {user.role}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <a href="/chat" style={{ ...btn, textDecoration: "none", display: "inline-block" }}>
                채팅으로
              </a>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center" }}>
            <input
              type="file"
              multiple
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              disabled={busy}
            />
            <button onClick={upload} disabled={busy} style={primaryBtn}>
              {busy ? "처리 중..." : "업로드"}
            </button>
          </div>

          {msg && (
            <div
              style={{
                marginTop: 12,
                border: "1px solid #e5e7eb",
                background: "#f9fafb",
                borderRadius: 12,
                padding: "10px 12px",
                fontSize: 13,
                color: "#374151",
              }}
            >
              {msg}
            </div>
          )}
        </div>

        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>업로드된 문서</div>
              <div style={{ marginTop: 4, color: "#6b7280", fontSize: 12 }}>
                열기는 PDF/DOCX/이미지 권장 · 한글 파일명도 정상 동작
              </div>
            </div>

            <div style={{ width: 320, maxWidth: "100%" }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="파일명 검색…" style={input} />
            </div>
          </div>

          {/* ✅ 체크박스/일괄삭제 컨트롤 */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => selectAll(filtered)} disabled={busy || filtered.length === 0} style={btn}>
              전체 선택(검색결과)
            </button>
            <button onClick={() => clearAll(filtered)} disabled={busy || filtered.length === 0} style={btn}>
              선택 해제(검색결과)
            </button>
            <button
              onClick={() => removeSelected(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              style={dangerBtn}
            >
              선택 삭제 ({selectedIds.length})
            </button>
          </div>

          <div style={{ marginTop: 12, borderTop: "1px solid #f1f5f9" }} />

          {filtered.length === 0 ? (
            <div style={{ padding: "14px 4px", color: "#6b7280" }}>문서가 없습니다.</div>
          ) : (
            <div style={{ marginTop: 4 }}>
              {filtered.map((d) => (
                <div
                  key={d.id}
                  style={{
                    padding: "12px 4px",
                    borderBottom: "1px solid #f3f4f6",
                    display: "grid",
                    gridTemplateColumns: "28px 1fr auto",
                    gap: 10,
                    alignItems: "start",
                  }}
                >
                  {/* ✅ 체크박스 */}
                  <div style={{ paddingTop: 2 }}>
                    <input
                      type="checkbox"
                      checked={!!selected[d.id]}
                      onChange={(e) => setSelected((prev) => ({ ...prev, [d.id]: e.target.checked }))}
                      disabled={busy}
                    />
                  </div>

                  <div>
                    <div style={{ fontWeight: 900 }}>
                      {d.filename}
                      {d.open_url && (
                        <a
                          href={d.open_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ marginLeft: 10, fontSize: 13, fontWeight: 900 }}
                        >
                          열기
                        </a>
                      )}
                    </div>

                    <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                      {new Date(d.created_at).toLocaleString()} · {d.content_type ?? "-"} ·{" "}
                      {d.size_bytes ? `${d.size_bytes.toLocaleString()} bytes` : "-"}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => removeDoc(d.id)} disabled={busy} style={dangerBtn}>
                      삭제
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af" }}>
            Tip) 데모에서는 문서 수가 많아지면 목록을 “최근 50개”로 제한하는 것도 좋아요.
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "#9ca3af" }}>
          © Covision HR Demo
        </div>
      </div>
    </div>
  );
  
}