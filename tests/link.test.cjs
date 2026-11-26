// 2단계: 붙여넣기 버튼, 링크 캡션, 링크 삭제, v2 백업.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { chromium, devices } = require('playwright');
const { startServer, checkoutOldApp } = require('./helpers.cjs');

let server;
before(async () => {
  server = await startServer(8771);
});
after(() => server.stop());

// 클립보드를 흉내 낸다. 앱이 몇 번 읽었는지도 센다.
function installClipboard(initial) {
  window.__clipboard = initial;
  window.__reads = 0;
  window.__failWrites = false;
  const clipboard = {
    async readText() {
      window.__reads += 1;
      if (window.__clipboard.denied) throw new DOMException('거절', 'NotAllowedError');
      return window.__clipboard.text;
    },
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__clipboard.missing ? undefined : clipboard });
  for (const name of ['add', 'put', 'delete']) {
    const original = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (...args) {
      const request = original.apply(this, args);
      if (window.__failWrites) request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  }
}

async function open(url = server.url, clipboard = { text: '' }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  await context.addInitScript(installClipboard, clipboard);
  const page = await context.newPage();
  await page.goto(url);
  await page.getByPlaceholder('무슨 생각이 나세요?').waitFor({ timeout: 3000 });
  await page.waitForTimeout(150); // DB가 열릴 시간
  return { browser, context, page };
}

function scenario(name, body) {
  test(name, async () => {
    const { browser, page } = await open();
    try {
      await body(page);
    } finally {
      await browser.close();
    }
  });
}

const urlBox = (page) => page.getByPlaceholder('링크를 붙여넣으세요');
const descBox = (page) => page.getByPlaceholder('링크 설명 (선택)');
const captionBox = (page) => page.getByPlaceholder('캡션 (선택)');
const editor = (page) => page.getByLabel('캡션 편집');
const items = (page) => page.getByTestId('item');
const linkCards = (page) => page.locator('[data-type="link"]');
const shows = (locator, text) => locator.filter({ hasText: text }).waitFor({ state: 'visible', timeout: 3000 });
const values = async (page) => [await urlBox(page).inputValue(), await descBox(page).inputValue()];

async function paste(page, clipboard) {
  await page.evaluate((c) => Object.assign(window.__clipboard, { denied: false, text: '' }, c), clipboard);
  await page.getByRole('button', { name: '붙여넣기' }).click();
  await page.waitForTimeout(100);
}

async function addLink(page, { url = '', desc = '', caption = '' }) {
  await urlBox(page).fill(url);
  await descBox(page).fill(desc);
  await captionBox(page).fill(caption);
  await page.getByRole('button', { name: '링크 추가' }).click();
}

async function savedLink(page, link) {
  const before = await linkCards(page).count();
  await addLink(page, link);
  await linkCards(page).nth(before).waitFor({ timeout: 3000 });
}

// 카드의 링크 글자가 아닌 곳을 눌러 상세 화면을 연다.
async function openDetail(page, text) {
  await linkCards(page).filter({ hasText: text }).locator('.badge').click();
  await editor(page).waitFor({ state: 'visible', timeout: 3000 });
}

async function reload(page) {
  await page.reload();
  await page.getByPlaceholder('무슨 생각이 나세요?').waitFor({ timeout: 3000 });
  await page.waitForTimeout(300);
}

async function searchCount(page, word) {
  await page.getByLabel('검색').fill(word);
  return items(page).count();
}

// ---- 붙여넣기 규칙 ----

const RULES = [
  ['주소 하나', 'https://example.com/a?b=1#c', 'https://example.com/a?b=1#c', ''],
  ['http 주소와 앞뒤 공백', '  http://example.com/x \n', 'http://example.com/x', ''],
  ['글과 주소: 뒤의 문장 부호는 주소에서 뺀다', '이 글 좋아요 https://example.com/a. 꼭 보기', 'https://example.com/a', '이 글 좋아요 . 꼭 보기'],
  ['주소가 여러 개면 첫 주소만 주소 칸, 나머지는 설명에 남긴다', '첫째 https://a.com/1, 둘째 https://b.com/2', 'https://a.com/1', '첫째 , 둘째 https://b.com/2'],
  ['여러 줄 공유 글', '릴스 제목\nhttps://www.instagram.com/reel/abc/\n설명 줄', 'https://www.instagram.com/reel/abc/', '릴스 제목 설명 줄'],
  ['괄호로 감싼 주소', '(https://example.com/a)', 'https://example.com/a', ''],
  ['주소에 포함된 괄호는 남긴다', 'https://en.wikipedia.org/wiki/Mercury_(planet)', 'https://en.wikipedia.org/wiki/Mercury_(planet)', ''],
  ['http 없는 주소에는 https://를 붙인다', 'example.com', 'https://example.com', ''],
  ['http 없는 주소와 경로', 'sub.example.co.kr/path?q=1', 'https://sub.example.co.kr/path?q=1', ''],
  ['점 없는 낱말은 설명 칸', 'hello', '', 'hello'],
  ['숫자는 설명 칸', '3.14', '', '3.14'],
  ['마지막 부분이 한 글자면 설명 칸', 'a.b', '', 'a.b'],
  ['공백이 있는 글은 설명 칸', 'example.com 보기', '', 'example.com 보기'],
  ['이메일 주소는 설명 칸', 'someone@example.com', '', 'someone@example.com'],
  ['위험한 주소는 주소 칸에 넣지 않는다', 'javascript:alert(1)', '', 'javascript:alert(1)'],
];

