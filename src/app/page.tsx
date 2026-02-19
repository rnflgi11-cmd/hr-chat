"use client";

import { useMemo, useState } from "react";
import { saveSessionUser } from "@/lib/auth";

export default function LoginPage() {
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    return empNo.trim().length >= 2 && name.trim().length >= 2 && !loading;
  }, [empNo, name, loading]);

  async function onLogin() {
    if (!canSubmit) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), name: name.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? "로그인 실패");
        return;
      }
      saveSessionUser(json.user);
      window.location.href = "/chat";
    } catch {
      setErr("네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-14">
      <div className="grid w-full gap-10 lg:grid-cols-2 lg:gap-14">
        {/* Left: Brand */}
        <div className="flex flex-col justify-center">
          <div className="inline-flex items-center gap-2">
            <div className="h-10 w-10 rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
              <div className="flex h-full w-full items-center justify-center text-lg font-bold">
                HR
              </div>
            </div>
            <div>
              <div className="text-sm text-white/60">Covision Internal</div>
              <div className="text-xl font-semibold tracking-tight">
                코비전 HR 규정 챗봇
              </div>
            </div>
          </div>

          <h1 className="mt-7 text-3xl font-semibold leading-tight tracking-tight lg:text-4xl">
            규정 문서 기반으로
            <br />
            <span className="bg-gradient-to-r from-indigo-300 via-sky-200 to-fuchsia-200 bg-clip-text text-transparent">
              정확하게 답하는 HR Assistant
            </span>
          </h1>

          <p className="mt-4 max-w-xl text-base leading-relaxed text-white/70">
            업로드된 사내 규정/매뉴얼에 근거해 답변합니다. (추론/인터넷 정보 사용
            없음)
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <Feature title="출처 제공" desc="규정 파일/근거 문단을 함께 표시" />
            <Feature title="권한 기반" desc="인사팀 전용 접근 제어" />
            <Feature title="PWA 설치" desc="홈 화면에 추가해 앱처럼 사용" />
            <Feature title="외부 데모" desc="깔끔한 UI로 대외 시연" />
          </div>
        </div>

        {/* Right: Card */}
        <div className="flex items-center justify-center">
          <div className="w-full max-w-md rounded-3xl bg-white/6 p-6 ring-1 ring-white/12 backdrop-blur-xl shadow-2xl shadow-indigo-500/20">

            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">사내 로그인</div>
                <div className="mt-1 text-sm text-white/60">
                  이름과 사번으로 인증합니다.
                </div>
              </div>
              <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200 ring-1 ring-emerald-300/15">
                HR Only
              </span>
            </div>

            <div className="mt-6 space-y-4">
              <Field
                label="이름"
                placeholder="홍길동"
                value={name}
                onChange={setName}
              />
              <Field
                label="사번"
                placeholder="예: 230123"
                value={empNo}
                onChange={setEmpNo}
              />

              {err && (
                <div className="rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-300/15">
                  {err}
                </div>
              )}

              <button
  onClick={onLogin}
  disabled={!canSubmit}
  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/15 transition hover:brightness-110 transition-all duration-300 hover:scale-[1.02] disabled:opacity-50 disabled:hover:brightness-100"
>
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    로그인 중…
                  </>
                ) : (
                  <>로그인</>
                )}
              </button>

              <div className="mt-3 rounded-2xl bg-white/5 p-4 text-xs text-white/60 ring-1 ring-white/10">
                <div className="font-medium text-white/70">데모 팁</div>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>“경조휴가”, “기타휴가”, “프로젝트 수당” 질문으로 시연</li>
                  <li>답변에 출처/파일명이 함께 보이게 구성</li>
                </ul>
              </div>
            </div>

            <div className="mt-6 text-center text-xs text-white/50">
              문제가 계속되면 인사팀으로 문의해 주세요.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-white/60">{desc}</div>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-xs font-medium text-white/70">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35"
      />
    </label>
  );
}
