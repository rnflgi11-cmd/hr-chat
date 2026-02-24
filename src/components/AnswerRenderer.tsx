"use client";

import React from "react";
import MarkdownView from "@/components/MarkdownView";

type Block = {
  filename?: string;
  kind: "heading" | "paragraph" | "table" | string;
  text?: string | null;
  table_html?: string | null;
  block_index?: number;
};

type AnswerData =
  | {
      blocks?: Block[];
      message?: string;
      meta?: any;
    }
  | any;

function safeText(s: any) {
  return (s ?? "").toString();
}

/** 매우 간단한 HTML sanitize: script/iframe 제거 정도만 */
function sanitizeTableHtml(html: string) {
  const x = html ?? "";
  return x
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "");
}

export default function AnswerRenderer({ data }: { data: AnswerData }) {
  const blocks: Block[] = Array.isArray(data?.blocks) ? data.blocks : [];
  const message = safeText(data?.message);

  // 1) blocks가 없으면 message(또는 기본 폴백) 출력
  if (!blocks.length) {
    const text =
      message ||
      "죄송합니다. 업로드된 규정 문서에서 관련 내용을 찾지 못했습니다. 키워드를 바꿔서 다시 질문해 주세요.";

    return (
      <div className="prose prose-invert max-w-none">
        <MarkdownView text={text} />
      </div>
    );
  }

  // 2) 파일명 표시(있으면)
  const filename = blocks.find((b) => b.filename)?.filename;

  return (
    <div className="space-y-3">
      {filename && (
        <div className="text-xs text-white/60">
          근거 문서: <span className="font-semibold text-white/80">{filename}</span>
        </div>
      )}

      <div className="space-y-3">
        {blocks.map((b, idx) => {
          const kind = (b.kind ?? "").toString();
          const text = b.text ?? "";
          const tableHtml = b.table_html ?? "";

          // heading
          if (kind === "heading") {
            return (
              <div
                key={(b.block_index ?? idx) + "_h"}
                className="text-sm font-semibold text-white/90"
              >
                {text}
              </div>
            );
          }

          // table (table_html 우선)
          if (kind === "table" && tableHtml) {
            return (
              <div
                key={(b.block_index ?? idx) + "_t"}
                className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10 overflow-auto"
              >
                <div
                  className="prose prose-invert max-w-none prose-table:my-0 prose-table:w-full"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: sanitizeTableHtml(tableHtml) }}
                />
              </div>
            );
          }

          // paragraph (기본)
          if (text) {
            return (
              <div
                key={(b.block_index ?? idx) + "_p"}
                className="prose prose-invert max-w-none"
              >
                <MarkdownView text={text} />
              </div>
            );
          }

          return null;
        })}
      </div>

      {/* 관련 질문(suggest) 기능이 필요하면 여기서 버튼을 만들 수 있음
          지금은 LLM 없음이라 meta에서 추천 질문을 생성하지 않으니 생략 */}
    </div>
  );
}