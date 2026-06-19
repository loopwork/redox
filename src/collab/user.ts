// Local user identity, persisted in localStorage and broadcast via Yjs awareness
// so collaborators see a named, colored cursor.

const USER_KEY = "redox-user";
const USER_COLORS = [
  "#f97316",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#eab308",
];

export interface LocalUser {
  name: string;
  color: string;
}

export function getLocalUser(): LocalUser {
  const raw = window.localStorage.getItem(USER_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LocalUser;
    } catch {
      /* fall through and regenerate */
    }
  }
  const n = Math.floor(Math.random() * 1000);
  const user: LocalUser = {
    name: `User ${n}`,
    color: USER_COLORS[n % USER_COLORS.length],
  };
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}
