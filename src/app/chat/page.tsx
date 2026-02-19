"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSessionUser, clearSessionUser } from "@/lib/auth";

type SourceDoc = {
  filename: string;
  open_url?: string;
  chunk_index?: number;
  snippet?: string;
};

type AnswerResponse = {
  answer: string;
  sources?: SourceDoc[];
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  sources?: SourceDoc[];
};

export default function ChatPage() {
  const [me, setMe] = useState<{ empNo: string; name: string } | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "안녕하세요! HR 규정 챗봇입니다.\n\n아래 예시로 질문해 보세요:\n- 경조휴가 며칠이야?\n- 기타휴가 종류 알려줘\n- 프로젝트 수당 기준이 뭐야?\n- 증명서 발급은 어떻게 해?",
    },
  ]);
  const [showSources, setShowSources] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const u = getSessionUser?.();
    if (!u) {
      window.location.href = "/";
      return;
    }
    setMe(u);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, loading]);

  const canSend = useMemo(() => q.trim().length > 0 && !loading, [q, loading]);

  async function send() {
    if (!canSend) return;
    setErr(null);

    const userMsg: Msg = { role: "user", content: q.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setQ("");
    setLoading(true);

    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: userMsg.content,
        }),
      });
      const json: AnswerResponse = await res.json();
      if (!res.ok) throw new Error((json as any)?.error ?? "답변 생성 실패");

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: json.answer ?? "(답변 없음)",
          sources: json.sources ?? [],
        },
      ]);
    } catch (e: any) {
      setErr(e?.message ?? "오류가 발생했습니다.");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "죄송합니다. 현재 답변 생성 중 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onLogout() {
    clearSessionUser?.();
    window.location.href = "/";
  }

  return (
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
            <div className="text-xs text-white/55">
              {me ? `${me.name} (${me.empNo})` : "로그인 확인 중…"} · 접근 권한:{" "}
              <span className="text-emerald-200">HR</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSources((v) => !v)}
            className="rounded-2xl bg-white/6 px-3 py-2 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/10"
          >
            출처 {showSources ? "ON" : "OFF"}
          </button>
          <button
            onClick={onLogout}
            className="rounded-2xl bg-white/6 px-3 py-2 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/10"
          >
            로그아웃
          </button>
        </div>
      </div>

      {/* Install hint */}
      <InstallHint />

      {/* Chat box */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="text-sm font-semibold">대화</div>
          <div className="text-xs text-white/55">
            규정 문서 기반 답변 · 출처 제공
          </div>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-auto px-5 py-5"
        >
          <div className="space-y-4">
            {messages.map((m, idx) => (
              <Bubble key={idx} msg={m} showSources={showSources} />
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-3xl bg-white/6 px-4 py-3 text-sm text-white/80 ring-1 ring-white/10">
                  <div className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
                    답변 생성 중…
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Error */}
        {err && (
          <div className="px-5 pb-3">
            <div className="rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-300/15">
              {err}
            </div>
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-white/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <textarea
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send();
                }}
                placeholder="질문을 입력하세요. (Ctrl/⌘ + Enter로 전송)"
                className="h-[52px] w-full resize-none rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  "경조휴가 며칠이야?",
                  "기타휴가 종류 알려줘",
                  "프로젝트 수당 기준 알려줘",
                  "증명서 발급은 어떻게 해?",
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => setQ(t)}
                    className="rounded-full bg-white/6 px-3 py-1.5 text-xs text-white/75 ring-1 ring-white/10 hover:bg-white/10"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={send}
              disabled={!canSend}
              className="h-[52px] rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/15 transition hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100"
            >
              전송
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 text-center text-xs text-white/45">
        © Covision Internal · HR Policy Assistant
      </div>
    </div>
  );
}

function Bubble({ msg, showSources }: { msg: Msg; showSources: boolean }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] space-y-2">
        <div
          className={[
            "rounded-3xl px-4 py-3 text-sm leading-relaxed ring-1",
            isUser
              ? "bg-gradient-to-r from-indigo-500/90 to-sky-500/90 text-white ring-white/10"
              : "bg-white/6 text-white/90 ring-white/10",
          ].join(" ")}
          style={{ whiteSpace: "pre-wrap" }}
        >
          {msg.content}
        </div>

        {!isUser && showSources && msg.sources && msg.sources.length > 0 && (
          <div className="rounded-2xl bg-white/4 p-3 text-xs text-white/70 ring-1 ring-white/10">
            <div className="mb-2 font-semibold text-white/75">근거(출처)</div>
            <ul className="space-y-1">
              {msg.sources.slice(0, 5).map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-white/6 px-2 py-0.5 ring-1 ring-white/10">
                    {s.filename}
                  </span>
                  {typeof s.chunk_index === "number" && (
                    <span className="text-white/50"># {s.chunk_index}</span>
                  )}
                  {s.open_url && (
                    <a
                      href={s.open_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-200 hover:underline"
                    >
                      열기
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function InstallHint() {
  // 데모용: 과하게 안내하지 않고 “제품 느낌”만 주는 가벼운 배너
  return (
    <div className="mt-4 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">앱처럼 설치해서 사용하기</div>
          <div className="text-xs text-white/60">
            브라우저 메뉴에서 “홈 화면에 추가”를 선택하면 앱처럼 빠르게 사용할 수
            있어요.
          </div>
        </div>
        <div className="text-xs text-white/55">
          Tip: 외부 시연 시 전체화면(PWA)로 열면 더 멋있게 보여요.
        </div>
      </div>
    </div>
  );
}
