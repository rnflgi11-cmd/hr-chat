// src/app/chat/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { clearSessionUser, loadSessionUser } from "@/lib/auth";
import MarkdownView from "@/components/MarkdownView";
import AnswerRenderer from "@/components/AnswerRenderer";

type UserMsg = { role: "user"; content: string; ts: number };

type Evidence = {
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

type AssistantContent = {
  answer: string;
  hits: Evidence[];
  meta?: { intent?: string };
};

type AssistantMsg = { role: "assistant"; ts: number; content: AssistantContent };
type Msg = UserMsg | AssistantMsg;

type AnswerResponse = {
  ok?: boolean;
  answer?: string;
  hits?: Evidence[];
  meta?: { intent?: string };
  error?: string;
};

export default function ChatPage() {
  const user = useMemo(
    () => (typeof window !== "undefined" ? loadSessionUser() : null),
    []
  );

  const [messages, setMessages] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user) window.location.href = "/";
  }, [user]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);

  async function send(textOverride?: string) {
    const text = (textOverride ?? q).trim();
    if (!text || sending || !user) return;

    const next: Msg[] = [
      ...messages,
      { role: "user", content: text, ts: Date.now() },
    ];
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
          {
            role: "assistant",
            ts: Date.now(),
            content: {
              answer: json.error ?? "오류가 발생했어요.",
              hits: [],
              meta: { intent: "오류" },
            },
          },
        ]);
        return;
      }

      setMessages([
        ...next,
        {
          role: "assistant",
          ts: Date.now(),
          content: {
            answer: json.answer ?? "",
            hits: json.hits ?? [],
            meta: json.meta ?? {},
          },
        },
      ]);
    } catch {
      setMessages([
        ...next,
        {
          role: "assistant",
          ts: Date.now(),
          content: {
            answer: "네트워크 오류가 발생했어요.",
            hits: [],
            meta: { intent: "오류" },
          },
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function logout() {
    clearSessionUser();
    window.location.href = "/";
  }

  // suggest 이벤트(유지)
  useEffect(() => {
    function onSuggest(ev: Event) {
      const q = (ev as CustomEvent).detail as string;
      if (typeof q === "string" && q.trim()) send(q);
    }
    window.addEventListener("suggest", onSuggest as any);
    return () => window.removeEventListener("suggest", onSuggest as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sending, user]);

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0b1220] via-[#0e1628] to-[#0b1220] text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
              <div className="flex h-full w-full items-center justify-center text-lg font-bold">
                HR
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">
                코비전 HR 규정 챗봇
              </div>
              <div className="mt-0.5 text-xs text-white/55">
                근거 원문 기반(무료 검색형)
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 rounded-full bg-white/6 px-3 py-2 text-xs text-white/75 ring-1 ring-white/10">
              <span className="text-white/50">👤</span>
              <span className="font-semibold text-white/85">{user.name}</span>
              <span className="text-white/40">·</span>
              <span className="text-white/70">{user.emp_no}</span>
              <span className="text-white/40">·</span>
              <span className="text-emerald-200">{user.role}</span>
            </div>

            {user.role === "admin" && (
              <>
                <a
                  href="/admin"
                  className="rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/10 hover:bg-white/10"
                >
                  문서관리
                </a>
                <a
                  href="/admin/users"
                  className="rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/10 hover:bg-white/10"
                >
                  사용자관리
                </a>
              </>
            )}

            <button
              type="button"
              onClick={logout}
              className="rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold text-white/80 ring-1 ring-white/10 hover:bg-white/10"
            >
              로그아웃
            </button>
          </div>
        </div>

        {/* Install hint */}
        <div className="mt-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">앱처럼 설치해서 사용하기</div>
              <div className="text-xs text-white/60">
                브라우저 메뉴에서 “홈 화면에 추가”를 선택하면 앱처럼 빠르게 사용할 수 있어요.
              </div>
            </div>
            <div className="text-xs text-white/55">
              Tip: 외부 시연 시 전체화면(PWA)로 열면 더 멋있게 보여요.
            </div>
          </div>
        </div>

        {/* Chat shell */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div className="text-sm font-semibold">대화</div>
            <div className="text-xs text-white/55">질문을 입력하면 근거 원문을 함께 보여줘요</div>
          </div>

          {/* Messages */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-5 py-5">
            {messages.length === 0 ? (
              <div className="text-sm text-white/55">
                예: <b className="text-white/85">“화환 신청 절차 알려줘”</b>,{" "}
                <b className="text-white/85">“경조휴가 며칠이야?”</b>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((m, idx) => {
                  const isUser = m.role === "user";
                  return (
                    <div
                      key={(m as any).ts + "_" + idx}
                      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <div className="max-w-[85%] space-y-2">
                        <div
                          className={[
                            "rounded-3xl px-4 py-3 text-sm leading-relaxed ring-1",
                            isUser
                              ? "bg-gradient-to-r from-indigo-500/90 to-sky-500/90 text-white ring-white/10"
                              : "bg-white/6 text-white/90 ring-white/10",
                          ].join(" ")}
                        >
                          {m.role === "assistant" ? (
                            <AnswerRenderer data={m.content} />
                          ) : (
                            <div className="prose prose-invert max-w-none">
                              <MarkdownView text={m.content} />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {sending && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-3xl bg-white/6 px-4 py-3 text-sm text-white/80 ring-1 ring-white/10">
                      <div className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
                        검색 중…
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-white/10 p-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
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
                  className="h-[52px] w-full resize-none rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35"
                />

                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    "화환 신청 절차 알려줘",
                    "경조휴가 며칠이야?",
                    "기타휴가 종류 알려줘",
                    "프로젝트 수당 기준 알려줘",
                    "안식년 기준은?",
                  ].map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => send(t)}
                      className="rounded-full bg-white/6 px-3 py-1.5 text-xs text-white/75 ring-1 ring-white/10 hover:bg-white/10"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => send()}
                disabled={sending}
                className="h-[52px] rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/15 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
              >
                {sending ? "검색 중..." : "전송"}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 text-center text-xs text-white/45">© Covision HR Demo</div>
      </div>
    </div>
  );
}