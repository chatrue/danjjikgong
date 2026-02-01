import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadState, saveState, uid } from "./lib/store.js";
import { speakText, stopSpeak } from "./lib/tts.js";
import { buildQuiz } from "./lib/quiz.js";
import { runOCRAndExtract } from "./lib/ocr_extract.js";

/** ---------------------------
 *  Freemium policy
 *  - OCR: 무료/유료 동일하게 고급 OCR
 *  - 무료 제한:
 *      - 단어장 최대 20개 (넘으면 맨 뒤(가장 오래된)부터 자동 정리)
 *      - 단어장 1개당 단어 최대 50개
 *      - 다국어 선택 불가
 *      - 내보내기 불가
 *  - 프리미엄(평생):
 *      - 다국어 선택
 *      - 단어장/단어 수 무제한
 *      - 내보내기 가능
 * --------------------------- */

const FREE_MAX_SETS = 20;
const FREE_MAX_WORDS_PER_SET = 50;
const LIFETIME_PRICE = "$3 / 3,000원 (1회 결제)";

const PAIRS = [
  { id: "en-ko", left: "영어", right: "한국어", ttsLang: "en-US", premiumOnly: false },
  { id: "ko-en", left: "한국어", right: "영어", ttsLang: "ko-KR", premiumOnly: true },
  { id: "es-en", left: "스페인어", right: "영어", ttsLang: "es-ES", premiumOnly: true },
  { id: "en-es", left: "영어", right: "스페인어", ttsLang: "en-US", premiumOnly: true },
  { id: "ja-en", left: "일본어", right: "영어", ttsLang: "ja-JP", premiumOnly: true },
  { id: "en-ja", left: "영어", right: "일본어", ttsLang: "en-US", premiumOnly: true },
];

function getPair(settings) {
  return PAIRS.find((p) => p.id === settings?.pair) || PAIRS[0];
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

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function resizeImageForOCR(file, { maxWidth = 1200, quality = 0.8 } = {}) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  const w = bitmap.width;
  const h = bitmap.height;

  if (w <= maxWidth) {
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
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
  });

  if (!blob) {
    const dataUrl = await fileToDataURL(file);
    return { blob: file, dataUrl };
  }

  const dataUrl = await fileToDataURL(blob);
  return { blob, dataUrl };
}

function downloadTextFile(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function toCSV(items, leftLabel, rightLabel) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  lines.push([esc(leftLabel), esc(rightLabel)].join(","));
  for (const it of items) {
    lines.push([esc(it.term ?? ""), esc(it.meaning ?? "")].join(","));
  }
  return lines.join("\n");
}

function isMergedSet(set) {
  return set?.title === "합친 단어장" || (set?.meta && Array.isArray(set.meta.mergedFrom));
}
function defaultNameForSet(set) {
  const t = (set?.title ?? "").trim();
  if (t) return t;
  return isMergedSet(set) ? "합친 단어장" : "단어장";
}

