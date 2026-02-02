// src/lib/ocr_table_extract.js
// DJJG 단찍공: 표(좌/우 컬럼) 기반 단어장 추출기
// 입력: tesseract result.data (words 포함)
// 출력: [{ term, meaning }]
//
// ✅ fromLang/toLang 옵션 지원 (EN-KO 하드코딩 제거)
// ✅ KO/JA/ES/EN 조합에 따라 좌/우 컬럼 텍스트가 해당 언어처럼 보이는지 검사
// ✅ 비라틴(KO/JA)은 과도한 정제 금지(원문 보존) / 라틴(EN/ES)은 발음/품사 토큰 등 정제

function normSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
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

function removePronAndMarksLatin(term) {
  let t = normSpace(term);

  // remove [pron] blocks and /pron/ blocks
  t = t.replace(/\[[^\]]+\]/g, " ");
  t = t.replace(/\/[^/]+\/+?/g, " "); // tolerate multiple slashes

  // remove stars/bullets
  t = t.replace(/[*•·]+/g, " ");

  // remove leading index "1", "2", ...
  t = t.replace(/^\(?\d+\)?\s+/g, "");

  // remove trailing POS tokens (phr., v., n., a., adj., adv. 등)
  t = t.replace(/\s+(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num)\.?\s*$/i, "");

  // keep letters, spaces, hyphen, apostrophe, spanish accents
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'\-]/g, " ");
  t = normSpace(t);

  // lowercase except acronyms
  if (/^[A-Z]{2,}(?:\s+[A-Z]{2,})*$/.test(t)) return t;
  if (t === "I") return t;
  return t.toLowerCase();
}

function cleanMeaning(meaning) {
  let m = normSpace(meaning);

  // remove leading POS tokens like "v." "n." "a." "phr."
  m = m.replace(/^(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num)\.?\s+/i, "");

  // remove stray stars
  m = m.replace(/[*•·]+/g, " ");

  return normSpace(m);
}

function cleanTermByLang(term, fromLang) {
  const t = normSpace(term);
  if (!t) return t;

  // 비라틴은 원문을 보존(기호/인덱스만 약하게 정리)
  if (fromLang === "KO" || fromLang === "JA") {
    return normSpace(
      t
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/\/[^/]+\/+?/g, " ")
        .replace(/^[\s•·\-–—~]*\d+[\.\)]\s*/g, "")
        .replace(/^[\s•·\-–—~]+/g, "")
        .replace(/[*•·]+/g, " ")
    );
  }

  // EN/ES는 라틴 정제 적용
  return removePronAndMarksLatin(t);
}

function looksLikeLang(text, lang) {
  const s = normSpace(text);
  if (!s) return false;

  if (lang === "KO") return hasHangul(s);
  if (lang === "JA") return hasJapanese(s);
  if (lang === "ES") return hasSpanishHint(s) || hasLatinBasic(s);
  // EN 포함 라틴
  return hasLatinBasic(s);
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
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
      return {
        text: String(w.text),
        x0,
        x1,
        y0,
        y1,
        xc: (x0 + x1) / 2,
        yc: (y0 + y1) / 2,
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
  // collect x centers; for a 2-column layout, there’s usually a gap in the middle.
  const xcs = [];
  for (const r of rows) {
    for (const w of r.words) xcs.push(w.xc);
  }
  if (!xcs.length) return 0;

  // heuristic: use median as base
  const xMed = median(xcs);

  // refine: try to find biggest gap around median
  const sorted = [...xcs].sort((a, b) => a - b);
  let bestGap = 0;
  let bestSplit = xMed;
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1];
    const right = sorted[i];
    const gap = right - left;
    const mid = (left + right) / 2;
    if (Math.abs(mid - xMed) < xMed * 0.25 && gap > bestGap) {
      bestGap = gap;
      bestSplit = mid;
    }
  }
  return bestSplit;
}

function rowText(words) {
  return normSpace((words || []).map((w) => w.text).join(" "));
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

    // ✅ 언어 조합 기반으로 좌/우 검증
    if (!looksLikeLang(leftText, fromLang)) continue;
    if (!looksLikeLang(rightText, toLang)) continue;

    const term = cleanTermByLang(leftText, fromLang);
    const meaning = cleanMeaning(rightText);

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
