import React from "react";

export function diffSpansForAnswer(answer, user) {
  const a = answer ?? "";
  const b = user ?? "";

  const m = a.length;
  const n = b.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const inLcs = Array(m).fill(false);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
      inLcs[i - 1] = true; i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }

  const spans = [];
  let start = 0;
  let curGood = m ? inLcs[0] : true;

  const push = (s, e, good) => {
    if (s >= e) return;
    spans.push(
      <span key={`${s}-${e}-${good}`} style={{ color: good ? "#111" : "#dc2626" }}>
        {a.slice(s, e)}
      </span>
    );
  };

  for (let idx = 1; idx < m; idx++) {
    const good = inLcs[idx];
    if (good !== curGood) {
      push(start, idx, curGood);
      start = idx;
      curGood = good;
    }
  }
  push(start, m, curGood);

  return <>{spans}</>;
}
