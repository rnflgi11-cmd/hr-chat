"use client";

import React, { useMemo, useState } from "react";

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

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function isHeadingLine(s: string) {
  // “1. …”, “2. …”, “[...]” 같은 제목/섹션 라인
  return (
    /^\[\s*.+\s*\]$/.test(s) ||
    /^\d+\.\s+/.test(s) ||
    /^[가-힣A-Za-z0-9]+\s*[:：]/.test(s)
  );
}

function makeSummary(evidence: Evidence[]) {
  // ✅ 표가 있으면 표를 우선 요약(며칠/일수 질문에 제일 정확)
  const table = evidence.find((e) => e.block_type === "table_html" && (e.content_html ?? "").trim());
  if (table) {
    // 표가 있으면 요약은 “표가 근거” 한 줄만 만들고, 실제 내용은 표가 보여주니까 OK
    return ["아래 표에서 경조유형/대상별 휴가일수를 확인할 수 있습니다."];
  }

  // 표가 없으면 문단 중 “의미있는 줄” 3~6줄로 구성
  const lines: string[] = [];

  for (const ev of evidence) {
    if (ev.block_type !== "p") continue;
    const t = clean(ev.content_text ?? "");
    if (!t) continue;

    // 너무 짧은 조각 제거
    if (t.length < 10) continue;

    // '문의:' 같은 안내는 요약에서 제외
    if (/^문의[:：]/.test(t)) continue;

    // 중복 제거
    if (lines.includes(t)) continue;

    // 제목/섹션 라인 우선
    if (isHeadingLine(t)) lines.push(t);
    else if (lines.length < 6) lines.push(t);

    if (lines.length >= 6) break;
  }

  return lines.length ? lines : ["관련 내용을 찾았지만 요약할 문장을 구성하지 못했습니다. 아래 근거 원문을 확인해 주세요."];
}

export default function AnswerRenderer({ data }: { data: AnswerPayload }) {
  const evidence = Array.isArray(data?.evidence) ? data.evidence : [];

  // ✅ 표 다음에 표 내용이 paragraph로 반복되는 중복 제거
  const filtered = useMemo(() => {
    const out: Evidence[] = [];
    let lastTableText = "";

    for (const ev of evidence) {
      if (ev.block_type === "table_html") {
        lastTableText = (ev.content_text ?? "").replace(/\s+/g, "");
        out.push(ev);
        continue;
      }

      if (ev.block_type === "p" && lastTableText) {
        const t = (ev.content_text ?? "").replace(/\s+/g, "");
        if (t.length >= 3 && lastTableText.includes(t)) continue;
        // ✅ 표 열 헤더 같은 단어는 그냥 제거(구분/대상/비고/휴가일수/첨부서류 등)
const headerWords = new Set(["구분", "대상", "비고", "내용", "휴가일수", "첨부서류", "경조유형"]);
if (headerWords.has((ev.content_text ?? "").trim())) continue;
      }

      out.push(ev);
    }

    return out;
  }, [evidence]);

  const summaryLines = useMemo(() => makeSummary(filtered), [filtered]);

  const fallback =
    data?.summary?.trim() ||
    "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

  const hasEvidence = filtered.length > 0;
  const [open, setOpen] = useState(false);

  if (!hasEvidence) {
    return <div className="text-sm leading-relaxed text-white/90">{fallback}</div>;
  }

  // 근거 파일명 하나만 대표로
  const 대표파일 = filtered[0]?.filename ?? "";

  return (
    <div className="space-y-4">
      {/* 상단: 요약 답변 영역 */}
      <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
        <div className="text-xs text-white/55">
          <span className="font-semibold text-white/70">근거 문서</span>{" "}
          <span className="text-white/70">{대표파일}</span>
        </div>

        <div className="mt-2 space-y-2 text-sm leading-relaxed text-white/90">
          {summaryLines.length ? (
            summaryLines.map((t, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {t}
              </div>
            ))
          ) : (
            <div>{fallback}</div>
          )}
        </div>
      </div>

      {/* 하단: 근거 원문은 “접기/펼치기” */}
      <div className="rounded-2xl bg-white/5 ring-1 ring-white/10">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="text-sm font-semibold text-white/80">근거 원문 보기</div>
          <div className="text-xs text-white/60">{open ? "접기" : "펼치기"}</div>
        </button>

        {open && (
          <div className="border-t border-white/10 px-4 py-4 space-y-3">
            {filtered.map((ev, idx) => {
              const key = `${ev.filename}_${idx}`;

              if (ev.block_type === "p") {
                const text = (ev.content_text ?? "").trim();
                if (!text) return null;

                return (
                  <div key={key} className="rounded-xl bg-white/5 p-3">
                    <div className="mb-1 text-[11px] text-white/45">{ev.filename}</div>
                    <div className="text-sm leading-relaxed text-white/90 whitespace-pre-wrap">
                      {text}
                    </div>
                  </div>
                );
              }

              if (ev.block_type === "table_html") {
                const html = (ev.content_html ?? "").trim();
                if (!html) return null;

                return (
                  <div key={key} className="rounded-xl bg-white/5 p-3">
                    <div className="mb-2 text-[11px] text-white/45">{ev.filename} (표)</div>
                    <div
                      className="overflow-auto rounded-xl bg-white/95 p-2 text-black"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
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
        )}
      </div>

      {/* 관련 질문 버튼 */}
      {Array.isArray(data.related_questions) && data.related_questions.length > 0 ? (
        <div>
          <div className="mb-2 text-xs font-semibold text-white/70">관련 질문</div>
          <div className="flex flex-wrap gap-2">
            {data.related_questions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("suggest", { detail: q }))}
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