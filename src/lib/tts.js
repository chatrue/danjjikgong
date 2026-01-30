export function stopSpeak() {
  try { window.speechSynthesis?.cancel(); } catch {}
}

export function speakEN(text) {
  if (!text?.trim()) return;
  stopSpeak();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.9; // 너무 빠르지 않게
  window.speechSynthesis.speak(u);
}
