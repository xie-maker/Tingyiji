(() => {
  const nativeFetch = window.fetch.bind(window);
  const apiKey = 'lyrics-translator-api-profiles';
  const historyKey = 'lyrics-translator-history';
  const defaultDownloadText = '浏览器默认下载路径';
  let selectedDirectoryHandle = null;

  function pathnameOf(input) {
    try {
      if (typeof input === 'string') return new URL(input, window.location.origin).pathname;
      if (input instanceof URL) return input.pathname;
      if (input?.url) return new URL(input.url, window.location.origin).pathname;
    } catch {}
    return '';
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  window.fetch = async (input, init) => {
    const pathname = pathnameOf(input);
    const method = String(init?.method || 'GET').toUpperCase();

    if (pathname === '/api/history/settings' && method === 'GET') {
      return new Response(JSON.stringify({ historyDir: defaultDownloadText, defaultHistoryDir: defaultDownloadText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (!pathname.startsWith('/api/')) return nativeFetch(input, init);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const target = attempt === 0 ? input : (typeof input === 'string' ? new URL(input, window.location.origin).toString() : input);
        return await nativeFetch(target, init);
      } catch (error) {
        lastError = error;
        await sleep(800 + attempt * 1200);
      }
    }
    throw new TypeError(`网络请求没有成功  请刷新页面或稍后重试  ${lastError?.message || ''}`.trim());
  };

  function seedDeepSeekProfile() {
    try {
      const raw = localStorage.getItem(apiKey);
      if (raw) return;
      localStorage.setItem(apiKey, JSON.stringify({
        activeProfileId: 1,
        profiles: [
          { id: 1, enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', saveKey: false, apiKey: '' },
          { id: 2, enabled: false },
          { id: 3, enabled: false },
          { id: 4, enabled: false },
          { id: 5, enabled: false },
        ],
      }));
    } catch {}
  }

  function historyItems() {
    try { return JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { return []; }
  }

  function historyEntry(id) {
    return historyItems().find((entry) => entry.id === id);
  }

  function showMessage(value, isError = false) {
    const node = document.getElementById('message');
    if (!node) return;
    node.textContent = value || '';
    node.classList.toggle('error', isError);
  }

  function normalizeHistoryPathUi() {
    const input = document.getElementById('historyDirInput');
    const button = document.getElementById('saveHistoryDirButton');
    const label = input?.closest('label')?.querySelector('span');
    if (label && label.textContent !== '下载位置') label.textContent = '下载位置';
    if (input) {
      const value = selectedDirectoryHandle?.name || defaultDownloadText;
      if (input.value !== value) input.value = value;
      input.placeholder = defaultDownloadText;
      input.readOnly = true;
    }
    if (button && button.textContent !== '选择路径') button.textContent = '选择路径';
  }

  async function chooseDirectory() {
    const input = document.getElementById('historyDirInput');
    if (!window.showDirectoryPicker) {
      normalizeHistoryPathUi();
      showMessage('当前浏览器不支持网页选择下载文件夹，将使用浏览器默认下载路径。');
      return;
    }
    try {
      selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (input) input.value = selectedDirectoryHandle.name || '已选择文件夹';
      showMessage('已选择下载位置。');
    } catch {
      normalizeHistoryPathUi();
    }
  }

  async function prepareDocx(entry) {
    const response = await nativeFetch('/api/history/prepare-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'DOCX 生成失败');
    return data;
  }

  async function saveToSelectedDirectory(prepared) {
    if (!selectedDirectoryHandle) return false;
    const response = await nativeFetch(prepared.downloadUrl);
    if (!response.ok) return false;
    const blob = await response.blob();
    const fileHandle = await selectedDirectoryHandle.getFileHandle(prepared.filename || 'lyrics.docx', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  function openDownloadLink(prepared) {
    const url = new URL(prepared.downloadUrl, window.location.origin).toString();
    const link = document.createElement('a');
    link.href = url;
    link.download = prepared.filename || 'lyrics.docx';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      try { window.location.href = url; } catch {}
    }, 160);
  }

  function installStaticHideRule() {
    if (document.getElementById('tingyiji-history-hotfix-style')) return;
    const style = document.createElement('style');
    style.id = 'tingyiji-history-hotfix-style';
    style.textContent = 'button[data-action="save"],button[data-history-action="save-docx"]{display:none!important}';
    document.head.append(style);
  }

  document.addEventListener('click', async (event) => {
    const pathButton = event.target.closest('#saveHistoryDirButton');
    if (pathButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await chooseDirectory();
      return;
    }

    const historyButton = event.target.closest('button[data-action], button[data-history-action]');
    const action = historyButton?.dataset.action || historyButton?.dataset.historyAction;
    if (!historyButton || !['save', 'save-docx', 'download', 'download-docx'].includes(action)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (action === 'save' || action === 'save-docx') {
      historyButton.remove();
      return;
    }

    const card = historyButton.closest('.history-item');
    const id = card?.dataset.id || historyButton.dataset.historyId;
    const entry = historyEntry(id);
    if (!entry) {
      showMessage('没有找到这条历史记录，请刷新页面后重试。', true);
      return;
    }

    const oldText = historyButton.textContent;
    historyButton.disabled = true;
    historyButton.textContent = '生成中...';
    try {
      const prepared = await prepareDocx(entry);
      const saved = await saveToSelectedDirectory(prepared);
      if (saved) showMessage('DOCX 已保存到选择的路径。');
      else {
        openDownloadLink(prepared);
        showMessage('DOCX 已开始下载。');
      }
    } catch (error) {
      showMessage(error.message || 'DOCX 下载失败。', true);
    } finally {
      historyButton.disabled = false;
      historyButton.textContent = oldText;
    }
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    seedDeepSeekProfile();
    installStaticHideRule();
    normalizeHistoryPathUi();
    document.getElementById('openHistoryButton')?.addEventListener('click', () => {
      window.setTimeout(normalizeHistoryPathUi, 0);
      window.setTimeout(normalizeHistoryPathUi, 120);
    });
  });
})();
