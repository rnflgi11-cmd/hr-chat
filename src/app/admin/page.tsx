"use client";

import AdminNav from "@/components/AdminNav";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSessionUser } from "@/lib/auth";

type Doc = {
  id: string;
  filename: string;
  created_at: string;
  content_type: string | null;
  size_bytes: number | null;
  open_url?: string | null;
  can_preview?: boolean;
};

type UploadProgressItem = {
  filename: string;
  status: "pending" | "uploading" | "done" | "failed";
  error?: string;
};

export default function AdminPage() {
  const user = useMemo(
    () => (typeof window !== "undefined" ? loadSessionUser() : null),
    []
  );

  const [docs, setDocs] = useState<Doc[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressItem[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ✅ 체크박스 선택 상태
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  useEffect(() => {
    if (!user) {
      window.location.href = "/";
      return;
    }
    if (user.role !== "admin") {
      window.location.href = "/chat";
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch("/api/admin/docs");
    const json = await res.json();
    const nextDocs: Doc[] = json.docs ?? [];
    setDocs(nextDocs);

    // ✅ 문서 목록 갱신 시, 존재하지 않는 id 선택 제거
    setSelected((prev) => {
      const idSet = new Set(nextDocs.map((d) => d.id));
      const next: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (v && idSet.has(id)) next[id] = true;
      }
      return next;
    });
  }

  async function upload() {
    if (!files || files.length === 0) {
      setMsg("파일을 선택해 주세요.");
      return;
    }
    
    setBusy(true);
    setUploadProgress(files.map((f) => ({ filename: f.name, status: "pending" })));
    setMsg(`업로드 중... (0/${files.length})`);

    let okCount = 0;
    const failItems: Array<{ filename: string; error: string }> = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress((prev) =>
          prev.map((it, idx) => (idx === i ? { ...it, status: "uploading" } : it))
        );
        setMsg(`업로드 중... (${i + 1}/${files.length}) ${file.name}`);

        const form = new FormData();
        form.append("files", file);
        form.append("user", JSON.stringify(user));

        const res = await fetch("/api/admin/upload", {
          method: "POST",
          body: form,
        });
        const json = await res.json();

        if (!res.ok) {
          const error = (json?.error ?? "업로드 실패").toString();
          failItems.push({ filename: file.name, error });
          setUploadProgress((prev) =>
            prev.map((it, idx) => (idx === i ? { ...it, status: "failed", error } : it))
          );
          continue;
        }

        const r0 = Array.isArray(json?.results) ? json.results[0] : null;
        const ok = !!r0?.ok;

        if (ok) {
          okCount += 1;
          setUploadProgress((prev) =>
            prev.map((it, idx) => (idx === i ? { ...it, status: "done" } : it))
          );
        } else {
          const error = (r0?.error ?? "업로드 실패").toString();
          failItems.push({ filename: file.name, error });
          setUploadProgress((prev) =>
            prev.map((it, idx) => (idx === i ? { ...it, status: "failed", error } : it))
          );
        }
      }

      if (failItems.length > 0) {
        const lines = failItems
          .slice(0, 5)
          .map((r) => `- ${r.filename}: ${r.error}`)
          .join("\n");

        setMsg(
          `부분 실패: 성공 ${okCount} / 실패 ${failItems.length}\n` +
            lines +
            (failItems.length > 5 ? `\n...외 ${failItems.length - 5}건` : "")
        );
      } else {
        setMsg(`업로드 완료! (${okCount}개)`);
      }

      await refresh();
    } finally {
      setBusy(false);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }


  async function suggestQuestions(doc: Doc) {
    try {
      setBusy(true);
      setMsg("문서 분석 중...");
      setSuggestions([]);

      const res = await fetch(`/api/admin/docs?docId=${encodeURIComponent(doc.id)}&suggestCases=1`);
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "문서 분석 실패");
        return;
      }

      const items = Array.isArray(json.suggested_questions)
        ? json.suggested_questions.map((x: unknown) => String(x)).filter(Boolean)
        : [];

      if (!items.length) {
        setMsg("추천 질문을 생성하지 못했습니다.");
        return;
      }

      setSuggestions(items);
      setMsg(`추천 질문 생성 완료: ${doc.filename}`);
    } catch {
      setMsg("추천 질문 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function copySuggestedPrompt() {
    if (!suggestions.length) {
      setMsg("먼저 문서에서 질문 추천을 생성해 주세요.");
      return;
    }

    const content = [
      "[추천 질문 케이스]",
      ...suggestions.map((q, i) => `${i + 1}. ${q}`),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(content);
      setMsg("추천 질문 템플릿을 복사했습니다.");
    } catch {
      setMsg("추천 질문 복사에 실패했습니다.");
    }
  }

  async function copySource(doc: Doc) {
    try {
      setBusy(true);
      setMsg("원문 불러오는 중...");

      const res = await fetch(`/api/admin/docs?docId=${encodeURIComponent(doc.id)}`);
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "원문 불러오기 실패");
        return;
      }

      const text = (json.markdown ?? "").toString();
      if (!text.trim()) {
        setMsg("복사할 원문이 없습니다.");
        return;
      }

      await navigator.clipboard.writeText(text);
      setMsg(`원문 복사 완료: ${doc.filename} (${json.block_count ?? 0} 블록)`);
    } catch {
      setMsg("복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }


  async function removeDoc(docId: string) {
    if (!confirm("정말 삭제할까요? (스토리지/DB에서 삭제됩니다)")) return;

    setBusy(true);
    setMsg("삭제 중...");

    try {
      const res = await fetch("/api/admin/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, user }),
      });
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "삭제 실패");
        return;
      }

      // ✅ 선택 상태에서도 제거
      setSelected((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });

      setMsg("삭제 완료!");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // ✅ 전체 선택/해제(현재 필터 결과 기준)
  function selectAll(list: Doc[]) {
    setSelected((prev) => {
      const next = { ...prev };
      list.forEach((d) => (next[d.id] = true));
      return next;
    });
  }

  function clearAll(list: Doc[]) {
    setSelected((prev) => {
      const next = { ...prev };
      list.forEach((d) => delete next[d.id]);
      return next;
    });
  }

  // ✅ 선택 일괄 삭제
  async function removeSelected(ids: string[]) {
    if (ids.length === 0) return;
    if (
      !confirm(
        `선택한 ${ids.length}개 문서를 삭제할까요?\n(스토리지 + DB(chunks 포함)에서 삭제)`
      )
    )
      return;

    setBusy(true);
    setMsg("선택 문서 삭제 중...");

    try {
      const res = await fetch("/api/admin/delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, user }),
      });
      const json = await res.json();

      if (!res.ok) {
        setMsg(json.error ?? "삭제 실패");
        return;
      }

      const extra = json.storage_error
        ? ` (storage 일부 실패: ${json.storage_error})`
        : "";
      setMsg(
        `삭제 완료! 문서 ${json.deleted_documents ?? ids.length}건${extra}`
      );
      setSelected({});
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return docs;
    return docs.filter((d) => d.filename.toLowerCase().includes(t));
  }, [docs, q]);

  if (!user) return null;

  const btnBase =
    "rounded-2xl bg-white/6 px-3 py-2 text-xs font-semibold ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-white/6";
  const btnDanger =
    "rounded-2xl bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200 ring-1 ring-rose-300/15 hover:bg-rose-500/15 disabled:opacity-50";
  const btnPrimary =
    "rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-500/15 hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100";
  const inputClass =
    "w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-2 focus:ring-sky-400/35";

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
                관리자 · 문서 업로드
              </div>
              <div className="mt-0.5 text-xs text-white/55">
                👤 {user.name} ({user.emp_no}) · 권한:{" "}
                <span className="text-emerald-200">{user.role}</span>
              </div>
            </div>
          </div>

          {/* ✅ 기존 AdminNav 유지 */}
          <AdminNav current="docs" />
        </div>

        {/* Card 1: Upload */}
        <div className="mt-4 rounded-3xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">파일 업로드</div>
              <div className="mt-1 text-xs text-white/55">
                DOCX 업로드 후 자동 분할·저장됩니다.
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                const next = Array.from(e.target.files ?? []);
                setFiles(next);
                setUploadProgress(next.map((f) => ({ filename: f.name, status: "pending" })));
              }}
              disabled={busy}
              className="block w-full rounded-2xl bg-white/5 px-4 py-3 text-sm text-white/80 ring-1 ring-white/10 file:mr-4 file:rounded-xl file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white/80 hover:file:bg-white/15"
            />
            <button onClick={upload} disabled={busy} className={btnPrimary}>
              {busy ? "처리 중..." : "업로드"}
            </button>
          </div>

          {uploadProgress.length > 0 && (
            <div className="mt-3 space-y-1 rounded-2xl bg-white/4 p-3 ring-1 ring-white/10">
              {uploadProgress.map((u, idx) => (
                <div key={`${u.filename}_${idx}`} className="flex items-center justify-between text-xs text-white/75">
                  <span className="truncate pr-2">{u.filename}</span>
                  <span>
                    {u.status === "pending" && "대기"}
                    {u.status === "uploading" && "업로드 중"}
                    {u.status === "done" && "완료"}
                    {u.status === "failed" && `실패${u.error ? `: ${u.error}` : ""}`}
                  </span>
                </div>
              ))}
            </div>
          )}


          {suggestions.length > 0 && (
            <div className="mt-4 rounded-2xl bg-white/4 p-3 ring-1 ring-white/10">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-amber-100">문서 자동 추천 질문</div>
                <button
                  type="button"
                  onClick={copySuggestedPrompt}
                  className="text-xs font-semibold text-amber-200 hover:underline"
                >
                  템플릿 복사
                </button>
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-white/80">
                {suggestions.map((item, idx) => (
                  <li key={`${item}_${idx}`}>{item}</li>
                ))}
              </ol>
            </div>
          )}

          {msg && (
            <div className="mt-4 rounded-2xl bg-white/6 p-3 text-sm text-white/80 ring-1 ring-white/10">
              {msg}
            </div>
          )}
        </div>

        {/* Card 2: List */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur">
          <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">업로드된 문서</div>
              <div className="mt-1 text-xs text-white/55">
                열기는 PDF/DOCX/이미지 권장 · 한글 파일명도 정상 동작
              </div>
            </div>

            <div className="w-full sm:w-[320px]">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="파일명 검색…"
                className={inputClass}
              />
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <button
              onClick={() => selectAll(filtered)}
              disabled={busy || filtered.length === 0}
              className={btnBase}
            >
              전체 선택(검색결과)
            </button>
            <button
              onClick={() => clearAll(filtered)}
              disabled={busy || filtered.length === 0}
              className={btnBase}
            >
              선택 해제(검색결과)
            </button>
            <button
              onClick={() => removeSelected(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              className={btnDanger}
            >
              선택 삭제 ({selectedIds.length})
            </button>
          </div>

          {/* List */}
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
            {filtered.length === 0 ? (
              <div className="py-6 text-sm text-white/55">문서가 없습니다.</div>
            ) : (
              <div className="divide-y divide-white/10">
                {filtered.map((d) => (
                  <div
                    key={d.id}
                    className="grid grid-cols-[28px_1fr_auto] gap-3 py-4"
                  >
                    <div className="pt-1">
                      <input
                        type="checkbox"
                        checked={!!selected[d.id]}
                        onChange={(e) =>
                          setSelected((prev) => ({
                            ...prev,
                            [d.id]: e.target.checked,
                          }))
                        }
                        disabled={busy}
                        className="h-4 w-4 accent-sky-400"
                      />
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate font-semibold text-white/90">
                          {d.filename}
                        </div>
                        {d.open_url && (
                          <a
                            href={d.open_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-semibold text-sky-200 hover:underline"
                          >
                            열기
                          </a>
                        )}
                                                <button
                          type="button"
                          onClick={() => copySource(d)}
                          disabled={busy}
                          className="text-xs font-semibold text-emerald-200 hover:underline disabled:opacity-50"
                        >
                          원문 복사
                        </button>
                        <button
                          type="button"
                          onClick={() => suggestQuestions(d)}
                          disabled={busy}
                          className="text-xs font-semibold text-amber-200 hover:underline disabled:opacity-50"
                        >
                          질문 추천
                        </button>
                      </div>

                      <div className="mt-2 text-xs text-white/50">
                        {new Date(d.created_at).toLocaleString()} ·{" "}
                        {d.content_type ?? "-"} ·{" "}
                        {d.size_bytes
                          ? `${d.size_bytes.toLocaleString()} bytes`
                          : "-"}
                      </div>
                    </div>

                    <div className="flex items-start justify-end">
                      <button
                        onClick={() => removeDoc(d.id)}
                        disabled={busy}
                        className={btnDanger}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 text-xs text-white/45">
              Tip) 데모에서는 문서 수가 많아지면 목록을 “최근 50개”로 제한하는 것도 좋아요.
            </div>
          </div>
        </div>

        <div className="mt-4 text-center text-xs text-white/45">
          © Covision HR
        </div>
      </div>
    </div>
  );
}
