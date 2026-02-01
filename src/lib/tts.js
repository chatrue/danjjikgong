// src/lib/tts.js
// DJJG 단찍공 - 다국어 TTS
// - Web Speech API 기반 (브라우저 지원 범위 내)
// - 언어코드 예: "en-US", "ko-KR", "es-ES"

let currentUtter = null;

export function stopSpeak() {
  try {
    window.speechSynthesis?.cancel();
  } catch {}
  currentUtter = null;
}

export function speakText(text, lang = "en-US") {
  const t = (text ?? "").toString().trim();
  if (!t) return;

  stopSpeak();

  const u = new SpeechSynthesisUtterance(t);
  u.lang = lang;
  u.rate = 1; // ✅ 속도 버튼 없음 (요구사항)
  u.pitch = 1;

  currentUtter = u;
  try {
    window.speechSynthesis?.speak(u);
  } catch {}
}

// 기존 호환용
export function speakEN(text) {
  return speakText(text, "en-US");
}
