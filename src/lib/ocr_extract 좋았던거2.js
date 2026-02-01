// src/lib/ocr_extract.js
// DJJG 단찍공 OCR + 추출 (recognize 기반 + "필요할 때만" 자동 분할 OCR)
// 1) Tesseract 실행
// 2) (우선) 2컬럼(표) 좌표 기반 추출 시도
// 3) fallback: 텍스트 기반 추출
// 4) (중요) "정말 누락이 의심될 때만" 2분할/3분할 OCR
// 5) 짧은 단어장에서 불필요한 단어(잡음) 생성 억제(필터 강화)

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

function countHangul(s) {
  return ((s ?? "").match(/[가-힣]/g) || []).length;
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

// ----------------- EN cleanup + noise filter -----------------

// 흔한 영어 기능어(잡음) 차단
const EN_STOPWORDS = new Set([
  "a","an","the","to","of","in","on","at","for","and","or","but","with","from","by","as",
  "is","are","be","been","being","was","were","do","does","did","have","has","had",
  "this","that","these","those","it","its","i","you","he","she","they","we","my","your",
  "their","our","me","him","her","them","us"
]);

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

  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t; // 약어
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

  // 너무 “짧고 흔한 단어” 제거
  if (len <= 3 && EN_STOPWORDS.has(t)) return false;

  // 한 단어로 쪼개진 기능어 비슷한 것 제거
  if (!t.includes(" ") && t.length <= 3 && EN_STOPWORDS.has(t)) return false;

  if (englishRatio(t) < 0.6) return false;

  if (len === 1 && !/^(a|i)$/i.test(t)) return false;
  if (/^(n|v|adj|adv|prep|conj|pron|det|num|phr|ph|vt|vi)\.?$/i.test(t)) return false;

  const hy = (t.match(/\-/g) || []).length;
  if (hy >= 4) return false;

  // 단어가 너무 “기호처럼” 나오면 제외 (예: "l", "il" 등)
  if (!/[a-z]/i.test(t)) return false;

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

  x = x.replace(/^\s*[A-Za-z]{2,12}\s*[:=]\s*/g, "");

  x = x.replace(/[*•·]+/g, " ");
  x = x.replace(/\s+/g, " ").trim();

  x = fixKoreanSyllableSpacing(x);
  return x;
}

function isLikelyKoreanMeaning(token) {
  const t = normalizeKO(token);
  if (!t) return false;

  // ✅ 한글이 너무 적으면 잡음으로 취급
  const hc = countHangul(t);
  if (hc < 2) return false;

  if (koreanRatio(t) < 0.25) return false;

  // 너무 짧은 의미(한두 글자) 잡음 제거
  if (t.length < 2) return false;

  if (t.length > 140) return false;
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

  if (hasKorean(s) && s.length >= 55) return true;
  if (hasEnglish(s) && s.length >= 70 && /[.!?]/.test(s) && /\s/.test(s)) return true;

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

// rawText에서 "단어 번호"처럼 보이는 줄 개수 추정
function estimateExpectedCountFromRawText(rawText) {
  const lines = (rawText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let c = 0;
  for (const l of lines) {
    // 예: "12." "12)" "12 " "(12)" "12-" 같은 패턴
    if (/^\(?\d{1,3}\)?[\.\)\-]?\s+/.test(l)) c++;
  }
  return c;
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

  // 영어줄 + 의미줄 (다음 1~3줄 탐색)
  for (let i = 0; i < cleaned.length; i++) {
    if (used[i]) continue;
    const a = cleaned[i];

    const enCand = normalizeENKeepPhrase(removeParenthesesAndBrackets(a));
    if (!isLikelyEnglishTerm(enCand)) continue;
    if (hasKorean(a)) continue;

    let j = i + 1;
    let hop = 0;

    while (j < cleaned.length && hop < 3) {
      if (used[j]) {
        j++;
        continue;
      }
      const b = cleaned[j];
      const koCand = normalizeKO(removeParenthesesAndBrackets(b));

      if (!hasKorean(b) || !isLikelyKoreanMeaning(koCand)) {
        j++;
        hop++;
        continue;
      }

      pairs.push({ term: enCand, meaning: koCand });
      used[i] = true;
      used[j] = true;
      break;
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

function computeDebugFromText(rawText, chosen, items, note = "") {
  const textLen = (rawText ?? "").length;
  const expected = estimateExpectedCountFromRawText(rawText);
  return {
    extractor: chosen, // "text" | "text+split2" | "text+split3" | "table" | "table+text"
    wordsCount: 0,
    textLen,
    itemCount: items.length,
    expectedHint: expected,
    note,
  };
}

/** ----------------- 이미지 분할 도우미 ----------------- */

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

  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, top, w, ch, 0, 0, w, ch);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
  });

  return blob || file;
}

/** ----------------- OCR 실행(텍스트) ----------------- */

