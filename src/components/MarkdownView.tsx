// src/components/MarkdownView.tsx
"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const styles: Record<string, React.CSSProperties> = {
  root: {
    lineHeight: 1.65,
    whiteSpace: "normal",
    wordBreak: "break-word",
  },

  p: { margin: "8px 0" },
  ul: { margin: "8px 0 8px 18px", padding: 0 },
  ol: { margin: "8px 0 8px 18px", padding: 0 },
  li: { margin: "4px 0" },

  a: { textDecoration: "underline" },

  blockquote: {
    margin: "10px 0",
    padding: "8px 12px",
    borderLeft: "3px solid rgba(255,255,255,0.25)",
    background: "rgba(255,255,255,0.06)",
    borderRadius: 10,
  },

  hr: {
    border: "none",
    borderTop: "1px solid rgba(255,255,255,0.12)",
    margin: "12px 0",
  },

  codeInline: {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    padding: "2px 6px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.10)",
    border: "1px solid rgba(255,255,255,0.12)",
  },

  pre: {
    margin: "10px 0",
    padding: "12px 14px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    overflowX: "auto",
  },

  // ✅ 테이블: 작은 화면에서도 절대 깨지지 않게 "가로 스크롤" + "셀 줄바꿈" 허용
  tableWrap: { overflowX: "auto", margin: "10px 0" },
  table: {
    borderCollapse: "collapse",
    width: "100%",
    minWidth: 520,
    fontSize: 13,
  },
  th: {
    border: "1px solid rgba(255,255,255,0.15)",
    padding: "8px 10px",
    textAlign: "left",
    background: "rgba(255,255,255,0.08)",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  td: {
    border: "1px solid rgba(255,255,255,0.12)",
    padding: "8px 10px",
    verticalAlign: "top",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
};

export default function MarkdownView({ text }: { text: string }) {
  const md = (text ?? "").toString();

  return (
    <div style={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children, ...props }) => (
            <p style={styles.p} {...props}>
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul style={styles.ul} {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol style={styles.ol} {...props}>
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li style={styles.li} {...props}>
              {children}
            </li>
          ),
          a: ({ children, ...props }) => (
            <a style={styles.a} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote style={styles.blockquote} {...props}>
              {children}
            </blockquote>
          ),
          hr: (props) => <hr style={styles.hr} {...props} />,

          // react-markdown v9: inline prop 없음
          code({ children, ...props }) {
            const className = (props as any).className || "";
            const isBlock =
              typeof className === "string" && className.includes("language-");

            if (!isBlock) {
              return (
                <code style={styles.codeInline} {...props}>
                  {children}
                </code>
              );
            }

            return (
              <pre style={styles.pre}>
                <code {...props}>{children}</code>
              </pre>
            );
          },

          table: ({ children, ...props }) => (
            <div style={styles.tableWrap}>
              <table style={styles.table} {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th style={styles.th} {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td style={styles.td} {...props}>
              {children}
            </td>
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}