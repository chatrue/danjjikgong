// src/lib/import_pack.js
// DJJG 단찍공 - 가져오기 파서
// 목표: OCR rawText에서 "단어 | 뜻" 형태만 안정적으로 뽑기
// (제목/날짜/브랜드/언어표기 등은 모두 무시)

function normSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function stripWeird(s) {
  return (s ?? "")
    .replace(/\u200b/g, " ")
    .replace(/\r/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function isGarbageLine(line) {
  const s = normSpace(stripWeird(line));
  if (!s) return true;
  // 너무 짧거나 숫자만
  if (/^\d+$/.test(s)) return true;
  // 구분자가 아예 없으면 일단 버림 (가져오기용 PNG는 구분자가 있어야 함)
  if (!s.includes("|") && !s.includes("｜") && !s.includes("\t")) return true;
  return false;
}

function splitPair(line) {
  let s = normSpace(stripWeird(line));
  if (!s) return null;

  // 다양한 파이프 문자 대응
  s = s.replace(/｜/g, "|");

  // 탭/파이프 기반 우선
  let parts = [];
  if (s.includes("|")) {
    parts = s.split("|").map((x) => normSpace(x));
  } else if (s.includes("\t")) {
    parts = s.split("\t").map((x) => normSpace(x));
  }

  if (parts.length < 2) return null;

  const term = parts[0] ?? "";
  const meaning = parts.slice(1).join(" | ").trim();

  if (!term && !meaning) return null;

  // 너무 이상한 라인은 제외(예: term이 1글자 이하이면서 meaning도 짧은 경우 등)
  if (term.length <= 1 && meaning.length <= 1) return null;

  return { term, meaning };
}

// ✅ 외부에서 쓰는 함수
export function parseDJJGTextBlock(rawText) {
  const text = (rawText ?? "").toString();
  const lines = text.split("\n");

  const items = [];
  for (const line of lines) {
    if (isGarbageLine(line)) continue;
    const pair = splitPair(line);
    if (!pair) continue;

    // term/meaning 둘 다 공백 제거
    const term = normSpace(pair.term);
    const meaning = normSpace(pair.meaning);

    if (!term || !meaning) continue;
    items.push({ term, meaning });
  }

  // 중복 제거(단어 기준)
  const map = new Map();
  for (const it of items) {
    const key = it.term.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, it);
  }

  return {
    title: "", // 일부러 비움(불필요한 텍스트는 오류 유발 가능)
    items: Array.from(map.values()),
  };
}
