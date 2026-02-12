"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSessionUser } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const hasError = useMemo(() => Boolean(err), [err]);

  async function onLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);

    const trimmedName = name.trim();
    const trimmedEmpNo = empNo.trim();

    if (!trimmedName || !trimmedEmpNo) {
      setErr("이름과 사번을 입력해 주세요.");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ empNo: trimmedEmpNo, name: trimmedName }),
      });

      let json: any = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }

      if (!res.ok) {
        setErr(json?.error ?? "로그인에 실패했어요. 이름/사번을 확인해 주세요.");
        return;
      }

      saveSessionUser(json.user);
      router.push("/chat");
      router.refresh();
    } catch {
      setErr("네트워크 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 12px",
    marginTop: 8,
    borderRadius: 10,
    border: hasError ? "1px solid #ef4444" : "1px solid #e5e7eb",
    outline: "none",
    fontSize: 14,
    background: "#fff",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: "#374151",
    fontWeight: 700,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "linear-gradient(180deg, #f9fafb 0%, #ffffff 50%, #f9fafb 100%)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.2 }}>
            코비전 HR 규정 챗봇
          </div>
          <div style={{ marginTop: 6, color: "#6b7280", fontSize: 13 }}>
            이름과 사번으로 로그인해요 (데모용)
          </div>
        </div>

        <div
          style={{
            border: "1px solid #eef2f7",
            borderRadius: 16,
            padding: 18,
            boxShadow: "0 10px 30px rgba(0,0,0,0.05)",
            background: "#fff",
          }}
        >
          <form onSubmit={onLogin} style={{ display: "grid", gap: 12 }}>
            <div>
              <div style={labelStyle}>이름</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
                autoComplete="name"
                autoFocus
                placeholder="예: 김인호"
              />
            </div>

            <div>
              <div style={labelStyle}>사번</div>
              <input
                value={empNo}
                onChange={(e) => setEmpNo(e.target.value)}
                style={inputStyle}
                autoComplete="off"
                placeholder="예: HR001"
              />
            </div>

            {err && (
              <div
                style={{
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  color: "#b91c1c",
                  borderRadius: 12,
                  padding: "10px 12px",
                  fontSize: 13,
                  lineHeight: 1.4,
                }}
              >
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 2,
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid #111827",
                background: loading ? "#111827" : "#111827",
                color: "#fff",
                fontWeight: 900,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.85 : 1,
              }}
            >
              {loading ? "로그인 중..." : "로그인"}
            </button>

            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              * 인사팀 관리자만 문서 업로드 가능
            </div>
          </form>
        </div>

        <div style={{ textAlign: "center", marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
          © Covision HR Demo
        </div>
      </div>
    </div>
  );
}
