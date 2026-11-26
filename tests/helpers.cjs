const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

// 시험용 파일 서버. Node만으로 동작한다.
// base를 주면 GitHub Pages처럼 그 하위 주소에서만 파일을 준다. (밖의 주소는 404)
// maxAge를 주면 GitHub Pages처럼 브라우저가 파일을 잠시 보관한다. setRoot()는 새 버전 배포를 흉내 낸다.
async function startServer(port, { base = '/', root = ROOT, maxAge } = {}) {
  let currentRoot = root;
  const server = http.createServer((req, res) => {
    const notFound = () => res.writeHead(404).end('not found');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return notFound();
    }
    if (!pathname.startsWith(base)) return notFound();
    let relative = pathname.slice(base.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(currentRoot, relative);
    if (!file.startsWith(path.resolve(currentRoot) + path.sep)) return notFound();
    fs.readFile(file, (error, data) => {
      if (error) return notFound();
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
      if (maxAge !== undefined) headers['Cache-Control'] = `max-age=${maxAge}`;
      res.writeHead(200, headers);
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}${base}`,
    setRoot: (next) => {
      currentRoot = next;
    },
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// 아이폰 크기 화면으로 앱을 연다.
async function openApp(url, { colorScheme = 'light' } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme });
  const page = await context.newPage();
  await page.goto(url);
  return { browser, context, page };
}

// 예전 버전의 앱 파일을 git 기록에서 임시 폴더로 꺼낸다. 다 쓰면 호출한 쪽에서 지운다.
function checkoutOldApp(commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-old-'));
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  const files = git('ls-tree', '-r', '--name-only', commit).toString().split('\n');
  for (const file of files.filter((f) => f && !f.startsWith('tests/') && !f.startsWith('docs/'))) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), git('show', `${commit}:${file}`));
  }
  return dir;
}

module.exports = { startServer, openApp, checkoutOldApp };
