function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildQuiz(vocab, opts = {}) {
  const { mode = "mixed" } = opts; // "mcq" | "written" | "mixed"
  const n = vocab.length;

  const optionCount = () => (n >= 4 ? 4 : n);
  const canMcq = () => optionCount() >= 2;

  // ✅ 4종류 유지
  const kinds = ["enToKo", "koToEn", "listenToEn", "listenToKo"];

  const answerFor = (item, kind) => {
    if (kind === "enToKo") return item.meaning; // 영어 -> 뜻
    if (kind === "koToEn") return item.term;    // 뜻 -> 영어
    if (kind === "listenToEn") return item.term;
    if (kind === "listenToKo") return item.meaning;
    return "";
  };

  const poolFor = (kind) => {
    if (kind === "enToKo" || kind === "listenToKo") return vocab.map((v) => v.meaning);
    return vocab.map((v) => v.term);
  };

  const buildChoices = (correct, kind) => {
    const pool = Array.from(new Set(poolFor(kind).map((x) => (x ?? "").trim()))).filter(Boolean);
    if (!pool.includes(correct)) pool.push(correct);

    const wrong = shuffle(pool.filter((x) => x !== correct));
    const k = optionCount();

    const choices = [correct];
    for (let i = 0; i < wrong.length && choices.length < k; i++) choices.push(wrong[i]);

    return shuffle(choices);
  };

  const questions = [];

  for (let i = 0; i < n; i++) {
    for (const kind of kinds) {
      const ans = (answerFor(vocab[i], kind) ?? "").trim();
      const forceWritten = !ans || !canMcq();

      let format = "written";
      if (!forceWritten) {
        if (mode === "mcq") format = "mcq";
        else if (mode === "written") format = "written";
        else format = Math.random() < 0.5 ? "mcq" : "written";
      }

      if (format === "mcq") {
        const choices = buildChoices(ans, kind);
        if (choices.length < 2) {
          questions.push({
            itemIndex: i,
            kind,
            format: "written",
            answer: ans,
            isListening: kind.startsWith("listen"),
          });
        } else {
          questions.push({
            itemIndex: i,
            kind,
            format: "mcq",
            choices,
            answer: ans,
            isListening: kind.startsWith("listen"),
          });
        }
      } else {
        questions.push({
          itemIndex: i,
          kind,
          format: "written",
          answer: ans,
          isListening: kind.startsWith("listen"),
        });
      }
    }
  }

  return shuffle(questions);
}
