"use client";

import Link from "next/link";

type Current = "chat" | "docs" | "users";

export default function AdminNav({ current }: { current: Current }) {
  function navClass(key: Current) {
    const isActive = current === key;

    return `relative px-4 py-2 rounded-xl transition-all duration-200
    ${
      isActive
        ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg scale-[1.03]"
        : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
    }`;
  }

  return (
    <div className="flex gap-3">
      <Link href="/admin" className={navClass("chat")}>
        채팅
      </Link>

      <Link href="/admin/users" className={navClass("users")}>
        사용자 관리
      </Link>

      <Link href="/admin/docs" className={navClass("docs")}>
        문서 관리
      </Link>
    </div>
  );
}
