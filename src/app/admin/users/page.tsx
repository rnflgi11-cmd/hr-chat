"use client";

import { useEffect, useMemo } from "react";
import { loadSessionUser } from "@/lib/auth";

export default function AdminUsersPage() {
  const user = useMemo(() => (typeof window !== "undefined" ? loadSessionUser() : null), []);

  useEffect(() => {
    if (!user) {
      window.location.href = "/";
      return;
    }
    if (user.role !== "admin") {
      window.location.href = "/chat";
      return;
    }
  }, [user]);

  if (!user) return null;

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontWeight: 900, fontSize: 20 }}>관리자 · 사용자 관리</h1>
      <p style={{ marginTop: 8, color: "#6b7280" }}>
        (1단계) 페이지 연결만 확인 중 — 다음 단계에서 목록/권한부여 기능 붙입니다.
      </p>

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <a href="/admin" style={{ textDecoration: "none", fontWeight: 900 }}>← 문서 관리로</a>
        <a href="/chat" style={{ textDecoration: "none", fontWeight: 900 }}>채팅으로 →</a>
      </div>
    </div>
  );
}
