(() => {
  const nativeFetch = window.fetch.bind(window);
  const apiKey = 'lyrics-translator-api-profiles';
  const historyKey = 'lyrics-translator-history';
  const defaultDownloadText = '浏览器默认下载路径';
  let selectedDirectoryHandle = null;

  function getPathname(input) {
    try {
      if (typeof input === 'string') return new URL(input, window.location.origin).pathname;
      if (input instanceof URL) return input.pathname;
      if (input && typeof input.url === 'string') return new URL(input.url, window.location.origin).pathname;
    } catch {}
    return '';
  }

  function isApiRequest(input) {
    return getPathname(input).startsWith('/api/');
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  window.fetch = async (input, init) => {
    const pathname = getPathname(input);
    const method = String(init?.method || 'GET').toUpperCase();

    if (pathname === '/api/history/settings' && method === 'GET') {
      return new Response(JSON.stringify({ historyDir: defaultDownloadText, defaultHistoryDir: defaultDownloadText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (!isApiRequest(input)) return nativeFetch(input, init);

    let lastError;
    const candidates = [input, typeof input === 'string' ? new URL(input, window.location.origin).toString() : input];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = candidates[Math.min(attempt, candidates.length - 1)];
      try {
        return await nativeFetch(target, init);
      } catch (error) {
        lastError = error;
        await sleep(900 + attempt * 1400);
      }
    }
    throw new TypeError(`网络请求没有成功  请刷新页面或稍后重试  ${lastError?.message || ''}`.trim());
  };

  function seedDeepSeekProfile() {
    try {
      const raw = localStorage.getItem(apiKey);
      if (!raw) {
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
        return;
      }

      const state = JSON.parse(raw);
      if (!Array.isArray(state.profiles)) return;
      let profile1 = state.profiles.find((profile) => Number(profile.id) === 1);
      if (!profile1) {
        profile1 = { id: 1, enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', saveKey: false, apiKey: '' };
        state.profiles.unshift(profile1);
      } else if (!profile1.enabled && !profile1.provider && !profile1.model && !profile1.baseUrl) {
        Object.assign(profile1, { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' });
      }
      localStorage.setItem(apiKey, JSON.stringify(state));
    } catch {}
  }

  const findEntry = (id) => {
    try {
      return JSON.parse(localStorage.getItem(historyKey) || '[]').find((entry) => entry.id === id);
    } catch {
      return null;
    }
  };

  async function prepareDocx(entry) {
    const response = await nativeFetch('/api/history/prepare-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'DOCX 生成失败');
    return data;
  }

  async function saveToSelectedDirectory(prepared) {
    if (!selectedDirectoryHandle) return false;
    const response = await nativeFetch(prepared.downloadUrl);
    if (!response.ok) return false;
    const blob = await response.blob();
    const fileHandle = await selectedDirectoryHandle.getFileHandle(prepared.filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    alert('DOCX 已保存到你选择的文件夹');
    return true;
  }

  function navigateDownload(prepared) {
    const link = document.createElement('a');
    link.href = prepared.downloadUrl;
    link.download = prepared.filename || 'lyrics.docx';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  }

  function hideLocalSaveButtons(root = document) {
    root.querySelectorAll('button[data-history-action="save-docx"]').forEach((button) => {
      button.remove();
    });
  }

  async function chooseDownloadDirectory(input) {
    if (!window.showDirectoryPicker) {
      if (input && input.value !== defaultDownloadText) input.value = defaultDownloadText;
      alert('当前浏览器不支持网页选择下载文件夹  将使用浏览器默认下载路径');
      return;
    }
    try {
      selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (input) input.value = selectedDirectoryHandle.name || '已选择文件夹';
    } catch {}
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setupHistoryPathUi() {
    const input = document.getElementById('historyDirInput');
    const button = document.getElementById('saveHistoryDirButton');
    const label = input?.closest('label');
    const span = label?.querySelector('span');
    if (!input || !button) return;
    setText(span, '下载位置');
    const value = selectedDirectoryHandle?.name || defaultDownloadText;
    if (input.value !== value) input.value = value;
    if (input.placeholder !== defaultDownloadText) input.placeholder = defaultDownloadText;
    if (!input.readOnly) input.readOnly = true;
    setText(button, '选择路径');
  }

  let uiSetupTimer = 0;
  function scheduleHistoryPathUi() {
    if (uiSetupTimer) return;
    uiSetupTimer = window.setTimeout(() => {
      uiSetupTimer = 0;
      setupHistoryPathUi();
      hideLocalSaveButtons();
    }, 80);
  }

  document.addEventListener('click', async (event) => {
    const pathButton = event.target.closest('#saveHistoryDirButton');
    if (pathButton) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await chooseDownloadDirectory(document.getElementById('historyDirInput'));
      setupHistoryPathUi();
      return;
    }

    const button = event.target.closest('button[data-history-action]');
    const action = button?.dataset.historyAction;
    if (!button || !['save-docx', 'download-docx'].includes(action)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (action === 'save-docx') {
      button.remove();
      return;
    }

    const entry = findEntry(button.dataset.historyId);
    if (!entry) {
      alert('没有找到这条历史记录  请刷新页面后重试');
      return;
    }

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = '生成中...';
    try {
      const prepared = await prepareDocx(entry);
      const saved = await saveToSelectedDirectory(prepared);
      if (!saved) navigateDownload(prepared);
    } catch (error) {
      alert(error.message || 'DOCX 下载失败');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    seedDeepSeekProfile();
    setupHistoryPathUi();
    hideLocalSaveButtons();
    setTimeout(scheduleHistoryPathUi, 300);
    setTimeout(scheduleHistoryPathUi, 1000);
    const observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          hideLocalSaveButtons(node);
          if (node.id === 'historyDirInput' || node.id === 'saveHistoryDirButton' || node.querySelector?.('#historyDirInput, #saveHistoryDirButton')) {
            shouldRefresh = true;
          }
        });
      }
      if (shouldRefresh) scheduleHistoryPathUi();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