async function runTesseractTextOnly(Tesseract, file, report) {
  const result = await Tesseract.recognize(file, "eng+kor", {
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
  const data = result?.data;
  const rawText = data?.text ? data.text : "";
  return { rawText, data };
}

function parseRawTextToItems(rawText) {
  const lines = (rawText ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trim())
    .filter(Boolean);

  const { pairs } = parseLinesToPairs(lines);
  return mergePairs(pairs);
}

/** ----------------- main ----------------- */

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

  // 1) 전체 OCR
  report("OCR 실행중...", 0.06);

  let data, rawText;
  try {
    const r1 = await runTesseractTextOnly(Tesseract, file, report);
    data = r1.data;
    rawText = r1.rawText;
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

  // 2) 표(2컬럼) 추출 우선
  let itemsTable = [];
  try {
    itemsTable = extractPairsFromTwoColumnTable(data) || [];
  } catch (e) {
    console.warn("table extract error:", e);
    itemsTable = [];
  }

  if (itemsTable.length >= 5) {
    report("완료", 1);
    return {
      items: itemsTable,
      debug: {
        extractor: "table",
        wordsCount: Array.isArray(data?.words) ? data.words.length : 0,
        textLen: (data?.text ?? "").length,
        itemCount: itemsTable.length,
      },
      rawText: data?.text ?? "",
    };
  }

  // 3) 텍스트 파싱(전체)
  const itemsText = parseRawTextToItems(rawText);

  // ✅ 분할 OCR 실행 여부를 "똑똑하게" 결정
  // - 짧은 단어장(번호 추정이 작음)에서는 분할 금지
  // - 번호 추정이 큰데(item 기대치 높음) item이 너무 적으면 분할
  const expected = estimateExpectedCountFromRawText(rawText);

  const isShortList = expected > 0 && expected <= 6; // 짧은 단어장
  const missingLikely =
    expected >= 10 && itemsText.length < Math.max(6, Math.floor(expected * 0.55)); // 누락 의심
  const veryFewAnyway = itemsText.length < 8 && expected >= 12; // 추가 안전장치

  if (!isShortList && (missingLikely || veryFewAnyway)) {
    // 3-1) 상/하 2분할
    report("인식 보강중(2분할)...", 0.86);
    const topBlob = await cropFileToBlob(file, 0.0, 0.52);
    const botBlob = await cropFileToBlob(file, 0.48, 1.0);

    const rTop = await runTesseractTextOnly(Tesseract, topBlob, (s, p) =>
      report(s, 0.86 + p * 0.06)
    );
    const rBot = await runTesseractTextOnly(Tesseract, botBlob, (s, p) =>
      report(s, 0.92 + p * 0.06)
    );

    const items2 = mergePairs([
      ...itemsText,
      ...parseRawTextToItems(rTop.rawText),
      ...parseRawTextToItems(rBot.rawText),
    ]);

    // 3분할은 "여전히 누락이 크다"가 명확할 때만
    const expected2 = Math.max(expected, estimateExpectedCountFromRawText(rTop.rawText) + estimateExpectedCountFromRawText(rBot.rawText));
    const stillMissing = expected2 >= 14 && items2.length < Math.floor(expected2 * 0.65);

    if (stillMissing) {
      report("인식 보강중(3분할)...", 0.94);
      const b1 = await cropFileToBlob(file, 0.0, 0.36);
      const b2 = await cropFileToBlob(file, 0.32, 0.68);
      const b3 = await cropFileToBlob(file, 0.64, 1.0);

      const r1 = await runTesseractTextOnly(Tesseract, b1, (s, p) => report(s, 0.94 + p * 0.02));
      const r2 = await runTesseractTextOnly(Tesseract, b2, (s, p) => report(s, 0.96 + p * 0.02));
      const r3 = await runTesseractTextOnly(Tesseract, b3, (s, p) => report(s, 0.98 + p * 0.02));

      const items3 = mergePairs([
        ...items2,
        ...parseRawTextToItems(r1.rawText),
        ...parseRawTextToItems(r2.rawText),
        ...parseRawTextToItems(r3.rawText),
      ]);

      report("완료", 1);
      return {
        items: items3,
        debug: computeDebugFromText(
          [rawText, rTop.rawText, rBot.rawText, r1.rawText, r2.rawText, r3.rawText].join("\n"),
          "text+split3",
          items3,
          "split3 only when missing likely"
        ),
        rawText: [rawText, rTop.rawText, rBot.rawText, r1.rawText, r2.rawText, r3.rawText].join("\n"),
      };
    }

    report("완료", 1);
    return {
      items: items2,
      debug: computeDebugFromText(
        [rawText, rTop.rawText, rBot.rawText].join("\n"),
        "text+split2",
        items2,
        "split2 only when missing likely"
      ),
      rawText: [rawText, rTop.rawText, rBot.rawText].join("\n"),
    };
  }

  // table이 조금이라도 있으면 text 결과와 합쳐서 보강
  const combined = mergePairs([...(itemsTable || []), ...(itemsText || [])]);

  report("완료", 1);
  return {
    items: combined,
    debug: computeDebugFromText(rawText, itemsTable.length ? "table+text" : "text", combined, "no split"),
    rawText,
  };
}
