// src/lib/ocr_extract.js
// DJJG 단찍공 OCR + 추출 (통합 강화판)
// ✅ fromLang/toLang 기반 Tesseract 언어 자동 선택 + traineddata 없으면 fallback
// ✅ KO 포함 시: 강한 잡음 억제/정제 + 누락 의심일 때만 2/3분할 OCR 보강
// ✅ KO 미포함 시: 보수적으로 덜 걸러서 최대한 추출(Preview에서 수정 전제)
// ✅ table(2컬럼) 우선 + text 파서 + 항상 병합(table+text)로 누락 방지
// ✅ (추가) 누락 의심 시 PSM 11(sparse text) 1회 재시도 → 효과 있으면 채택
// ✅ (추가) IPA 찌꺼기 라틴 조각(rd, sf, dabl 등) term 끝에서 제거
// ✅ (추가) KO 뜻 앞에 붙는 라틴 찌꺼기/동그라미 표식 제거

import { extractPairsFromTwoColumnTable } from "./ocr_table_extract.js";

/* ---------------- utils ---------------- */
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
function normSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function countVowels(s) {
  return ((s || "").match(/[aeiou]/gi) || []).length;
}

const LATIN_SHORT_ALLOW = new Set([
  "a",
  "i",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "but",
  "by",
  "off",
  "up",
  "out",
  "as",
  "is",
  "be",
  "do",
  "go",
  "no",
  "so",
  "we",
  "he",
  "she",
  "it",
  "us",
  "me",
  "my",
  "your",
  "our",
  "their",
]);

function stripTrailingJunkTokensLatin(phrase) {
  let t = normSpace(phrase);
  if (!t) return t;

  const parts0 = t.split(" ").filter(Boolean);
  if (parts0.length <= 1) return t;

  const isSuspicious = (tok) => {
    const s = tok.toLowerCase();
    if (LATIN_SHORT_ALLOW.has(s)) return false;

    const len = s.length;
    if (len <= 1) return true;

    const v = countVowels(s);

    // rd, sf 같은 IPA 찌꺼기 (모음 0개, 짧음)
    if (len <= 4 && v === 0) return true;

    // dabl 같은 찌꺼기: 모음이 0~1개이고 짧은 경우
    if (len <= 6 && v <= 1 && /^[a-z]+$/i.test(tok)) return true;

    return false;
  };

  const parts = [...parts0];

  // 마지막 토큰이 찌꺼기로 의심되면 1~2개까지 제거
  for (let k = 0; k < 2 && parts.length > 1; k++) {
    const last = parts[parts.length - 1];
    if (!isSuspicious(last)) break;
    parts.pop();
  }

  return normSpace(parts.join(" "));
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
function hasSpanishHint(s) {
  return /[áéíóúüñÁÉÍÓÚÜÑ]/.test(s ?? "");
}

function latinRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}
function hangulRatio(s) {
  const str = s ?? "";
  const letters = (str.match(/[가-힣]/g) || []).length;
  const total = str.length || 1;
  return letters / total;
}
function countHangul(s) {
  return ((s ?? "").match(/[가-힣]/g) || []).length;
}

/* ---------------- EN strict cleanup (KO모드에서만 강하게 사용) ---------------- */
const EN_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "but",
  "with",
  "from",
  "by",
  "as",
  "is",
  "are",
  "be",
  "been",
  "being",
  "was",
  "were",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "you",
  "he",
  "she",
  "they",
  "we",
  "my",
  "your",
  "their",
  "our",
  "me",
  "him",
  "her",
  "them",
  "us",
]);