for (const [label, text, url, desc] of RULES) {
  scenario(`붙여넣기 규칙: ${label}`, async (page) => {
    await paste(page, { text });
    assert.deepStrictEqual(await values(page), [url, desc]);
    assert.strictEqual(await captionBox(page).inputValue(), '', '캡션 칸은 채우지 않는다');
  });
}

scenario('붙여넣기는 버튼을 눌렀을 때만 클립보드를 읽고, 버튼은 44px 이상이다', async (page) => {
  await urlBox(page).fill('x');
  await captionBox(page).click();
  await reload(page);
  assert.strictEqual(await page.evaluate(() => window.__reads), 0);
  const box = await page.getByRole('button', { name: '붙여넣기' }).boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44, JSON.stringify(box));
  await paste(page, { text: 'example.com' });
  assert.strictEqual(await page.evaluate(() => window.__reads), 1);
});

scenario('이미 글이 있는 칸은 덮어쓰지 않고 알린다', async (page) => {
  await descBox(page).fill('내가 쓴 설명');
  await paste(page, { text: '공유 글 https://example.com/new' });
  assert.deepStrictEqual(await values(page), ['https://example.com/new', '내가 쓴 설명']);
  await shows(page.locator('#link-message'), '설명 칸에는 이미 글이 있어');

  await paste(page, { text: 'https://example.com/other' });
  assert.deepStrictEqual(await values(page), ['https://example.com/new', '내가 쓴 설명']);
  await shows(page.locator('#link-message'), '주소 칸에는 이미 글이 있어');
});

for (const [label, clipboard, notice] of [
  ['거절하면', { denied: true }, '클립보드를 읽지 못했어요'],
  ['비어 있으면', { text: '   ' }, '클립보드에 붙여넣을 글이 없어요'],
]) {
  scenario(`클립보드 읽기를 ${label} 안내하고 기존 입력을 보존한다`, async (page) => {
    await urlBox(page).fill('기존 주소');
    await descBox(page).fill('기존 설명');
    await paste(page, clipboard);
    await shows(page.locator('#link-message'), notice);
    await shows(page.locator('#link-message'), '길게 눌러');
    assert.deepStrictEqual(await values(page), ['기존 주소', '기존 설명']);
  });
}

test('클립보드를 지원하지 않는 브라우저에서도 직접 붙여넣는 방법을 안내한다', async () => {
  const { browser, page } = await open(server.url, { missing: true });
  try {
    await page.getByRole('button', { name: '붙여넣기' }).click();
    await shows(page.locator('#link-message'), '길게 눌러');
  } finally {
    await browser.close();
  }
});

test('실제 브라우저 클립보드로도 붙여넣기가 동작한다', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin });
    const page = await context.newPage();
    await page.goto(server.url);
    await page.evaluate(() => navigator.clipboard.writeText('진짜 클립보드 https://example.com/real'));
    await page.getByRole('button', { name: '붙여넣기' }).click();
    await page.waitForFunction(() => document.getElementById('link-url').value !== '');
    assert.deepStrictEqual(await values(page), ['https://example.com/real', '진짜 클립보드']);
  } finally {
    await browser.close();
  }
});

// ---- 주소 없이 저장 ----

