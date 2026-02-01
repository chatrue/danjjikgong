// src/lib/ocr_extract.js
// DJJG 단찍공 OCR + 추출
// 1) Tesseract 실행
// 2) (우선) 2컬럼(표) 좌표 기반 추출 시도
// 3) 결과가 너무 적으면 기존 텍스트 기반 추출로 fallback

import { extractPairsFromTwoColumnTable } from "./ocr_table_extract.js";

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function stripOuterPunct(s) {
  return (s ?? "")
    .trim()
    .replace(/^[\s"'“”‘’`~!@#$%^&*(){}\[\]<>+=|\\/:;,.?-]+/, "")
    .replace(/[\s"'“”‘’`~!@#$%^&*(){}\[\]<>+=|\\/:;,.?-]+$/, "")
    .trim();
}

function removeParenthesesAndBrackets(s) {
  return (s ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKorean(s) {
  return /[가-힣]/.test(s ?? "");
}
function hasEnglish(s) {
  return /[A-Za-z]/.test(s ?? "");
}

function englishRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[A-Za-z]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}
function koreanRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[가-힣]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}

// ----------------- EN cleanup -----------------

function stripTrailingPOSToken(term) {
  let t = normSpace(term);

  t = t.replace(
    /\s+(a|an|n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\s*$/i,
    ""
  );
  t = t.replace(/\s+(a|n|v)\s*\.\s*$/i, "");
  return t.trim();
}

function normalizeTermCase(term) {
  const t = normSpace(term);
  if (!t) return t;

  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t;
  if (t === "I") return t;
  return t.toLowerCase();
}

function normalizeENKeepPhrase(s) {
  let x = (s ?? "").trim();
  x = x.replace(/[’']/g, "'");

  x = x.replace(/\[[^\]]+\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");
  x = x.replace(/[*•·]+/g, " ");

  x = x.replace(/[^A-Za-z\s'\-]/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  x = stripTrailingPOSToken(x);
  x = normalizeTermCase(x);

  return x;
}

function isLikelyEnglishTerm(token) {
  const t = normalizeENKeepPhrase(token);
  if (!t) return false;

  const len = t.length;
  if (len < 2 || len > 60) return false;
  if (englishRatio(t) < 0.6) return false;

  if (len === 1 && !/^(a|i)$/i.test(t)) return false;
  if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;

  const hy = (t.match(/\-/g) || []).length;
  if (hy >= 4) return false;

  return true;
}

// ----------------- KO cleanup + spacing fix -----------------

function fixKoreanSyllableSpacing(s) {
  const text = normSpace(s);
  if (!text) return text;

  const tokens = text.split(" ");
  const out = [];
  let i = 0;

  const isHangulOnly = (t) => /^[가-힣]+$/.test(t);
  const isShortHangul = (t) => isHangulOnly(t) && t.length <= 2;

  while (i < tokens.length) {
    const t = tokens[i];

    if (isShortHangul(t)) {
      let j = i;
      let merged = tokens[i];
      let runLen = 1;

      while (j + 1 < tokens.length && isShortHangul(tokens[j + 1])) {
        if (merged.length + tokens[j + 1].length > 10) break;
        merged += tokens[j + 1];
        j++;
        runLen++;
        if (runLen >= 6) break;
      }

      if (runLen >= 2) out.push(merged);
      else out.push(t);

      i = j + 1;
      continue;
    }

    out.push(t);
    i++;
  }

  return out.join(" ");
}

function normalizeKO(s) {
  let x = (s ?? "").trim();

  x = x.replace(/\b(n|v|adj|adv|prep|conj|pron|det|num)\.\b/gi, " ");
  x = x.replace(/\b(명|동|형|부|전|접|대|관)\b/g, " ");

  x = x.replace(/^[\s•·\-–—~]*\d+[\.\)]\s*/g, "");
  x = x.replace(/^[\s•·\-–—~]+/g, "");

  // "dobj =" 같은 잡영문 제거(앞부분)
  x = x.replace(/^\s*[A-Za-z]{2,12}\s*[:=]\s*/g, "");

  x = x.replace(/[*•·]+/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  x = fixKoreanSyllableSpacing(x);
  return x;
}

function isLikelyKoreanMeaning(token) {
  const t = normalizeKO(token);
  if (!t) return false;
  if (koreanRatio(t) < 0.25) return false;
  if (t.length > 80) return false;
  return true;
}

function looksLikePageOrUnit(line) {
  const s = (line ?? "").trim();
  if (!s) return true;

  if (/^\d+$/.test(s)) return true;
  if (/^p\.?\s*\d+$/i.test(s)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(s)) return true;
  if (/^unit\s*\d+/i.test(s)) return true;
  if (/^lesson\s*\d+/i.test(s)) return true;
  if (/^day\s*\d+/i.test(s)) return true;
  if (/^chapter\s*\d+/i.test(s)) return true;

  const sym = (s.match(/[^A-Za-z0-9가-힣\s]/g) || []).length;
  if (sym >= 6 && s.length <= 20) return true;

  return false;
}

function looksLikeExampleSentence(line) {
  const s = (line ?? "").trim();
  if (!s) return false;

  if (hasKorean(s) && s.length >= 45) return true;
  if (hasEnglish(s) && s.length >= 55 && /[.!?]/.test(s) && /\s/.test(s)) return true;

  if (/^(예문|ex\)|e\.g\.|예:)\b/i.test(s)) return true;
  return false;
}

function cleanLine(raw) {
  let s = raw ?? "";
  s = s.replace(/\u200b/g, " ");
  s = s.replace(/\t/g, " ");
  s = s.replace(/•/g, " ");
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = normSpace(s);
  s = s.replace(/^[\s\-–—•·]+/g, "").trim();
  return s;
}

function stripLeadingIndex(line) {
  let s = (line ?? "").trim();
  s = s.replace(/^\(?\d+\)?[\.\)]\s*/g, "");
  s = s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/g, "");
  s = s.replace(/^[가-힣]\)\s*/g, "");
  return s.trim();
}

function trySplitOneLine(line) {
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;

  if (!hasEnglish(s0) || !hasKorean(s0)) return null;
  if (looksLikeExampleSentence(s0)) return null;

  const strongSep = ["→", "=>", "=", ":", " - ", " – ", " — "];
  for (const sep of strongSep) {
    if (s0.includes(sep)) {
      const parts = s0.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(" ").trim();
        const en = normalizeENKeepPhrase(removeParenthesesAndBrackets(left));
        const ko = normalizeKO(removeParenthesesAndBrackets(right));
        if (isLikelyEnglishTerm(en) && isLikelyKoreanMeaning(ko)) {
          return { term: en, meaning: ko };
        }
      }
    }
  }

  const idx = s0.search(/[가-힣]/);
  if (idx > 0) {
    const left = s0.slice(0, idx).trim();
    const right = s0.slice(idx).trim();

    const en = normalizeENKeepPhrase(removeParenthesesAndBrackets(left));
    const ko = normalizeKO(removeParenthesesAndBrackets(right));

    if (isLikelyEnglishTerm(en) && isLikelyKoreanMeaning(ko)) {
      return { term: en, meaning: ko };
    }
  }

  return null;
}

function parseLinesToPairs(lines) {
  const cleaned = [];

  for (const raw of lines) {
    let s = cleanLine(raw);
    if (!s) continue;

    s = stripLeadingIndex(s);
    if (!s) continue;

    if (looksLikePageOrUnit(s)) continue;
    if (looksLikeExampleSentence(s)) continue;

    const sym = (s.match(/[^A-Za-z0-9가-힣\s'"\-]/g) || []).length;
    if (sym >= 10 && s.length <= 35) continue;

    cleaned.push(s);
  }

  const pairs = [];
  const used = new Array(cleaned.length).fill(false);

  for (let i = 0; i < cleaned.length; i++) {
    const one = trySplitOneLine(cleaned[i]);
    if (one) {
      pairs.push(one);
      used[i] = true;
    }
  }

  for (let i = 0; i < cleaned.length; i++) {
    if (used[i]) continue;
    const a = cleaned[i];

    const enCand = normalizeENKeepPhrase(removeParenthesesAndBrackets(a));
    if (!isLikelyEnglishTerm(enCand)) continue;
    if (hasKorean(a)) continue;

    let j = i + 1;
    while (j < cleaned.length && used[j]) j++;

    if (j < cleaned.length) {
      const b = cleaned[j];
      const koCand = normalizeKO(removeParenthesesAndBrackets(b));

      if (isLikelyKoreanMeaning(koCand) && hasKorean(b)) {
        pairs.push({ term: enCand, meaning: koCand });
        used[i] = true;
        used[j] = true;
      }
    }
  }

  return { pairs, cleanedLines: cleaned };
}

function mergePairs(pairs) {
  const map = new Map();

  for (const p of pairs) {
    const term = normalizeENKeepPhrase(stripOuterPunct(p.term));
    const meaning = normalizeKO(stripOuterPunct(p.meaning));

    if (!term || !meaning) continue;
    if (!isLikelyEnglishTerm(term)) continue;
    if (!isLikelyKoreanMeaning(meaning)) continue;

    const key = term.trim().toLowerCase().replace(/\s+/g, " ");
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { term, meaning });
      continue;
    }

    const existParts = existing.meaning.split(" / ").map((x) => normalizeKO(x)).filter(Boolean);
    const newParts = meaning
      .split(/[\/,;·=]/g)
      .map((x) => normalizeKO(x))
      .filter(Boolean);

    const seen = new Set(existParts.map((x) => x.toLowerCase()));
    for (const np of newParts) {
      const k = np.toLowerCase();
      if (!seen.has(k)) {
        existParts.push(np);
        seen.add(k);
      }
    }
    existing.meaning = existParts.join(" / ");
  }

  return Array.from(map.values());
}

function computeDebug(data, chosen, items) {
  const wordsCount = Array.isArray(data?.words) ? data.words.length : 0;
  const textLen = (data?.text ?? "").length;
  return {
    extractor: chosen,      // "table" or "text"
    wordsCount,
    textLen,
    itemCount: items.length,
  };
}

export async function runOCRAndExtract(file, onProgress) {
  const report = (status, p) => {
    if (typeof onProgress === "function") onProgress(status, clamp01(p));
  };

  report("OCR 모듈 로딩중...", 0.03);

  let Tesseract;
  try {
    const mod = await import("tesseract.js");
    Tesseract = mod.default || mod;
  } catch (e) {
    console.error(e);
    throw new Error("tesseract.js를 불러올 수 없어요. (npm i tesseract.js 설치 확인)");
  }

  report("OCR 실행중...", 0.06);

  let data;
  try {
    const result = await Tesseract.recognize(file, "eng+kor", {
      // ✅ 단어 간 공백 유지(표 형태에서 도움 되는 경우가 많음)
      tessedit_pageseg_mode: 6,
      preserve_interword_spaces: "1",
      logger: (m) => {
        if (m && typeof m.progress === "number") {
          const p = 0.06 + m.progress * 0.7;
          const st = m.status ? `OCR: ${m.status}` : "OCR 진행중...";
          report(st, p);
        }
      },
    });
    data = result?.data;
  } catch (e) {
    console.error("OCR failed:", e);
    report("OCR 실패(직접 수정 가능)", 1);
    return {
      items: [],
      debug: { extractor: "none", wordsCount: 0, textLen: 0, itemCount: 0 },
      rawText: "",
    };
  }

  report("텍스트/좌표 정리중...", 0.82);

  // ✅ 1) 표(2컬럼) 추출을 우선 시도
  let itemsTable = [];
  try {
    itemsTable = extractPairsFromTwoColumnTable(data) || [];
  } catch (e) {
    console.warn("table extract error:", e);
    itemsTable = [];
  }

  // 충분히 뽑혔으면 이걸 사용
  if (itemsTable.length >= 5) {
    report("완료", 1);
    return {
      items: itemsTable,
      debug: computeDebug(data, "table", itemsTable),
      rawText: data?.text ?? "",
    };
  }

  // ✅ 2) fallback: 기존 text 기반 파서
  const rawText = data?.text ? data.text : "";
  const lines = rawText
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  const { pairs } = parseLinesToPairs(lines);
  const itemsText = mergePairs(pairs);

  // table이 조금이라도 있으면 text 결과와 합쳐서 보강(중복 제거는 mergePairs가 해줌)
  const combined = mergePairs([...(itemsTable || []), ...(itemsText || [])]);

  report("완료", 1);
  return {
    items: combined,
    debug: computeDebug(data, itemsTable.length ? "table+text" : "text", combined),
    rawText,
  };
}
