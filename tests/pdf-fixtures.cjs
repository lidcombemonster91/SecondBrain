// 시험에서 쓰는 PDF를 직접 만든다.

// objects: 1번부터 차례대로의 객체 본문. 1번은 Catalog여야 한다.
function buildPdf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n'),
    ]);
    offsets.push(length);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}

const stream = (content) => `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;

function onePage(content, fonts, extra = []) {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`,
    stream(content),
    ...extra,
  ]);
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

// 영문 글자가 있는 PDF
// 페이지 밖의 글자는 pdf.js가 읽지 않으므로, 긴 글은 글씨를 작게 해서 한 페이지 안에 넣는다.
function textPdf(text) {
  const size = Math.min(18, 400 / text.length).toFixed(6);
  const escaped = text.replace(/[\\()]/g, '\\$&');
  return onePage(`BT /F1 ${size} Tf 20 350 Td (${escaped}) Tj ET`, '/F1 5 0 R', [HELVETICA]);
}

// 한글 PDF: 글꼴을 넣지 않고 미리 정해진 한글 CMap을 쓴다. (앱의 cmaps 파일이 있어야 읽힌다)
function koreanPdf(text) {
  const hex = [...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  return onePage(`BT /F1 18 Tf 20 350 Td <${hex}> Tj ET`, '/F1 5 0 R', [
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -148 1001 880] /ItalicAngle 0 /Ascent 880 /Descent -148 /CapHeight 880 /StemV 93 >>',
  ]);
}

// 글자 없이 그림만 있는 PDF (스캔본처럼)
const drawingPdf = () => onePage('0.2 0.5 0.9 rg 40 100 220 200 re f', '');

// 크기가 정확히 size 바이트인 PDF
function sizedPdf(size) {
  const make = (padding) =>
    onePage('0 0 0 rg 10 10 50 50 re f', '', [Buffer.concat([Buffer.from(`<< /Length ${padding} >>\nstream\n`), Buffer.alloc(padding, 0x20), Buffer.from('\nendstream')])]);
  let padding = size - make(0).length;
  let result = make(padding);
  padding -= result.length - size; // 길이 숫자의 자릿수만큼 다시 맞춘다.
  result = make(padding);
  if (result.length !== size) throw new Error(`크기를 맞추지 못했어요: ${result.length} / ${size}`);
  return result;
}

module.exports = { textPdf, koreanPdf, drawingPdf, sizedPdf };