function Modal({ open, title, children, actions }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "#fff",
          borderRadius: 18,
          padding: 16,
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.45, color: "#111", whiteSpace: "pre-wrap" }}>{children}</div>
        <div style={{ height: 14 }} />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>{actions}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [db, setDb] = useState(() => loadState());
  const [route, setRoute] = useState({ name: "home" });

  const settings = db.settings;
  const pair = useMemo(() => getPair(settings), [settings]);

  const [ocrProgress, setOcrProgress] = useState(null);

  // draft from OCR
  const [draft, setDraft] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");

  // create set
  const [createTitle, setCreateTitle] = useState("");
  const [createItems, setCreateItems] = useState([{ term: "", meaning: "" }]);

  // edit set
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState([]);

  // merge
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelected, setMergeSelected] = useState(new Set());
  const [mergeTitle, setMergeTitle] = useState("");

  // rename in list
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef(null);

  // quiz
  const timerRef = useRef(null);

  // modal
  const [modal, setModal] = useState({ open: false });

  const currentSet = useMemo(() => {
    if (route.name !== "setDetail") return null;
    return db.sets.find((s) => s.id === route.setId) || null;
  }, [route, db.sets]);

  function persist(next) {
    setDb(next);
    saveState(next);
  }

  function go(name, extra = {}) {
    stopSpeak();
    setRoute({ name, ...extra });
  }

  function goHome() {
    stopSpeak();
    go("home");
  }

  function isPremium() {
    return !!db.settings?.premium;
  }

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

  useEffect(() => {
    if (!currentSet) return;
    setEditMode(false);
    setEditItems((currentSet.items ?? []).map((x) => ({ term: x.term ?? "", meaning: x.meaning ?? "" })));
  }, [currentSet?.id]);

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

  function openPremiumScreen(from = route) {
    go("premium", { from });
  }

  function showSetLimitModal(onContinueFree, fromLabel = "") {
    setModal({
      open: true,
      title: "단어장 관리",
      body:
        "무료 버전에서는 최대 20개의 단어장을 관리할 수 있어요.\n" +
        "계속 저장하면 가장 오래된 단어장이 정리돼요.",
      actions: [
        {
          text: "정리하고 저장",
          variant: "secondary",
          onClick: () => {
            setModal({ open: false });
            onContinueFree?.();
          },
        },
        {
          text: `평생 프리미엄으로 유지하기 (${LIFETIME_PRICE})`,
          variant: "primary",
          onClick: () => {
            setModal({ open: false });
            openPremiumScreen(fromLabel ? { name: fromLabel } : route);
          },
        },
      ],
    });
  }

  function showWordLimitModal(onKeep50, fromLabel = "") {
    setModal({
      open: true,
      title: "단어장 확장",
      body:
        "무료 버전에서는 단어장 하나에 최대 50개의 단어를 담을 수 있어요.\n" +
        "이 단어장을 더 키우고 싶다면 평생 프리미엄을 선택해 주세요.",
      actions: [
        {
          text: "50개로 유지",
          variant: "secondary",
          onClick: () => {
            setModal({ open: false });
            onKeep50?.();
          },
        },
        {
          text: `평생 프리미엄 (${LIFETIME_PRICE})`,
          variant: "primary",
          onClick: () => {
            setModal({ open: false });
            openPremiumScreen(fromLabel ? { name: fromLabel } : route);
          },
        },
      ],
    });
  }

  function showLanguagePremiumModal() {
    setModal({
      open: true,
      title: "다국어 학습",
      body:
        "여러 언어로 공부하고 싶다면 평생 프리미엄이 필요해요.\n" +
        "단찍공 하나로 다양한 언어를 학습할 수 있어요.",
      actions: [
        {
          text: "확인",
          variant: "secondary",
          onClick: () => setModal({ open: false }),
        },
        {
          text: `평생 프리미엄 (${LIFETIME_PRICE})`,
          variant: "primary",
          onClick: () => {
            setModal({ open: false });
            openPremiumScreen(route);
          },
        },
      ],
    });
  }

  function showExportPremiumModal() {
    setModal({
      open: true,
      title: "내보내기",
      body:
        "단어장을 파일로 저장하고 싶다면\n" +
        "평생 프리미엄으로 언제든 내보낼 수 있어요.",
      actions: [
        {
          text: "닫기",
          variant: "secondary",
          onClick: () => setModal({ open: false }),
        },
        {
          text: `평생 프리미엄 (${LIFETIME_PRICE})`,
          variant: "primary",
          onClick: () => {
            setModal({ open: false });
            openPremiumScreen(route);
          },
        },
      ],
    });
  }

  function enforceFreeSetCount(sets) {
    if (isPremium()) return sets;
    if (sets.length <= FREE_MAX_SETS) return sets;
    return sets.slice(0, FREE_MAX_SETS);
  }

  function clampItemsForFree(items) {
    if (isPremium()) return items;
    return items.slice(0, FREE_MAX_WORDS_PER_SET);
  }

  function saveNewSetWithPolicies(newSet) {
    const nextSets = [newSet, ...db.sets];

    if (isPremium()) {
      persist({ ...db, sets: nextSets });
      return true;
    }

    if (nextSets.length > FREE_MAX_SETS) {
      showSetLimitModal(() => {
        const trimmed = enforceFreeSetCount(nextSets);
        persist({ ...db, sets: trimmed });
        go("setDetail", { setId: newSet.id });
      }, "home");
      return false;
    }

    persist({ ...db, sets: nextSets });
    return true;
  }

  function saveDraftAsSet() {
    const cleaned = (draft?.items ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term || x.meaning);

    const title = (draftTitle ?? "").trim() || "단어장";

    if (!isPremium() && cleaned.length > FREE_MAX_WORDS_PER_SET) {
      showWordLimitModal(() => {
        const clamped = clampItemsForFree(cleaned);
        const set = { id: uid(), title, createdAt: Date.now(), items: clamped };
        const ok = saveNewSetWithPolicies(set);
        if (ok) go("setDetail", { setId: set.id });
        setDraft(null);
        setDraftTitle("");
      }, "preview");
      return;
    }

    const set = { id: uid(), title, createdAt: Date.now(), items: cleaned };
    const ok = saveNewSetWithPolicies(set);
    setDraft(null);
    setDraftTitle("");
    if (ok) go("setDetail", { setId: set.id });
  }

  function saveCreatedSet() {
    const title = (createTitle || "").trim() || "단어장";
    const cleaned = (createItems ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term || x.meaning);

    if (!isPremium() && cleaned.length > FREE_MAX_WORDS_PER_SET) {
      showWordLimitModal(() => {
        const clamped = clampItemsForFree(cleaned);
        const set = { id: uid(), title, createdAt: Date.now(), items: clamped };
        const ok = saveNewSetWithPolicies(set);
        if (ok) go("setDetail", { setId: set.id });
        setCreateTitle("");
        setCreateItems([{ term: "", meaning: "" }]);
      }, "create");
      return;
    }

    const set = { id: uid(), title, createdAt: Date.now(), items: cleaned };
    const ok = saveNewSetWithPolicies(set);
    setCreateTitle("");
    setCreateItems([{ term: "", meaning: "" }]);
    if (ok) go("setDetail", { setId: set.id });
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
    cancelRename();
  }

  function mergeAndDedupeItems(items) {
    const map = new Map();
    for (const it of items) {
      const term = (it?.term ?? "").trim();
      const meaning = (it?.meaning ?? "").trim();
      if (!term && !meaning) continue;

      const key = term.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key) continue;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, { term, meaning });
        continue;
      }

      if (!meaning) continue;
      if (!existing.meaning) {
        existing.meaning = meaning;
        continue;
      }

      const parts = existing.meaning.split(" / ").map((x) => x.trim()).filter(Boolean);
      const candParts = meaning.split(/[\/,;·=]/g).map((x) => x.trim()).filter(Boolean);

      const seen = new Set(parts.map((x) => x.toLowerCase()));
      for (const cp of candParts) {
        const k = cp.toLowerCase();
        if (!seen.has(k)) {
          parts.push(cp);
          seen.add(k);
        }
      }
      existing.meaning = parts.join(" / ");
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

    if (!isPremium() && mergedItems.length > FREE_MAX_WORDS_PER_SET) {
      showWordLimitModal(() => {
        const clamped = clampItemsForFree(mergedItems);
        const merged = { id: uid(), title, createdAt: Date.now(), items: clamped, meta: { mergedFrom: ids } };

        const nextSets = [merged, ...db.sets];
        if (nextSets.length > FREE_MAX_SETS) {
          showSetLimitModal(() => {
            persist({ ...db, sets: enforceFreeSetCount(nextSets) });
            go("setDetail", { setId: merged.id });
          }, "sets");
        } else {
          persist({ ...db, sets: nextSets });
          go("setDetail", { setId: merged.id });
        }
      }, "sets");
      return;
    }

    const merged = { id: uid(), title, createdAt: Date.now(), items: mergedItems, meta: { mergedFrom: ids } };
    const nextSets = [merged, ...db.sets];

    if (!isPremium() && nextSets.length > FREE_MAX_SETS) {
      showSetLimitModal(() => {
        persist({ ...db, sets: enforceFreeSetCount(nextSets) });
        go("setDetail", { setId: merged.id });
      }, "sets");
      return;
    }

    persist({ ...db, sets: nextSets });

    const del = confirm("원본 단어장들을 삭제할까요?\n(취소하면 원본은 그대로 유지됩니다.)");
    if (del) {
      persist({ ...db, sets: nextSets.filter((s) => !ids.includes(s.id)) });
    }

    setMergeMode(false);
    setMergeSelected(new Set());
    setMergeTitle("");
    cancelRename();
    go("setDetail", { setId: merged.id });
  }

  /** ✅ OCR 처리: 여기에서 debug 콘솔 출력이 자동으로 들어가 있음 */
  async function handlePickImage(file) {
    if (!file) return;

    setOcrProgress({ status: "이미지 최적화중...", p: 0.05 });
    try {
      const { blob, dataUrl } = await resizeImageForOCR(file, { maxWidth: 1200, quality: 0.8 });
      setOcrProgress({ status: "OCR 실행중...", p: 0.1 });

      const { items, debug } = await runOCRAndExtract(blob, (status, p) => {
        setOcrProgress({ status, p });
      });

      // ✅ 여기! 이제 찾을 필요 없음. App.jsx에 이미 박혀 있음.
      console.log("OCR DEBUG:", debug);

      setDraft({
        imageURL: dataUrl,
        items: (items ?? []).map((x) => ({ term: x.term ?? "", meaning: x.meaning ?? "" })),
      });
      setDraftTitle("");
      setOcrProgress(null);
      go("preview");
    } catch (e) {
      console.error(e);
      setOcrProgress(null);

      let fallbackUrl = "";
      try {
        fallbackUrl = await fileToDataURL(file);
      } catch {}

      setDraft({ imageURL: fallbackUrl, items: [] });
      setDraftTitle("");
      go("preview");
    }
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

  const modalActions = (modal.actions ?? []).map((a, idx) => (
    <button
      key={idx}
      className={a.variant === "primary" ? "btn" : "btn secondary"}
      onClick={a.onClick}
      style={{ textAlign: "center" }}
    >
      {a.text}
    </button>
  ));

  // HOME
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

            <div style={{ height: 6 }} />
            <div className="small" style={{ textAlign: "center", opacity: 0.85 }}>
              {isPremium() ? "평생 프리미엄 사용 중" : "무료 사용 중"}
            </div>
          </div>
        </div>

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // SETTINGS
  if (route.name === "settings") {
    const selectedPair = getPair(db.settings);

    function setPair(nextId) {
      const nextPair = PAIRS.find((p) => p.id === nextId);
      if (!nextPair) return;

      if (nextPair.premiumOnly && !isPremium()) {
        showLanguagePremiumModal();
        return;
      }

      const next = { ...db, settings: { ...db.settings, pair: nextId } };
      persist(next);
    }

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="설정" />

          <div className="col">
            <div className="card" style={{ background: "#f9fafb" }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>학습 언어</div>

              <div className="small" style={{ marginBottom: 8 }}>
                {isPremium()
                  ? "원하는 언어쌍을 선택할 수 있어요."
                  : "무료 버전에서는 기본 언어쌍만 사용할 수 있어요."}
              </div>

              <div className="col">
                {PAIRS.map((p) => {
                  const locked = p.premiumOnly && !isPremium();
                  const checked = selectedPair.id === p.id;
                  return (
                    <label
                      key={p.id}
                      className="card"
                      style={{
                        background: "#fff",
                        padding: 12,
                        border: "1px solid #eef2f7",
                        borderRadius: 14,
                        opacity: locked ? 0.65 : 1,
                        cursor: "pointer",
                      }}
                    >
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 900 }}>
                            {p.left} → {p.right} {locked ? " (프리미엄)" : ""}
                          </div>
                          <div className="small">듣기는 {p.left}로 나와요.</div>
                        </div>
                        <input type="radio" name="pair" checked={checked} onChange={() => setPair(p.id)} />
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="card" style={{ background: "#f9fafb" }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>프리미엄</div>
              {isPremium() ? <div className="small">✅ 평생 프리미엄 사용 중</div> : <div className="small">무료 제한 없이 사용하려면 평생 프리미엄을 선택할 수 있어요.</div>}
              <div style={{ height: 10 }} />
              <button className={isPremium() ? "btn secondary" : "btn"} onClick={() => openPremiumScreen(route)} style={{ textAlign: "center" }}>
                {isPremium() ? "프리미엄 정보 보기" : `평생 프리미엄 (${LIFETIME_PRICE})`}
              </button>
            </div>

            <button className="btn" onClick={goHome} style={{ textAlign: "center" }}>
              닫기
            </button>
          </div>
        </div>

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // PREMIUM
  if (route.name === "premium") {
    const from = route.from ?? { name: "home" };

    function activatePremiumTest() {
      persist({ ...db, settings: { ...db.settings, premium: true } });
      alert("평생 프리미엄이 활성화되었습니다. (현재는 테스트/개발 모드)");
      go(from.name ?? "home", from);
    }

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="평생 프리미엄" />

          <div className="card" style={{ background: "#f9fafb" }}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>단찍공을 제한 없이 사용해 보세요</div>
            <div className="col" style={{ gap: 6 }}>
              <div>✅ 단어장 개수 무제한</div>
              <div>✅ 단어장 당 단어 무제한</div>
              <div>✅ 여러 언어로 학습</div>
              <div>✅ 단어장 내보내기</div>
              <div style={{ fontWeight: 900 }}>✅ 한 번 결제로 평생 사용</div>
            </div>
            <div style={{ height: 12 }} />
            <div className="pill" style={{ fontWeight: 900 }}>
              💳 {LIFETIME_PRICE}
            </div>
            <div style={{ height: 12 }} />
            <div className="small" style={{ opacity: 0.85 }}>
              * 실제 결제 연결은 다음 단계에서 진행하면 돼요. 지금은 기능 검증을 위한 개발 모드입니다.
            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            {!isPremium() ? (
              <button className="btn" onClick={activatePremiumTest} style={{ textAlign: "center", flex: 1 }}>
                평생 프리미엄 시작하기
              </button>
            ) : (
              <button className="btn secondary" disabled style={{ textAlign: "center", flex: 1 }}>
                이미 프리미엄 사용 중
              </button>
            )}
            <button className="btn secondary" onClick={() => go(from.name ?? "home", from)} style={{ textAlign: "center" }}>
              나중에
            </button>
          </div>
        </div>

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // CAPTURE
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

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // PREVIEW
  if (route.name === "preview") {
    const items = draft?.items ?? [];

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="인식 결과" />

          <div className="hr" />

          <div className="kv" style={{ marginBottom: 6, alignItems: "flex-end" }}>
            <div className="small">단어장 제목</div>
            <div />
          </div>
          <input className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="(선택) 예: 단어장" />

          <div className="hr" />

          {draft?.imageURL && (
            <img src={draft.imageURL} alt="source" style={{ width: "100%", borderRadius: 14, border: "1px solid #eef2f7" }} />
          )}

          <div className="hr" />

          <EditableList items={items} leftLabel={pair.left} rightLabel={pair.right} onSpeak={(t) => speakText(t, pair.ttsLang)} onChange={(next) => setDraft({ ...draft, items: next })} />

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

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // CREATE
  if (route.name === "create") {
    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="단어장 직접 만들기" />

          <div className="col">
            <div className="kv" style={{ marginBottom: 6, alignItems: "flex-end" }}>
              <div className="small">단어장 제목</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="iconbtn" onClick={() => go("home")}>
                  뒤로가기
                </button>
                <button className="iconbtn" onClick={() => go("sets")}>
                  이전 단어장
                </button>
              </div>
            </div>

            <input className="input" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder="(선택) 예: 1월 1주차 단어" />

            <div className="hr" />

            <EditableList items={createItems} leftLabel={pair.left} rightLabel={pair.right} onSpeak={(t) => speakText(t, pair.ttsLang)} onChange={setCreateItems} />

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

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // SETS
  if (route.name === "sets") {
    function toggleSelect(id) {
      const next = new Set(mergeSelected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setMergeSelected(next);
    }

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="이전 단어장" />

          <div className="kv" style={{ marginBottom: 10, alignItems: "flex-end" }}>
            <div className="small">
              {!isPremium()
                ? `무료: 단어장 최대 ${FREE_MAX_SETS}개, 단어장 당 최대 ${FREE_MAX_WORDS_PER_SET}개`
                : "프리미엄: 무제한"}
            </div>

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
                <input className="input" style={{ maxWidth: 260 }} value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} placeholder="예: 합친 단어장" />
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
                const name = defaultNameForSet(s);
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

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // SET DETAIL
  if (route.name === "setDetail" && currentSet) {
    function saveEdits() {
      const cleaned = (editItems ?? [])
        .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
        .filter((x) => x.term || x.meaning);

      if (!isPremium() && cleaned.length > FREE_MAX_WORDS_PER_SET) {
        showWordLimitModal(() => {
          const clamped = clampItemsForFree(cleaned);
          const nextSets = db.sets.map((s) => (s.id === currentSet.id ? { ...s, items: clamped } : s));
          persist({ ...db, sets: nextSets });
          setEditMode(false);
        }, "setDetail");
        return;
      }

      const nextSets = db.sets.map((s) => (s.id === currentSet.id ? { ...s, items: cleaned } : s));
      persist({ ...db, sets: nextSets });
      setEditMode(false);
    }

    function exportSet() {
      if (!isPremium()) {
        showExportPremiumModal();
        return;
      }
      const filenameSafe = (defaultNameForSet(currentSet) || "단어장").replace(/[\\/:*?"<>|]/g, "_");
      const csv = toCSV(currentSet.items ?? [], pair.left, pair.right);
      downloadTextFile(`${filenameSafe}.csv`, csv, "text/csv;charset=utf-8");
    }

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title={defaultNameForSet(currentSet)} />

          <div className="kv" style={{ marginBottom: 10 }}>
            <div className="pill">
              단어 {currentSet.items.length}개 · {formatKoreanDateTime(currentSet.createdAt)}
            </div>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
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

              <button className="iconbtn" onClick={exportSet}>
                내보내기
              </button>
            </div>
          </div>

          <div className="hr" />

          {!editMode ? (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>소리</th>
                  <th>{pair.left}</th>
                  <th>{pair.right}</th>
                </tr>
              </thead>
              <tbody>
                {currentSet.items.map((it, idx) => (
                  <tr key={idx}>
                    <td>
                      <button className="iconbtn" onClick={() => speakText(it.term, pair.ttsLang)}>
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
            <EditableList items={editItems} leftLabel={pair.left} rightLabel={pair.right} onSpeak={(t) => speakText(t, pair.ttsLang)} onChange={setEditItems} />
          )}
        </div>

        <Modal open={modal.open} title={modal.title} actions={modalActions}>
          {modal.body}
        </Modal>
      </div>
    );
  }

  // QUIZ
  if (route.name === "quiz") {
    return (
      <QuizScreen
        brand="DJJG 단찍공"
        pair={pair}
        route={route}
        timerRef={timerRef}
        onExitToSet={() => go("setDetail", { setId: route.setId })}
        onHome={() => goHome()}
        onUpdateRoute={(next) => setRoute(next)}
      />
    );
  }

  return null;
}

function EditableList({ items, onChange, onSpeak, leftLabel, rightLabel }) {
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
            <th>{leftLabel}</th>
            <th>{rightLabel}</th>
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

/** ---------- Quiz Screen (이전 구현 유지) ---------- */

function QuizScreen({ brand, pair, route, timerRef, onExitToSet, onHome, onUpdateRoute }) {
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
            <div style={{ fontWeight: 900 }}>{brand}</div>
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
    if (q.kind === "koToEn" || q.kind === "listenToEn") return `${pair.left}를 고르세요`;
    return `${pair.right}을(를) 고르세요`;
  }

  function inputLabel() {
    if (q.kind === "koToEn" || q.kind === "listenToEn") return `${pair.left}:`;
    return `${pair.right}:`;
  }

  function promptLine() {
    if (q.kind === "enToKo") return `문제: ${item.term}`;
    if (q.kind === "koToEn") return `문제: ${item.meaning}`;
    return "문제: (듣기)";
  }

  return (
    <div className="container">
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>{brand}</div>
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
                <button className="btn secondary" onClick={() => speakText(item.term, pair.ttsLang)} style={{ textAlign: "center" }}>
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
                    <button key={idx} className="btn secondary" onClick={() => submit(c)} style={{ textAlign: "center" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="col">
                <div className="row" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: 72, fontWeight: 900 }}>{inputLabel()}</div>
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

/** ---------- 주관식 판정 ---------- */

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
      const nu = normKO(uc);
      for (const ac of aCands) {
        if (nu === normKO(ac)) return { correct: true, caseFix: false };
      }
    }
    return { correct: false, caseFix: false };
  }

  const na = normEN(a);
  const nu = normEN(u);
  const correct = na && nu && na === nu;

  const caseFix =
    correct &&
    a.trim() !== u.trim() &&
    a.trim().toLowerCase() === u.trim().toLowerCase();

  return { correct, caseFix };
}
