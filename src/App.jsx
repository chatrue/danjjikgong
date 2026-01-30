import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadState, saveState, uid, nowTitle } from "./lib/store.js";
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

export default function App() {
  const [db, setDb] = useState(() => loadState());
  const [route, setRoute] = useState({ name: "home" }); // home | settings | capture | preview | sets | setDetail | quiz
  const [ocrProgress, setOcrProgress] = useState(null);
  const [draft, setDraft] = useState(null);

  // setDetail 수정모드
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState([]);

  const timerRef = useRef(null);

  const currentSet = useMemo(() => {
    if (route.name !== "setDetail") return null;
    return db.sets.find((s) => s.id === route.setId) || null;
  }, [route, db]);

  useEffect(() => {
    if (!currentSet) return;
    setEditMode(false);
    setEditItems((currentSet.items ?? []).map((x) => ({ term: x.term ?? "", meaning: x.meaning ?? "" })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSet?.id]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function persist(next) {
    setDb(next);
    saveState(next);
  }

  function go(name, extra = {}) {
    if (name !== "setDetail") {
      setEditMode(false);
      setEditItems([]);
    }
    setRoute({ name, ...extra });
  }

  function goHome() {
    stopSpeak();
    go("home");
  }

  function Header({ right }) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>DJJK 단찍공</div>
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
    return <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>{title}</div>;
  }

  async function handlePickImage(file) {
    if (!file) return;
    setOcrProgress({ status: "이미지 준비중...", p: 0 });

    try {
      const imageURL = await fileToDataURL(file);
      setOcrProgress({ status: "인식 준비중...", p: 0.02 });

      const { items, quality } = await runOCRAndExtract(file, (pText, pVal) => {
        setOcrProgress({ status: pText, p: pVal });
      });

      setDraft({ imageURL, items, quality });
      setOcrProgress(null);
      go("preview");
    } catch (e) {
      console.error(e);
      setOcrProgress(null);
      alert("이미지 처리/OCR 중 오류가 발생했어요. 다른 사진으로 시도해보세요.");
    }
  }

  function saveDraftAsSet() {
    const cleaned = (draft?.items ?? [])
      .map((x) => ({ term: (x.term ?? "").trim(), meaning: (x.meaning ?? "").trim() }))
      .filter((x) => x.term || x.meaning);

    const set = { id: uid(), title: nowTitle(), createdAt: Date.now(), items: cleaned };
    persist({ ...db, sets: [set, ...db.sets] });

    setDraft(null);
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

  // ---------------- HOME ----------------
  if (route.name === "home") {
    return (
      <div className="container">
        <div className="card">
          <Header right="settings" />
          <div className="col">
            <button className="btn" onClick={() => go("capture")}>
              단어장 찍기
            </button>
            <button className="btn secondary" onClick={() => go("sets")}>
              이전 단어
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
            >
              데이터 초기화
            </button>
            <button className="btn" onClick={goHome}>
              닫기
            </button>
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
      }}
    >
      {text}
      <input
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" } : {})}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // 같은 파일 재선택 가능
          handlePickImage(f);
        }}
        style={{
          position: "absolute",
          inset: 0,            // ✅ 라벨 전체를 덮는다
          width: "100%",
          height: "100%",
          opacity: 0,          // ✅ 안 보이게
          cursor: "pointer",   // ✅ 클릭 가능
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
    const q = draft?.quality;
    const warn =
      !items.length || (q && (q.suspectLowCount || q.suspectNoKorean || q.suspectNoEnglish));

    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="인식 결과" />

          {warn ? (
            <div className="badgeWarn">인식 품질이 낮아 보입니다. 아래에서 수정/추가해 주세요.</div>
          ) : (
            <div className="badgeOk">자동 추출 완료. 필요하면 수정해 주세요.</div>
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

          <EditableList items={items} onChange={(next) => setDraft({ ...draft, items: next })} onSpeak={speakEN} />

          <div className="stickyBottom">
            <div className="row">
              <button className="btn" onClick={saveDraftAsSet}>
                저장
              </button>
              <button className="btn secondary" onClick={() => go("capture")}>
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
    return (
      <div className="container">
        <div className="card">
          <Header right="home" />
          <ScreenTitle title="이전 단어" />

          <div className="col">
            {db.sets.length === 0 ? (
              <div className="small">저장된 단어장이 없어요.</div>
            ) : (
              db.sets.map((s) => (
                <div key={s.id} className="card" style={{ background: "#fff" }}>
                  <div className="kv">
                    <div>
                      <div style={{ fontWeight: 900 }}>{s.title}</div>
                      <div className="small">단어 {s.items.length}개</div>
                    </div>
                    <div className="row">
                      <button className="iconbtn" onClick={() => go("setDetail", { setId: s.id })}>
                        열기
                      </button>
                      <button className="iconbtn" onClick={() => deleteSet(s.id)}>
                        삭제
                      </button>
                    </div>
                  </div>
                </div>
              ))
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

          {/* ✅ 오른쪽에 나란히 붙이기 */}
          <div className="kv" style={{ marginBottom: 10 }}>
            <div className="pill">단어 {currentSet.items.length}개</div>
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
                이전단어
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
          go("home"); // ✅ 완전히 홈으로
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
        <button className="iconbtn" onClick={add}>
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
                <input
                  className="input"
                  value={it.meaning}
                  onChange={(e) => update(i, { meaning: e.target.value })}
                />
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
            <div style={{ fontWeight: 900 }}>DJJK 단찍공</div>
            <button className="iconbtn" onClick={onHome}>
              🏠
            </button>
          </div>
          <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>학습 완료</div>
          <button className="btn" onClick={onExitToSet}>
            단어장으로
          </button>
        </div>
      </div>
    );
  }

  const item = vocab[q.itemIndex];

  function normalize(s) {
    return (s ?? "").trim().replace(/\s+/g, " ");
  }
  function isCorrectIgnoreCase(answer, user) {
    return normalize(answer).toLowerCase() === normalize(user).toLowerCase();
  }
  function needsCaseCorrection(answer, user) {
    if (!isCorrectIgnoreCase(answer, user)) return false;
    return normalize(answer) !== normalize(user);
  }

  function goNext() {
    setShowSheet(false);
    setLast(null);
    setInput("");
    onUpdateRoute({ ...route, qIndex: qIndex + 1, showSheet: false, last: null });
  }

  function submit(userAnswer) {
    const correct = isCorrectIgnoreCase(q.answer, userAnswer);
    const caseFix = needsCaseCorrection(q.answer, userAnswer);
    const r = { correct, caseFix, answer: q.answer, user: userAnswer };

    setLast(r);
    setShowSheet(true);

    if (correct && !caseFix) {
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
        {/* 헤더: 홈은 진짜 홈 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>DJJK 단찍공</div>
          <button className="iconbtn" onClick={onHome} aria-label="홈">
            🏠
          </button>
        </div>

        {/* 제목 + 나가기 */}
        <div className="kv" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 900 }}>학습</div>
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
                <button className="btn secondary" onClick={() => speakEN(item.term)}>
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
                    <button key={idx} className="btn secondary" onClick={() => submit(c)}>
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
                <button className="btn" onClick={() => submit(input)}>
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
      <div style={{ fontSize: 22, fontWeight: 900, color: isWrong ? "#dc2626" : "#059669" }}>
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
          margin: "6px 0 12px",
          fontSize: 38,
          fontWeight: 900,
          color: isWrong ? "#dc2626" : "#059669",
        }}
      >
        {isWrong ? "✕" : "✓"}
      </div>

      {isPerfect ? (
        <div className="card" style={{ background: "#f9fafb" }}>
          <div style={{ fontSize: 16, fontWeight: 900 }}>좋아요!</div>
        </div>
      ) : caseOnly ? (
        <div className="card" style={{ background: "#f9fafb" }}>
          <div className="small">표기는 이렇게 쓰는 게 맞아요:</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginTop: 6 }}>{last.answer}</div>
          <div className="small" style={{ marginTop: 8 }}>내 답: {last.user}</div>
        </div>
      ) : (
        <div className="card" style={{ background: "#f9fafb" }}>
          <div className="small">정답:</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginTop: 6 }}>{last.answer}</div>
          <div className="small" style={{ marginTop: 8 }}>내 답: {last.user}</div>
        </div>
      )}

      <button className="btn" onClick={onNext}>
        다음
      </button>
    </div>
  );
}
