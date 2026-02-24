"use client";

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string;
  content_html?: string;
};

export default function AnswerRenderer({ data }: { data: any }) {
  const evidence: Evidence[] = data?.evidence ?? [];

  return (
    <div className="grid gap-3">
      {/* 요약 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white">
        <div className="text-sm font-semibold text-white/85">안내</div>
        <div className="mt-2 text-sm leading-6 text-white/90">{data?.summary}</div>
      </div>

      {/* 근거 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white">
        <div className="text-sm font-semibold text-white/85">근거(규정 원문)</div>

        <div className="mt-3 grid gap-3">
          {evidence.map((e, i) => (
            <div key={i} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-xs font-bold text-white/80">{e.filename}</div>

              {e.block_type === "table_html" && e.content_html ? (
                <div className="overflow-x-auto">
                  <div
                    className="prose prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: e.content_html }}
                  />
                </div>
              ) : (
                <pre className="m-0 whitespace-pre-wrap text-sm leading-6 text-white/90">
                  {e.content_text ?? ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 관련 질문 */}
      <div className="flex flex-wrap gap-2">
        {(data?.related_questions ?? []).map((q: string, i: number) => (
          <button
            key={i}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/85 hover:bg-white/10"
            onClick={() => {
              const ev = new CustomEvent("suggest", { detail: q });
              window.dispatchEvent(ev);
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}