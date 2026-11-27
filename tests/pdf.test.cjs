// 3단계: PDF 저장·보기·검색·삭제·요약 요청문·제한·보안·백업·저장소 보존.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { chromium, devices } = require('playwright');
const { startServer } = require('./helpers.cjs');
const { textPdf, koreanPdf, drawingPdf, sizedPdf } = require('./pdf-fixtures.cjs');

const MB20 = 20 * 1024 * 1024;
let server;
before(async () => {
  server = await startServer(8781);
});
after(() => server.stop());

function install(options) {
  window.__failWrites = false;
  window.__copied = null;
  window.__failCopy = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        if (window.__failCopy) throw new DOMException('거절', 'NotAllowedError');
        window.__copied = text;
      },
    },
  });
  if (options.persist) {
    const storage =
      options.persist === 'unsupported'
        ? undefined
        : { persisted: async () => false, persist: async () => options.persist === 'granted' };
    Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
  }
  for (const name of ['add', 'delete']) {
    const original = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (...args) {
      const request = original.apply(this, args);
      if (window.__failWrites) request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  }
}

async function open(options = {}, url = server.url) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  await context.addInitScript(install, options);
  const page = await context.newPage();
  await page.goto(url);
  await page.getByPlaceholder('무슨 생각이 나세요?').waitFor({ timeout: 3000 });
  await page.waitForTimeout(150);
  return { browser, context, page };
}

function scenario(name, body, options) {
  test(name, async () => {
    const { browser, page } = await open(options);
    try {
      await body(page);
    } finally {
      await browser.close();
    }
  });
}

const cards = (page) => page.locator('[data-type="pdf"]');
const message = (page) => page.locator('#pdf-message');
const detailMessage = (page) => page.locator('#detail-message');
const shows = (locator, text) => locator.filter({ hasText: text }).waitFor({ state: 'visible', timeout: 5000 });

async function choose(page, buffer, name = 'doc.pdf', desc = '', mimeType = 'application/pdf') {
  // 큰 파일은 임시 파일로 넘긴다.
  if (buffer.length > MB20 / 2) {
    const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sb-pdf-'));
    const file = require('node:path').join(dir, name);
    fs.writeFileSync(file, buffer);
    await page.getByLabel('PDF 선택').setInputFiles(file);
  } else {
    await page.getByLabel('PDF 선택').setInputFiles({ name, mimeType, buffer });
  }
  await page.getByPlaceholder('PDF 설명 (선택)').fill(desc);
  await page.getByRole('button', { name: 'PDF 추가' }).click();
}

async function savePdf(page, buffer, name, desc) {
  const before = await cards(page).count();
  await choose(page, buffer, name, desc);
  await cards(page).nth(before).waitFor({ timeout: 30000 });
}

async function openDetail(page, text) {
  await cards(page).filter({ hasText: text }).locator('.badge').click();
  await page.getByRole('button', { name: '요약 요청문 복사' }).waitFor({ timeout: 3000 });
}

async function reload(page) {
  await page.reload();
  await page.getByPlaceholder('무슨 생각이 나세요?').waitFor({ timeout: 3000 });
  await page.waitForTimeout(400);
}

async function found(page, word) {
  await page.getByLabel('검색').fill(word);
  const count = await page.getByTestId('item').count();
  await page.getByLabel('검색').fill('');
  return count;
}

const stored = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('second-brain', 1);
        open.onsuccess = () => {
          const request = open.result.transaction('items').objectStore('items').getAll();
          request.onsuccess = async () => {
            const out = [];
            for (const item of request.result) {
              const head = item.blob ? await item.blob.slice(0, 5).text() : '';
              out.push({ ...item, blob: item.blob && { type: item.blob.type, size: item.blob.size, head }, thumb: !!item.thumb, pdfTextLength: (item.pdfText || '').length });
            }
            resolve(out);
          };
        };
      })
  );

const waitThumb = (page) => page.waitForFunction(() => document.querySelector('[data-type="pdf"] img')?.naturalWidth > 0);

// ---- 저장·보기·검색 ----

scenario('PDF를 저장하면 파일명·설명·첫 페이지 미리보기가 보이고, 본문·파일명·설명으로 검색된다', async (page) => {
  await savePdf(page, textPdf('Quarterly zebra report'), 'report-q3.pdf', '분기 보고서');
  const text = await cards(page).innerText();
  assert.ok(text.includes('report-q3.pdf') && text.includes('분기 보고서') && text.includes('PDF'), text);
  await waitThumb(page);
  assert.strictEqual(await page.getByPlaceholder('PDF 설명 (선택)').inputValue(), '');
  await reload(page);
  await waitThumb(page);
  for (const word of ['zebra', 'report-q3', '분기']) assert.strictEqual(await found(page, word), 1, word);
  assert.strictEqual(await found(page, '없는낱말'), 0);
});