for (const [label, input] of [
  ['글만 있으면', { desc: '그냥 글' }],
  ['캡션만 있으면', { caption: '긴 캡션만' }],
  ['위험한 주소면', { url: 'javascript:alert(1)', desc: '위험', caption: '캡션' }],
  ['아무것도 없으면', {}],
]) {
  scenario(`${label} 저장하지 않고 "주소가 필요해요"라고 알리며 입력을 보존한다`, async (page) => {
    await addLink(page, input);
    await shows(page.locator('#link-message'), '주소가 필요해요');
    assert.strictEqual(await items(page).count(), 0);
    assert.deepStrictEqual(await values(page), [input.url || '', input.desc || '']);
    assert.strictEqual(await captionBox(page).inputValue(), input.caption || '');
  });
}

// ---- 캡션 ----

const CAPTION = '첫 줄: 김치찌개 레시피\n둘째 줄: 두부를 넣는다';

scenario('캡션을 저장하면 검색되고, 새로고침 후 상세 화면에서 전체가 보인다', async (page) => {
  await savedLink(page, { url: 'example.com/reel', desc: '릴스', caption: CAPTION });
  assert.strictEqual(await captionBox(page).inputValue(), '');
  await reload(page);
  assert.strictEqual(await searchCount(page, '두부'), 1);
  assert.strictEqual(await searchCount(page, '릴스'), 1);
  assert.strictEqual(await searchCount(page, 'example.com/reel'), 1);
  assert.strictEqual(await searchCount(page, '없는 말'), 0);
  await page.getByLabel('검색').fill('');
  await openDetail(page, '릴스');
  assert.strictEqual(await editor(page).inputValue(), CAPTION);
  const anchor = page.locator('#detail a');
  assert.strictEqual(await anchor.getAttribute('href'), 'https://example.com/reel');
  assert.strictEqual(await anchor.getAttribute('target'), '_blank');
  assert.ok((await anchor.getAttribute('rel')).includes('noopener'));
  assert.ok((await page.locator('#detail').innerText()).includes('릴스'));
});

scenario('상세 화면에서 캡션을 고치고, 비워 저장하면 캡션만 지워진다', async (page) => {
  await savedLink(page, { url: 'example.com/edit', desc: '고칠 링크', caption: '예전캡션' });
  await openDetail(page, '고칠 링크');
  await editor(page).fill('새캡션');
  await page.getByRole('button', { name: '캡션 저장' }).click();
  await editor(page).waitFor({ state: 'hidden', timeout: 3000 });
  await reload(page);
  assert.strictEqual(await searchCount(page, '새캡션'), 1);
  assert.strictEqual(await searchCount(page, '예전캡션'), 0);
  await page.getByLabel('검색').fill('');

  await openDetail(page, '고칠 링크');
  await editor(page).fill('   ');
  await page.getByRole('button', { name: '캡션 저장' }).click();
  await editor(page).waitFor({ state: 'hidden', timeout: 3000 });
  await reload(page);
  assert.strictEqual(await linkCards(page).count(), 1, '링크는 남아야 한다');
  assert.strictEqual(await searchCount(page, '새캡션'), 0);
  assert.strictEqual(await searchCount(page, 'example.com/edit'), 1);
});

scenario('카드의 주소를 누르면 새 탭이 열리고 상세 화면은 열리지 않는다', async (page) => {
  await savedLink(page, { url: 'https://example.com/tab', desc: '새 탭' });
  await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'ok' }));
  const [popup] = await Promise.all([page.waitForEvent('popup'), linkCards(page).locator('a').click()]);
  await popup.close();
  assert.strictEqual(await editor(page).isVisible(), false);
});

scenario('메모 화면과 링크 화면을 번갈아 열어도 서로 섞이지 않는다', async (page) => {
  await page.getByPlaceholder('무슨 생각이 나세요?').fill('메모 하나');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await savedLink(page, { url: 'example.com/mix', desc: '섞기 링크', caption: '링크의 캡션' });
  await openDetail(page, '섞기 링크');
  await page.locator('[data-type="memo"]').click();
  await page.getByLabel('메모 수정').waitFor({ state: 'visible', timeout: 3000 });
  assert.strictEqual(await page.getByLabel('메모 수정').inputValue(), '메모 하나');
  assert.strictEqual(await page.locator('#detail a').isVisible(), false);
  assert.strictEqual(await page.getByRole('button', { name: '수정 저장' }).isVisible(), true);
  await openDetail(page, '섞기 링크');
  assert.strictEqual(await editor(page).inputValue(), '링크의 캡션');
});

scenario('캡션 속 HTML은 글자로만 보인다', async (page) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await savedLink(page, { url: 'example.com/html', desc: evil, caption: evil });
  await openDetail(page, 'example.com/html');
  assert.strictEqual(await editor(page).inputValue(), evil);
  assert.strictEqual(await page.locator('#list img, #detail img').count(), 0);
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
});

