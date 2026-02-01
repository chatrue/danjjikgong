// src/lib/export_pack.js
// DJJG 단찍공 - 내보내기 (PDF/PNG 저장 + 공유)
// - PNG: 단어 | 뜻 라인만 (가져오기 OCR에 최적화)
// - PDF: 단어 | 뜻 라인만 (공유/프린트 용도)
//
// ⚠️ 이 파일은 아래 라이브러리를 사용합니다.
//   npm i html-to-image jspdf
//
// (이미 설치되어 있으면 OK)

import { toPng } from "html-to-image";
import jsPDF from "jspdf";

export function formatKSTDateTime(ts) {
  const d = new Date(ts || Date.now());
  // KST 강제는 브라우저 TZ가 다르면 완전 고정이 어렵지만,
  // 사용자 요구상 "표시용" 정도로만 사용.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStableRender() {
  // 폰트/레이아웃 안정화: 빈 PNG 방지에 꽤 중요
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {}
  // rAF 여러번 + 짧은 딜레이
  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
  await sleep(30);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}

export async function shareOrDownload({ blob, filename, mime, preferShare = true }) {
  if (!blob) throw new Error("파일 생성 실패");

  const file = new File([blob], filename, { type: mime });

  // Web Share API (모바일에서 특히 좋음)
  if (
    preferShare &&
    navigator.share &&
    navigator.canShare &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({
        files: [file],
        title: "DJJG 단찍공",
        text: "단어장을 공유합니다.",
      });
      return { method: "share" };
    } catch {
      // 사용자가 공유 취소했거나 오류 → 다운로드 fallback
    }
  }

  downloadBlob(blob, filename);
  return { method: "download" };
}

/**
 * ✅ PNG 생성 (단어 | 뜻만)
 * mountEl은 "내보내기 전용 DOM" (App.jsx에서 ref로 연결)
 */
export async function exportAsDJJGPNG({ mountEl, filenameBase = "DJJG_vocab", pixelRatio = 2 }) {
  if (!mountEl) throw new Error("PNG mountEl이 없어요.");

  await waitForStableRender();

  // html-to-image는 외부 폰트/이미지 이슈가 있으면 깨질 수 있어서 안전 옵션을 준다
  const dataUrl = await toPng(mountEl, {
    cacheBust: true,
    pixelRatio,
    backgroundColor: "#ffffff",
    // 일부 환경에서 글자 깨짐 방지
    style: {
      transform: "scale(1)",
      transformOrigin: "top left",
    },
  });

  // dataUrl → blob
  const blob = await (await fetch(dataUrl)).blob();
  const filename = `${filenameBase}.png`;

  downloadBlob(blob, filename);
  return { blob, filename, dataUrl };
}

/**
 * ✅ PDF 생성 (단어 | 뜻만)
 * - mountEl을 PNG로 만든 뒤 PDF에 붙여서 한국어 폰트 문제 회피
 * - 길면 페이지 분할
 */
export async function exportAsPDF({ mountEl, filenameBase = "DJJG_vocab_pdf" }) {
  if (!mountEl) throw new Error("PDF mountEl이 없어요.");

  await waitForStableRender();

  const dataUrl = await toPng(mountEl, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: "#ffffff",
  });

  const img = new Image();
  img.src = dataUrl;
  await new Promise((r, rej) => {
    img.onload = () => r();
    img.onerror = rej;
  });

  const pdf = new jsPDF("p", "pt", "a4");
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // 이미지 비율 유지해서 페이지 너비에 맞춤
  const imgW = pageW;
  const imgH = (img.height * imgW) / img.width;

  let y = 0;
  let remaining = imgH;

  // 첫 페이지
  pdf.addImage(dataUrl, "PNG", 0, y, imgW, imgH);

  // 이미지가 페이지보다 길면, 같은 이미지를 y를 음수로 이동해서 “잘라서” 여러 페이지로 넣음
  remaining -= pageH;
  while (remaining > 0) {
    pdf.addPage();
    y = -((imgH - remaining) || 0);
    pdf.addImage(dataUrl, "PNG", 0, y, imgW, imgH);
    remaining -= pageH;
  }

  const blob = pdf.output("blob");
  const filename = `${filenameBase}.pdf`;

  downloadBlob(blob, filename);
  return { blob, filename };
}
