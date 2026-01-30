import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadState, saveState, uid } from "./lib/store.js";
import { runOCRAndExtract } from "./lib/ocr_extract.js";
import { speakEN, stopSpeak } from "./lib/tts.js";
import { buildQuiz } from "./lib/quiz.js";

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function blobToDataURL(blob) {
  return fileToDataURL(blob);
}

/**
 * ✅ A) OCR 전에 이미지 리사이즈(모바일 안정성 핵심)
 * - maxWidth: 1200 권장
 * - quality: 0.8 권장
 * - EXIF 회전 처리: createImageBitmap의 imageOrientation 옵션 사용(지원 브라우저)
 */
async function resizeImageForOCR(file, { maxWidth = 1200, quality = 0.8 } = {}) {
  // file: File or Blob
  const type = "image/jpeg";

  // 1) decode
  let bitmap = null;
  try {
    // 일부 브라우저 지원
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // fallback
    bitmap = await createImageBitmap(file);
  }

  const w = bitmap.width;
  const h = bitmap.height;

  // 이미 충분히 작으면 그대로 사용
  if (w <= maxWidth) {
    // 그래도 DataURL은 필요(미리보기)
    const dataUrl = await fileToDataURL(file);
    return { blob: file, dataUrl };
  }

  const scale = maxWidth / w;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext("2d");

  ctx.drawImage(bitmap, 0, 0, nw, nh);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });

  if (!blob) {
    // toBlob 실패 시 원본
    const dataUrl = await fileToDataURL(file);
    return { blob: file, dataUrl };
  }

  const dataUrl = await blobToDataURL(blob);
  return { blob, dataUrl };
}

function formatKoreanDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function normalizeKeyTerm(term) {
  return (term ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeMeaning(m) {
  return (m ?? "").trim().replace(/\s+/g, " ");
}

function isMergedSet(set) {
  return set?.title === "합친 단어장" || (set?.meta && Array.isArray(set.meta.mergedFrom));
}

function defaultNameForSet(set) {
  return isMergedSet(set) ? "합친 단어장" : "단어장";
}

// ---- 주관식 정답 판정 A (이전 합의) ----
function normEN(s) {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[-_./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normKO(s) {
  return (s ?? "").trim().replace(/\s+/g, " ").trim();
}
function splitMeaningCandidates(s) {
  const raw = normKO(s);
  if (!raw) return [];
  const noParen = raw.replace(/\([^)]*\)/g, "").trim();
  const parts = noParen
    .split(/[\/,;·=]/g)
    .map((x) => normKO(x))
    .filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  return uniq.length ? uniq : [noParen];
}
function isCorrectWrittenA({ kind, answer, user }) {
  const a = (answer ?? "").toString();
  const u = (user ?? "").toString();

  if (kind === "enToKo" || kind === "listenToKo") {
    const aCands = splitMeaningCandidates(a);
    const uCands = splitMeaningCandidates(u);
    if (!aCands.length || !uCands.length) return { correct: false, caseFix: false };
    for (const uc of uCands) {
      const nuk = normKO(uc);
      for (const ac of aCands) {
        if (nuk === normKO(ac)) return { correct: true, caseFix: false };
      }
    }
    return { correct: false, caseFix: false };
  }

  const na = normEN(a);
  const nu = normEN(u);
  const correct = na && nu && na === nu;

  const caseFix =
    correct &&
    (a.trim() !== u.trim()) &&
    (a.trim().toLowerCase() === u.trim().toLowerCase());

  return { correct, caseFix };
}

export default function App() {
  const [db, setDb] = useState(() => loadState());
  const [route, setRoute] = useState({ name: "home" });
  const [ocrProgress, setOcrProgress] = useState(null);

  // draft: { imageURL, items, quality, rawText }
  const [draft, setDraft] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState([]);

  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelected, setMergeSelected] = useState(() => new Set());
  const [mergeTitle, setMergeTitle] = useState("");

  const [createTitle, setCreateTitle] = useState("");
  const [createItems, setCreateItems] = useState([{ term: "", meaning: "" }]);
  const lastRouteRef = useRef(null);

  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);

  const timerRef = useRef(null);

  const currentSet = useMemo(() => {
    if (route.name !== "setDetail") return null;
    return db.sets.find((s) => s.id === route.setId) || null;
  }, [route, db]);

  useEffect(() => {
    if (!currentSet) return;
    setEditMode(false);
    setEditItems((currentSet.items ?? []).map((x) => ({ term: x.term ?? "", meaning: x.meaning ?? "" })));
  }, [currentSet?.id]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!renamingId) return;
    setTimeout(() => {
      try {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      } catch {}
    }, 0);
  }, [renamingId]);

  function persist(next) {
    setDb(next);
    saveState(next);
  }

  function go(name, extra = {}) {
    if (name === "create") lastRouteRef.current = route;

    if (name !== "setDetail") {
      setEditMode(false);
      setEditItems([]);
    }

    if (name !== "sets") {
      setMergeMode(false);
      setMergeSelected(new Set());
      setMergeTitle("");
      setRenamingId(null);
      setRenameValue("");
    }

    if (name !== "preview") setShowRaw(false);

    setRoute({ name, ...extra });
  }

  function goHome() {
    stopSpeak();
    go("home");
  }

  function Header({ right }) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>DJJG 단찍공</div>
        {right === "settings" ? (
          <button className="iconbtn" aria-label="설정" onClick={() => go("settings")}>
            ⚙️
          </button>
        ) : (
          <button className="iconbtn" aria-label="홈" onClick={goHome}>
            🏠
          </button>
        )}
      </div>
    );
  }

  function ScreenTitle({ title }) {
    return <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10, textAlign: "center" }}>{title}</div>;
  }

  // ✅ A+B 핵심: 리사이즈 후 OCR, 실패해도 preview로
  async function handlePickImage(file) {
    if (!file) return;

    setOcrProgress({ status: "이미지 준비중...", p: 0 });
    try {
      // 1) 리사이즈 + 미리보기 URL 생성
      setOcrProgress({ status: "이미지 최적화중...", p: 0.05 });
      const { blob, dataUrl } = await resizeImageForOCR(file, { maxWidth: 1200, quality: 0.8 });

      // 2) OCR 실행(최적화된 blob 사용)
      setOcrProgress({ status: "인식 준비중...", p: 0.12 });

      const { items, quality, rawText } = await runOCRAndExtract(blob, (pText, pVal) => {
        setOcrProgress({ status: pText, p: pVal });
      });

      setDraft({
        imageURL: dataUrl,      // 최적화된 이미지로 미리보기(안정적)
        items: items ?? [],
        quality: quality ?? {},
        rawText: rawText ?? "",
      });
      setDraftTitle("");
      setShowRaw(false);
      setOcrProgress(null);
      go("preview");
    } catch (e) {
      console.error(e);

      // ✅ B: 완전 실패해도 preview로 보내서 직접 입력 가능하게
      let fallbackUrl = "";
      try {
        fallbackUrl = await fileToDataURL(file);
      } catch {}

      setDraft({
        imageURL: fallbackUrl,
        items: [],
        quality: { ocrFailed: true },
        rawText: "",
      });
      setDraftTitle("");
      setShowRaw(false);
      setOcrProgress(null);
      go("preview");
    }
  }

  function saveDraftAsSet() {
    const cleaned = (draft?.items ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term || x.meaning);

    const title = (draftTitle ?? "").trim() || "단어장";
    const set = { id: uid(), title, createdAt: Date.now(), items: cleaned };
    persist({ ...db, sets: [set, ...db.sets] });

    setDraft(null);
    setDraftTitle("");
    setShowRaw(false);
    go("setDetail", { setId: set.id });
  }

  function startQuizFromSet(set, mode) {
    const vocab = (set.items ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term && x.meaning);

    if (vocab.length === 0) {
      alert("단어/뜻이 비어있어요. 먼저 수정 후 학습해 주세요.");
      return;
    }

    const questions = buildQuiz(vocab, { mode });
    go("quiz", { setId: set.id, questions, vocab, qIndex: 0, last: null, showSheet: false });
  }

  function deleteSet(setId) {
    if (!confirm("이 단어장을 삭제할까요?")) return;
    persist({ ...db, sets: db.sets.filter((s) => s.id !== setId) });
  }

  function startRename(set) {
    setRenamingId(set.id);
    setRenameValue(((set.title ?? "").trim()) || defaultNameForSet(set));
  }
  function cancelRename() {
    setRenamingId(null);
    setRenameValue("");
  }
  function commitRename(set) {
    const name = (renameValue ?? "").trim();
    const finalName = name || defaultNameForSet(set);
    const nextSets = db.sets.map((s) => (s.id === set.id ? { ...s, title: finalName } : s));
    persist({ ...db, sets: nextSets });
    setRenamingId(null);
    setRenameValue("");
  }

  function saveCreatedSet() {
    const title = (createTitle || "").trim() || "단어장";
    const cleaned = (createItems ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term || x.meaning);

    const set = { id: uid(), title, createdAt: Date.now(), items: cleaned };
    persist({ ...db, sets: [set, ...db.sets] });

    setCreateTitle("");
    setCreateItems([{ term: "", meaning: "" }]);

    go("setDetail", { setId: set.id });
  }

  // 합치기 중복 단어 자동 정리(이미 적용된 버전 유지)
  function mergeAndDedupeItems(items) {
    const map = new Map();
    for (const it of items) {
      const termRaw = (it?.term ?? "").trim();
      const meaningRaw = (it?.meaning ?? "").trim();
      if (!termRaw && !meaningRaw) continue;

      const key = normalizeKeyTerm(termRaw || "");
      if (!key) continue;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, { term: termRaw, meaning: meaningRaw });
        continue;
      }

      const a = normalizeMeaning(existing.meaning);
      const b = normalizeMeaning(meaningRaw);

      if (!b) continue;
      if (!a) {
        existing.meaning = meaningRaw;
        continue;
      }

      if (a.toLowerCase() === b.toLowerCase()) continue;

      const parts = existing.meaning.split(" / ").map((x) => normalizeMeaning(x)).filter(Boolean);
      const has = parts.some((p) => p.toLowerCase() === b.toLowerCase());
      if (!has) existing.meaning = `${existing.meaning} / ${meaningRaw}`;
    }
    return Array.from(map.values());
  }

  function mergeSelectedSets() {
    const ids = Array.from(mergeSelected);
    if (ids.length < 2) {
      alert("두 개 이상 선택해 주세요.");
      return;
    }

    const selectedSets = db.sets.filter((s) => ids.includes(s.id));
    const mergedItemsRaw = selectedSets.flatMap((s) => s.items ?? []);
    const mergedItems = mergeAndDedupeItems(mergedItemsRaw);

    const title = (mergeTitle ?? "").trim() || "합친 단어장";

    const merged = {
      id: uid(),
      title,
      createdAt: Date.now(),
      items: mergedItems,
      meta: { mergedFrom: ids },
    };

    let next = { ...db, sets: [merged, ...db.sets] };
    persist(next);

    const del = confirm("원본 단어장들을 삭제할까요?\n(취소하면 원본은 그대로 유지됩니다.)");
    if (del) {
      next = { ...next, sets: next.sets.filter((s) => !ids.includes(s.id)) };
      persist(next);
    }

    setMergeMode(false);
    setMergeSelected(new Set());
    setMergeTitle("");
    cancelRename();
    go("setDetail", { setId: merged.id });
  }

  // ---------------- HOME ----------------
  if (route.name === "home") {
    return (
      <div className="container">
        <div className="card">
          <Header right="settings" />
          <div className="col">
            <button className="btn" style={{ textAlign: "center" }} onClick={() => go("capture")}>
              단어장 찍기
            </button>
            <button className="btn secondary" style={{ textAlign: "center" }} onClick={() => go("create")}>
              단어장 직접 만들기
            </button>
            <button className="btn secondary" style={{ textAlign: "center" }} onClick={() => go("sets")}>
              이전 단어장
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- SETTINGS ----------------
  if (route.name === "settings") {
    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="설정" />
          <div className="col">
            <button
              className="btn secondary"
              onClick={() => {
                if (!confirm("저장된 단어장을 모두 삭제할까요?")) return;
                persist({ sets: [] });
                alert("초기화 완료");
              }}
              style={{ textAlign: "center" }}
            >
              데이터 초기화
            </button>
            <button className="btn" onClick={goHome} style={{ textAlign: "center" }}>
              닫기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- CREATE ----------------
  if (route.name === "create") {
    const goBack = () => {
      const prev = lastRouteRef.current;
      if (prev && prev.name) {
        stopSpeak();
        setRoute(prev);
      } else {
        goHome();
      }
    };

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="단어장 직접 만들기" />

          <div className="col">
            <div className="kv" style={{ marginBottom: 6, alignItems: "flex-end" }}>
              <div className="small">단어장 제목</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="iconbtn" onClick={goBack}>
                  뒤로가기
                </button>
                <button className="iconbtn" onClick={() => go("sets")}>
                  이전 단어장
                </button>
              </div>
            </div>

            <input
              className="input"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="예: 1월 1주차 단어"
            />

            <div className="hr" />

            <EditableList items={createItems} onChange={setCreateItems} onSpeak={speakEN} />

            <div className="stickyBottom">
              <div className="row">
                <button className="btn" onClick={saveCreatedSet} style={{ textAlign: "center" }}>
                  저장
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    if (!confirm("작성 중인 내용이 사라집니다. 홈으로 갈까요?")) return;
                    setCreateTitle("");
                    setCreateItems([{ term: "", meaning: "" }]);
                    goHome();
                  }}
                  style={{ textAlign: "center" }}
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- CAPTURE ----------------
  if (route.name === "capture") {
    const PickButton = ({ text, capture }) => (
      <label
        className={capture ? "btn" : "btn secondary"}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          userSelect: "none",
          textAlign: "center",
        }}
      >
        {text}
        <input
          type="file"
          accept="image/*"
          {...(capture ? { capture: "environment" } : {})}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            handlePickImage(f);
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
          }}
        />
      </label>
    );

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="단어장 찍기" />

          <div className="col">
            <div className="grid2">
              <PickButton text="사진 찍기" capture />
              <PickButton text="앨범에서 가져오기" />
            </div>

            {ocrProgress && (
              <div className="card" style={{ background: "#f9fafb" }}>
                <div className="small">{ocrProgress.status}</div>
                <div style={{ height: 10 }} />
                <progress value={ocrProgress.p} max={1} style={{ width: "100%" }} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------------- PREVIEW ----------------
  if (route.name === "preview") {
    const items = draft?.items || [];
    const q = draft?.quality || {};

    const warn =
      q.ocrFailed ||
      !items.length ||
      (q && (q.suspectLowCount || q.suspectNoKorean || q.suspectNoEnglish || q.suspectPairing));

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="인식 결과" />

          {warn ? (
            <div className="badgeWarn">
              {q.ocrFailed
                ? "OCR에 실패했어요. 아래에서 직접 단어를 추가/수정해서 저장할 수 있어요."
                : "인식 품질이 낮아 보입니다. 아래에서 수정/추가해 주세요."}
            </div>
          ) : (
            <div className="badgeOk">자동 추출 완료. 필요하면 수정해 주세요.</div>
          )}

          <div className="hr" />

          {/* 제목 입력 UI: Create와 동일한 간격/스타일 */}
          <div className="kv" style={{ marginBottom: 6, alignItems: "flex-end" }}>
            <div className="small">단어장 제목</div>
            <div />
          </div>
          <input
            className="input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="예: 단어장"
          />

          {/* ✅ B) 원문 보기(토글) */}
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <button className="iconbtn" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "원문 닫기" : "원문 보기"}
            </button>
          </div>

          {showRaw && (
            <div className="card" style={{ background: "#f9fafb" }}>
              <div className="small" style={{ marginBottom: 6 }}>
                OCR 원문(참고용)
              </div>
              <textarea
                className="input"
                value={draft?.rawText ?? ""}
                readOnly
                rows={8}
                style={{ width: "100%", resize: "vertical" }}
                placeholder="(원문이 없으면 OCR이 완전히 실패했을 수 있어요)"
              />
            </div>
          )}

          <div className="hr" />

          {draft?.imageURL && (
            <img
              src={draft.imageURL}
              alt="source"
              style={{ width: "100%", borderRadius: 14, border: "1px solid #eef2f7" }}
            />
          )}

          <div className="hr" />

          <EditableList
            items={items}
            onChange={(next) => setDraft({ ...draft, items: next })}
            onSpeak={speakEN}
          />

          <div className="stickyBottom">
            <div className="row">
              <button className="btn" onClick={saveDraftAsSet} style={{ textAlign: "center" }}>
                저장
              </button>
              <button className="btn secondary" onClick={() => go("capture")} style={{ textAlign: "center" }}>
                다시 찍기
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- SETS ----------------
  if (route.name === "sets") {
    function toggleSelect(id) {
      const next = new Set(mergeSelected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setMergeSelected(next);
    }

    const selectedCount = mergeSelected.size;

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="이전 단어장" />

          <div className="kv" style={{ marginBottom: 10, alignItems: "flex-end" }}>
            <div className="small">{mergeMode ? `${selectedCount}개 선택됨` : ""}</div>

            {!mergeMode ? (
              <button
                className="iconbtn"
                onClick={() => {
                  setMergeMode(true);
                  setMergeSelected(new Set());
                  setMergeTitle("");
                  cancelRename();
                }}
                style={{ textAlign: "center" }}
              >
                단어장 합치기
              </button>
            ) : (
              <div className="col" style={{ gap: 8, alignItems: "flex-end" }}>
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  value={mergeTitle}
                  onChange={(e) => setMergeTitle(e.target.value)}
                  placeholder="예: 합친 단어장"
                />
                <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                  <button className="iconbtn" onClick={mergeSelectedSets} style={{ textAlign: "center" }}>
                    합치기
                  </button>
                  <button
                    className="iconbtn"
                    onClick={() => {
                      setMergeMode(false);
                      setMergeSelected(new Set());
                      setMergeTitle("");
                    }}
                    style={{ textAlign: "center" }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="col">
            {db.sets.length === 0 ? (
              <div className="small">저장된 단어장이 없어요.</div>
            ) : (
              db.sets.map((s) => {
                const dt = formatKoreanDateTime(s.createdAt);
                const name = (s.title ?? "").trim() || defaultNameForSet(s);
                const isRenaming = renamingId === s.id;

                return (
                  <div key={s.id} className="card" style={{ background: "#fff" }}>
                    <div className="kv">
                      <div>
                        <div style={{ fontWeight: 900, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <span>{dt}</span>

                          {!isRenaming ? (
                            <button
                              onClick={() => startRename(s)}
                              title="이름 수정"
                              style={{
                                padding: 0,
                                border: "none",
                                background: "transparent",
                                font: "inherit",
                                fontWeight: 900,
                                cursor: "pointer",
                                textAlign: "left",
                              }}
                            >
                              {name}
                            </button>
                          ) : (
                            <input
                              ref={renameInputRef}
                              className="input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(s);
                                if (e.key === "Escape") cancelRename();
                              }}
                              onBlur={() => commitRename(s)}
                              placeholder={defaultNameForSet(s)}
                              style={{ maxWidth: 240 }}
                            />
                          )}
                        </div>

                        <div className="small">단어 {s.items.length}개</div>
                      </div>

                      {mergeMode ? (
                        <label className="row" style={{ gap: 8, alignItems: "center" }}>
                          <input type="checkbox" checked={mergeSelected.has(s.id)} onChange={() => toggleSelect(s.id)} />
                          <span className="small">선택</span>
                        </label>
                      ) : (
                        <div className="row">
                          <button className="iconbtn" onClick={() => go("setDetail", { setId: s.id })}>
                            열기
                          </button>
                          <button className="iconbtn" onClick={() => deleteSet(s.id)}>
                            삭제
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------------- SET DETAIL ----------------
  if (route.name === "setDetail" && currentSet) {
    function saveEdits() {
      const cleaned = (editItems ?? [])
        .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
        .filter((x) => x.term || x.meaning);

      const nextSets = db.sets.map((s) => (s.id === currentSet.id ? { ...s, items: cleaned } : s));
      persist({ ...db, sets: nextSets });
      setEditMode(false);
    }

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title={currentSet.title} />

          <div className="kv" style={{ marginBottom: 10 }}>
            <div className="pill">
              단어 {currentSet.items.length}개 · {formatKoreanDateTime(currentSet.createdAt)}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button className="iconbtn" disabled={editMode} onClick={() => startQuizFromSet(currentSet, "mcq")}>
                객관식
              </button>
              <button className="iconbtn" disabled={editMode} onClick={() => startQuizFromSet(currentSet, "written")}>
                주관식
              </button>

              {!editMode ? (
                <button className="iconbtn" onClick={() => setEditMode(true)}>
                  수정
                </button>
              ) : (
                <button className="iconbtn" onClick={saveEdits}>
                  저장
                </button>
              )}

              <button className="iconbtn" onClick={() => go("sets")}>
                이전 단어장
              </button>
            </div>
          </div>

          <div className="hr" />

          {!editMode ? (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>소리</th>
                  <th>영어</th>
                  <th>한글</th>
                </tr>
              </thead>
              <tbody>
                {currentSet.items.map((it, idx) => (
                  <tr key={idx}>
                    <td>
                      <button className="iconbtn" onClick={() => speakEN(it.term)}>
                        🔊
                      </button>
                    </td>
                    <td style={{ fontWeight: 800 }}>{it.term}</td>
                    <td>{it.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EditableList items={editItems} onChange={setEditItems} onSpeak={speakEN} />
          )}
        </div>
      </div>
    );
  }

  // ---------------- QUIZ ----------------
  if (route.name === "quiz") {
    return (
      <QuizScreen
        route={route}
        timerRef={timerRef}
        onExitToSet={() => {
          stopSpeak();
          go("setDetail", { setId: route.setId });
        }}
        onHome={() => {
          stopSpeak();
          go("home");
        }}
        onUpdateRoute={(next) => setRoute(next)}
      />
    );
  }

  return null;
}

// ---------- Editable List ----------
function EditableList({ items, onChange, onSpeak }) {
  function update(i, patch) {
    const next = items.map((x, idx) => (idx === i ? { ...x, ...patch } : x));
    onChange(next);
  }
  function remove(i) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([{ term: "", meaning: "" }, ...items]);
  }

  return (
    <div className="col">
      <div className="kv">
        <div style={{ fontWeight: 900 }}>단어 목록</div>
        <button className="iconbtn" onClick={add} style={{ textAlign: "center" }}>
          + 단어 추가
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>소리</th>
            <th>영어</th>
            <th>한글</th>
            <th style={{ width: 70 }}>삭제</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>
                <button className="iconbtn" onClick={() => onSpeak(it.term)}>
                  🔊
                </button>
              </td>
              <td>
                <input className="input" value={it.term} onChange={(e) => update(i, { term: e.target.value })} />
              </td>
              <td>
                <input className="input" value={it.meaning} onChange={(e) => update(i, { meaning: e.target.value })} />
              </td>
              <td>
                <button className="iconbtn" onClick={() => remove(i)}>
                  🗑️
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {items.length === 0 && <div className="small">항목이 없어요. “단어 추가”로 입력하세요.</div>}
    </div>
  );
}

// ---------- Quiz Screen ----------
function QuizScreen({ route, timerRef, onExitToSet, onHome, onUpdateRoute }) {
  const { questions, vocab } = route;
  const qIndex = route.qIndex ?? 0;
  const q = questions[qIndex];

  const [input, setInput] = useState("");
  const [showSheet, setShowSheet] = useState(route.showSheet ?? false);
  const [last, setLast] = useState(route.last ?? null);

  useEffect(() => {
    onUpdateRoute({ ...route, qIndex, showSheet, last });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qIndex, showSheet, last]);

  if (!q) {
    return (
      <div className="container">
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontWeight: 900 }}>DJJG 단찍공</div>
            <button className="iconbtn" onClick={onHome}>
              🏠
            </button>
          </div>
          <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10, textAlign: "center" }}>학습 완료</div>
          <button className="btn" onClick={onExitToSet} style={{ textAlign: "center" }}>
            단어장으로
          </button>
        </div>
      </div>
    );
  }

  const item = vocab[q.itemIndex];

  function goNext() {
    setShowSheet(false);
    setLast(null);
    setInput("");
    onUpdateRoute({ ...route, qIndex: qIndex + 1, showSheet: false, last: null });
  }

  function submit(userAnswer) {
    let r;
    if (q.format === "written") {
      r = isCorrectWrittenA({ kind: q.kind, answer: q.answer, user: userAnswer });
    } else {
      const correct = (q.answer ?? "").toString() === (userAnswer ?? "").toString();
      r = { correct, caseFix: false, answer: q.answer, user: userAnswer };
    }

    setLast({ ...r, answer: q.answer, user: userAnswer });
    setShowSheet(true);

    if (r.correct && !r.caseFix) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(goNext, 600);
    }
  }

  function nextAfterSheet() {
    if (timerRef.current) clearTimeout(timerRef.current);
    goNext();
  }

  function mcqHint() {
    if (q.kind === "koToEn" || q.kind === "listenToEn") return "영어를 고르세요";
    return "뜻을 고르세요";
  }

  function inputLabel() {
    if (q.kind === "koToEn" || q.kind === "listenToEn") return "영어:";
    return "뜻:";
  }

  function promptLine() {
    if (q.kind === "enToKo") return `문제: ${item.term}`;
    if (q.kind === "koToEn") return `문제: ${item.meaning}`;
    return `문제: (듣기)`;
  }

  return (
    <div className="container">
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>DJJG 단찍공</div>
          <button className="iconbtn" onClick={onHome} aria-label="홈">
            🏠
          </button>
        </div>

        <div className="kv" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 900, textAlign: "center", flex: 1 }}>학습</div>
          <button className="iconbtn" onClick={onExitToSet} aria-label="나가기">
            나가기
          </button>
        </div>

        <div className="small" style={{ marginBottom: 10 }}>
          {qIndex + 1} / {questions.length}
        </div>

        {showSheet && last ? (
          <AnswerSheet last={last} onNext={nextAfterSheet} />
        ) : (
          <>
            {q.isListening && (
              <div className="row" style={{ marginBottom: 12 }}>
                <button className="btn secondary" onClick={() => speakEN(item.term)} style={{ textAlign: "center" }}>
                  🔊 듣기
                </button>
              </div>
            )}

            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>{promptLine()}</div>

            {q.format === "mcq" ? (
              <>
                <div className="small" style={{ marginBottom: 10 }}>
                  {mcqHint()}
                </div>
                <div className="col">
                  {q.choices.map((c, idx) => (
                    <button
                      key={idx}
                      className="btn secondary"
                      onClick={() => submit(c)}
                      style={{ textAlign: "center" }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="col">
                <div className="row" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: 56, fontWeight: 900 }}>{inputLabel()}</div>
                  <input
                    className="input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="정답을 입력하세요"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit(input);
                    }}
                  />
                </div>
                <button className="btn" onClick={() => submit(input)} style={{ textAlign: "center" }}>
                  제출
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AnswerSheet({ last, onNext }) {
  const isWrong = !last.correct;
  const caseOnly = last.correct && last.caseFix;
  const isPerfect = last.correct && !last.caseFix;

  return (
    <div className="col">
      <div style={{ fontSize: 22, fontWeight: 900, color: isWrong ? "#dc2626" : "#059669", textAlign: "center" }}>
        {isWrong ? "틀렸어요" : "정답이에요 👍"}
      </div>

      <div
        style={{
          width: 86,
          height: 86,
          borderRadius: 999,
          border: `7px solid ${isWrong ? "#dc2626" : "#059669"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "6px auto 12px",
          fontSize: 38,
          fontWeight: 900,
          color: isWrong ? "#dc2626" : "#059669",
        }}
      >
        {isWrong ? "✕" : "✓"}
      </div>

      {isPerfect ? (
        <div className="card" style={{ background: "#f9fafb", textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 900 }}>좋아요!</div>
        </div>
      ) : caseOnly ? (
        <div className="card" style={{ background: "#f9fafb" }}>
          <div className="small">표기는 이렇게 쓰는 게 맞아요:</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginTop: 6, textAlign: "center" }}>{last.answer}</div>
          <div className="small" style={{ marginTop: 8 }}>
            내 답: {last.user}
          </div>
        </div>
      ) : (
        <div className="card" style={{ background: "#f9fafb" }}>
          <div className="small">정답:</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginTop: 6, textAlign: "center" }}>{last.answer}</div>
          <div className="small" style={{ marginTop: 8 }}>
            내 답: {last.user}
          </div>
        </div>
      )}

      <button className="btn" onClick={onNext} style={{ textAlign: "center" }}>
        다음
      </button>
    </div>
  );
}
