"use client";

import React, { useMemo, useState } from "react";

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

type AnswerContent = {
  answer: string;
  hits: Evidence[];
  meta?: { intent?: string };
};

function clampText(s: string, max = 520) {
  const t = (s ?? "").trim();
  if (t.length <= max) return { text: t, clamped: false };
  return { text: t.slice(0, max).trimEnd() + "…", clamped: true };
}

function SafeHTML({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function AnswerRenderer({ data }: { data: AnswerContent }) {
  const [showSources, setShowSources] = useState(false);

  const answer = (data?.answer ?? "").trim();
  const hits = data?.hits ?? [];
  const intent = data?.meta?.intent ?? "";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* 답변 */}
      <div
        style={{
          padding: 14,
          borderRadius: 14,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#e5e7eb",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "visible",
        }}
      >
        {answer || "답변을 생성하지 못했습니다."}
        {intent ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "rgba(229,231,235,0.55)" }}>
            intent: {intent}
          </div>
        ) : null}
      </div>

      {/* 근거 토글 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => setShowSources((v) => !v)}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            color: "#e5e7eb",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          근거 원문 {showSources ? "접기" : "보기"}
        </button>

        <div style={{ color: "rgba(229,231,235,0.7)", fontSize: 12 }}>
          {hits.length ? `근거 ${hits.length}개` : "근거 없음"}
        </div>
      </div>

      {showSources && (
        <div style={{ display: "grid", gap: 10 }}>
          {hits.map((e, idx) => (
            <SourceBlock key={`${e.filename}-${idx}`} e={e} idx={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceBlock({ e, idx }: { e: Evidence; idx: number }) {
  const [open, setOpen] = useState(false);
  const isTable = e.block_type === "table_html";

  return (
    <div
      style={{
        borderRadius: 16,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.08)",
        padding: 12,
        overflow: "visible",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "rgba(229,231,235,0.55)" }}>
            {(e.filename ?? "문서") + ` · #${idx}`}
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e5e7eb" }}>
            {isTable ? "표" : "원문"}
          </div>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            flex: "0 0 auto",
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            color: "#e5e7eb",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 12,
            height: 34,
          }}
        >
          {open ? "닫기" : "열기"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {isTable ? <TableBlock html={e.content_html ?? ""} /> : <ParagraphBlock text={e.content_text ?? ""} />}
        </div>
      )}
    </div>
  );
}

function ParagraphBlock({ text }: { text: string }) {
  const raw = (text ?? "").trim();
  const [more, setMore] = useState(false);
  const { text: clamped, clamped: isClamped } = useMemo(() => clampText(raw, 520), [raw]);

  return (
    <div>
      <div
        style={{
          color: "#e5e7eb",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "visible",
          fontSize: 13,
        }}
      >
        {more ? raw : clamped}
      </div>

      {isClamped && (
        <button
          onClick={() => setMore((v) => !v)}
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            color: "#e5e7eb",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 12,
          }}
        >
          {more ? "접기" : "더보기"}
        </button>
      )}
    </div>
  );
}

function TableBlock({ html }: { html: string }) {
  const h = (html ?? "").trim();
  return (
    <div
      style={{
        borderRadius: 12,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.10)",
        padding: 10,
        overflowX: "auto",
        overflowY: "auto",
        maxHeight: 520,
        WebkitOverflowScrolling: "touch",
      }}
    >
      {h ? (
        <div style={{ minWidth: 680 }}>
          <SafeHTML html={h} />
        </div>
      ) : (
        <div style={{ color: "rgba(229,231,235,0.7)", fontSize: 12 }}>
          table_html 없음
        </div>
      )}
    </div>
  );
}