// src/lib/ocr_extract.js
// - No JSX
// - Stronger cleanup for IPA/pron symbols, POS tokens, weird latin debris in meanings
// - Fix Korean spacing when OCR splits by syllables (폐 지 하다 -> 폐지하다)
// - Keep idioms (multi-word terms) better
// - OCR failure returns empty items with quality.ocrFailed

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
  // remove (...) and [...] which often include notes/pronunciation
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

  // remove trailing POS tokens: v., n., a., adj., adv., phr., vt, vi...
  t = t.replace(
    /\s+(a|an|n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?\s*$/i,
    ""
  );

  // sometimes OCR yields: "v ." or "n ."
  t = t.replace(/\s+(a|n|v)\s*\.\s*$/i, "");

  return t.trim();
}

function normalizeTermCase(term) {
  const t = normSpace(term);
  if (!t) return t;

  // keep acronyms: US, UK, DNA, TOEFL ...
  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t;

  // keep single-letter "I"
  if (t === "I") return t;

  return t.toLowerCase();
}

function normalizeENKeepPhrase(s) {
  let x = (s ?? "").trim();
  x = x.replace(/[’']/g, "'");

  // ✅ remove pronunciation blocks that may appear with slashes too
  // examples: [əbálɪʃ], /əbólɪʃ/, etc.
  x = x.replace(/\[[^\]]+\]/g, " ");
  x = x.replace(/\/[^/]+\/+/g, " ");

  // remove star markers etc.
  x = x.replace(/[*•·]+/g, " ");

  // keep letters, spaces, hyphen, apostrophe (idioms allowed)
  x = x.replace(/[^A-Za-z\s'\-]/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  // remove trailing pos token
  x = stripTrailingPOSToken(x);

  // normalize case
  x = normalizeTermCase(x);

  return x;
}

function isLikelyEnglishTerm(token) {
  const t = normalizeENKeepPhrase(token);
  if (!t) return false;

  const len = t.length;
  if (len < 2 || len > 60) return false; // ✅ idioms can be longer than 40
  if (englishRatio(t) < 0.6) return false;

  // reject single-letter except a/i
  if (len === 1 && !/^(a|i)$/i.test(t)) return false;

  // reject if POS only
  if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;

  // too many hyphens
  const hy = (t.match(/\-/g) || []).length;
  if (hy >= 4) return false;

  return true;
}

// ----------------- KO cleanup + spacing fix -----------------

function fixKoreanSyllableSpacing(s) {
  // Fix cases like "폐 지 하다" or "호 전적인" where OCR inserts spaces between syllables.
  // Strategy: merge runs of tokens that are Hangul-only and short (<=2 chars),
  // but avoid merging long phrases.
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
      // build a short hangul run
      let j = i;
      let merged = tokens[i];
      let runLen = 1;

      while (j + 1 < tokens.length && isShortHangul(tokens[j + 1])) {
        // stop runaway merges: keep runs reasonably short
        if (merged.length + tokens[j + 1].length > 10) break;
        merged += tokens[j + 1];
        j++;
        runLen++;
        if (runLen >= 6) break; // safety
      }

      // only merge if it actually fixes syllable-splitting (>=2 tokens)
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

  // remove common POS markers
  x = x.replace(/\b(n|v|adj|adv|prep|conj|pron|det|num)\.\b/gi, " ");
  x = x.replace(/\b(명|동|형|부|전|접|대|관)\b/g, " ");

  // remove leading bullets/numbering
  x = x.replace(/^[\s•·\-–—~]*\d+[\.\)]\s*/g, "");
  x = x.replace(/^[\s•·\-–—~]+/g, "");

  // ✅ remove weird leading latin debris like "dobj =" or "obj:" that sometimes appears
  x = x.replace(/^\s*[A-Za-z]{2,12}\s*[:=]\s*/g, "");

  // remove excessive symbols
  x = x.replace(/[*•·]+/g, " ");

  x = x.replace(/\s+/g, " ").trim();

  // ✅ fix syllable-level spacing
  x = fixKoreanSyllableSpacing(x);

  return x;
}

function isLikelyKoreanMeaning(token) {
  const t = normalizeKO(token);
  if (!t) return false;

  // must contain some Korean
  if (koreanRatio(t) < 0.25) return false;

  // prevent long example sentences
  if (t.length > 60) return false;

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
  // Case A: one line contains EN + KO (common in two-column OCR output)
  const s0 = stripLeadingIndex(cleanLine(line));
  if (!s0) return null;

  if (!hasEnglish(s0) || !hasKorean(s0)) return null;
  if (looksLikeExampleSentence(s0)) return null;

  // strong separators
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

  // fallback: split by first Korean index
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

    // too symbol heavy
    const sym = (s.match(/[^A-Za-z0-9가-힣\s'"\-]/g) || []).length;
    if (sym >= 10 && s.length <= 35) continue;

    cleaned.push(s);
  }

  const pairs = [];
  const used = new Array(cleaned.length).fill(false);

  // 1) one-line split first
  for (let i = 0; i < cleaned.length; i++) {
    const one = trySplitOneLine(cleaned[i]);
    if (one) {
      pairs.push(one);
      used[i] = true;
    }
  }

  // 2) two-line pairing (EN-only then KO-only)
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

      // allow a tiny amount of english garbage in meaning line (but still must have korean)
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

    // merge meanings with " / " and dedupe
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

function computeQuality(rawText, cleanedLines, items, ocrFailed) {
  const t = rawText ?? "";
  const enCount = (t.match(/[A-Za-z]/g) || []).length;
  const koCount = (t.match(/[가-힣]/g) || []).length;

  const suspectLowCount = items.length < 5;
  const suspectNoEnglish = enCount < 30;
  const suspectNoKorean = koCount < 10;

  const suspectPairing =
    cleanedLines.length >= 12 && items.length <= Math.max(2, Math.floor(cleanedLines.length * 0.2));

  return {
    ocrFailed: !!ocrFailed,
    enCount,
    koCount,
    cleanedLineCount: cleanedLines.length,
    itemCount: items.length,
    suspectLowCount,
    suspectNoEnglish,
    suspectNoKorean,
    suspectPairing,
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
      quality: computeQuality("", [], [], true),
      rawText: "",
    };
  }

  const rawText = data?.text ? data.text : "";
  report("텍스트 정리중...", 0.8);

  const lines = rawText
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  const { pairs, cleanedLines } = parseLinesToPairs(lines);
  report("단어/뜻 매칭중...", 0.9);

  const items = mergePairs(pairs);
  const quality = computeQuality(rawText, cleanedLines, items, false);

  report("완료", 1);
  return { items, quality, rawText };
}
