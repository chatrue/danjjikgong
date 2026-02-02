// src/lib/ocr_table_extract.js
// DJJG 단찍공: 표(좌/우 컬럼) 기반 단어장 추출기
// 입력: tesseract result.data (words 포함)
// 출력: [{ term, meaning }]
//
// ✅ fromLang/toLang 옵션 지원 (EN-KO 하드코딩 제거)
// ✅ KO/JA/ES/EN 조합에 따라 좌/우 컬럼 텍스트가 해당 언어처럼 보이는지 검사
// ✅ 비라틴(KO/JA)은 과도한 정제 금지(원문 보존) / 라틴(EN/ES)은 발음/품사 토큰 등 정제
// ✅ (추가) IPA 찌꺼기 라틴 조각(rd, sf, dabl 등) term 끝에서 제거
// ✅ (추가) KO 뜻 앞에 붙는 라틴 찌꺼기/동그라미 표식 제거

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

  let parts = t.split(" ").filter(Boolean);
  if (parts.length <= 1) return t;

  const isSuspicious = (tok) => {
    const s = tok.toLowerCase();
    if (LATIN_SHORT_ALLOW.has(s)) return false;

    const len = s.length;
    if (len <= 1) return true;

    const v = countVowels(s);

    // rd, sf 같은 IPA 찌꺼기 (모음 0개, 짧음)
    if (len <= 4 && v === 0) return true;

    // dabl 같은 찌꺼기: 모음이 0~1개이고 짧은 경우
    if (len <= 6 && v <= 1 && /^[a-z]+$/i.test(tok)) {
      return true;
    }

    return false;
  };

  // 마지막 토큰이 찌꺼기로 의심되면 1~2개까지 제거
  for (let k = 0; k < 2 && parts.length > 1; k++) {
    const last = parts[parts.length - 1];
    if (!isSuspicious(last)) break;
    parts.pop();
  }

  return normSpace(parts.join(" "));
}

function hasHangul(s) {
  return /[가-힣]/.test(s ?? "");
}
function hasJapanese(s) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s ?? "");
}
function hasLatinBasic(s) {
  return /[A-Za-z]/.test(s ?? "");
}
function hasSpanishHint(s) {
  return /[áéíóúüñÁÉÍÓÚÜÑ]/.test(s ?? "");
}

function looksLikeLang(text, lang) {
  // 리더/기호 제거 후 판정(점선/표 기호 때문에 언어판정이 흔들리는 것 방지)
  const s0 = normSpace(text);
  if (!s0) return false;
  const s = s0.replace(/[\.\-·•_–—=]/g, "");
  const ss = normSpace(s);

  if (lang === "KO") return hasHangul(ss);
  if (lang === "JA") return hasJapanese(ss);
  if (lang === "ES") return hasSpanishHint(ss) || hasLatinBasic(ss);
  return hasLatinBasic(ss);
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 점선/구분선(리더) 토큰 판정
 * 예) "......", "-----", "····", "____", "— — —", ". . . . ."
 */
function isLeaderLikeText(text) {
  const s = normSpace(text);
  if (!s) return false;

  // 공백 제거 후 특정 기호로만 이루어졌는지
  const compact = s.replace(/\s+/g, "");
  if (/^[\.\-·•_–—=]{3,}$/.test(compact)) return true;

  // ". . . . ." 형태
  if (/^(?:[.\-·•_–—=]\s*){6,}$/.test(s)) return true;

  return false;
}

function removePronAndMarksLatin(term) {
  let t = normSpace(term);

  // remove [pron] blocks and /pron/ blocks
  t = t.replace(/\[[^\]]+\]/g, " ");
  t = t.replace(/\/[^/]+\/+?/g, " "); // tolerate multiple slashes

  // remove stars/bullets
  t = t.replace(/[*•·]+/g, " ");

  // remove leading index "1", "(2)", "3."
  t = t.replace(/^\(?\d+\)?\.?\s+/g, "");

  // remove leading leaders (....., ---- 등)
  t = t.replace(/^[\.\-·•_–—=]{3,}\s*/g, " ");

  // remove trailing POS tokens (phr., v., n., a., adj., adv. 등)
  t = t.replace(/\s+(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num|vt|vi)\.?\s*$/i, "");

  // keep letters, spaces, hyphen, apostrophe, spanish accents
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'\-]/g, " ");
  t = normSpace(t);

  // lowercase except acronyms
  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return stripTrailingJunkTokensLatin(t);
  if (t === "I") return t;
  const cleaned = t.toLowerCase();
  return stripTrailingJunkTokensLatin(cleaned);
}

