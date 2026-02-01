// src/lib/store.js
// State schema v2 (DJJG 단찍공)
// - settings: { premium:boolean, pair:string }
// - sets: [{id,title,createdAt,items:[{term,meaning}], meta?}]

const KEY = "djjg_state_v2";

export function uid() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

export function defaultState() {
  return {
    settings: {
      premium: false,      // ✅ 평생 프리미엄(결제 연동 전: 토글 방식)
      pair: "en-ko",       // ✅ 기본: 영어 → 한국어
    },
    sets: [],
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);

    // migrate / validate lightly
    const st = defaultState();
    if (parsed && typeof parsed === "object") {
      if (parsed.settings && typeof parsed.settings === "object") {
        st.settings.premium = !!parsed.settings.premium;
        st.settings.pair = typeof parsed.settings.pair === "string" ? parsed.settings.pair : st.settings.pair;
      }
      if (Array.isArray(parsed.sets)) {
        st.sets = parsed.sets;
      }
    }
    return st;
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}
