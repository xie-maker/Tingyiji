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

  const historyKey = 'lyrics-translator-history';
  const findEntry = (id) => {
    try {
      return JSON.parse(localStorage.getItem(historyKey) || '[]').find((entry) => entry.id === id);
    } catch {
      return null;
    }
  };
  const submitDownload = (entry) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/history/save-docx';
    form.target = '_blank';
    form.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify({ mode: 'download', forceDownload: true, entry });
    form.append(input);
    document.body.append(form);
    form.submit();
    setTimeout(() => form.remove(), 1000);
  };
  document.addEventListener('click', (event) => {
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
    submitDownload(entry);
  }, true);
})();