function cleanMeaning(meaning, toLang) {
  let m = normSpace(meaning);

  // remove leading POS tokens like "v." "n." "a." "phr."
  m = m.replace(/^(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num|vt|vi)\.?\s+/i, "");
  m = m.replace(/^(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num|vt|vi)\s*\.\s*/i, "");

  // remove stray stars/bullets
  m = m.replace(/[*•·]+/g, " ");

  // KO 모드: 뜻 앞에 붙는 라틴 찌꺼기(dabl, rd 등) / 동그라미 표식 제거
  if (toLang === "KO") {
    m = m.replace(/^[○●◦ㅇoO]+\s*/g, "");
    // 라틴 찌꺼기 토큰 1~2개 제거 (뒤에 한글이 있는 경우만)
    if (/[가-힣]/.test(m)) {
      m = m.replace(/^(?:[A-Za-z]{1,6}\s+){1,2}/, "");
    }
  }

  // trailing leaders
  m = m.replace(/\s*[\.\-·•_–—=]{3,}$/g, "");

  return normSpace(m);
}

function cleanTermByLang(term, fromLang) {
  const t = normSpace(term);
  if (!t) return t;

  // 비라틴은 원문을 보존(기호/인덱스/리더만 약하게 정리)
  if (fromLang === "KO" || fromLang === "JA") {
    return normSpace(
      t
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/\/[^/]+\/+?/g, " ")
        .replace(/^[\s•·\-–—~]*\d+[\.\)]\s*/g, "")
        .replace(/^[\s•·\-–—~]+/g, "")
        .replace(/^[\.\-·•_–—=]{3,}\s*/g, "") // leading leaders
        .replace(/[*•·]+/g, " ")
        .replace(/\s*[\.\-·•_–—=]{3,}$/g, "") // trailing leaders
    );
  }

  // EN/ES는 라틴 정제 + IPA 찌꺼기 토큰 제거 적용
  return removePronAndMarksLatin(t);
}

/**
 * 1D k-means (k=2) for x-centers
 * gap이 무너지거나(리더로 채워짐) 중앙이 애매할 때 splitX를 안정적으로 잡음
 */
function kmeans2SplitX(xcs) {
  if (!xcs || xcs.length < 6) return median(xcs || []);

  const xs = [...xcs].sort((a, b) => a - b);
  const p25 = xs[Math.floor(xs.length * 0.25)];
  const p75 = xs[Math.floor(xs.length * 0.75)];
  let c1 = p25;
  let c2 = p75;

  for (let it = 0; it < 10; it++) {
    const g1 = [];
    const g2 = [];
    for (const x of xs) {
      if (Math.abs(x - c1) <= Math.abs(x - c2)) g1.push(x);
      else g2.push(x);
    }
    if (!g1.length || !g2.length) break;

    const m1 = g1.reduce((a, b) => a + b, 0) / g1.length;
    const m2 = g2.reduce((a, b) => a + b, 0) / g2.length;

    if (Math.abs(m1 - c1) < 0.001 && Math.abs(m2 - c2) < 0.001) break;
    c1 = m1;
    c2 = m2;
  }

  const left = Math.min(c1, c2);
  const right = Math.max(c1, c2);
  return (left + right) / 2;
}

