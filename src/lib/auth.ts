// src/lib/auth.ts
export type SessionUser = {
  role: string;
  empNo: string;
  name: string;
  // 필요하면 role 같은 것도 나중에 추가 가능
  // role?: "HR" | "EMP";
};

const KEY = "hrgpt_session_user";

export function saveSessionUser(user: SessionUser) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(user));
}

export function getSessionUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function clearSessionUser() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}