const POS_TOKEN_RE = /\b(a|an|n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\b/gi;

function stripTrailingPOSToken(term) {
  let t = normSpace(term);
  t = t.replace(/\s+(a|an|n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\s*$/i, "");
  t = t.replace(/\s+(a|n|v)\s*\.\s*$/i, "");
  return t.trim();
}
function normalizeTermCase(term) {
  const t = normSpace(term);
  if (!t) return t;
  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t; // 약어
  if (t === "I") return t;
  return t.toLowerCase();
}
function normalizeENKeepPhraseStrict(s) {
  let x = (s ?? "").trim();
  x = x.replace(/[’']/g, "'");
  x = x.replace(/\[[^\]]+\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");
  x = x.replace(/\([^)]*\)/g, " ");
  x = x.replace(POS_TOKEN_RE, " ");
  x = x.replace(/[*•·]+/g, " ");
  x = x.replace(/[^A-Za-z\s'\-]/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  x = stripTrailingPOSToken(x);
  x = normalizeTermCase(x);
  x = stripTrailingJunkTokensLatin(x);
  return x;
}
function isLikelyEnglishTermStrict(token) {
  const t = normalizeENKeepPhraseStrict(token);
  if (!t) return false;

  const len = t.length;
  if (len < 2 || len > 60) return false;
  if (latinRatio(t) < 0.6) return false;

  if (!t.includes(" ") && EN_STOPWORDS.has(t)) return false;
  if (len <= 3 && EN_STOPWORDS.has(t)) return false;

  if (len === 1 && !/^(a|i)$/i.test(t)) return false;
  if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;

  const hy = (t.match(/\-/g) || []).length;
  if (hy >= 4) return false;

  return true;
}

/* ---------------- Latin (EN/ES) cleanup (KO 미포함 모드에서는 더 관대) ---------------- */
function normalizeLatinKeepPhrase(s) {
  let x = (s ?? "").trim();
  x = x.replace(/[’']/g, "'");
  x = x.replace(/\[[^\]]+\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");
  x = x.replace(/[*•·]+/g, " ");
  x = x.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'\-]/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  x = stripTrailingPOSToken(x);
  x = normalizeTermCase(x); // 스페인어도 소문자 통일(원하면 나중에 옵션화 가능)
  x = stripTrailingJunkTokensLatin(x);
  return x;
}
function isLikelyLatinText(token, { relaxed = false } = {}) {
  const t = normalizeLatinKeepPhrase(token);
  if (!t) return false;
  const len = t.length;
  if (len < 2 || len > 90) return false;

  if (!relaxed) {
    if (latinRatio(t) < 0.35 && !hasSpanishHint(t)) return false;
    if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;
  } else {
    if (latinRatio(t) < 0.18 && !hasSpanishHint(t)) return false;
  }

  return true;
}

/* ---------------- KO cleanup ---------------- */
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

  x = x.replace(/\[[^\]]*\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");

  x = x.replace(/\b[A-Za-z]{1,3}\b/g, " ");
  x = x.replace(/\b(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\b/gi, " ");
  x = x.replace(/\b(명|동|형|부|전|접|대|관)\b/g, " ");

  x = x.replace(/^[\s•·\-–—~]*\d+[\.\)]\s*/g, "");
  x = x.replace(/^[\s•·\-–—~]+/g, "");
  x = x.replace(/^\s*[A-Za-z]{2,12}\s*[:=]\s*/g, "");

  x = x.replace(/[*•·]+/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  // 뜻(한글) 앞에 붙는 라틴 찌꺼기(dabl, rd 등) 제거
  if (/[가-힣]/.test(x)) {
    x = x.replace(/^[○●◦ㅇoO]+\s*/g, "");
    x = x.replace(/^(?:[A-Za-z]{1,6}\s+){1,2}/, "");
  }

  x = fixKoreanSyllableSpacing(x);
  return x;
}
function isLikelyKoreanMeaning(token, { relaxed = false } = {}) {
  const t = normalizeKO(token);
  if (!t) return false;

  if (!relaxed) {
    if (countHangul(t) < 2) return false;
    if (hangulRatio(t) < 0.25) return false;
    if (t.length > 140) return false;
  } else {
    if (countHangul(t) < 1) return false;
    if (hangulRatio(t) < 0.12) return false;
    if (t.length > 180) return false;
  }
  return true;
}

/* ---------------- filtering helpers ---------------- */
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

function looksLikeExampleSentence(line, { strictKO = false } = {}) {
  const s = (line ?? "").trim();
  if (!s) return false;

  if (/^(예문|ex\)|e\.g\.|예:)\b/i.test(s)) return true;

  const wordCount = s.split(/\s+/).filter(Boolean).length;
  const hasPunct = /[.!?]/.test(s);

  if (hasHangul(s)) {
    const lenTh = strictKO ? 85 : 75;
    if (s.length >= lenTh) {
      const hasSentenceEnding = /(다|요|죠|니다)\s*[.!?]?$/.test(s);
      if (hasPunct || wordCount >= 7 || hasSentenceEnding) return true;
    }
    return false;
  }

  if (hasLatin(s) || hasSpanishHint(s)) {
    const lenTh = strictKO ? 80 : 65;
    if (s.length >= lenTh && hasPunct && wordCount >= 6) return true;
  }

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

/* ---------------- lang normalizer / validator ---------------- */
function normalizeByLang(text, langCode, ctx) {
  if (langCode === "KO") return normalizeKO(text);
  if (ctx?.strictKO && langCode === "EN") return normalizeENKeepPhraseStrict(text);
  return normalizeLatinKeepPhrase(text);
}

function isLikelyByLang(text, langCode, ctx) {
  const t = (text ?? "").trim();
  if (!t) return false;

  const relaxed = !!ctx?.relaxedNonKO;

  if (langCode === "KO") return isLikelyKoreanMeaning(t, { relaxed });
  if (ctx?.strictKO && langCode === "EN") return isLikelyEnglishTermStrict(t);
  return isLikelyLatinText(t, { relaxed });
}

/* ---------------- split logic ---------------- */
function trySplitOneLine_KO(line, fromLang, toLang, ctx) {
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;
  if (!hasLatin(s0) || !hasHangul(s0)) return null;
  if (looksLikeExampleSentence(s0, { strictKO: true })) return null;

  const strongSep = ["→", "=>", "=", ":", " - ", " – ", " — ", "|"];
  for (const sep of strongSep) {
    if (s0.includes(sep)) {
      const parts = s0.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(" ").trim();

        const term = normalizeByLang(removeParenthesesAndBrackets(left), fromLang, ctx);
        const meaning = normalizeByLang(removeParenthesesAndBrackets(right), toLang, ctx);

        if (isLikelyByLang(term, fromLang, ctx) && isLikelyByLang(meaning, toLang, ctx)) {
          return { term, meaning };
        }
      }
    }
  }

  const idx = s0.search(/[가-힣]/);
  if (idx > 0) {
    const left = s0.slice(0, idx).trim();
    const right = s0.slice(idx).trim();

    const term = normalizeByLang(removeParenthesesAndBrackets(left), fromLang, ctx);
    const meaning = normalizeByLang(removeParenthesesAndBrackets(right), toLang, ctx);

    if (isLikelyByLang(term, fromLang, ctx) && isLikelyByLang(meaning, toLang, ctx)) {
      return { term, meaning };
    }
  }

  return null;
}

function trySplitOneLine_Generic(line, fromLang, toLang, ctx) {
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;
  if (looksLikeExampleSentence(s0, { strictKO: !!ctx?.strictKO })) return null;

  const strongSep = ["→", "=>", "=", ":", " - ", " – ", " — ", "|"];
  for (const sep of strongSep) {
    if (s0.includes(sep)) {
      const parts = s0.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(" ").trim();

        const term = normalizeByLang(removeParenthesesAndBrackets(left), fromLang, ctx);
        const meaning = normalizeByLang(removeParenthesesAndBrackets(right), toLang, ctx);

        if (isLikelyByLang(term, fromLang, ctx) && isLikelyByLang(meaning, toLang, ctx)) {
          return { term, meaning };
        }
      }
    }
  }

  const m = s0.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
  if (m.length >= 2) {
    const left = m[0];
    const right = m.slice(1).join(" ").trim();

    const term = normalizeByLang(removeParenthesesAndBrackets(left), fromLang, ctx);
    const meaning = normalizeByLang(removeParenthesesAndBrackets(right), toLang, ctx);

    if (isLikelyByLang(term, fromLang, ctx) && isLikelyByLang(meaning, toLang, ctx)) {
      return { term, meaning };
    }
  }

  return null;
}

function parseLinesToPairs(lines, fromLang, toLang, ctx) {
  const cleaned = [];

  for (const raw of lines) {
    let s = cleanLine(raw);
    if (!s) continue;

    s = stripLeadingIndex(s);
    if (!s) continue;
    
    if (looksLikePageOrUnit(s)) continue;
    if (looksLikeExampleSentence(s, { strictKO: !!ctx?.strictKO })) continue;

    const sym = (s.match(/[^A-Za-z0-9가-힣\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s'"\-]/g) || []).length;
    if (sym >= 10 && s.length <= 35) continue;

    cleaned.push(s);
  }

  const pairs = [];
  const used = new Array(cleaned.length).fill(false);

  for (let i = 0; i < cleaned.length; i++) {
    let one = null;

    if (ctx?.strictKO && ((fromLang === "EN" && toLang === "KO") || (fromLang === "KO" && toLang !== "KO"))) {
      one = trySplitOneLine_KO(cleaned[i], fromLang, toLang, ctx);
    }

    if (!one) one = trySplitOneLine_Generic(cleaned[i], fromLang, toLang, ctx);

    if (one) {
      pairs.push(one);
      used[i] = true;
    }
  }

  for (let i = 0; i < cleaned.length; i++) {
    if (used[i]) continue;

    const a = cleaned[i];
    const termCand = normalizeByLang(removeParenthesesAndBrackets(a), fromLang, ctx);
    if (!isLikelyByLang(termCand, fromLang, ctx)) continue;

    let j = i + 1;
    let hop = 0;
    while (j < cleaned.length && hop < (ctx?.strictKO ? 3 : 2)) {
      if (used[j]) {
        j++;
        continue;
      }

      const b = cleaned[j];
      const meaningCand = normalizeByLang(removeParenthesesAndBrackets(b), toLang, ctx);

      if (!isLikelyByLang(meaningCand, toLang, ctx)) {
        j++;
        hop++;
        continue;
      }

      pairs.push({ term: termCand, meaning: meaningCand });
      used[i] = true;
      used[j] = true;
      break;
    }
  }

  return { pairs, cleanedLines: cleaned };
}

function mergePairs(pairs, fromLang, toLang, ctx) {
  const map = new Map();

  for (const p of pairs) {
    const term = normalizeByLang(stripOuterPunct(p.term), fromLang, ctx);
    const meaning = normalizeByLang(stripOuterPunct(p.meaning), toLang, ctx);

    if (!term || !meaning) continue;
    if (!isLikelyByLang(term, fromLang, ctx)) continue;
    if (!isLikelyByLang(meaning, toLang, ctx)) continue;

    const key = term.trim().toLowerCase().replace(/\s+/g, " ");
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { term, meaning });
      continue;
    }

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

/* ---------------- debug ---------------- */
function estimateExpectedCountFromRawText(rawText) {
  const lines = (rawText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let c = 0;
  for (const l of lines) {
    if (/^\(?\d{1,3}\)?[\.\)\-]?\s+/.test(l)) c++;
  }
  return c;
}
function computeDebugFromText(rawText, chosen, items, meta = {}) {
  const textLen = (rawText ?? "").length;
  const linesCount = (rawText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).length;
  const expectedHint = estimateExpectedCountFromRawText(rawText);

  return {
    extractor: chosen,
    itemCount: items.length,
    textLen,
    linesCount,
    expectedHint,
    ...meta,
  };
}

/* ---------------- image split (for OCR reinforcement) ---------------- */
async function fileToBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}
async function cropFileToBlob(file, y0, y1) {
  const bmp = await fileToBitmap(file);
  const w = bmp.width;
  const h = bmp.height;

  const top = Math.max(0, Math.floor(y0 * h));
  const bottom = Math.min(h, Math.floor(y1 * h));
  const ch = Math.max(1, bottom - top);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = ch;

  const ctx2d = canvas.getContext("2d");
  ctx2d.drawImage(bmp, 0, top, w, ch, 0, 0, w, ch);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
  });

  return blob || file;
}

/* ---------------- tesseract lang mapping ---------------- */
const TESS_MAP = {
  EN: "eng",
  KO: "kor",
  ES: "spa",
  JA: "jpn",
};

function buildTessLang(fromLang, toLang) {
  const a = TESS_MAP[fromLang] || "eng";
  const b = TESS_MAP[toLang] || "eng";

  const set = new Set([a, b]);

  if (fromLang === "EN" || toLang === "EN" || fromLang === "ES" || toLang === "ES") {
    set.add("eng");
  }

  return Array.from(set).join("+");
}

async function runTesseractTextOnly(
  Tesseract,
  file,
  lang,
  report,
  baseP = 0.06,
  span = 0.7,
  label = "OCR",
  opt = {}
) {
  const psm = opt?.psm ?? 6;

  const result = await Tesseract.recognize(file, lang, {
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
    logger: (m) => {
      if (m && typeof m.progress === "number") {
        const p = baseP + m.progress * span;
        const st = m.status ? `${label}: ${m.status}` : `${label} 진행중...`;
        report(st, p);
      }
    },
  });

  const data = result?.data;
  const rawText = data?.text ? data.text : "";
  return { data, rawText };
}

function parseRawTextToItems(rawText, fromLang, toLang, ctx) {
  const lines = (rawText ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  const { pairs } = parseLinesToPairs(lines, fromLang, toLang, ctx);
  return mergePairs(pairs, fromLang, toLang, ctx);
}

/* ---------------- main ---------------- */
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

  const strictKO = fromLang === "KO" || toLang === "KO";
  const relaxedNonKO = !strictKO;

  const ctx = { strictKO, relaxedNonKO };

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

  const langWanted = buildTessLang(fromLang, toLang);

  report(`OCR 실행중... (${langWanted})`, 0.06);

  let data,
    rawText,
    usedLang = langWanted,
    fallback = "none";

  try {
    const r1 = await runTesseractTextOnly(Tesseract, file, langWanted, report, 0.06, 0.7, "OCR");
    data = r1.data;
    rawText = r1.rawText;
  } catch (e) {
    console.warn("OCR failed with lang:", langWanted, e);

    try {
      fallback = "eng+kor";
      usedLang = "eng+kor";
      report("OCR 재시도중... (eng+kor)", 0.10);
      const r2 = await runTesseractTextOnly(Tesseract, file, "eng+kor", report, 0.10, 0.66, "OCR(재시도)");
      data = r2.data;
      rawText = r2.rawText;
    } catch (e2) {
      console.warn("OCR failed with eng+kor:", e2);

      try {
        fallback = "eng";
        usedLang = "eng";
        report("OCR 재시도중... (eng)", 0.12);
        const r3 = await runTesseractTextOnly(Tesseract, file, "eng", report, 0.12, 0.64, "OCR(재시도)");
        data = r3.data;
        rawText = r3.rawText;
      } catch (e3) {
        console.error("OCR failed:", e3);
        report("OCR 실패(직접 수정 가능)", 1);
        return {
          items: [],
          debug: { extractor: "none", itemCount: 0, usedLang, fallback },
          rawText: "",
        };
      }
    }
  }

  report("텍스트/좌표 정리중...", 0.82);

  let itemsTable = [];
  try {
    itemsTable = extractPairsFromTwoColumnTable(data, { fromLang, toLang }) || [];
  } catch (e) {
    try {
      itemsTable = extractPairsFromTwoColumnTable(data) || [];
    } catch (e2) {
      console.warn("table extract error:", e2);
      itemsTable = [];
    }
  }

  const itemsText = parseRawTextToItems(rawText, fromLang, toLang, ctx);

  let combinedBase = mergePairs([...(itemsTable || []), ...(itemsText || [])], fromLang, toLang, ctx);

  if (itemsTable.length >= 8 && combinedBase.length >= itemsTable.length) {
    report("완료", 1);
    return {
      items: combinedBase,
      debug: computeDebugFromText(rawText, "table+text", combinedBase, {
        usedLang,
        fallback,
        mode: strictKO ? "strictKO" : "relaxed",
        note: "table strong",
      }),
      rawText,
    };
  }

  const quickRetryPSM11 = (rawText?.length ?? 0) >= 220 && (itemsText?.length ?? 0) <= 7;

  if (quickRetryPSM11) {
    report("인식 보강중(PSM 11 재시도)...", 0.835);

    try {
      const rAlt = await runTesseractTextOnly(Tesseract, file, usedLang, report, 0.835, 0.06, "OCR(PSM11)", {
        psm: 11,
      });

      const itemsAlt = mergePairs(
        [
          ...(itemsTable || []),
          ...parseRawTextToItems(rAlt.rawText, fromLang, toLang, ctx),
          ...combinedBase,
        ],
        fromLang,
        toLang,
        ctx
      );

      if (itemsAlt.length >= combinedBase.length + 4) {
        const mergedRawAlt = [rawText, rAlt.rawText].join("\n");
        report("완료", 1);
        return {
          items: itemsAlt,
          debug: computeDebugFromText(mergedRawAlt, "table+text+psm11", itemsAlt, {
            usedLang,
            fallback,
            mode: strictKO ? "strictKO" : "relaxed",
            note: "psm11 improved",
          }),
          rawText: mergedRawAlt,
        };
      }
    } catch (e) {
      console.warn("PSM11 retry failed:", e);
    }
  }

  const expected = estimateExpectedCountFromRawText(rawText);
  const linesCount = (rawText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).length;

  const isShortList = expected > 0 && expected <= 6;

  const missingLikely = expected >= 10 && itemsText.length < Math.max(6, Math.floor(expected * 0.55));

  const veryFewAnyway = itemsText.length < 8 && expected >= 12;

  const rawLooksBigButItemsSmall =
    linesCount >= 18 && itemsText.length <= 7 && expected === 0 && (rawText?.length ?? 0) >= 220;

  const shouldSplit = !isShortList && (missingLikely || veryFewAnyway || rawLooksBigButItemsSmall);

  if (shouldSplit) {
    report("인식 보강중(2분할)...", 0.86);

    const topBlob = await cropFileToBlob(file, 0.0, 0.52);
    const botBlob = await cropFileToBlob(file, 0.48, 1.0);

    const rTop = await runTesseractTextOnly(
      Tesseract,
      topBlob,
      usedLang,
      (s, p) => report(s, 0.86 + p * 0.06),
      0.0,
      1.0,
      "OCR(보강)"
    );
    const rBot = await runTesseractTextOnly(
      Tesseract,
      botBlob,
      usedLang,
      (s, p) => report(s, 0.92 + p * 0.06),
      0.0,
      1.0,
      "OCR(보강)"
    );

    const items2 = mergePairs(
      [
        ...combinedBase,
        ...parseRawTextToItems(rTop.rawText, fromLang, toLang, ctx),
        ...parseRawTextToItems(rBot.rawText, fromLang, toLang, ctx),
      ],
      fromLang,
      toLang,
      ctx
    );

    const expected2 = Math.max(
      expected,
      estimateExpectedCountFromRawText(rTop.rawText) + estimateExpectedCountFromRawText(rBot.rawText)
    );

    const stillMissing = expected2 >= 14 && items2.length < Math.floor(expected2 * 0.65);

    if (stillMissing) {
      report("인식 보강중(3분할)...", 0.94);

      const b1 = await cropFileToBlob(file, 0.0, 0.36);
      const b2 = await cropFileToBlob(file, 0.32, 0.68);
      const b3 = await cropFileToBlob(file, 0.64, 1.0);

      const rr1 = await runTesseractTextOnly(
        Tesseract,
        b1,
        usedLang,
        (s, p) => report(s, 0.94 + p * 0.02),
        0.0,
        1.0,
        "OCR(보강)"
      );
      const rr2 = await runTesseractTextOnly(
        Tesseract,
        b2,
        usedLang,
        (s, p) => report(s, 0.96 + p * 0.02),
        0.0,
        1.0,
        "OCR(보강)"
      );
      const rr3 = await runTesseractTextOnly(
        Tesseract,
        b3,
        usedLang,
        (s, p) => report(s, 0.98 + p * 0.02),
        0.0,
        1.0,
        "OCR(보강)"
      );

      const items3 = mergePairs(
        [
          ...items2,
          ...parseRawTextToItems(rr1.rawText, fromLang, toLang, ctx),
          ...parseRawTextToItems(rr2.rawText, fromLang, toLang, ctx),
          ...parseRawTextToItems(rr3.rawText, fromLang, toLang, ctx),
        ],
        fromLang,
        toLang,
        ctx
      );

      const mergedRaw = [rawText, rTop.rawText, rBot.rawText, rr1.rawText, rr2.rawText, rr3.rawText].join("\n");

      report("완료", 1);
      return {
        items: items3,
        debug: computeDebugFromText(mergedRaw, "table+text+split3", items3, {
          usedLang,
          fallback,
          mode: strictKO ? "strictKO" : "relaxed",
          note: "noise guard + split3",
        }),
        rawText: mergedRaw,
      };
    }

    const mergedRaw2 = [rawText, rTop.rawText, rBot.rawText].join("\n");

    report("완료", 1);
    return {
      items: items2,
      debug: computeDebugFromText(mergedRaw2, "table+text+split2", items2, {
        usedLang,
        fallback,
        mode: strictKO ? "strictKO" : "relaxed",
        note: "noise guard + split2",
      }),
      rawText: mergedRaw2,
    };
  }

  report("완료", 1);
  return {
    items: combinedBase,
    debug: computeDebugFromText(rawText, itemsTable.length ? "table+text" : "text", combinedBase, {
      usedLang,
      fallback,
      mode: strictKO ? "strictKO" : "relaxed",
      note: "no split",
    }),
    rawText,
  };
}