scenario('상세 화면의 버튼은 모두 44px 이상이다', async (page) => {
  await savedLink(page, { url: 'example.com/size', desc: '크기' });
  await openDetail(page, '크기');
  for (const name of ['캡션 저장', '삭제', '닫기']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44, `${name}: ${JSON.stringify(box)}`);
  }
});

// ---- 삭제 ----

scenario('링크 삭제는 확인창을 거치며, 취소하면 남고 확인하면 새로고침 후에도 없다', async (page) => {
  await savedLink(page, { url: 'example.com/keep', desc: '남길 링크' });
  await savedLink(page, { url: 'example.com/drop', desc: '지울 링크', caption: '캡션' });
  await openDetail(page, '지울 링크');
  const messages = [];
  page.once('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '삭제' }).click();
  await page.waitForTimeout(300);
  assert.ok(messages[0].includes('링크') && messages[0].includes('삭제'), messages[0]);
  assert.strictEqual(await linkCards(page).count(), 2);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '삭제' }).click();
  await editor(page).waitFor({ state: 'hidden', timeout: 3000 });
  await reload(page);
  assert.strictEqual(await linkCards(page).count(), 1);
  assert.ok((await linkCards(page).innerText()).includes('남길 링크'));
});

// ---- 저장 실패 ----

scenario('캡션이 있는 링크 저장에 실패하면 캡션까지 되돌려 놓는다', async (page) => {
  await page.evaluate(() => (window.__failWrites = true));
  await addLink(page, { url: 'example.com/f', desc: '설명', caption: CAPTION });
  await shows(page.locator('#link-message'), '저장하지 못했어요');
  assert.strictEqual(await captionBox(page).inputValue(), CAPTION);
  await page.evaluate(() => (window.__failWrites = false));
  await page.getByRole('button', { name: '링크 추가' }).click();
  await linkCards(page).first().waitFor({ timeout: 3000 });
  await reload(page);
  assert.strictEqual(await searchCount(page, '두부'), 1);
});

scenario('입력칸을 다시 쓰고 있으면 실패한 링크의 캡션은 "저장 못 한 항목"에서 복사할 수 있다', async (page) => {
  await page.evaluate(() => {
    window.__failWrites = true;
    document.getElementById('link-url').value = 'example.com/first';
    document.getElementById('link-caption').value = '잃으면 안 되는 캡션';
    document.getElementById('link-form').requestSubmit();
    document.getElementById('link-caption').value = '다음 캡션';
  });
  await shows(page.locator('#unsaved'), '잃으면 안 되는 캡션');
  assert.strictEqual(await captionBox(page).inputValue(), '다음 캡션');
  assert.strictEqual(await urlBox(page).inputValue(), '');
});

scenario('캡션 수정에 실패하면 편집 화면과 입력한 내용이 남는다', async (page) => {
  await savedLink(page, { url: 'example.com/e', desc: '수정 실패', caption: '원래' });
  await openDetail(page, '수정 실패');
  await editor(page).fill('고친 캡션');
  await page.evaluate(() => (window.__failWrites = true));
  await page.getByRole('button', { name: '캡션 저장' }).click();
  await shows(page.locator('#detail-message'), '수정하지 못했어요');
  assert.strictEqual(await editor(page).inputValue(), '고친 캡션');
  await page.evaluate(() => (window.__failWrites = false));
  await page.getByRole('button', { name: '캡션 저장' }).click();
  await editor(page).waitFor({ state: 'hidden', timeout: 3000 });
  await reload(page);
  assert.strictEqual(await searchCount(page, '고친 캡션'), 1);
});

scenario('링크 삭제에 실패하면 링크가 남아 있다고 알린다', async (page) => {
  await savedLink(page, { url: 'example.com/d', desc: '삭제 실패' });
  await openDetail(page, '삭제 실패');
  await page.evaluate(() => (window.__failWrites = true));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '삭제' }).click();
  await shows(page.locator('#detail-message'), '링크는 그대로 남아 있어요');
  await reload(page);
  assert.strictEqual(await linkCards(page).count(), 1);
});

// ---- 안내 ----

scenario('공유 단축어 만드는 방법과 라이브 텍스트, 백업 전 업데이트 안내를 볼 수 있다', async (page) => {
  const guide = page.locator('#share-guide');
  const summary = guide.locator('summary');
  const box = await summary.boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44, JSON.stringify(box));
  await summary.click();
  const text = await guide.innerText();
  for (const word of ['공유 시트에서 보기', '클립보드에 복사', '붙여넣기', '홈 화면', 'Safari', '저장 공간', 'URL 열기']) {
    assert.ok(text.includes(word), word);
  }
  assert.ok((await page.locator('#link-form').innerText()).includes('라이브 텍스트'));
  assert.ok((await page.locator('#backup').innerText()).includes('가져오기 전에 앱을 업데이트하세요'));
});