scenario('한글 PDF의 본문도 검색된다', async (page) => {
  await savePdf(page, koreanPdf('김치찌개 조리법'), 'kr.pdf', '');
  assert.strictEqual(await found(page, '조리법'), 1);
});

scenario('저장한 원본은 application/pdf 임시 주소로 새 탭에 연다 (파일이 주장하는 형식은 무시한다)', async (page) => {
  const original = textPdf('open me');
  await choose(page, original, 'evil.pdf', '', 'text/html');
  await cards(page).first().waitFor({ timeout: 15000 });
  for (const scope of [cards(page).first(), page.locator('#detail')]) {
    if (!(await scope.isVisible())) await openDetail(page, 'evil.pdf');
    const link = scope.getByRole('link', { name: 'PDF 열기' });
    assert.strictEqual(await link.getAttribute('target'), '_blank');
    const href = await link.getAttribute('href');
    assert.ok(href.startsWith('blob:'), href);
    const result = await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      return { type: blob.type, size: blob.size };
    }, href);
    assert.deepStrictEqual(result, { type: 'application/pdf', size: original.length });
  }
  assert.strictEqual((await stored(page))[0].blob.type, 'application/pdf');
});

scenario('글자가 없는 PDF도 원본과 미리보기를 보관하고 "글자를 읽지 못했어요"라고 알린다', async (page) => {
  await savePdf(page, drawingPdf(), 'scan.pdf', '');
  await shows(cards(page), '글자를 읽지 못했어요');
  await waitThumb(page);
  await openDetail(page, 'scan.pdf');
  await page.getByRole('button', { name: '요약 요청문 복사' }).click();
  await shows(detailMessage(page), '복사할 글자가 없어요');
  assert.strictEqual(await page.evaluate(() => window.__copied), null);
});

scenario('내용이 깨진 PDF는 미리보기·글자 추출에 실패해도 원본을 보관한다', async (page) => {
  const broken = Buffer.from('%PDF-1.7\n이 파일은 중간이 깨져 있어요');
  await savePdf(page, broken, 'broken.pdf', '깨진 파일');
  await shows(cards(page), '글자를 읽지 못했어요');
  assert.strictEqual(await cards(page).locator('img').count(), 0);
  assert.strictEqual((await stored(page))[0].blob.size, broken.length);
});

scenario('PDF가 아닌 파일은 저장하지 않고 입력을 남긴 채 알린다', async (page) => {
  await choose(page, Buffer.from('<script>alert(1)</script>'), 'fake.pdf', '가짜');
  await shows(message(page), 'PDF 파일이 아니에요');
  assert.strictEqual(await cards(page).count(), 0);
  assert.strictEqual(await page.getByPlaceholder('PDF 설명 (선택)').inputValue(), '가짜');
});

scenario('파일명·설명·본문의 HTML은 글자로만 보인다', async (page) => {
  const evil = '<img src=x onerror=window.__pwned=1>';
  await savePdf(page, textPdf(evil), 'a<b>.pdf', evil);
  await openDetail(page, evil);
  assert.ok((await page.locator('#detail').innerText()).includes(evil));
  assert.strictEqual(await page.locator('#detail img, #list img[src="x"]').count(), 0);
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
});

// ---- 삭제·실패 ----

scenario('PDF 삭제는 확인창을 거치며, 취소하면 남고 확인하면 새로고침 후에도 없다', async (page) => {
  await savePdf(page, textPdf('bye'), 'bye.pdf', '');
  await openDetail(page, 'bye.pdf');
  assert.strictEqual(await page.locator('#detail-input').isVisible(), false);
  assert.strictEqual(await page.locator('#detail-save').isVisible(), false);
  for (const name of ['요약 요청문 복사', '삭제', '닫기']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44, name);
  }
  const messages = [];
  page.once('dialog', async (d) => {
    messages.push(d.message());
    await d.dismiss();
  });
  await page.getByRole('button', { name: '삭제' }).click();
  await page.waitForTimeout(300);
  assert.ok(messages[0].includes('PDF'), messages[0]);
  assert.strictEqual(await cards(page).count(), 1);

  await page.evaluate(() => (window.__failWrites = true));
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '삭제' }).click();
  await shows(detailMessage(page), 'PDF는 그대로 남아 있어요');
  await page.evaluate(() => (window.__failWrites = false));

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '삭제' }).click();
  await page.locator('#detail').waitFor({ state: 'hidden' });
  await reload(page);
  assert.strictEqual(await cards(page).count(), 0);
});

