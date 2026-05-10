(() => {
  const nativeFetch = window.fetch.bind(window);
  const apiPath = (input) => {
    if (typeof input === 'string') return input.startsWith('/api/') ? input : '';
    if (input instanceof URL) return input.pathname.startsWith('/api/') ? input.toString() : '';
    return '';
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.fetch = async (input, init) => {
    const path = apiPath(input);
    if (!path) return nativeFetch(input, init);
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

  const apiKey = 'lyrics-translator-api-profiles';
  const historyKey = 'lyrics-translator-history';
  let selectedDirectoryHandle = null;

  function seedDeepSeekProfile() {
    try {
      if (localStorage.getItem(apiKey)) return;
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

  async function saveToSelectedDirectory(entry, prepared) {
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

  function navigateDownload(url) {
    window.location.href = url;
  }

  function hideLocalSaveButtons(root = document) {
    root.querySelectorAll('button[data-action="save"], button[data-a="save"]').forEach((button) => {
      button.remove();
    });
  }

  function setupHistoryPathUi() {
    const input = document.getElementById('historyDirInput');
    const button = document.getElementById('saveHistoryDirButton');
    const label = input?.closest('label');
    const span = label?.querySelector('span');
    if (!input || !button) return;
    if (span) span.textContent = '下载位置';
    input.value = '浏览器默认下载路径';
    input.readOnly = true;
    button.textContent = '选择路径';
    button.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.showDirectoryPicker) {
        input.value = '浏览器默认下载路径';
        alert('当前浏览器不支持网页选择下载文件夹  将使用浏览器默认下载路径');
        return;
      }
      try {
        selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        input.value = selectedDirectoryHandle.name || '已选择文件夹';
      } catch {}
    };
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action], button[data-a]');
    const action = button?.dataset.action || button?.dataset.a;
    if (!button || !['save', 'download'].includes(action)) return;
    const item = button.closest('.history-item');
    const id = item?.dataset.id || button.dataset.id;
    const entry = findEntry(id);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = '生成中...';
    try {
      const prepared = await prepareDocx(entry);
      const saved = await saveToSelectedDirectory(entry, prepared);
      if (!saved) navigateDownload(prepared.downloadUrl);
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
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) hideLocalSaveButtons(node);
        });
      }
      setupHistoryPathUi();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
