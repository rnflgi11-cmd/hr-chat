"use client";

export default function AdminNav({
  current,
}: {
  current?: "docs" | "users";
}) {
  const tab = (active: boolean) =>
    [
      "rounded-2xl px-3 py-2 text-xs font-semibold ring-1 transition",
      active
        ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white ring-blue-400/30 shadow-md"
        : "bg-white/6 text-white/80 ring-white/10 hover:bg-white/10",
    ].join(" ");

  return (
    <div className="flex items-center gap-2">
      <a href="/chat" className={tab(false)}>
        채팅
      </a>

      <a href="/admin" className={tab(current === "docs")}>
        문서 관리
      </a>

      <a href="/admin/users" className={tab(current === "users")}>
        사용자 관리
      </a>
    </div>
  );
}
