// 저장·수정·삭제·가져오기·내보내기·DB 열기가 실패했을 때의 화면 동작 시험.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium, devices } = require('playwright');
const { startServer } = require('./helpers.cjs');

let server;
before(async () => {
  server = await startServer(8741);
});
after(() => server.stop());

// 앱 코드보다 먼저 실행되어, 시험이 켠 실패만 흉내 낸다.
// window.__fail = { add: true } 처럼 켜면 요청이 성공한 직후 transaction이 abort 된다.
// (저장 공간이 부족할 때처럼 error 없이 abort만 일어나는 상황)
function installFaults(initial) {
  window.__fail = { ...initial };
  for (const name of ['add', 'put', 'delete', 'getAll']) {
    const original = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (...args) {
      const request = original.apply(this, args);
      const rule = window.__fail[name];
      // 숫자를 주면 그 횟수만큼은 성공시키고 그다음부터 실패시킨다.
      const failNow = typeof rule === 'number' ? (rule > 0 ? ((window.__fail[name] = rule - 1), false) : true) : !!rule;
      if (failNow) request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  }
  const originalOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) {
    if (!window.__fail.open) return originalOpen.apply(this, args);
    const request = {};
    setTimeout(() => {
      request.error = new DOMException('시험용 열기 실패', 'UnknownError');
      if (request.onerror) request.onerror();
    }, 0);
    return request;
  };
  const originalCreateUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (window.__fail.exportFile && blob.type === 'application/json') throw new Error('시험용 파일 생성 실패');
    return originalCreateUrl(blob);
  };
}

async function openWithFaults(faults = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  await context.addInitScript(installFaults, faults);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByPlaceholder('무슨 생각이 나세요?').waitFor({ timeout: 3000 });
  return { browser, page };
}

// 시험 하나를 실행하고 브라우저를 닫는다.
function scenario(name, faults, body) {
  test(name, async () => {
    const { browser, page } = await openWithFaults(faults);
    try {
      await body(page);
    } finally {
      await browser.close();
    }
  });
}

const setFail = (page, faults) => page.evaluate((f) => Object.assign(window.__fail, f), faults);
const memoBox = (page) => page.getByPlaceholder('무슨 생각이 나세요?');
const items = (page) => page.getByTestId('item');
const shows = (locator, text) => locator.filter({ hasText: text }).waitFor({ state: 'visible', timeout: 3000 });

async function saveMemo(page, text) {
  await memoBox(page).fill(text);
  await page.getByRole('button', { name: '저장', exact: true }).click();
}

async function savedMemo(page, text) {
  await saveMemo(page, text);
  await items(page).filter({ hasText: text }).first().waitFor({ timeout: 3000 });
}

async function reloadedTexts(page) {
  await page.reload();
  await memoBox(page).waitFor({ timeout: 3000 });
  await page.waitForTimeout(400);
  return items(page).allInnerTexts();
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
const photoInput = (page) => page.getByLabel('사진 선택');
const selectedFiles = (page) => photoInput(page).evaluate((el) => [...el.files].map((f) => f.name));

// ---- 저장 ----

scenario('메모 저장에 실패하면 글을 되돌려 놓고 알리며, 다시 저장할 수 있다', { add: true }, async (page) => {
  await saveMemo(page, '잃으면 안 되는 메모');
  await shows(page.locator('#memo-message'), '저장하지 못했어요');
  assert.strictEqual(await memoBox(page).inputValue(), '잃으면 안 되는 메모');
  assert.strictEqual(await items(page).count(), 0);

  await setFail(page, { add: false });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await items(page).first().waitFor({ timeout: 3000 });
  await page.locator('#memo-message').waitFor({ state: 'hidden', timeout: 3000 });
  assert.strictEqual(await memoBox(page).inputValue(), '');
  assert.deepStrictEqual(await reloadedTexts(page), ['잃으면 안 되는 메모']);
});

scenario('실패하기 전에 새 글을 쓰면 덮어쓰지 않고 "저장 못 한 항목"에서 다시 저장한다', { add: true }, async (page) => {
  await page.evaluate(() => {
    const input = document.getElementById('memo-input');
    input.value = '먼저 쓴 메모';
    document.getElementById('memo-form').requestSubmit();
    input.value = '지금 쓰는 메모';
  });
  const unsaved = page.locator('#unsaved');
  await shows(unsaved, '먼저 쓴 메모');
  assert.ok((await unsaved.innerText()).includes('닫으면 사라져요'));
  assert.strictEqual(await memoBox(page).inputValue(), '지금 쓰는 메모');

  // 다시 시도도 실패하면 목록에 남는다.
  const retry = unsaved.getByRole('button', { name: '다시 저장' });
  const box = await retry.boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44, `다시 저장: ${JSON.stringify(box)}`);
  await retry.click();
  await page.waitForTimeout(300);
  await shows(unsaved, '먼저 쓴 메모');

  await setFail(page, { add: false });
  await retry.click();
  await unsaved.waitFor({ state: 'hidden', timeout: 3000 });
  assert.strictEqual(await memoBox(page).inputValue(), '지금 쓰는 메모');
  assert.deepStrictEqual(await reloadedTexts(page), ['먼저 쓴 메모']);
});