function groupIntoRows(words) {
  // row grouping by y-center with tolerance
  const items = (words || [])
    .filter((w) => w && w.text && w.bbox)
    .map((w) => {
      const x0 = w.bbox.x0 ?? w.bbox.left ?? 0;
      const x1 = w.bbox.x1 ?? w.bbox.right ?? 0;
      const y0 = w.bbox.y0 ?? w.bbox.top ?? 0;
      const y1 = w.bbox.y1 ?? w.bbox.bottom ?? 0;

      const text = String(w.text);
      return {
        text,
        x0,
        x1,
        y0,
        y1,
        xc: (x0 + x1) / 2,
        yc: (y0 + y1) / 2,
        isLeader: isLeaderLikeText(text),
      };
    })
    .filter((w) => normSpace(w.text));

  // sort by y then x
  items.sort((a, b) => a.yc - b.yc || a.xc - b.xc);

  // tolerance: estimate from median height
  const heights = items.map((w) => Math.max(1, w.y1 - w.y0));
  const hMed = median(heights) || 16;
  const tol = Math.max(8, hMed * 0.6);

  const rows = [];
  for (const w of items) {
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push({ yc: w.yc, words: [w] });
      continue;
    }
    if (Math.abs(w.yc - last.yc) <= tol) {
      last.words.push(w);
      // update row center
      last.yc = (last.yc * (last.words.length - 1) + w.yc) / last.words.length;
    } else {
      rows.push({ yc: w.yc, words: [w] });
    }
  }

  // sort words inside each row by x
  for (const r of rows) {
    r.words.sort((a, b) => a.xc - b.xc);
  }
  return rows;
}

function estimateColumnSplitX(rows) {
  // 리더 토큰 제외하고 x centers 수집
  const xcs = [];
  for (const r of rows) {
    for (const w of r.words) {
      if (w.isLeader) continue;
      xcs.push(w.xc);
    }
  }
  if (!xcs.length) return 0;

  const xMed = median(xcs);

  // gap 기반 split(기본)
  const sorted = [...xcs].sort((a, b) => a - b);
  const minX = sorted[0];
  const maxX = sorted[sorted.length - 1];
  const range = Math.max(1, maxX - minX);

  let bestGap = 0;
  let bestSplit = xMed;

  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1];
    const right = sorted[i];
    const gap = right - left;
    const mid = (left + right) / 2;

    // 중앙 근처에서만 gap 탐색
    if (Math.abs(mid - xMed) < range * 0.25 && gap > bestGap) {
      bestGap = gap;
      bestSplit = mid;
    }
  }

  // gap이 충분히 크지 않으면(리더로 중앙이 채워짐 등) k-means로 splitX 재추정
  const gapThreshold = range * 0.08; // 경험치: 8% 미만이면 gap 신뢰 낮음
  if (bestGap < gapThreshold) {
    return kmeans2SplitX(xcs);
  }

  return bestSplit;
}

function rowText(words) {
  // row 텍스트 생성 시 리더 제외
  return normSpace(
    (words || [])
      .filter((w) => !w.isLeader)
      .map((w) => w.text)
      .join(" ")
  );
}

export function extractPairsFromTwoColumnTable(tessData, opt = {}) {
  const { fromLang = "EN", toLang = "KO" } = opt || {};

  const words = tessData?.words || [];
  const rows = groupIntoRows(words);
  if (!rows.length) return [];

  const splitX = estimateColumnSplitX(rows);

  const pairs = [];
  for (const r of rows) {
    const left = r.words.filter((w) => w.xc < splitX);
    const right = r.words.filter((w) => w.xc >= splitX);

    const leftText = rowText(left);
    const rightText = rowText(right);

    if (!leftText && !rightText) continue;

    // 언어 조합 기반으로 좌/우 검증
    if (!looksLikeLang(leftText, fromLang)) continue;
    if (!looksLikeLang(rightText, toLang)) continue;

    const term = cleanTermByLang(leftText, fromLang);
    const meaning = cleanMeaning(rightText, toLang);

    if (!term || !meaning) continue;
    if (term.length < 1) continue;

    pairs.push({ term, meaning });
  }

  // de-duplicate by term (라틴은 소문자, 비라틴은 원문 기준)
  const map = new Map();
  for (const p of pairs) {
    const key = fromLang === "KO" || fromLang === "JA" ? p.term : p.term.toLowerCase();
    if (!map.has(key)) map.set(key, p);
  }
  return Array.from(map.values());
}