// ---- 백업 v2 ----

async function exportFile(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.getByRole('button', { name: '내보내기' }).click(),
  ]);
  const buffer = fs.readFileSync(await download.path());
  return { buffer, json: JSON.parse(buffer.toString('utf-8')) };
}

const importBuffer = (page, buffer) =>
  page.getByLabel('가져오기 파일').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer });
const asFile = (data) => Buffer.from(JSON.stringify(data));

async function makeBackupWithCaption() {
  const { browser, page } = await open();
  try {
    await page.getByPlaceholder('무슨 생각이 나세요?').fill('백업 메모');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await savedLink(page, { url: 'example.com/backup', desc: '백업 링크', caption: CAPTION });
    return await exportFile(page);
  } finally {
    await browser.close();
  }
}

test('v2로 내보낸 캡션이 빈 앱에서 복구되어 검색되고, 다시 가져와도 중복되지 않는다', async () => {
  const { buffer, json } = await makeBackupWithCaption();
  assert.strictEqual(json.version, 2);
  assert.ok(!('items' in json));
  assert.strictEqual(json.entries.find((e) => e.type === 'link').caption, CAPTION);

  const { browser, page } = await open();
  try {
    await importBuffer(page, buffer);
    await shows(page.locator('#backup-message'), '2개를 가져왔어요');
    await reload(page);
    assert.strictEqual(await searchCount(page, '두부'), 1);
    await openDetail(page, '백업 링크');
    assert.strictEqual(await editor(page).inputValue(), CAPTION);
    await importBuffer(page, buffer);
    await shows(page.locator('#backup-message'), '이미 있는 2개는 건너뛰었어요');
    await page.getByLabel('검색').fill('');
    assert.strictEqual(await items(page).count(), 2);
  } finally {
    await browser.close();
  }
});

scenario('v1 백업(캡션 없는 링크)도 가져올 수 있고, 상세 화면에서 캡션을 더할 수 있다', async (page) => {
  await importBuffer(page, asFile({ app: 'second-brain', version: 1, items: [{ id: 'v1', type: 'link', url: 'https://example.com/v1', text: '옛 링크', createdAt: 1000 }] }));
  await shows(page.locator('#backup-message'), '1개를 가져왔어요');
  assert.strictEqual(await searchCount(page, '옛 링크'), 1);
  await openDetail(page, '옛 링크');
  assert.strictEqual(await editor(page).inputValue(), '');
  await editor(page).fill('나중에 더한 캡션');
  await page.getByRole('button', { name: '캡션 저장' }).click();
  await editor(page).waitFor({ state: 'hidden', timeout: 3000 });
  assert.strictEqual(await searchCount(page, '나중에 더한'), 1);
});

const entry = { id: 'z', type: 'memo', text: '들어오면 안 됨', createdAt: 1000 };
for (const [label, data] of [
  ['모르는 버전(3)', { app: 'second-brain', version: 3, entries: [entry], items: [entry] }],
  ['글자 버전("2")', { app: 'second-brain', version: '2', entries: [entry] }],
  ['버전 없음', { app: 'second-brain', items: [entry] }],
  ['v2인데 items만 있음', { app: 'second-brain', version: 2, items: [entry] }],
  ['v1인데 entries만 있음', { app: 'second-brain', version: 1, entries: [entry] }],
]) {
  scenario(`읽을 수 없는 백업(${label})은 파일 전체를 거부하고 안내한다`, async (page) => {
    await importBuffer(page, asFile(data));
    await shows(page.locator('#backup-message'), '가져올 수 없는 파일이에요');
    assert.strictEqual(await items(page).count(), 0);
  });
}

for (const commit of ['edea9dc', 'aad9805']) {
  test(`구버전 앱(${commit})은 v2 파일을 거부하고 아무것도 바꾸지 않는다`, async () => {
    const { buffer } = await makeBackupWithCaption();
    const dir = checkoutOldApp(commit);
    const old = await startServer(commit === 'edea9dc' ? 8772 : 8773, { root: dir });
    const { browser, page } = await open(old.url);
    try {
      await importBuffer(page, buffer);
      await shows(page.locator('#backup-message'), '가져올 수 없는 파일이에요');
      assert.strictEqual(await items(page).count(), 0);
    } finally {
      await browser.close();
      old.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
