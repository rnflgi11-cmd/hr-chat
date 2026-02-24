"use client";

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string;
  content_html?: string;
};

export default function AnswerRenderer({ data }: { data: any }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>안내</div>
        <div>{data?.summary}</div>
      </div>

      <div style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>근거(규정)</div>

        <div style={{ display: "grid", gap: 10 }}>
          {(data?.evidence ?? []).map((e: Evidence, i: number) => (
            <div key={i} style={{ border: "1px solid #f3f4f6", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>{e.filename}</div>

              {e.block_type === "table_html" && e.content_html ? (
                <div style={{ overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: e.content_html }} />
              ) : (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {e.content_text ?? ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}