scenario('링크 저장에 실패하면 주소와 설명을 되돌려 놓고, 다시 저장할 수 있다', { add: true }, async (page) => {
  await page.getByPlaceholder('링크를 붙여넣으세요').fill('example.com/a');
  await page.getByPlaceholder('링크 설명 (선택)').fill('나중에 볼 글');
  await page.getByRole('button', { name: '링크 추가' }).click();
  await shows(page.locator('#link-message'), '저장하지 못했어요');
  assert.strictEqual(await page.getByPlaceholder('링크를 붙여넣으세요').inputValue(), 'example.com/a');
  assert.strictEqual(await page.getByPlaceholder('링크 설명 (선택)').inputValue(), '나중에 볼 글');

  await setFail(page, { add: false });
  await page.getByRole('button', { name: '링크 추가' }).click();
  await page.locator('[data-type="link"]').waitFor({ timeout: 3000 });
  assert.strictEqual((await reloadedTexts(page)).length, 1);
});

scenario('사진 저장에 실패하면 선택한 파일과 설명이 남아 다시 저장할 수 있다', { add: true }, async (page) => {
  await photoInput(page).setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.getByPlaceholder('사진 설명 (선택)').fill('영수증');
  await page.getByRole('button', { name: '사진 추가' }).click();
  await shows(page.locator('#photo-message'), '저장하지 못했어요');
  assert.deepStrictEqual(await selectedFiles(page), ['photo.png']);
  assert.strictEqual(await page.getByPlaceholder('사진 설명 (선택)').inputValue(), '영수증');

  await setFail(page, { add: false });
  await page.getByRole('button', { name: '사진 추가' }).click();
  await page.locator('[data-type="photo"] img').waitFor({ timeout: 5000 });
  assert.deepStrictEqual(await selectedFiles(page), []);
  assert.strictEqual(await items(page).count(), 1);
});

scenario('사진 입력칸을 이미 다시 쓰고 있으면 실패한 사진은 "저장 못 한 항목"에 남는다', { add: true }, async (page) => {
  await photoInput(page).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: png });
  await page.evaluate(() => {
    document.getElementById('photo-form').requestSubmit();
    document.getElementById('photo-desc').value = '다음 사진 설명';
  });
  const unsaved = page.locator('#unsaved');
  await shows(unsaved, 'first.png');
  assert.strictEqual(await page.getByPlaceholder('사진 설명 (선택)').inputValue(), '다음 사진 설명');

  await setFail(page, { add: false });
  await unsaved.getByRole('button', { name: '다시 저장' }).click();
  await page.locator('[data-type="photo"] img').waitFor({ timeout: 5000 });
  await unsaved.waitFor({ state: 'hidden', timeout: 3000 });
});

scenario('저장은 됐는데 목록 갱신만 실패하면, 저장 실패로 알리지 않고 중복 저장을 막는다', {}, async (page) => {
  await savedMemo(page, '기존 메모');
  await setFail(page, { getAll: true });
  await saveMemo(page, '저장은 되는 메모');
  await shows(page.locator('#list-message'), '목록을 새로 불러오지 못했어요');
  assert.strictEqual(await memoBox(page).inputValue(), '');
  assert.strictEqual(await page.locator('#memo-message').isVisible(), false);
  assert.strictEqual(await page.locator('#unsaved').isVisible(), false);
  assert.deepStrictEqual(await items(page).allInnerTexts(), ['저장은 되는 메모', '기존 메모']);
  assert.deepStrictEqual(await reloadedTexts(page), ['저장은 되는 메모', '기존 메모']);
});

