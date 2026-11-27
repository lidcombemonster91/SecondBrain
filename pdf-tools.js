// PDF 파일 검사, 글자 추출, 첫 페이지 미리보기. 모두 이 기기 안에서 처리한다.
// 라이브러리: pdf.js (pdfjs-dist 6.5.438, legacy 빌드). lib/pdfjs/ 에 그대로 넣어 두었다.
(function () {
  const MAX_BYTES = 20 * 1024 * 1024; // PDF 파일 크기 상한
  const MAX_TEXT = 500000; // 저장·검색하는 글자 수 상한
  const MAX_COPY = 100000; // 요약 요청문(요청문 포함) 글자 수 상한
  const TIMEOUT = 60000;
  const TYPE = 'application/pdf';
  const base = new URL('./lib/pdfjs/', document.baseURI).href;
  let library = null;

  function loadLibrary() {
    if (!library) {
      library = import(`${base}pdf.min.mjs`).then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
        return pdfjs;
      });
      library.catch(() => {
        library = null; // 다음에 다시 시도한다.
      });
    }
    return library;
  }

  // 앞부분이 %PDF- 인지 확인한다. 파일이 주장하는 이름이나 형식은 믿지 않는다.
  async function hasPdfHeader(blob) {
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head) === '%PDF-';
  }

  // 글자 수 상한에서 자르되, 한 글자를 반으로 자르지 않는다.
  function cut(text, limit) {
    if (text.length <= limit) return text;
    const code = text.charCodeAt(limit - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
  }

  async function readText(doc) {
    let text = '';
    for (let number = 1; number <= doc.numPages && text.length <= MAX_TEXT; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      for (const part of content.items) {
        text += (part.str || '') + (part.hasEOL ? '\n' : '');
        if (text.length > MAX_TEXT * 2) break;
      }
      text += '\n';
      page.cleanup();
    }
    text = text.trim();
    return { pdfText: cut(text, MAX_TEXT), pdfCut: text.length > MAX_TEXT };
  }

  async function drawFirstPage(doc) {
    const page = await doc.getPage(1);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(480 / size.width, 640 / size.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    // 'print'는 화면이 가려져 있어도 그리기가 멈추지 않는다.
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  function withTimeout(promise) {
    let timer;
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('PDF를 읽는 시간이 너무 길어요')), TIMEOUT);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  // 글자와 미리보기를 만든다. 실패해도 던지지 않고, 만든 것만 돌려준다.
  async function analyze(blob) {
    const result = { pdfText: '', pdfCut: false };
    let task;
    try {
      const pdfjs = await withTimeout(loadLibrary());
      task = pdfjs.getDocument({
        data: new Uint8Array(await blob.arrayBuffer()),
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
        iccUrl: `${base}iccs/`,
        isEvalSupported: false,
        enableXfa: false,
        maxImageSize: 4096 * 4096,
      });
      const doc = await withTimeout(task.promise);
      try {
        Object.assign(result, await withTimeout(readText(doc)));
      } catch {
        // 글자를 읽지 못해도 원본은 보관한다.
      }
      try {
        const thumb = await withTimeout(drawFirstPage(doc));
        if (thumb) result.thumb = thumb;
      } catch {
        // 미리보기를 만들지 못해도 원본은 보관한다.
      }
    } catch {
      // 깨졌거나 암호가 걸린 PDF
    } finally {
      if (task) task.destroy().catch(() => {});
    }
    return result;
  }

  window.PdfTools = { MAX_BYTES, MAX_TEXT, MAX_COPY, TYPE, hasPdfHeader, analyze, cut };
})();
