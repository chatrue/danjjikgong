// src/lib/ocr_extract.js
// DJJG 단찍공 OCR + 추출
// - 설정(fromLang/toLang)에 맞춰 Tesseract 언어 자동 선택
// - KO 포함이면 기존 한글 중심 정제 로직 사용
// - KO 미포함(예: EN<->JA, EN<->ES, ES<->EN 등)은 "보수적"으로 덜 걸러서 최대한 뽑고,
//   잘못된 줄은 사용자가 Preview에서 수정하도록 설계

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

function hasHangul(s) {
  return /[가-힣]/.test(s ?? "");
}
function hasLatin(s) {
  return /[A-Za-z]/.test(s ?? "");
}
function hasJapanese(s) {
  // Hiragana / Katakana / Kanji
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s ?? "");
}
function hasSpanishHint(s) {
  // 스페인어 악센트/ñ 같은 힌트 (없어도 스페인어일 수 있음)
  return /[áéíóúüñÁÉÍÓÚÜÑ]/.test(s ?? "");
}

function latinRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[A-Za-z]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}
function hangulRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[가-힣]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}
function japaneseRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}

// ----------------- EN/LATIN cleanup -----------------

function stripTrailingPOSToken(term) {
  let t = normSpace(term);
  t = t.replace(/\s+(a|an|n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\s*$/i, "");
  t = t.replace(/\s+(a|n|v)\s*\.\s*$/i, "");
  return t.trim();
}

function normalizeTermCase(term) {
  const t = normSpace(term);
  if (!t) return t;

  // ALLCAPS 약어는 유지
  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t;
  if (t === "I") return t;
  return t.toLowerCase();
}

function normalizeLatinKeepPhrase(s) {
  let x = (s ?? "").trim();
  x = x.replace(/[’']/g, "'");
  x = x.replace(/\[[^\]]+\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");
  x = x.replace(/[*•·]+/g, " ");
  // 라틴 문자/공백/하이픈/아포스트로피만 최대한 유지
  x = x.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'\-]/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  x = stripTrailingPOSToken(x);
  // 스페인어도 대소문자 섞여올 수 있지만, 여기서는 EN과 동일 정책(대부분 소문자)
  x = normalizeTermCase(x);

  return x;
}

function isLikelyLatinTerm(token) {
  const t = normalizeLatinKeepPhrase(token);
  if (!t) return false;
  const len = t.length;
  if (len < 2 || len > 80) return false;

  // 라틴 문자가 어느 정도 있어야 함
  if (latinRatio(t) < 0.35 && !hasSpanishHint(t)) return false;
  // 품사 토큰만 있는 경우 제거
  if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;

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
  if (hangulRatio(t) < 0.20) return false;
  if (t.length > 120) return false;
  return true;
}

// ----------------- JA cleanup -----------------

function normalizeJA(s) {
  let x = (s ?? "").trim();
  x = x.replace(/\s+/g, " ").trim();
  // 일본어는 띄어쓰기 자체가 희귀하므로 크게 건드리지 않음
  return x;
}
function isLikelyJapaneseText(token) {
  const t = normalizeJA(token);
  if (!t) return false;
  if (japaneseRatio(t) < 0.15) return false;
  if (t.length > 120) return false;
  return true;
}

// ----------------- Filtering helpers -----------------

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

  const sym = (s.match(/[^A-Za-z0-9가-힣\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s]/g) || []).length;
  if (sym >= 6 && s.length <= 20) return true;

  return false;
}

function looksLikeExampleSentence(line) {
  const s = (line ?? "").trim();
  if (!s) return false;

  if (hasHangul(s) && s.length >= 45) return true;
  if ((hasLatin(s) || hasSpanishHint(s)) && s.length >= 55 && /[.!?]/.test(s) && /\s/.test(s)) return true;

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

// ----------------- Split logic (generic + KO-special) -----------------

function trySplitOneLine_KO(line) {
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;
  if (!hasLatin(s0) || !hasHangul(s0)) return null;
  if (looksLikeExampleSentence(s0)) return null;

  const strongSep = ["→", "=>", "=", ":", " - ", " – ", " — "];
  for (const sep of strongSep) {
    if (s0.includes(sep)) {
      const parts = s0.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(" ").trim();
        const term = normalizeLatinKeepPhrase(removeParenthesesAndBrackets(left));
        const meaning = normalizeKO(removeParenthesesAndBrackets(right));
        if (isLikelyLatinTerm(term) && isLikelyKoreanMeaning(meaning)) {
          return { term, meaning };
        }
      }
    }
  }

  // 첫 한글 위치 기준 split
  const idx = s0.search(/[가-힣]/);
  if (idx > 0) {
    const left = s0.slice(0, idx).trim();
    const right = s0.slice(idx).trim();

    const term = normalizeLatinKeepPhrase(removeParenthesesAndBrackets(left));
    const meaning = normalizeKO(removeParenthesesAndBrackets(right));

    if (isLikelyLatinTerm(term) && isLikelyKoreanMeaning(meaning)) {
      return { term, meaning };
    }
  }

  return null;
}

function trySplitOneLine_Generic(line, fromLang, toLang) {
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;
  if (looksLikeExampleSentence(s0)) return null;

  // 강한 구분자 기반
  const strongSep = ["→", "=>", "=", ":", " - ", " – ", " — ", "|"];
  for (const sep of strongSep) {
    if (s0.includes(sep)) {
      const parts = s0.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(" ").trim();

        const term = normalizeByLang(left, fromLang);
        const meaning = normalizeByLang(right, toLang);

        if (isLikelyByLang(term, fromLang) && isLikelyByLang(meaning, toLang)) {
          return { term, meaning };
        }
      }
    }
  }

  // 2개 이상의 공백(표형태)로 분리 시도
  const m = s0.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
  if (m.length >= 2) {
    const left = m[0];
    const right = m.slice(1).join(" ").trim();

    const term = normalizeByLang(left, fromLang);
    const meaning = normalizeByLang(right, toLang);

    if (isLikelyByLang(term, fromLang) && isLikelyByLang(meaning, toLang)) {
      return { term, meaning };
    }
  }

  return null;
}

function normalizeByLang(text, langCode) {
  if (langCode === "KO") return normalizeKO(text);
  if (langCode === "JA") return normalizeJA(text);
  // EN/ES는 라틴 정규화로 동일 처리
  return normalizeLatinKeepPhrase(text);
}

function isLikelyByLang(text, langCode) {
  const t = (text ?? "").trim();
  if (!t) return false;

  if (langCode === "KO") return isLikelyKoreanMeaning(t);
  if (langCode === "JA") return isLikelyJapaneseText(t);

  // EN/ES: 라틴 기반
  return isLikelyLatinTerm(t) || (t.length >= 2 && (hasLatin(t) || hasSpanishHint(t)));
}

function parseLinesToPairs(lines, fromLang, toLang) {
  const cleaned = [];
  for (const raw of lines) {
    let s = cleanLine(raw);
    if (!s) continue;

    s = stripLeadingIndex(s);
    if (!s) continue;

    if (looksLikePageOrUnit(s)) continue;
    if (looksLikeExampleSentence(s)) continue;

    // 너무 기호만 많은 짧은 줄 제거
    const sym = (s.match(/[^A-Za-z0-9가-힣\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s'"\-]/g) || []).length;
    if (sym >= 10 && s.length <= 35) continue;

    cleaned.push(s);
  }

  const pairs = [];
  const used = new Array(cleaned.length).fill(false);

  // 1) 한 줄에서 바로 분리
  for (let i = 0; i < cleaned.length; i++) {
    let one = null;
    if (fromLang === "EN" && toLang === "KO") one = trySplitOneLine_KO(cleaned[i]);
    if (!one) one = trySplitOneLine_Generic(cleaned[i], fromLang, toLang);

    if (one) {
      pairs.push(one);
      used[i] = true;
    }
  }

  // 2) 두 줄(위 term / 아래 meaning) 페어링
  for (let i = 0; i < cleaned.length; i++) {
    if (used[i]) continue;
    const a = cleaned[i];

    const termCand = normalizeByLang(removeParenthesesAndBrackets(a), fromLang);
    if (!isLikelyByLang(termCand, fromLang)) continue;

    let j = i + 1;
    while (j < cleaned.length && used[j]) j++;

    if (j < cleaned.length) {
      const b = cleaned[j];
      const meaningCand = normalizeByLang(removeParenthesesAndBrackets(b), toLang);
      if (isLikelyByLang(meaningCand, toLang)) {
        pairs.push({ term: termCand, meaning: meaningCand });
        used[i] = true;
        used[j] = true;
      }
    }
  }

  return { pairs, cleanedLines: cleaned };
}

function mergePairs(pairs, fromLang, toLang) {
  const map = new Map();

  for (const p of pairs) {
    const term = normalizeByLang(stripOuterPunct(p.term), fromLang);
    const meaning = normalizeByLang(stripOuterPunct(p.meaning), toLang);

    if (!term || !meaning) continue;
    if (!isLikelyByLang(term, fromLang)) continue;
    if (!isLikelyByLang(meaning, toLang)) continue;

    const key = term.trim().toLowerCase().replace(/\s+/g, " ");
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { term, meaning });
      continue;
    }

    // 뜻 합치기(언어 상관 없이 / 로 합침)
    const existParts = (existing.meaning ?? "").split(" / ").map((x) => normSpace(x)).filter(Boolean);
    const newParts = (meaning ?? "")
      .split(/[\/,;·=]/g)
      .map((x) => normSpace(x))
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
    extractor: chosen, // "table" or "text" or "table+text"
    wordsCount,
    textLen,
    itemCount: items.length,
  };
}

// ----------------- Tesseract language mapping -----------------

// 앱 설정 코드 -> Tesseract traineddata 코드
const TESS_MAP = {
  EN: "eng",
  KO: "kor",
  ES: "spa",
  JA: "jpn",
};

// 중복 제거 + eng fallback 포함
function buildTessLang(fromLang, toLang) {
  const a = TESS_MAP[fromLang] || "eng";
  const b = TESS_MAP[toLang] || "eng";

  // eng는 웬만하면 함께 두는 게 안전(숫자/기호/영문 섞임 대비)
  const set = new Set([a, b, "eng"]);
  return Array.from(set).join("+");
}

/**
 * runOCRAndExtract(file, options, onProgress)
 * - options: { fromLang: "EN"|"KO"|"ES"|"JA", toLang: ... }
 * - onProgress: (status, p) => void
 *
 * ✅ 기존 호환:
 * runOCRAndExtract(file, onProgress) 형태도 동작
 */
export async function runOCRAndExtract(file, optionsOrOnProgress, maybeOnProgress) {
  let options = { fromLang: "EN", toLang: "KO" };
  let onProgress = null;

  if (typeof optionsOrOnProgress === "function") {
    onProgress = optionsOrOnProgress;
  } else {
    options = { ...options, ...(optionsOrOnProgress || {}) };
    onProgress = typeof maybeOnProgress === "function" ? maybeOnProgress : null;
  }

  const { fromLang, toLang } = options;

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

  const lang = buildTessLang(fromLang, toLang);

  report(`OCR 실행중... (${lang})`, 0.06);

  let data;
  try {
    const result = await Tesseract.recognize(file, lang, {
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
    // ✅ lang traineddata가 없으면 실패할 수 있음(예: jpn/spa)
    console.warn("OCR failed with lang:", lang, e);

    // 1차 fallback: eng+kor (기존 안정 조합)
    try {
      report("OCR 재시도중... (eng+kor)", 0.1);
      const result2 = await Tesseract.recognize(file, "eng+kor", {
        tessedit_pageseg_mode: 6,
        preserve_interword_spaces: "1",
        logger: (m) => {
          if (m && typeof m.progress === "number") {
            const p = 0.1 + m.progress * 0.66;
            const st = m.status ? `OCR(재시도): ${m.status}` : "OCR 재시도중...";
            report(st, p);
          }
        },
      });
      data = result2?.data;
    } catch (e2) {
      console.error("OCR failed:", e2);
      report("OCR 실패(직접 수정 가능)", 1);
      return {
        items: [],
        debug: { extractor: "none", wordsCount: 0, textLen: 0, itemCount: 0 },
        rawText: "",
      };
    }
  }

  report("텍스트/좌표 정리중...", 0.82);

  // ✅ 1) 표(2컬럼) 추출 우선
  let itemsTable = [];
  try {
    itemsTable = extractPairsFromTwoColumnTable(data, { fromLang, toLang }) || [];
  } catch (e) {
    console.warn("table extract error:", e);
    itemsTable = [];
  }

  // table이 충분히 뽑히면 그대로 사용
  if (itemsTable.length >= 5) {
    report("완료", 1);
    return {
      items: itemsTable,
      debug: computeDebug(data, "table", itemsTable),
      rawText: data?.text ?? "",
    };
  }

  // ✅ 2) fallback: text 기반 파서
  const rawText = data?.text ? data.text : "";
  const lines = rawText
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  const { pairs } = parseLinesToPairs(lines, fromLang, toLang);
  const itemsText = mergePairs(pairs, fromLang, toLang);

  // table이 조금이라도 있으면 합쳐서 보강
  const combined = mergePairs([...(itemsTable || []), ...(itemsText || [])], fromLang, toLang);

  report("완료", 1);
  return {
    items: combined,
    debug: computeDebug(data, itemsTable.length ? "table+text" : "text", combined),
    rawText,
  };
}
