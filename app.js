(function () {
  const DB_NAME = 'second-brain';
  const STORE = 'items';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 화면에 새로 추가한 안내 문구. 나중에 번역 사전으로 옮기기 쉽게 한곳에 모은다.
  const TEXT = {
    noDb: '저장 공간이 열리지 않아 저장하지 못했어요. 입력한 내용은 그대로 있어요.',
    restored: '저장하지 못했어요. 입력한 내용을 되돌려 놓았어요. 다시 저장해 주세요.',
    keptBelow: '저장하지 못했어요. 아래 "저장 못 한 항목"에 보관했어요.',
    retryFailed: '다시 저장하지 못했어요.',
    quota: ' 폰의 저장 공간이 부족할 수 있어요.',
    retry: '다시 저장',
    refreshFailed: '저장 작업은 끝났지만 목록을 새로 불러오지 못했어요. 다시 저장하지 말고 앱을 다시 열어 주세요.',
    loadFailed: '저장한 항목을 불러오지 못했어요. 앱을 다시 열어 주세요.',
    openFailed: '항목을 열지 못했어요. 다시 눌러 주세요.',
    editFailed: '수정하지 못했어요. 쓴 내용은 그대로 있어요. 다시 저장해 주세요.',
    deleteFailed: '삭제하지 못했어요. 메모는 그대로 남아 있어요.',
    exportFailed: '내보내지 못했어요. 마지막 내보내기 시각은 바꾸지 않았어요.',
    importNoDb: '저장 공간이 열리지 않아 가져오지 못했어요.',
    importReadFailed: '파일을 읽지 못했어요. 다시 골라 주세요.',
    importResume: '같은 파일을 다시 가져오면 나머지를 이어서 가져와요. 이미 가져온 항목은 건너뛰어요.',
    importUnreadable: '가져올 수 없는 파일이에요. 내보내기로 만든 파일을 골라 주세요.',
    importUnknownVersion: '가져올 수 없는 파일이에요. 이 앱이 읽을 수 없는 버전이에요. 앱을 업데이트한 뒤 다시 가져와 주세요.',
    needUrl: '주소가 필요해요. 주소 칸에 링크를 넣어 주세요.',
    pasteFailed: '클립보드를 읽지 못했어요. 넣을 칸을 길게 눌러 "붙여넣기"를 골라 직접 붙여넣어 주세요.',
    pasteEmpty: '클립보드에 붙여넣을 글이 없어요. 다시 복사하거나, 넣을 칸을 길게 눌러 직접 붙여넣어 주세요.',
    pasteKept: (fields) => `${fields.join('·')} 칸에는 이미 글이 있어 덮어쓰지 않았어요. 칸을 비우고 다시 붙여넣어 주세요.`,
    urlField: '주소',
    descField: '설명',
  };

  // 상세 화면은 하나를 같이 쓰고, 항목 종류에 따라 고치는 칸과 문구가 달라진다.
  const DETAIL = {
    memo: {
      title: '메모 보기',
      inputLabel: '메모 수정',
      saveLabel: '수정 저장',
      field: 'text',
      required: true,
      confirm: '이 메모를 삭제할까요? 되돌릴 수 없어요.',
      deleteFailed: TEXT.deleteFailed,
    },
    link: {
      title: '링크 보기',
      inputLabel: '캡션 편집',
      saveLabel: '캡션 저장',
      field: 'caption',
      required: false, // 비워서 저장하면 캡션만 지운다.
      confirm: '이 링크를 삭제할까요? 되돌릴 수 없어요.',
      deleteFailed: '삭제하지 못했어요. 링크는 그대로 남아 있어요.',
    },
  };

  // 저장 작업 하나를 실행한다. 오류(error)와 중단(abort)은 모두 실패다.
  function run(database, mode, fn) {
    return new Promise((resolve, reject) => {
      if (!database) throw new Error('저장 공간이 열려 있지 않아요');
      let tx;
      try {
        tx = database.transaction(STORE, mode);
      } catch (error) {
        // 폰이 저장 공간 연결을 끊은 경우: 다시 열 수 있게 안내한다.
        if (error.name === 'InvalidStateError') loseDb(database);
        throw error;
      }
      let result;
      const fail = (event) => reject(tx.error || event.target.error || new Error('저장 작업이 중단됐어요'));
      tx.oncomplete = () => resolve(result && result.result);
      tx.onerror = fail;
      tx.onabort = fail;
      try {
        result = fn(tx.objectStore(STORE));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  const form = document.getElementById('memo-form');
  const input = document.getElementById('memo-input');
  const list = document.getElementById('list');
  const detail = document.getElementById('detail');
  const detailInput = document.getElementById('detail-input');
  let db;
  let lastTs = 0;
  let openId = null;

  const searchInput = document.getElementById('search');
  const listMessage = document.getElementById('list-message');
  const dbError = document.getElementById('db-error');
  const dbRetry = document.getElementById('db-retry');
  let allItems = [];
  let thumbUrls = [];

  // 검색에 쓰이는 글: 항목 종류가 늘어나도 여기만 고치면 된다.
  function searchableText(item) {
    return item.type === 'link' ? [item.text, item.url, item.caption].filter(Boolean).join(' ') : item.text || '';
  }

  // http/https 주소만 허용한다. (javascript: 같은 위험한 주소는 막는다)
  function normalizeUrl(raw) {
    const value = raw.trim();
    if (!value || /\s/.test(value)) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(withScheme);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  // ---- 붙여넣기 분류 ----
  // normalizeUrl()은 'hello'도 주소로 받아들이므로, 붙여넣은 글을 나눌 때는 아래 규칙을 따른다.
  const WEB_URL = /https?:\/\/[^\s<>"“”‘’「」『』、。]+/i;
  const BRACKETS = { ')': '(', ']': '[', '}': '{' };

  // 주소 뒤에 붙은 문장 부호를 뺀다. 주소 안에서 짝이 맞는 괄호는 남긴다.
  function trimUrl(url) {
    let result = url;
    while (result) {
      const last = result.slice(-1);
      const open = BRACKETS[last];
      const extraBracket = open && result.split(last).length > result.split(open).length;
      if (!extraBracket && !/[.,;:!?'…！？，]/.test(last)) break;
      result = result.slice(0, -1);
    }
    return result;
  }

  // 'example.com'처럼 http가 없는 주소 모양인지 확인한다.
  function isBareAddress(value) {
    if (/\s/.test(value)) return false;
    const host = value.split(/[/?#]/)[0];
    if (!/^[^:@\\]+(:\d+)?$/.test(host)) return false;
    const labels = host.replace(/:\d+$/, '').split('.');
    return labels.length > 1 && labels.every(Boolean) && /^\p{L}{2,}$/u.test(labels[labels.length - 1]);
  }

  // 설명 칸은 한 줄이라 줄바꿈을 띄어쓰기로 바꾼다.
  const oneLine = (value) => value.replace(/\s+/g, ' ').trim();

  function classifyPaste(raw) {
    const value = raw.trim();
    const match = value.match(WEB_URL);
    if (match) {
      const url = trimUrl(match[0]);
      if (normalizeUrl(url)) {
        const around = `${value.slice(0, match.index)} ${value.slice(match.index + url.length)}`;
        const rest = oneLine(around.replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' '));
        return { url, desc: /^[\p{P}<>\s]*$/u.test(rest) ? '' : rest };
      }
    }
    const bare = trimUrl(value);
    if (isBareAddress(bare) && normalizeUrl(bare)) return { url: `https://${bare}`, desc: '' };
    return { url: '', desc: oneLine(value) };
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const items = allItems
      .filter((item) => !query || searchableText(item).toLowerCase().includes(query))
      .sort((a, b) => b.createdAt - a.createdAt);
    document.getElementById('empty').hidden = !(query && items.length === 0);
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls = [];
    list.replaceChildren(
      ...items.map((item) => {
        const el = document.createElement('div');
        el.setAttribute('data-testid', 'item');
        el.dataset.id = item.id;
        el.dataset.type = item.type;
        el.tabIndex = 0;
        if (item.type === 'link') {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = '링크';
          const desc = document.createElement('span');
          desc.textContent = item.text;
          const anchor = document.createElement('a');
          anchor.href = item.url;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.textContent = item.url;
          el.append(badge, desc, anchor);
          if (item.caption) {
            const caption = document.createElement('span');
            caption.className = 'caption-preview';
            caption.textContent = item.caption;
            el.append(caption);
          }
        } else if (item.type === 'photo') {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = '사진';
          const desc = document.createElement('span');
          desc.textContent = item.text;
          const img = document.createElement('img');
          const url = URL.createObjectURL(item.blob);
          thumbUrls.push(url);
          img.src = url;
          img.alt = item.text || '저장한 사진';
          el.append(badge, desc, img);
        } else {
          el.textContent = item.text;
        }
        return el;
      })
    );
  }

  async function refresh() {
    const items = await run(db, 'readonly', (store) => store.getAll());
    lastTs = Math.max(lastTs, ...items.map((i) => i.createdAt), 0);
    allItems = items;
    render();
    listMessage.textContent = '';
  }

  // 저장·수정·삭제가 끝난 뒤 목록을 맞춘다.
  // 목록을 다시 읽지 못해도 이미 끝난 작업은 실패가 아니므로, 화면의 목록만 직접 고친다.
  async function syncList(applyChange) {
    try {
      await refresh();
    } catch {
      allItems = applyChange(allItems);
      render();
      listMessage.textContent = TEXT.refreshFailed;
    }
  }

  // 저장한 순서가 유지되도록 만든 시각은 항상 앞의 것보다 크게 한다.
  function nextTimestamp() {
    lastTs = Math.max(Date.now(), lastTs + 1);
    return lastTs;
  }

  // 모든 새 항목은 여기에서 만든다.
  function createItem(type, fields, createdAt = nextTimestamp()) {
    return { id: crypto.randomUUID(), type, createdAt, ...fields };
  }

  const withItems = (items, added) => [...items.filter((i) => !added.some((a) => a.id === i.id)), ...added];

  function failureText(base, error) {
    return error && error.name === 'QuotaExceededError' ? base + TEXT.quota : base;
  }

  const unsaved = document.getElementById('unsaved');
  const unsavedList = document.getElementById('unsaved-list');
  const formMessages = {
    memo: document.getElementById('memo-message'),
    link: document.getElementById('link-message'),
    photo: document.getElementById('photo-message'),
  };
  const TYPE_LABELS = { memo: '메모', link: '링크', photo: '사진' };

  // 입력칸으로 되돌릴 수 없는 항목은 앱이 열려 있는 동안 여기에 보관한다.
  function keepUnsaved(item, preview) {
    const entry = document.createElement('div');
    entry.className = 'unsaved-item';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = TYPE_LABELS[item.type];
    const body = document.createElement('p');
    body.className = 'unsaved-text';
    body.textContent = preview;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = TEXT.retry;
    const message = document.createElement('p');
    message.className = 'notice';
    message.setAttribute('role', 'alert');
    button.addEventListener('click', async () => {
      button.disabled = true;
      message.textContent = '';
      try {
        await run(db, 'readwrite', (store) => store.add(item));
      } catch (error) {
        message.textContent = failureText(TEXT.retryFailed, error);
        button.disabled = false;
        return;
      }
      entry.remove();
      unsaved.hidden = unsavedList.childElementCount === 0;
      formMessages[item.type].textContent = '';
      await syncList((items) => withItems(items, [item]));
    });
    entry.append(badge, body, button, message);
    unsavedList.append(entry);
    unsaved.hidden = false;
  }

  // 새 항목을 저장한다. 실패하면 restore()로 입력칸에 되돌리고, 그럴 수 없으면 따로 보관한다.
  async function saveNewItem(item, { restore, preview }) {
    const message = formMessages[item.type];
    try {
      await run(db, 'readwrite', (store) => store.add(item));
    } catch (error) {
      if (restore()) {
        message.textContent = failureText(TEXT.restored, error);
      } else {
        keepUnsaved(item, preview);
        message.textContent = failureText(TEXT.keptBelow, error);
      }
      return;
    }
    message.textContent = '';
    await syncList((items) => withItems(items, [item]));
  }

  searchInput.addEventListener('input', render);

  const viewer = document.getElementById('viewer');
  const viewerImg = document.getElementById('viewer-img');
  let viewerUrl = null;

  function openViewer(item) {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(item.blob);
    viewerImg.src = viewerUrl;
    viewerImg.alt = item.text || '저장한 사진';
    document.getElementById('viewer-caption').textContent = item.text;
    viewer.hidden = false;
  }

  document.getElementById('viewer-close').addEventListener('click', () => {
    viewer.hidden = true;
    viewerImg.removeAttribute('src');
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  });

  list.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-testid="item"]');
    if (!el) return;
    if (event.target.closest('a') || detailBusy) return;
    let item;
    try {
      item = await run(db, 'readonly', (store) => store.get(el.dataset.id));
    } catch {
      listMessage.textContent = TEXT.openFailed;
      return;
    }
    if (item && item.type === 'photo') {
      openViewer(item);
      return;
    }
    if (!item || !DETAIL[item.type] || detailBusy) return;
    openDetail(item);
  });

  const detailSave = document.getElementById('detail-save');
  const linkInfo = document.getElementById('detail-link-info');
  let openType = null;

  function openDetail(item) {
    const view = DETAIL[item.type];
    openId = item.id;
    openType = item.type;
    detailMessage.textContent = '';
    detail.setAttribute('aria-label', view.title);
    detailInput.setAttribute('aria-label', view.inputLabel);
    detailInput.placeholder = item.type === 'link' ? '캡션이 없어요. 여기에 적거나 붙여넣을 수 있어요.' : '';
    detailSave.textContent = view.saveLabel;
    detailInput.value = item[view.field] || '';
    linkInfo.hidden = item.type !== 'link';
    if (item.type === 'link') {
      document.getElementById('detail-link-desc').textContent = item.text;
      const anchor = document.getElementById('detail-link-url');
      anchor.textContent = item.url;
      // 저장된 값도 다시 검사해서 http/https 주소만 누를 수 있게 한다.
      const safeUrl = normalizeUrl(item.url);
      if (safeUrl) anchor.href = safeUrl;
      else anchor.removeAttribute('href');
    }
    detail.hidden = false;
    if (item.type === 'memo') detailInput.focus();
    else detail.scrollIntoView({ block: 'nearest' }); // 링크는 키보드를 바로 띄우지 않는다.
  }

  const detailMessage = document.getElementById('detail-message');
  const detailButtons = ['detail-save', 'detail-delete', 'detail-close'].map((id) => document.getElementById(id));
  let detailBusy = false;

  // 저장·삭제가 끝날 때까지 편집 화면을 바꾸지 못하게 해서, 실패해도 쓴 내용이 남게 한다.
  function setDetailBusy(busy) {
    detailBusy = busy;
    detailInput.readOnly = busy;
    detailButtons.forEach((button) => {
      button.disabled = busy;
    });
  }

  function closeDetail() {
    openId = null;
    detail.hidden = true;
    detailInput.value = '';
    detailMessage.textContent = '';
  }

  detailSave.addEventListener('click', async () => {
    const text = detailInput.value.trim();
    if (!openId || detailBusy) return;
    const view = DETAIL[openType];
    if (view.required && !text) return;
    const id = openId;
    let updated;
    setDetailBusy(true);
    detailMessage.textContent = '';
    try {
      const item = await run(db, 'readonly', (store) => store.get(id));
      if (!item) throw new Error('수정할 항목이 없어요');
      updated = { ...item, [view.field]: text };
      if (!view.required && !text) delete updated[view.field];
      await run(db, 'readwrite', (store) => store.put(updated));
    } catch (error) {
      detailMessage.textContent = failureText(TEXT.editFailed, error);
      return;
    } finally {
      setDetailBusy(false);
    }
    closeDetail();
    await syncList((items) => withItems(items, [updated]));
  });

  document.getElementById('detail-delete').addEventListener('click', async () => {
    if (!openId || detailBusy) return;
    const view = DETAIL[openType];
    if (!window.confirm(view.confirm)) return;
    const id = openId;
    setDetailBusy(true);
    detailMessage.textContent = '';
    try {
      await run(db, 'readwrite', (store) => store.delete(id));
    } catch {
      detailMessage.textContent = view.deleteFailed;
      return;
    } finally {
      setDetailBusy(false);
    }
    closeDetail();
    await syncList((items) => items.filter((item) => item.id !== id));
  });

  document.getElementById('detail-close').addEventListener('click', closeDetail);

  const linkForm = document.getElementById('link-form');
  const urlInput = document.getElementById('link-url');
  const descInput = document.getElementById('link-desc');
  const captionInput = document.getElementById('link-caption');

  // 클립보드는 이 버튼을 눌렀을 때만 읽는다. 캡션 칸은 채우지 않는다.
  document.getElementById('paste-btn').addEventListener('click', async () => {
    let clip;
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      formMessages.link.textContent = TEXT.pasteFailed;
      return;
    }
    if (!clip.trim()) {
      formMessages.link.textContent = TEXT.pasteEmpty;
      return;
    }
    const parts = classifyPaste(clip);
    const kept = [];
    for (const [box, value, name] of [
      [urlInput, parts.url, TEXT.urlField],
      [descInput, parts.desc, TEXT.descField],
    ]) {
      if (!value) continue;
      if (box.value.trim()) kept.push(name);
      else box.value = value;
    }
    formMessages.link.textContent = kept.length ? TEXT.pasteKept(kept) : '';
  });

  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      formMessages.link.textContent = TEXT.needUrl;
      return;
    }
    if (!db) {
      formMessages.link.textContent = TEXT.noDb;
      return;
    }
    const typed = { url: urlInput.value, desc: descInput.value, caption: captionInput.value };
    const text = typed.desc.trim();
    const caption = typed.caption.trim();
    urlInput.value = '';
    descInput.value = '';
    captionInput.value = '';
    const item = createItem('link', caption ? { url, text, caption } : { url, text });
    await saveNewItem(item, {
      restore() {
        if (urlInput.value || descInput.value || captionInput.value) return false;
        urlInput.value = typed.url;
        descInput.value = typed.desc;
        captionInput.value = typed.caption;
        return true;
      },
      preview: [text, url, caption].filter(Boolean).join('\n'),
    });
  });

  const BACKUP_KEY = 'lastBackupAt';
  const backupStatus = document.getElementById('backup-status');

  function readLastBackup() {
    try {
      const value = Number(localStorage.getItem(BACKUP_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function showBackupStatus() {
    const at = readLastBackup();
    // 파일이 실제로 저장됐는지는 알 수 없으므로 "백업"이 아니라 "내보내기"라고 적는다.
    backupStatus.textContent = at
      ? `마지막 내보내기: ${new Date(at).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' })} · 파일 앱에서 백업 파일을 확인해 주세요.`
      : '아직 내보낸 적이 없어요';
  }

  function saveLastBackup() {
    try {
      localStorage.setItem(BACKUP_KEY, String(Date.now()));
    } catch {
      // 저장소를 쓸 수 없어도 내보내기 자체는 성공한 것이다.
    }
    showBackupStatus();
  }

  showBackupStatus();

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // 모든 항목을 파일 하나(JSON)로 내려받는다. 사진도 파일 안에 들어간다.
  async function writeExportFile() {
    const items = await run(db, 'readonly', (store) => store.getAll());
    const out = [];
    for (const item of items) {
      const { blob, ...rest } = item;
      if (item.type === 'photo') {
        rest.photo = { mime: blob.type || 'image/jpeg', data: await blobToBase64(blob) };
      }
      out.push(rest);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    // v2는 배열 이름이 entries다. items를 넣지 않아야 옛 버전 앱이 캡션을 빠뜨린 채 가져오지 않고 거부한다.
    const payload = { app: 'second-brain', version: 2, exportedAt: new Date().toISOString(), entries: out };
    const file = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `second-brain-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const backupMessage = document.getElementById('backup-message');
  const exportButton = document.getElementById('export-btn');
  const importButton = document.getElementById('import-btn');

  // 내보내기·가져오기는 한 번에 하나만 실행한다.
  async function withBackupLock(task) {
    exportButton.disabled = true;
    importButton.disabled = true;
    try {
      await task();
    } finally {
      exportButton.disabled = false;
      importButton.disabled = false;
    }
  }

  async function exportAll() {
    backupMessage.textContent = '';
    try {
      await writeExportFile();
    } catch {
      backupMessage.textContent = TEXT.exportFailed;
      return;
    }
    saveLastBackup();
  }

  exportButton.addEventListener('click', () => withBackupLock(exportAll));

  function base64ToBlob(data, mime) {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const safeMime = /^image\/(jpeg|png|webp|gif)$/.test(mime) ? mime : 'image/jpeg';
    return new Blob([bytes], { type: safeMime });
  }

  // 가져온 파일의 항목 하나를 검사해서 저장 가능한 모양으로 바꾼다. 이상하면 null.
  function parseImportedItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (!Number.isFinite(raw.createdAt)) return null;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const base = { id: raw.id, type: raw.type, text, createdAt: raw.createdAt };
    if (raw.type === 'memo') {
      return text.trim() ? base : null;
    }
    if (raw.type === 'link') {
      const url = typeof raw.url === 'string' ? normalizeUrl(raw.url) : null;
      if (!url) return null;
      const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
      return caption ? { ...base, url, caption } : { ...base, url };
    }
    if (raw.type === 'photo') {
      const photo = raw.photo;
      if (!photo || typeof photo.data !== 'string' || !photo.data) return null;
      try {
        return { ...base, blob: base64ToBlob(photo.data, String(photo.mime)) };
      } catch {
        return null;
      }
    }
    return null;
  }

  // 백업 버전마다 항목 배열의 이름이 다르다. 모르는 버전은 읽지 않는다.
  const BACKUP_LISTS = new Map([
    [1, 'items'],
    [2, 'entries'],
  ]);

  async function importAll(file) {
    backupMessage.textContent = '';
    if (!db) {
      backupMessage.textContent = TEXT.importNoDb;
      return;
    }
    let content;
    try {
      content = await file.text();
    } catch {
      backupMessage.textContent = TEXT.importReadFailed;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(content);
    } catch {
      payload = null;
    }
    if (!payload || payload.app !== 'second-brain') {
      backupMessage.textContent = TEXT.importUnreadable;
      return;
    }
    const listName = BACKUP_LISTS.get(payload.version);
    if (!listName) {
      backupMessage.textContent = TEXT.importUnknownVersion;
      return;
    }
    const entries = payload[listName];
    if (!Array.isArray(entries)) {
      backupMessage.textContent = TEXT.importUnreadable;
      return;
    }
    const added = [];
    let duplicated = 0;
    let invalid = 0;
    let interrupted = false;
    try {
      const existing = new Set(await run(db, 'readonly', (store) => store.getAllKeys()));
      for (const raw of entries) {
        const item = parseImportedItem(raw);
        if (!item) {
          invalid += 1;
        } else if (existing.has(item.id)) {
          duplicated += 1;
        } else {
          await run(db, 'readwrite', (store) => store.add(item));
          existing.add(item.id);
          added.push(item);
        }
      }
    } catch {
      interrupted = true;
    }
    await syncList((items) => withItems(items, added));
    const parts = [interrupted ? `${added.length}개를 가져온 뒤 중단됐어요.` : `${added.length}개를 가져왔어요.`];
    if (duplicated) parts.push(`이미 있는 ${duplicated}개는 건너뛰었어요.`);
    if (invalid) parts.push(`읽을 수 없는 ${invalid}개는 건너뛰었어요.`);
    if (interrupted) parts.push(TEXT.importResume);
    backupMessage.textContent = parts.join(' ');
  }

  const importFile = document.getElementById('import-file');
  importButton.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (file) await withBackupLock(() => importAll(file));
  });

  const MAX_SIDE = 1600;

  // 큰 사진은 저장이 느려지지 않도록 줄인다. 읽을 수 없는 파일은 원본 그대로 저장한다.
  async function shrinkPhoto(file) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      return blob || file;
    } catch {
      return file;
    }
  }

  const photoForm = document.getElementById('photo-form');
  photoForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fileInput = document.getElementById('photo-file');
    const descInput = document.getElementById('photo-desc');
    const file = fileInput.files[0];
    if (!file) return;
    if (!db) {
      formMessages.photo.textContent = TEXT.noDb;
      return;
    }
    const typedDesc = descInput.value;
    const text = typedDesc.trim();
    fileInput.value = '';
    descInput.value = '';
    const createdAt = nextTimestamp(); // 사진을 줄이는 동안에도 고른 순서를 지킨다.
    const blob = await shrinkPhoto(file);
    const item = createItem('photo', { text, blob }, createdAt);
    await saveNewItem(item, {
      restore() {
        if (fileInput.files.length || descInput.value) return false;
        // 선택했던 파일을 파일 선택칸에 되돌린다. 브라우저가 막으면 따로 보관한다.
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          fileInput.files = transfer.files;
        } catch {
          return false;
        }
        if (fileInput.files.length !== 1) return false;
        descInput.value = typedDesc;
        return true;
      },
      preview: text ? `${file.name}\n${text}` : file.name,
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const typed = input.value;
    const text = typed.trim();
    if (!text) return;
    if (!db) {
      formMessages.memo.textContent = TEXT.noDb;
      return;
    }
    // 저장을 기다리는 동안 다음 글을 쓸 수 있도록 입력칸을 바로 비운다.
    input.value = '';
    const item = createItem('memo', { text });
    await saveNewItem(item, {
      restore() {
        if (input.value.trim()) return false;
        input.value = typed;
        return true;
      },
      preview: text,
    });
  });

  // 저장 공간과의 연결이 끊겼을 때 안내를 띄운다.
  function loseDb(database) {
    if (db !== database) return;
    db = undefined;
    dbError.hidden = false;
  }

  async function connect() {
    let opened;
    try {
      opened = await openDb();
    } catch {
      dbError.hidden = false;
      return;
    }
    opened.onclose = () => loseDb(opened);
    opened.onversionchange = () => {
      opened.close();
      loseDb(opened);
    };
    db = opened;
    dbError.hidden = true;
    try {
      await refresh();
    } catch {
      listMessage.textContent = TEXT.loadFailed;
    }
  }

  dbRetry.addEventListener('click', async () => {
    dbRetry.disabled = true;
    await connect();
    dbRetry.disabled = false;
  });

  connect();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // 등록에 실패해도 앱은 평소처럼 쓸 수 있다. (오프라인 기능만 빠진다)
      });
    });
  }

  // 홈 화면 앱으로 열었을 때는 설치 안내가 필요 없다.
  const standalone =
    navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  document.getElementById('install-tip').hidden = standalone;
})();
