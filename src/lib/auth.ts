export type SessionUser = {
  id: string;
  emp_no: string;
  name: string;
  role: "user" | "admin";
};

const KEY = "covision_hr_session_user";

export function saveSessionUser(u: SessionUser) {
  localStorage.setItem(KEY, JSON.stringify(u));
}

export function loadSessionUser(): SessionUser | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function clearSessionUser() {
  localStorage.removeItem(KEY);
}
