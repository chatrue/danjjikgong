import Tesseract from "tesseract.js";

// -------------------- 문자 비율 유틸 --------------------
function ratio(re, s) {
  if (!s) return 0;
  const m = s.match(re);
  return (m ? m.length : 0) / Math.max(1, s.length);
}

// -------------------- term 정리/노이즈 판단 --------------------
function cleanTerm(raw) {
  let t = (raw ?? "").trim();

  // 따옴표 통일
  t = t.replace(/[“”"]/g, '"');
  t = t.replace(/[‘’]/g, "'");

  // 흔한 OCR 쓰레기 기호 제거/완화
  t = t.replace(/[|¦]/g, "");
  t = t.replace(/[•·●■◆▶▷]/g, " ");
  t = t.replace(/[~^*_+=<>\\]/g, " ");

  // 앞뒤 구두점 제거
  t = t.replace(/^[\s\.\,\:\;\-\—\(\)\[\]\{\}]+/g, "");
  t = t.replace(/[\s\.\,\:\;\-\—\(\)\[\]\{\}]+$/g, "");

  // 연속 공백 정리
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function hasTooManySymbols(s) {
  const t = (s ?? "").trim();
  if (!t) return true;
  const bad = ratio(/[^A-Za-z0-9\s'’"\-\.\(\)]/g, t); // 허용 외 문자 비율
  return bad > 0.18;
}

// -------------------- 대문자/혼합 대소문자 정리 --------------------
// 목표: OCR이 만들어낸 지저분한 대소문자를 "보기 좋은" 형태로 정리
// - 기본은 소문자
// - 2~5글자 약어(USA/UN 등)는 유지
// - 숙어도 소문자 기반으로 정리(약어 토큰만 유지)
// - 단독 I는 대문자 복원
function normalizeTermCase(term) {
  let t = (term ?? "").trim();
  if (!t) return t;

  // 토큰 단위로 처리 (숙어/표현 지원)
  const tokens = t.split(/\s+/).filter(Boolean).map((tok) => {
    const letters = tok.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 2 && letters.length <= 5 && letters === letters.toUpperCase()) {
      // 약어로 보이면 유지
      return tok;
    }
    // 그 외는 소문자로
    return tok.toLowerCase();
  });

  t = tokens.join(" ");

  // 단독 I 복원
  t = t.replace(/\bi\b/g, "I");

  return t;
}

// -------------------- 영어 term 판별 --------------------
function isLikelyEnglishTerm(s) {
  const t = cleanTerm(s);
  if (!t) return false;

  // 노이즈 기호 과다
  if (hasTooManySymbols(t)) return false;

  // 예문처럼 너무 긴 문장 제거
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return false;

  const en = ratio(/[A-Za-z]/g, t);
  const ko = ratio(/[가-힣]/g, t);

  if (ko > 0.1) return false;
  if (en < 0.35) return false;

  // 번호/페이지 같은 것 제외
  if (/^\d+(\.|\/|\)|\s)*$/.test(t)) return false;

  return true;
}

// -------------------- 한글 meaning 정리/판별 --------------------
function cleanMeaning(s) {
  let t = (s ?? "").trim();

  // 번호 제거
  t = t.replace(/^\s*(\d+[\)\.\:]\s*)+/g, "");

  // 품사 제거 (n. v. adj. adv. ...)
  t = t.replace(/^\s*(n|v|adj|adv|prep|conj|pron)\.?\s+/i, "");

  // 불릿 제거
  t = t.replace(/[•·●■◆▶▷]/g, " ");

  // 공백 정리
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function isLikelyKoreanMeaning(s) {
  const t = cleanMeaning(s);
  if (!t) return false;

  const ko = ratio(/[가-힣]/g, t);
  const en = ratio(/[A-Za-z]/g, t);

  // 너무 긴 문장은 예문 가능성↑
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 12) return false;

  if (ko < 0.25) return false;
  if (en > 0.35) return false;

  return true;
}

// -------------------- 페어 추출 --------------------
function extractPairsFromLines(lines) {
  const pairs = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 1) 구분자 기반: "term - meaning" / "term : meaning"
    const sep = line.match(/^(.+?)\s*[:\-—=]\s*(.+)$/);
    if (sep) {
      const left = sep[1].trim();
      const right = sep[2].trim();

      const term0 = normalizeTermCase(cleanTerm(left));
      const meaning = cleanMeaning(right);

      if (isLikelyEnglishTerm(term0) && isLikelyKoreanMeaning(meaning)) {
        pairs.push({ term: term0, meaning });
        continue;
      }
    }

    // 2) 같은 줄 안에 영어+한글 섞여 있을 때
    const enChunk = line.match(/[A-Za-z][A-Za-z0-9'’"\-\.\s]{1,60}/);
    const koChunk = line.match(/[가-힣][가-힣\s\(\)\/,\.]{1,100}/);

    if (enChunk && koChunk) {
      const term0 = normalizeTermCase(cleanTerm(enChunk[0]));
      const meaning = cleanMeaning(koChunk[0]);

      if (isLikelyEnglishTerm(term0) && isLikelyKoreanMeaning(meaning)) {
        pairs.push({ term: term0, meaning });
      }
    }
  }

  // 중복 제거(term 기준, 소문자)
  const seen = new Set();
  const uniq = [];
  for (const p of pairs) {
    const key = (p.term ?? "").trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  return uniq;
}

// -------------------- 품질 체크 --------------------
function qualityCheck(items) {
  const n = items.length;
  const suspectLowCount = n < 3;
  const suspectNoEnglish = !items.some((x) => ratio(/[A-Za-z]/g, x.term) > 0.2);
  const suspectNoKorean = !items.some((x) => ratio(/[가-힣]/g, x.meaning) > 0.2);
  return { suspectLowCount, suspectNoEnglish, suspectNoKorean };
}

// -------------------- 메인 OCR 함수 --------------------
export async function runOCRAndExtract(file, onProgress) {
  const res = await Tesseract.recognize(file, "eng+kor", {
    logger: (m) => {
      if (onProgress && typeof m.progress === "number") {
        const label =
          m.status === "recognizing text" ? "텍스트 인식중..." :
          m.status === "loading tesseract core" ? "엔진 로딩중..." :
          m.status === "initializing tesseract" ? "초기화중..." :
          m.status === "loading language traineddata" ? "언어 데이터 로딩중..." :
          "처리중...";
        onProgress(label, m.progress);
      }
    },
  });

  const text = res?.data?.text ?? "";
  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  let items = extractPairsFromLines(lines);

  if (items.length > 80) items = items.slice(0, 80);

  return { items, quality: qualityCheck(items) };
}
