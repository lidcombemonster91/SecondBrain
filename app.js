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
    return item.type === 'link' ? `${item.text} ${item.url}` : item.text || '';
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
    if (!item || item.type !== 'memo' || detailBusy) return;
    openId = item.id;
    detailMessage.textContent = '';
    detailInput.value = item.text;
    detail.hidden = false;
    detailInput.focus();
  });

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

  document.getElementById('detail-save').addEventListener('click', async () => {
    const text = detailInput.value.trim();
    if (!openId || !text || detailBusy) return;
    const id = openId;
    let updated;
    setDetailBusy(true);
    detailMessage.textContent = '';
    try {
      const item = await run(db, 'readonly', (store) => store.get(id));
      if (!item) throw new Error('수정할 항목이 없어요');
      updated = { ...item, text };
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
    if (!window.confirm('이 메모를 삭제할까요? 되돌릴 수 없어요.')) return;
    const id = openId;
    setDetailBusy(true);
    detailMessage.textContent = '';
    try {
      await run(db, 'readwrite', (store) => store.delete(id));
    } catch {
      detailMessage.textContent = TEXT.deleteFailed;
      return;
    } finally {
      setDetailBusy(false);
    }
    closeDetail();
    await syncList((items) => items.filter((item) => item.id !== id));
  });

  document.getElementById('detail-close').addEventListener('click', closeDetail);

  const linkForm = document.getElementById('link-form');
  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const urlInput = document.getElementById('link-url');
    const descInput = document.getElementById('link-desc');
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    if (!db) {
      formMessages.link.textContent = TEXT.noDb;
      return;
    }
    const typed = { url: urlInput.value, desc: descInput.value };
    const text = typed.desc.trim();
    urlInput.value = '';
    descInput.value = '';
    lastTs = Math.max(Date.now(), lastTs + 1);
    const item = { id: crypto.randomUUID(), type: 'link', url, text, createdAt: lastTs };
    await saveNewItem(item, {
      restore() {
        if (urlInput.value || descInput.value) return false;
        urlInput.value = typed.url;
        descInput.value = typed.desc;
        return true;
      },
      preview: text ? `${text}\n${url}` : url,
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
    const payload = { app: 'second-brain', version: 1, exportedAt: new Date().toISOString(), items: out };
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
      return url ? { ...base, url } : null;
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
    if (!payload || payload.app !== 'second-brain' || !Array.isArray(payload.items)) {
      backupMessage.textContent = '가져올 수 없는 파일이에요. 내보내기로 만든 파일을 골라 주세요.';
      return;
    }
    const added = [];
    let duplicated = 0;
    let invalid = 0;
    let interrupted = false;
    try {
      const existing = new Set(await run(db, 'readonly', (store) => store.getAllKeys()));
      for (const raw of payload.items) {
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
    lastTs = Math.max(Date.now(), lastTs + 1);
    const createdAt = lastTs;
    const blob = await shrinkPhoto(file);
    const item = { id: crypto.randomUUID(), type: 'photo', text, blob, createdAt };
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
    lastTs = Math.max(Date.now(), lastTs + 1);
    const item = { id: crypto.randomUUID(), type: 'memo', text, createdAt: lastTs };
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