scenario('PDF 저장에 실패하면 선택한 파일과 설명이 남아 다시 저장할 수 있다', async (page) => {
  await page.evaluate(() => (window.__failWrites = true));
  await choose(page, textPdf('retry'), 'retry.pdf', '다시');
  await shows(message(page), '저장하지 못했어요');
  assert.deepStrictEqual(await page.getByLabel('PDF 선택').evaluate((el) => [...el.files].map((f) => f.name)), ['retry.pdf']);
  assert.strictEqual(await page.getByPlaceholder('PDF 설명 (선택)').inputValue(), '다시');
  await page.evaluate(() => (window.__failWrites = false));
  await page.getByRole('button', { name: 'PDF 추가' }).click();
  await cards(page).first().waitFor({ timeout: 15000 });
});

// ---- 요약 요청문·제한 ----

async function copySummary(page) {
  await page.getByRole('button', { name: '요약 요청문 복사' }).click();
  await detailMessage(page).filter({ hasText: '복사' }).waitFor({ timeout: 3000 });
  return page.evaluate(() => window.__copied);
}

scenario('요약 요청문 복사는 한국어 요청문과 PDF 글자를 함께 복사하고, 실패하면 알린다', async (page) => {
  await savePdf(page, textPdf('summary target'), 's.pdf', '');
  await openDetail(page, 's.pdf');
  const copied = await copySummary(page);
  assert.ok(copied.includes('요약해 주세요') && copied.includes('summary target'), copied);
  await shows(detailMessage(page), '복사했어요');
  await page.evaluate(() => (window.__failCopy = true));
  await page.getByRole('button', { name: '요약 요청문 복사' }).click();
  await shows(detailMessage(page), '복사하지 못했어요');
});

test('복사는 요청문을 포함해 100,000자까지이며, 넘으면 앞부분만 복사하고 알린다', async () => {
  const { browser, page } = await open();
  try {
    await savePdf(page, textPdf('a'), 'one.pdf', '');
    await openDetail(page, 'one.pdf');
    const overhead = (await copySummary(page)).length - 1;
    await page.getByRole('button', { name: '닫기' }).click();

    for (const [name, length, truncated] of [
      ['fit.pdf', 100000 - overhead, false],
      ['over.pdf', 100000 - overhead + 1, true],
    ]) {
      await savePdf(page, textPdf('b'.repeat(length)), name, '');
      await openDetail(page, name);
      const copied = await copySummary(page);
      assert.strictEqual(copied.length, 100000, name);
      assert.strictEqual((await detailMessage(page).innerText()).includes('앞부분만'), truncated, name);
      await page.getByRole('button', { name: '닫기' }).click();
    }
  } finally {
    await browser.close();
  }
});

scenario('추출한 글은 500,000자까지 저장하고, 넘으면 일부만 검색된다고 알린다', async (page) => {
  await savePdf(page, textPdf('c'.repeat(500000)), 'exact.pdf', '');
  assert.ok(!(await cards(page).innerText()).includes('일부만 검색'));
  await savePdf(page, textPdf('d'.repeat(500000) + 'TAILWORD'), 'long.pdf', '');
  await shows(cards(page).filter({ hasText: 'long.pdf' }), '일부만 검색');
  const byName = Object.fromEntries((await stored(page)).map((i) => [i.name, i.pdfTextLength]));
  assert.deepStrictEqual(byName, { 'exact.pdf': 500000, 'long.pdf': 500000 });
  assert.strictEqual(await found(page, 'TAILWORD'), 0);
});

scenario('PDF는 정확히 20MB까지 저장하고, 1바이트라도 넘으면 저장 전에 거부한다', async (page) => {
  await choose(page, sizedPdf(MB20 + 1), 'toobig.pdf', '큰 파일');
  await shows(message(page), '20MB');
  assert.strictEqual(await cards(page).count(), 0);
  await savePdf(page, sizedPdf(MB20), 'max.pdf', '');
  assert.strictEqual((await stored(page))[0].blob.size, MB20);
});

scenario('제한값과 백업·유실 주의 안내가 화면에 있다', async (page) => {
  const form = await page.locator('#pdf-form').innerText();
  for (const word of ['20MB', '500,000자', '100,000자']) assert.ok(form.includes(word), word);
  assert.ok((await page.locator('#backup').innerText()).includes('지울 수 있어요'));
});

