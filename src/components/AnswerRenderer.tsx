"use client";

import React, { useMemo } from "react";

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

type AnswerPayload = {
  intent: string;
  summary: string;
  evidence: Evidence[];
  related_questions: string[];
};

export default function AnswerRenderer({ data }: { data: AnswerPayload }) {
  const evidence = Array.isArray(data?.evidence) ? data.evidence : [];

  // ✅ 표(table_html) 다음에 표 내용이 paragraph로 반복되는 중복 제거
  const filtered = useMemo(() => {
    const out: Evidence[] = [];
    let lastTableText = "";

    for (const ev of evidence) {
      if (ev.block_type === "table_html") {
        // table 텍스트를 공백 제거 형태로 저장해두고,
        // 이후 paragraph가 표 안 내용(구분/내용/PM팀...)을 반복하면 제거한다.
        lastTableText = (ev.content_text ?? "").replace(/\s+/g, "");
        out.push(ev);
        continue;
      }

      if (ev.block_type === "p" && lastTableText) {
        const t = (ev.content_text ?? "").replace(/\s+/g, "");
        // 너무 짧은 단어는 오탐이 많으니 2글자 이하 제외
        if (t.length >= 3 && lastTableText.includes(t)) {
          continue;
        }
      }

      out.push(ev);
    }

    return out;
  }, [evidence]);

  // ✅ “정확 출력” 원칙:
  // - summary가 비어 있어도 evidence가 있으면 evidence를 보여준다.
  // - evidence도 없으면 그때만 fallback 메시지.
  const hasEvidence = filtered.length > 0;

  const fallback =
    data?.summary?.trim() ||
    "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

  if (!hasEvidence) {
    return (
      <div className="space-y-2">
        <div className="text-sm leading-relaxed text-white/90">{fallback}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* intent */}
      {data?.intent ? (
        <div className="text-xs text-white/55">
          <span className="font-semibold text-white/70">분류</span>{" "}
          <span className="text-white/65">{data.intent}</span>
        </div>
      ) : null}

      {/* summary (있으면만 보여줌) */}
      {data?.summary?.trim() ? (
        <div className="rounded-2xl bg-white/5 p-3 text-sm leading-relaxed ring-1 ring-white/10">
          {data.summary}
        </div>
      ) : null}

      {/* evidence */}
      <div className="space-y-3">
        {filtered.map((ev, idx) => {
          const key = `${ev.filename}_${idx}`;

          // 문단
          if (ev.block_type === "p") {
            const text = (ev.content_text ?? "").trim();
            if (!text) return null;

            return (
              <div
                key={key}
                className="rounded-2xl bg-white/5 p-3 text-sm leading-relaxed ring-1 ring-white/10"
              >
                <div className="mb-1 text-[11px] text-white/45">
                  근거: {ev.filename}
                </div>
                <div className="text-white/90 whitespace-pre-wrap">{text}</div>
              </div>
            );
          }

          // 표 HTML
          if (ev.block_type === "table_html") {
            const html = (ev.content_html ?? "").trim();
            if (!html) return null;

            return (
              <div
                key={key}
                className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10"
              >
                <div className="mb-2 text-[11px] text-white/45">
                  근거(표): {ev.filename}
                </div>

                {/* table_html 그대로 렌더 (보존) */}
                <div
                  className="overflow-auto rounded-xl bg-white/95 p-2 text-black"
                  dangerouslySetInnerHTML={{ __html: html }}
                />

                {/* 표 스타일 최소 보정 */}
                <style jsx>{`
                  :global(table) {
                    border-collapse: collapse;
                    width: 100%;
                    font-size: 13px;
                  }
                  :global(td),
                  :global(th) {
                    border: 1px solid rgba(0, 0, 0, 0.15);
                    padding: 6px 8px;
                    vertical-align: top;
                  }
                  :global(p) {
                    margin: 0;
                  }
                `}</style>
              </div>
            );
          }

          return null;
        })}
      </div>

      {/* related questions (있으면만) */}
      {Array.isArray(data.related_questions) && data.related_questions.length > 0 ? (
        <div className="pt-2">
          <div className="text-xs font-semibold text-white/70 mb-2">관련 질문</div>
          <div className="flex flex-wrap gap-2">
            {data.related_questions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("suggest", { detail: q }));
                }}
                className="rounded-full bg-white/6 px-3 py-1.5 text-xs text-white/75 ring-1 ring-white/10 hover:bg-white/10"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}