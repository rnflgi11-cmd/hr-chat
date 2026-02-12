"use client";

import { useEffect, useMemo, useState } from "react";
import { clearSessionUser, loadSessionUser } from "@/lib/auth";

type UserMsg = { role: "user"; content: string; ts: number };

type Chunk = {
  filename: string;
  chunk_index: number;
  content: string;
  sim?: number;
};

type AssistantMsg = {
  role: "assistant";
  ts: number;
  intent?: "A" | "B" | "C";
  chunks?: Chunk[];
  content?: string; // fallback 등
};

type Msg = UserMsg | AssistantMsg;

type AnswerResponse = {
  intent?: "A" | "B" | "C";
  chunks?: Chunk[];
  answer?: string | null;
  diag?: string;
  error?: string;
};

function ChunkCard({ c }: { c: Chunk }) {
  const [open, setOpen] = useState(false);
  const cleaned = (c.content ?? "").replace(/\n{3,}/g, "\n\n").trim();

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 12,
        background: "#fafafa",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div style={{ fontWeight: 900, fontSize: 13, color: "#111827" }}>
          {c.filename} / 조각 {c.chunk_index}
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 999,
            padding: "6px 10px",
            background: "#fff",
            fontWeight: 900,
            fontSize: 12,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {open ? "접기" : "원문 보기"}
        </button>
      </div>

      {!open ? (
        <div style={{ marginTop: 10, fontSize: 13, color: "#6b7280" }}>
          원문은 접혀있어요. 필요할 때 “원문 보기”를 눌러 확인해 주세요.
        </div>
      ) : (
        <pre
          style={{
            marginTop: 10,
            whiteSpace: "pre-wrap",
            lineHeight: 1.55,
            fontSize: 13,
            color: "#111827",
          }}
        >
          {cleaned}
        </pre>
      )}
    </div>
  );
}

export default function ChatPage() {
  const user = useMemo(() => (typeof window !== "undefined" ? loadSessionUser() : null), []);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!user) window.location.href = "/";
  }, [user]);

  async function send() {
    const text = q.trim();
    if (!text || sending || !user) return;

    const next: Msg[] = [...messages, { role: "user", content: text, ts: Date.now() }];
    setMessages(next);
    setQ("");
    setSending(true);

    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, user }),
      });

      const json = (await res.json()) as AnswerResponse;

      if (!res.ok) {
        setMessages([
          ...next,
          { role: "assistant", content: json.error ?? "오류가 발생했어요.", ts: Date.now() },
        ]);
        return;
      }

      const chunks = json.chunks ?? [];
      const fallbackText =
        json.answer ??
        (chunks.length === 0
          ? "죄송합니다. 해당 내용은 현재 규정집에서 확인할 수 없습니다. 정확한 확인을 위해 인사팀([02-6965-3100] 또는 [MS@covision.co.kr])으로 문의해 주시기 바랍니다."
          : "");

      setMessages([
        ...next,
        {
          role: "assistant",
          ts: Date.now(),
          intent: json.intent ?? "C",
          chunks: chunks.length ? chunks : undefined,
          content: chunks.length ? undefined : `분류: 의도 ${json.intent ?? "C"}\n\n${fallbackText}`,
        },
      ]);
    } catch {
      setMessages([...next, { role: "assistant", content: "네트워크 오류가 발생했어요.", ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  }

  function logout() {
    clearSessionUser();
    window.location.href = "/";
  }

  const pageWrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f9fafb 0%, #ffffff 60%, #f9fafb 100%)",
    padding: 16,
  };

  const shell: React.CSSProperties = { maxWidth: 980, margin: "24px auto" };

  const card: React.CSSProperties = {
    border: "1px solid #eef2f7",
    borderRadius: 16,
    background: "#fff",
    boxShadow: "0 10px 30px rgba(0,0,0,0.05)",
  };

  const header: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid #f1f5f9",
  };

  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    fontSize: 12,
    color: "#374151",
    background: "#fff",
    whiteSpace: "nowrap",
  };

  const btn: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 13,
    textDecoration: "none",
    display: "inline-block",
  };

  const primaryBtn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #111827",
    background: "#111827",
    color: "#fff",
    cursor: sending ? "not-allowed" : "pointer",
    fontWeight: 900,
    opacity: sending ? 0.85 : 1,
    whiteSpace: "nowrap",
  };

  const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: "12px 12px",
    outline: "none",
    fontSize: 14,
  };

  const chatArea: React.CSSProperties = {
    padding: 14,
    height: "calc(100vh - 230px)",
    minHeight: 420,
    overflow: "auto",
  };

  const footer: React.CSSProperties = {
    padding: 12,
    borderTop: "1px solid #f1f5f9",
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
  };

  const bubbleBase: React.CSSProperties = {
    maxWidth: "82%",
    padding: "10px 12px",
    borderRadius: 14,
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
    fontSize: 14,
  };

  if (!user) return null;

  return (
    <div style={pageWrap}>
      <div style={shell}>
        <div style={card}>
          <div style={header}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>코비전 HR 규정 챗봇</div>
              <div style={{ marginTop: 4, color: "#6b7280", fontSize: 12 }}>
                근거 원문 기반(무료 검색형)
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={pill}>
                👤 {user.name} · {user.emp_no} · {user.role}
              </div>

              {user.role === "admin" && (
                <a href="/admin" style={btn}>
                  관리자
                </a>
              )}

              <button onClick={logout} style={btn}>
                로그아웃
              </button>
            </div>
          </div>

          <div style={chatArea}>
            {messages.length === 0 ? (
              <div style={{ color: "#6b7280", fontSize: 14 }}>
                예: <b>“화환 신청 절차 알려줘”</b>, <b>“경조휴가 며칠이야?”</b>
              </div>
            ) : (
              messages.map((m, idx) => {
                const isUser = m.role === "user";
                return (
                  <div
                    key={(m as any).ts + "_" + idx}
                    style={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                      margin: "10px 0",
                    }}
                  >
                    <div
                      style={{
                        ...bubbleBase,
                        background: isUser ? "#111827" : "#f3f4f6",
                        color: isUser ? "#fff" : "#111827",
                        border: isUser ? "1px solid #111827" : "1px solid #e5e7eb",
                      }}
                    >
                      {m.role === "assistant" ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontSize: 12, color: "#6b7280" }}>
                            분류: 의도 {(m.intent ?? "C") as string}
                          </div>

                          {m.content && <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>}

                          {m.chunks && m.chunks.length > 0 && (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 900 }}>관련 규정 원문</div>
                              <div style={{ display: "grid", gap: 10 }}>
                                {m.chunks.map((c, i) => (
                                  <ChunkCard key={`${c.filename}-${c.chunk_index}-${i}`} c={c} />
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div style={footer}>
            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="질문을 입력하세요 (Enter 전송 / Shift+Enter 줄바꿈)"
              style={{ ...input, minHeight: 44, height: 44, resize: "none" }}
            />
            <button onClick={send} disabled={sending} style={primaryBtn}>
              {sending ? "검색 중..." : "전송"}
            </button>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "#9ca3af" }}>
          © Covision HR Demo
        </div>
      </div>
    </div>
  );
}