test('홈 화면 앱에서도 데이터 유실 주의를 볼 수 있다', async () => {
  const { browser, context, page } = await open();
  try {
    await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await reload(page);
    assert.strictEqual(await page.locator('#install-tip').isVisible(), false);
    assert.ok((await page.locator('#backup').innerText()).includes('지울 수 있어요'));
  } finally {
    await browser.close();
  }
});

// ---- 저장소 보존 ----

for (const [state, words] of [
  ['granted', '저장소 보존: 허용됨'],
  ['denied', '저장소 보존: 허용되지 않음'],
  ['unsupported', '저장소 보존: 이 브라우저는 지원하지 않음'],
]) {
  scenario(`저장소 보존 상태(${state})를 보여준다`, async (page) => {
    await shows(page.locator('#persist-status'), words);
  }, { persist: state });
}

// ---- 백업 ----

async function exportFile(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: '내보내기' }).click(),
  ]);
  const buffer = fs.readFileSync(await download.path());
  return { buffer, json: JSON.parse(buffer.toString('utf-8')) };
}
const importBuffer = (page, buffer) =>
  page.getByLabel('가져오기 파일').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer });

test('PDF 원본이 백업에 담기고, 빈 앱에서 복원해 열기와 검색이 된다', async () => {
  const original = textPdf('restorable giraffe');
  const first = await open();
  let backup;
  try {
    await savePdf(first.page, original, 'g.pdf', '기린 문서');
    backup = await exportFile(first.page);
  } finally {
    await first.browser.close();
  }
  const entry = backup.json.entries[0];
  assert.deepStrictEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'name', 'pdf', 'text', 'type']);
  assert.ok(Buffer.from(entry.pdf.data, 'base64').equals(original));

  const { browser, page } = await open();
  try {
    await importBuffer(page, backup.buffer);
    await shows(page.locator('#backup-message'), '1개를 가져왔어요');
    await reload(page);
    await waitThumb(page);
    for (const word of ['giraffe', 'g.pdf', '기린']) assert.strictEqual(await found(page, word), 1, word);
    const [item] = await stored(page);
    assert.deepStrictEqual(item.blob, { type: 'application/pdf', size: original.length, head: '%PDF-' });
    await importBuffer(page, backup.buffer);
    await shows(page.locator('#backup-message'), '이미 있는 1개는 건너뛰었어요');
  } finally {
    await browser.close();
  }
});

scenario('백업의 속인 형식은 무시하고, PDF가 아니거나 너무 큰 항목은 건너뛴 개수에 넣는다', async (page) => {
  const entry = (id, data, extra = {}) => ({ id, type: 'pdf', name: `${id}.pdf`, text: '', createdAt: 1000, pdf: { mime: 'text/html', data, ...extra } });
  const file = {
    app: 'second-brain',
    version: 2,
    entries: [
      entry('ok', textPdf('fine').toString('base64')),
      entry('html', Buffer.from('<html><script>1</script>').toString('base64')),
      entry('big', sizedPdf(MB20 + 1).toString('base64')),
      entry('bad64', '!!!not-base64!!!'),
      { id: 'empty', type: 'pdf', name: 'e.pdf', createdAt: 1 },
    ],
  };
  await importBuffer(page, Buffer.from(JSON.stringify(file)));
  await shows(page.locator('#backup-message'), '읽을 수 없는 4개는 건너뛰었어요');
  await shows(page.locator('#backup-message'), '1개를 가져왔어요');
  const items = await stored(page);
  assert.deepStrictEqual(items.map((i) => [i.id, i.blob.type]), [['ok', 'application/pdf']]);
});

// ---- 오프라인 (하위 주소) ----

test('/SecondBrain/ 하위 주소에서 오프라인으로도 한글 PDF를 저장·검색하고 미리본다', async () => {
  const sub = await startServer(8782, { base: '/SecondBrain/' });
  const { browser, context, page } = await open({}, sub.url);
  try {
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await reload(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    sub.stop();
    await context.setOffline(true);
    await reload(page);
    await savePdf(page, koreanPdf('오프라인 한글 문서'), 'off.pdf', '');
    assert.strictEqual(await found(page, '한글 문서'), 1);
    await savePdf(page, textPdf('offline latin'), 'off2.pdf', '');
    await waitThumb(page);
  } finally {
    await browser.close();
    sub.stop();
  }
});
