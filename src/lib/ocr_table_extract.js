// src/lib/ocr_table_extract.js
// DJJG 단찍공: 표(좌/우 컬럼) 기반 단어장 추출기
// 입력: tesseract result.data (words 포함)
// 출력: [{ term, meaning }]

function normSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function removePronAndMarks(term) {
  let t = normSpace(term);

  // remove [pron] blocks and /pron/ blocks
  t = t.replace(/\[[^\]]+\]/g, " ");
  t = t.replace(/\/[^/]+\/+/g, " ");

  // remove stars/bullets
  t = t.replace(/[*•·]+/g, " ");

  // remove leading index "1", "2", ...
  t = t.replace(/^\(?\d+\)?\s+/g, "");

  // remove trailing POS tokens (phr., v., n., a., adj., adv. 등)
  t = t.replace(/\s+(phr|ph|v|n|a|adj|adv|prep|conj|pron|det|num)\.?\s*$/i, "");

  // keep letters, spaces, hyphen, apostrophe
  t = t.replace(/[^A-Za-z\s'\-]/g, " ");
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

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function groupIntoRows(words) {
  // row grouping by y-center with tolerance
  const items = words
    .filter(w => w && w.text && w.bbox)
    .map(w => {
      const x0 = w.bbox.x0 ?? w.bbox.left ?? 0;
      const x1 = w.bbox.x1 ?? w.bbox.right ?? 0;
      const y0 = w.bbox.y0 ?? w.bbox.top ?? 0;
      const y1 = w.bbox.y1 ?? w.bbox.bottom ?? 0;
      return {
        text: String(w.text),
        x0, x1, y0, y1,
        xc: (x0 + x1) / 2,
        yc: (y0 + y1) / 2,
      };
    })
    .filter(w => normSpace(w.text));

  // sort by y then x
  items.sort((a, b) => (a.yc - b.yc) || (a.xc - b.xc));

  // tolerance: estimate from median height
  const heights = items.map(w => Math.max(1, w.y1 - w.y0));
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

  // heuristic: use median as base, then push split slightly right (because left column is shorter)
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
    if (Math.abs(mid - xMed) < (xMed * 0.25) && gap > bestGap) {
      bestGap = gap;
      bestSplit = mid;
    }
  }
  return bestSplit;
}

function rowText(words) {
  return normSpace(words.map(w => w.text).join(" "));
}

export function extractPairsFromTwoColumnTable(tessData) {
  const words = tessData?.words || [];
  const rows = groupIntoRows(words);
  if (!rows.length) return [];

  const splitX = estimateColumnSplitX(rows);

  const pairs = [];
  for (const r of rows) {
    const left = r.words.filter(w => w.xc < splitX);
    const right = r.words.filter(w => w.xc >= splitX);

    const leftText = rowText(left);
    const rightText = rowText(right);

    // skip header-like rows
    if (!leftText && !rightText) continue;

    // left column must look like English term line
    // (this table has indices: 1,2,3... so leftText often starts with digit)
    if (!/[A-Za-z]/.test(leftText)) continue;
    if (!/[가-힣]/.test(rightText)) continue;

    const term = removePronAndMarks(leftText);
    const meaning = cleanMeaning(rightText);

    if (!term || !meaning) continue;
    if (term.length < 2) continue;

    pairs.push({ term, meaning });
  }

  // de-duplicate by term
  const map = new Map();
  for (const p of pairs) {
    const key = p.term.toLowerCase();
    if (!map.has(key)) map.set(key, p);
  }
  return Array.from(map.values());
}
