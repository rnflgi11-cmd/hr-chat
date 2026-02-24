"use client";

import React, { useMemo, useState } from "react";

type Block = {
  id?: string;
  document_id?: string;
  block_index?: number;
  kind?: "paragraph" | "table";
  text?: string | null;
  table_html?: string | null;
  tsv?: string | null;
  filename?: string | null;
};

type NormalizedPayload = {
  answer: string;
  hits: Block[];
};

// ✅ 어떤 형태가 와도 안전하게 {answer, hits}로 정규화
function normalizeData(data: unknown): NormalizedPayload {
  // string이면 답변만
  if (typeof data === "string") return { answer: data, hits: [] };

  // null/undefined면 빈값
  if (!data) return { answer: "", hits: [] };

  // object면 answer/hits 뽑기
  if (typeof data === "object") {
    const obj = data as any;
    const answer =
      typeof obj.answer === "string"
        ? obj.answer
        : typeof obj.content === "string"
          ? obj.content
          : "";

    const hits = Array.isArray(obj.hits) ? (obj.hits as Block[]) : [];

    return { answer, hits };
  }

  // 그 외(숫자/불리언 등)
  return { answer: String(data), hits: [] };
}

function clampText(s: string, max = 520) {
  const t = (s ?? "").trim();
  if (t.length <= max) return { text: t, clamped: false };
  return { text: t.slice(0, max).trimEnd() + "…", clamped: true };
}

function SafeHTML({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function AnswerRenderer({ data }: { data: unknown }) {
  const payload = useMemo(() => normalizeData(data), [data]);

  const [showSources, setShowSources] = useState(false);
  const answer = (payload.answer ?? "").trim();
  const hits = payload.hits ?? [];

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

      {/* 근거 리스트 */}
      {showSources && (
        <div style={{ display: "grid", gap: 10 }}>
          {hits.map((b, idx) => (
            <SourceBlock key={(b.id as string) ?? `${idx}`} b={b} idx={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceBlock({ b, idx }: { b: Block; idx: number }) {
  const [open, setOpen] = useState(false);

  const kind = b.kind ?? (b.table_html ? "table" : "paragraph");
  const title = kind === "table" ? "표" : "원문";

  return (
    <div
      style={{
        borderRadius: 16,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.08)",
        padding: 12,
        overflow: "visible", // ✅ 짤림 방지
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "rgba(229,231,235,0.55)" }}>
            {(b.filename ?? "문서") +
              (typeof b.block_index === "number"
                ? ` · #${b.block_index}`
                : ` · #${idx}`)}
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e5e7eb" }}>
            {title}
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
          {kind === "table" ? <TableBlock b={b} /> : <ParagraphBlock b={b} />}
        </div>
      )}
    </div>
  );
}

function ParagraphBlock({ b }: { b: Block }) {
  const raw = (b.text ?? "").trim();
  const [more, setMore] = useState(false);
  const { text, clamped } = useMemo(() => clampText(raw, 520), [raw]);

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
        {more ? raw : text}
      </div>

      {clamped && (
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

function TableBlock({ b }: { b: Block }) {
  const html = (b.table_html ?? "").trim();

  return (
    <div
      style={{
        borderRadius: 12,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.10)",
        padding: 10,
        overflowX: "auto", // ✅ 가로 스크롤로 짤림 해결
        overflowY: "auto",
        maxHeight: 520,
        WebkitOverflowScrolling: "touch",
      }}
    >
      {html ? (
        <div style={{ minWidth: 680 }}>
          <SafeHTML html={html} />
        </div>
      ) : (
        <div style={{ color: "rgba(229,231,235,0.7)", fontSize: 12 }}>
          table_html 없음
        </div>
      )}
    </div>
  );
}