// ---- 수정·삭제 ----

scenario('수정에 실패하면 편집 화면과 입력한 내용이 남고, 다시 저장할 수 있다', {}, async (page) => {
  await savedMemo(page, '원래 메모');
  await items(page).first().click();
  const editor = page.getByLabel('메모 수정');
  await editor.fill('고친 내용');
  await setFail(page, { put: true });
  await page.getByRole('button', { name: '수정 저장' }).click();
  await shows(page.locator('#detail-message'), '수정하지 못했어요');
  assert.strictEqual(await editor.isVisible(), true);
  assert.strictEqual(await editor.inputValue(), '고친 내용');

  await setFail(page, { put: false });
  await page.getByRole('button', { name: '수정 저장' }).click();
  await editor.waitFor({ state: 'hidden', timeout: 3000 });
  assert.deepStrictEqual(await reloadedTexts(page), ['고친 내용']);
});

scenario('삭제에 실패하면 항목이 남아 있다고 알린다', {}, async (page) => {
  await savedMemo(page, '지워지지 않는 메모');
  await items(page).first().click();
  await setFail(page, { delete: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '삭제' }).click();
  await shows(page.locator('#detail-message'), '메모는 그대로 남아 있어요');
  assert.deepStrictEqual(await reloadedTexts(page), ['지워지지 않는 메모']);
});

// ---- 가져오기·내보내기 ----

const backup = Buffer.from(
  JSON.stringify({
    app: 'second-brain',
    version: 1,
    items: [1, 2, 3].map((n) => ({ id: `m${n}`, type: 'memo', text: `백업 메모 ${n}`, createdAt: n * 1000 })),
  })
);
const importBackup = (page) =>
  page.getByLabel('가져오기 파일').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });

scenario('가져오기가 중간에 실패하면 성공한 개수와 중단을 알리고, 다시 가져와도 중복되지 않는다', { add: 1 }, async (page) => {
  await importBackup(page);
  await shows(page.locator('#backup-message'), '1개를 가져온 뒤 중단됐어요');
  assert.strictEqual(await items(page).count(), 1);

  await setFail(page, { add: false });
  await importBackup(page);
  await shows(page.locator('#backup-message'), '2개를 가져왔어요');
  assert.strictEqual((await reloadedTexts(page)).length, 3);
});

for (const [label, fault] of [
  ['파일 생성', { exportFile: true }],
  ['저장 공간 읽기', { getAll: true }],
]) {
  scenario(`내보내기(${label})에 실패하면 알리고 마지막 내보내기 시각을 갱신하지 않는다`, {}, async (page) => {
    await savedMemo(page, '내보낼 메모');
    await setFail(page, fault);
    await page.getByRole('button', { name: '내보내기' }).click();
    await shows(page.locator('#backup-message'), '내보내지 못했어요');
    await shows(page.locator('#backup-status'), '아직 내보낸 적이 없어요');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lastBackupAt')), null);
  });
}

// ---- DB 열기 ----

scenario('저장 공간을 열지 못하면 알리고, 입력은 유지되며 "다시 시도"로 복구한다', { open: true }, async (page) => {
  const banner = page.locator('#db-error');
  await shows(banner, '지금은 저장할 수 없어요');

  await saveMemo(page, '아직 저장 못 하는 메모');
  await shows(page.locator('#memo-message'), '저장하지 못했어요');
  assert.strictEqual(await memoBox(page).inputValue(), '아직 저장 못 하는 메모');
  assert.strictEqual(await memoBox(page).isEditable(), true);

  await page.getByRole('button', { name: '내보내기' }).click();
  await shows(page.locator('#backup-message'), '내보내지 못했어요');

  const retry = banner.getByRole('button', { name: '다시 시도' });
  const box = await retry.boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44, `다시 시도: ${JSON.stringify(box)}`);
  await retry.click();
  await page.waitForTimeout(300);
  await shows(banner, '지금은 저장할 수 없어요');

  await setFail(page, { open: false });
  await retry.click();
  await banner.waitFor({ state: 'hidden', timeout: 3000 });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await items(page).first().waitFor({ timeout: 3000 });
  assert.deepStrictEqual(await items(page).allInnerTexts(), ['아직 저장 못 하는 메모']);
});
