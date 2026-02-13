"use client";

import React from "react";

export default function AdminNav({
  current,
}: {
  current?: "docs" | "users";
}) {
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

  const activeBtn: React.CSSProperties = {
    ...btn,
    border: "1px solid #111827",
    background: "#111827",
    color: "#fff",
  };

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <a href="/chat" style={btn}>
        채팅
      </a>

      <a href="/admin" style={current === "docs" ? activeBtn : btn}>
        문서 관리
      </a>

      <a href="/admin/users" style={current === "users" ? activeBtn : btn}>
        사용자 관리
      </a>
    </div>
  );
}
