"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSessionUser } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const hasError = useMemo(() => Boolean(err), [err]);

  async function onLogin(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading) return; // ✅ 중복 제출 방지
    setErr(null);

    const trimmedName = name.trim();
    const trimmedEmpNo = empNo.trim();

    if (!trimmedName || !trimmedEmpNo) {
      setErr("이름과 사번을 입력해 주세요.");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ empNo: trimmedEmpNo, name: trimmedName }),
      });

      let json: any = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }

      if (!res.ok) {
        setErr(json?.error ?? "로그인에 실패했어요. 이름/사번을 확인해 주세요.");
        return;
      }

      saveSessionUser(json.user);
      router.push("/chat");
      router.refresh();
    } catch {
      setErr("네트워크 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0b1220] via-[#0e1628] to-[#0b1220] text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center px-5 py-10">
        <div className="grid w-full gap-10 lg:grid-cols-2 lg:gap-14">
          {/* Left: Hero */}
          <div className="flex flex-col justify-center">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
                <div className="flex h-full w-full items-center justify-center text-lg font-bold">
                  HR
                </div>
              </div>
              <div>
                <div className="text-sm text-white/60">Covision Internal</div>
                <div className="text-base font-semibold">코비전 HR 규정 챗봇</div>
              </div>
            </div>

            <h1 className="mt-8 text-4xl font-black leading-tight tracking-tight lg:text-5xl">
              규정 문서 기반으로
              <br />
              정확하게 답하는 HR Assistant
            </h1>

            <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/65">
              업로드된 사내 규정/매뉴얼에 근거해 답변합니다. (추론/인터넷 정보 사용
              없음)
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <FeatureCard title="출처 제공" desc="규정 파일/근거 문단을 함께 표시" />
              <FeatureCard title="권한 기반" desc="인사팀 전용 접근 제어" />
              <FeatureCard title="PWA 설치" desc="홈 화면에 추가해 앱처럼 사용" />
              <FeatureCard title="외부 데모" desc="깔끔한 UI로 대외 시연" />
            </div>
          </div>

          {/* Right: Login */}
          <div className="flex items-center justify-center">
            <div className="w-full max-w-md rounded-3xl bg-white/5 p-6 ring-1 ring-white/10 backdrop-blur-xl sm:p-8">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-bold">사내 로그인</div>
                  <div className="mt-1 text-sm text-white/60">
                    이름과 사번으로 인증합니다.
                  </div>
                </div>
                <div className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-300/20">
                  HR Only
                </div>
              </div>

              <form onSubmit={onLogin} className="mt-6 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-white/70">
                    이름
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    autoFocus
                    placeholder="예: 김인호"
                    className={[
                      "mt-2 w-full rounded-2xl bg-white/5 px-4 py-3 text-sm outline-none ring-1 placeholder:text-white/35 focus:ring-2",
                      hasError
                        ? "ring-rose-300/30 focus:ring-rose-400/35"
                        : "ring-white/10 focus:ring-sky-400/35",
                    ].join(" ")}
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-white/70">
                    사번
                  </label>
                  <input
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    autoComplete="off"
                    inputMode="numeric"
                    placeholder="예: 사원번호를 입력하세요"
                    className={[
                      "mt-2 w-full rounded-2xl bg-white/5 px-4 py-3 text-sm outline-none ring-1 placeholder:text-white/35 focus:ring-2",
                      hasError
                        ? "ring-rose-300/30 focus:ring-rose-400/35"
                        : "ring-white/10 focus:ring-sky-400/35",
                    ].join(" ")}
                  />
                </div>

                {err && (
                  <div className="rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-300/15">
                    {err}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="h-[48px] w-full rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 text-sm font-semibold text-white shadow-lg shadow-indigo-500/15 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:brightness-100"
                >
                  {loading ? "로그인 중..." : "로그인"}
                </button>

                <div className="rounded-2xl bg-white/4 p-4 text-xs text-white/60 ring-1 ring-white/10">
                  <div className="font-semibold text-white/75">데모 팁</div>
                  <ul className="mt-2 list-disc space-y-1 pl-4">
                    <li>“경조휴가”, “기타휴가”, “프로젝트 수당” 질문으로 시연</li>
                    <li>답변에 출처/파일명이 함께 보이게 구성</li>
                  </ul>
                </div>

                <div className="text-center text-xs text-white/45">
                  문제가 지속되면 인사팀으로 문의해 주세요.
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs text-white/60">{desc}</div>
    </div>
  );
}
