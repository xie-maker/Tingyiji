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
})();
