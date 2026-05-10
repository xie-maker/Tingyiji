(() => {
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
