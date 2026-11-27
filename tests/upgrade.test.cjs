// 이미 배포된 버전을 쓰던 사람이 새 버전으로 바뀌어도 데이터가 남는지 시험한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, openApp, checkoutOldApp } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
// 첫 배포본, 1단계 배포본, 2단계(안내 수정 포함) 배포본
const OLD_VERSIONS = [
  { commit: 'edea9dc', cache: 'second-brain-v3' },
  { commit: 'aad9805', cache: 'second-brain-v4' },
  { commit: '88815d2', cache: 'second-brain-v6' },
];

const cacheNames = (page) => page.evaluate(() => caches.keys());
const currentCache = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1];

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

async function upgradeFrom(old) {
  const oldDir = checkoutOldApp(old.commit);
  const server = await startServer(8751, { base: '/SecondBrain/', root: oldDir, maxAge: 600 });
  const { browser, page } = await openApp(server.url);
  try {
    // 1) 구버전 설치와 데이터 만들기
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByPlaceholder('무슨 생각이 나세요?').fill('예전 메모');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByPlaceholder('링크를 붙여넣으세요').fill('example.com/old');
    await page.getByPlaceholder('링크 설명 (선택)').fill('예전 링크');
    await page.getByRole('button', { name: '링크 추가' }).click();
    await page.getByLabel('사진 선택').setInputFiles({ name: 'old.png', mimeType: 'image/png', buffer: png });
    await page.getByPlaceholder('사진 설명 (선택)').fill('예전 사진');
    await page.getByRole('button', { name: '사진 추가' }).click();
    await page.getByTestId('item').nth(2).waitFor({ timeout: 5000 });
    await page.evaluate(() => localStorage.setItem('lastBackupAt', String(Date.UTC(2026, 0, 15, 3, 0))));
    assert.deepStrictEqual(await cacheNames(page), [old.cache]);

    // 2) 새 버전 배포
    server.setRoot(ROOT);
    await page.reload();
    // 새 서비스 워커가 새 파일을 다 받고 예전 저장분을 지울 때까지 기다린다.
    let names = [];
    for (let i = 0; i < 150 && names.join() !== currentCache; i++) {
      await page.waitForTimeout(100);
      names = await cacheNames(page);
    }
    assert.deepStrictEqual(names, [currentCache]);
    await page.reload();

    // 3) 새 화면 파일이 쓰이고, 예전 데이터는 그대로다
    await page.locator('#pdf-form').waitFor({ state: 'attached', timeout: 5000 });
    const cachedScript = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.match('./app.js')).text();
    }, currentCache);
    assert.strictEqual(
      cachedScript.replace(/\r/g, ''),
      fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\r/g, '')
    );
    await page.getByTestId('item').nth(2).waitFor({ timeout: 5000 });
    assert.strictEqual(await page.getByTestId('item').count(), 3);
    for (const word of ['예전 메모', '예전 링크', '예전 사진', 'example.com/old']) {
      await page.getByLabel('검색').fill(word);
      assert.strictEqual(await page.getByTestId('item').count(), 1, word);
    }
    await page.getByLabel('검색').fill('');
    await page.waitForFunction(() => document.querySelector('[data-type="photo"] img')?.naturalWidth > 0);
    // 캡션이 없던 예전 링크도 상세 화면이 열린다.
    await page.locator('[data-type="link"] .badge').click();
    await page.getByLabel('캡션 편집').waitFor({ state: 'visible', timeout: 3000 });
    assert.strictEqual(await page.getByLabel('캡션 편집').inputValue(), '');
    // 예전 lastBackupAt 값은 계속 읽는다.
    const status = await page.locator('#backup-status').innerText();
    assert.ok(status.includes('마지막 내보내기') && status.includes('2026'), status);
  } finally {
    await browser.close();
    server.stop();
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
}

for (const old of OLD_VERSIONS) {
  test(`구버전(${old.commit})에서 만든 메모·링크·사진이 업데이트 후에도 남고 검색되며, 서비스 워커는 새 파일로 바뀐다`, () =>
    upgradeFrom(old));
}
