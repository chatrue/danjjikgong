export function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export function nowTitle() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 단어장`;
}

const KEY = "dantjickgong_v1";

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { sets: [] };
    const parsed = JSON.parse(raw);
    if (!parsed?.sets) return { sets: [] };
    return parsed;
  } catch {
    return { sets: [] };
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}
