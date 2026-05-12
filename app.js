const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const providerPresets = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', models: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-4.1-mini'] },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
  moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', models: ['glm-4-flash', 'glm-4-plus'] },
  custom: { label: '自定义', baseUrl: '', model: '', models: [] },
};

const storeKeys = {
  api: 'lyrics-translator-api-profiles',
  legacyApi: 'lyrics-translator-api-config',
  publicApi: 'lyrics-translator-api-profiles-public',
  history: 'lyrics-translator-history',
  historyDir: 'lyrics-translator-history-dir',
  preferences: 'lyrics-translator-preferences',
};

const labels = {
  purpose: { reading: '阅读', subtitle: '字幕', singing: '演唱', polished: '精修' },
  translationApproach: { naturalLyrics: '自然歌词', faithful: '忠实准确', poetic: '更有诗意', concise: '简洁直白' },
  style: { literal: '直译', natural: '自然', lyrical: '歌词化' },
  faithfulness: { balanced: '均衡', faithful: '更忠实', adaptive: '更灵活' },
  chineseTone: { lyric: '中文歌词感', plain: '清楚直白', poetic: '更有诗意', spoken: '更口语' },
  emotionIntensity: { original: '贴近原歌', restrained: '更克制', intense: '更浓烈' },
  delivery: { match: '贴近原行', short: '更短句', smooth: '更顺滑', singable: '更可唱' },
};

let downloadDirectoryHandle = null;

const approachDefaults = {
  naturalLyrics: { style: 'lyrical', faithfulness: 'balanced', chineseTone: 'lyric' },
  faithful: { style: 'natural', faithfulness: 'faithful', chineseTone: 'plain' },
  poetic: { style: 'lyrical', faithfulness: 'adaptive', chineseTone: 'poetic' },
  concise: { style: 'natural', faithfulness: 'balanced', chineseTone: 'plain' },
};

const deliveryDefaults = {
  match: { rhythm: 'pause', lineLength: 'match' },
  short: { rhythm: 'pause', lineLength: 'short' },
  smooth: { rhythm: 'smooth', lineLength: 'flexible' },
  singable: { rhythm: 'singable', lineLength: 'flexible' },
};

let translationLines = [];
let translationNotes = [];
let currentHistoryId = '';
let apiStore = loadApiStore();

function el(id) { return document.getElementById(id); }
function text(value) { return String(value ?? ''); }
function trimText(value) { return text(value).trim().replace(/\s+/g, ' '); }
function normalizeLyrics(value) {
  return text(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function noPunctuation(value) {
  return trimText(value)
    .replace(/[，,。．.、；;：:！？!?「」『』“”"‘’'（）()【】［］[\]《》<>…—–\-~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function showMessage(value, isError = false) {
  el('message').textContent = value || '';
  el('message').classList.toggle('error', isError);
}
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ''); } catch { return fallback; }
}
function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function profileName(id) {
  return `配置${id}`;
}
function emptyProfiles() {
  return [1, 2, 3, 4, 5].map((id) => ({ id, enabled: false }));
}
function defaultProfile(id = 1) {
  const preset = providerPresets.openai;
  return { id, enabled: true, provider: 'openai', baseUrl: preset.baseUrl, model: preset.model, saveKey: false, apiKey: '' };
}
function loadApiStore() {
  let data = readJson(storeKeys.api, null);
  if (!data) {
    const legacy = readJson(storeKeys.legacyApi, null) || readJson(storeKeys.publicApi, null);
    const profiles = emptyProfiles();
    profiles[0] = { ...defaultProfile(1), ...(legacy || {}) };
    if (legacy && !legacy.saveKey) profiles[0].apiKey = '';
    data = { activeProfileId: 1, profiles };
    writeJson(storeKeys.api, data);
  }
  const profiles = emptyProfiles().map((slot) => ({ ...slot, ...(data.profiles || []).find((p) => Number(p.id) === slot.id) }));
  if (!profiles.some((p) => p.enabled)) profiles[0] = defaultProfile(1);
  const activeProfileId = profiles.some((p) => p.enabled && p.id === data.activeProfileId)
    ? data.activeProfileId
    : profiles.find((p) => p.enabled).id;
  return { activeProfileId, profiles };
}
function saveApiStore() {
  apiStore.profiles = apiStore.profiles.map((p) => p.saveKey ? p : { ...p, apiKey: '' });
  writeJson(storeKeys.api, apiStore);
}
function activeProfile() {
  return apiStore.profiles.find((p) => p.id === apiStore.activeProfileId) || apiStore.profiles.find((p) => p.enabled) || defaultProfile(1);
}
function currentFormProfile() {
  return {
    id: apiStore.activeProfileId,
    enabled: true,
    provider: el('providerSelect').value,
    baseUrl: el('baseUrlInput').value.trim(),
    model: el('modelInput').value.trim(),
    saveKey: el('saveKeyInput').checked,
    apiKey: el('apiKeyInput').value.trim(),
  };
}
function applyProfileToForm(profile) {
  const preset = providerPresets[profile.provider] || providerPresets.openai;
  el('providerSelect').value = profile.provider || 'openai';
  el('baseUrlInput').value = profile.baseUrl || preset.baseUrl;
  el('modelInput').value = profile.model || preset.model;
  el('apiKeyInput').value = profile.apiKey || '';
  el('saveKeyInput').checked = !!profile.saveKey;
  populateModels(preset.models, el('modelInput').value);
  updateApiSummary();
}
function updateActiveProfileFromForm() {
  const next = currentFormProfile();
  apiStore.profiles = apiStore.profiles.map((p) => p.id === next.id ? next : p);
  apiStore.activeProfileId = next.id;
  saveApiStore();
  renderApiProfiles();
  updateApiSummary();
  return next;
}
function apiConfig() {
  const p = updateActiveProfileFromForm();
  return { provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey };
}
function updateApiSummary() {
  const p = currentFormProfile();
  const preset = providerPresets[p.provider] || providerPresets.openai;
  el('apiSummary').textContent = `${profileName(p.id)} · ${preset.label} / ${p.model || '未选择模型'}`;
  el('apiState').textContent = p.apiKey
    ? (p.saveKey ? '已保存到本机' : '仅本次使用')
    : '可用 .env.local';
}
function renderApiProfiles() {
  const list = el('apiProfileList');
  list.innerHTML = '';
  for (const profile of apiStore.profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `api-profile-tab ${profile.id === apiStore.activeProfileId ? 'active' : ''} ${profile.enabled ? '' : 'empty'}`;
    const preset = providerPresets[profile.provider] || providerPresets.openai;
    button.innerHTML = `<strong>${profileName(profile.id)}</strong><span>${profile.enabled ? `${preset.label} / ${profile.model || '未选择'}` : '空位'}</span>`;
    button.addEventListener('click', () => {
      if (!profile.enabled) return;
      updateActiveProfileFromForm();
      apiStore.activeProfileId = profile.id;
      applyProfileToForm(profile);
      renderApiProfiles();
    });
    list.append(button);
  }
  el('addApiProfileButton').disabled = apiStore.profiles.every((p) => p.enabled);
}
function addApiProfile() {
  updateActiveProfileFromForm();
  const slot = apiStore.profiles.find((p) => !p.enabled);
  if (!slot) return;
  const profile = defaultProfile(slot.id);
  apiStore.profiles = apiStore.profiles.map((p) => p.id === slot.id ? profile : p);
  apiStore.activeProfileId = slot.id;
  applyProfileToForm(profile);
  renderApiProfiles();
  saveApiStore();
}
function populateModels(models = [], preferred = '') {
  const values = [...new Set([preferred, ...models].filter(Boolean))];
  el('modelSelect').innerHTML = '';
  el('modelDatalist').innerHTML = '';
  for (const model of values) {
    el('modelSelect').add(new Option(model, model));
    const option = document.createElement('option');
    option.value = model;
    el('modelDatalist').append(option);
  }
  if (values.length) {
    el('modelInput').value = preferred || values[0];
    el('modelSelect').value = el('modelInput').value;
  }
}

function getPreferences() {
  const out = {};
  for (const input of $$('[data-preference]')) {
    out[input.dataset.preference] = input.type === 'checkbox' ? input.checked : input.value;
  }
  const delivery = deliveryDefaults[out.delivery] || deliveryDefaults.match;
  out.rhythm = delivery.rhythm;
  out.lineLength = delivery.lineLength;
  out.moderateSubjectFill = out.moderateSubjectFill !== false;
  out.noPunctuation = true;
  return out;
}
function applyPreferences(preferences = {}) {
  const normalized = normalizeUiPreferences(preferences);
  for (const input of $$('[data-preference]')) {
    const value = normalized[input.dataset.preference];
    if (value == null) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
  }
  summarizePreferences();
}
function savePreferences() {
  const preferences = getPreferences();
  writeJson(storeKeys.preferences, preferences);
  summarizePreferences();
  return preferences;
}
function summarizePreferences() {
  const p = getPreferences();
  el('preferenceSummary').textContent = [
    labels.purpose[p.purpose],
    labels.translationApproach[p.translationApproach],
    labels.emotionIntensity[p.emotionIntensity],
    labels.delivery[p.delivery],
  ].filter(Boolean).join(' · ');
}

function normalizeUiPreferences(preferences = {}) {
  const approach = preferences.translationApproach || inferTranslationApproach(preferences);
  const delivery = preferences.delivery || inferDelivery(preferences);
  return {
    ...approachDefaults[approach],
    purpose: preferences.purpose || 'reading',
    translationApproach: approach,
    emotionIntensity: preferences.emotionIntensity || 'original',
    delivery,
    rhyme: preferences.rhyme || 'none',
    slangPolicy: preferences.slangPolicy || 'naturalize',
    preserveImagery: preferences.preserveImagery !== false,
    keepHookConsistent: preferences.keepHookConsistent !== false,
    moderateSubjectFill: preferences.moderateSubjectFill !== false,
    avoidOverExplain: preferences.avoidOverExplain !== false,
    avoidOverLiterary: preferences.avoidOverLiterary !== false,
    avoidInventing: preferences.avoidInventing !== false,
    noPunctuation: true,
    customInstruction: preferences.customInstruction || '',
    style: preferences.style || approachDefaults[approach].style,
    faithfulness: preferences.faithfulness || approachDefaults[approach].faithfulness,
    chineseTone: preferences.chineseTone || approachDefaults[approach].chineseTone,
  };
}

function inferTranslationApproach(preferences = {}) {
  if (preferences.chineseTone === 'poetic') return 'poetic';
  if (preferences.faithfulness === 'faithful') return 'faithful';
  if (preferences.chineseTone === 'plain') return 'concise';
  return 'naturalLyrics';
}

function inferDelivery(preferences = {}) {
  if (preferences.rhythm === 'singable') return 'singable';
  if (preferences.lineLength === 'short') return 'short';
  if (preferences.rhythm === 'smooth' || preferences.lineLength === 'flexible') return 'smooth';
  return 'match';
}

function syncApproachDefaults() {
  const defaults = approachDefaults[el('preferenceTranslationApproach').value] || approachDefaults.naturalLyrics;
  for (const [key, value] of Object.entries(defaults)) {
    const input = $(`[data-preference="${key}"]`);
    if (input) input.value = value;
  }
}

function historyItems() {
  return readJson(storeKeys.history, []);
}
function saveHistoryItems(items) {
  writeJson(storeKeys.history, items.slice(0, 120));
}
function fullTranslation() {
  return translationLines.map((line) => line.translation || '').join('\n');
}
function currentEntry() {
  return currentHistoryId ? historyItems().find((item) => item.id === currentHistoryId) : null;
}
function saveNewHistory(entry) {
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    createdAt: new Date().toISOString(),
    ...entry,
  };
  saveHistoryItems([item, ...historyItems()]);
  currentHistoryId = item.id;
  return item;
}
function patchHistory(id, patch) {
  saveHistoryItems(historyItems().map((item) => item.id === id ? { ...item, ...patch } : item));
}
function ensureCurrentEntry() {
  const existing = currentEntry();
  if (existing) return existing;
  if (!fullTranslation().trim()) return null;
  return saveNewHistory({
    title: trimText(el('songTitleInput').value) || '未填写歌名',
    artist: trimText(el('artistInput').value) || '未填写歌手',
    lyrics: normalizeLyrics(el('lyricsInput').value),
    sourceLanguage: el('sourceLanguageSelect').value,
    preferences: getPreferences(),
    lines: translationLines,
    notes: translationNotes,
    fullTranslation: fullTranslation(),
  });
}

function renderEmptyResult() {
  translationLines = [];
  translationNotes = [];
  currentHistoryId = '';
  el('feedbackButton').disabled = true;
  el('resultList').className = 'result-list empty';
  el('resultList').innerHTML = '<div class="empty-state"><strong>等待生成译文</strong><span>粘贴外文歌词后，这里会生成逐行中文译文，并自动进入历史库。</span></div>';
}
function renderTranslations(lines = [], notes = []) {
  translationLines = lines.map((line) => ({ source: text(line.source), translation: text(line.translation) }));
  translationNotes = notes || [];
  el('feedbackButton').disabled = !fullTranslation().trim();
  el('resultList').className = 'result-list';
  el('resultList').innerHTML = '';
  if (translationNotes.length) {
    const block = document.createElement('div');
    block.className = 'notes-block';
    const title = document.createElement('strong');
    title.textContent = '改写说明';
    const list = document.createElement('ul');
    for (const note of translationNotes.slice(0, 5)) {
      const li = document.createElement('li');
      li.textContent = note;
      list.append(li);
    }
    block.append(title, list);
    el('resultList').append(block);
  }
  for (const line of translationLines) {
    const row = document.createElement('div');
    row.className = 'line-pair';
    const source = document.createElement('div');
    source.className = `line-cell source${line.source ? '' : ' blank'}`;
    source.textContent = line.source;
    const translation = document.createElement('div');
    translation.className = `line-cell translation${line.translation ? '' : ' blank'}`;
    translation.textContent = line.translation;
    row.append(source, translation);
    el('resultList').append(row);
  }
}

function renderHistory() {
  const items = historyItems();
  const artists = [...new Set(items.map((item) => item.artist || '未填写歌手'))].sort();
  const current = el('historyArtistFilter').value || '__all__';
  el('historyArtistFilter').innerHTML = '<option value="__all__">全部歌手</option>';
  for (const artist of artists) el('historyArtistFilter').add(new Option(artist, artist));
  el('historyArtistFilter').value = artists.includes(current) ? current : '__all__';
  const visible = items.filter((item) => el('historyArtistFilter').value === '__all__' || (item.artist || '未填写歌手') === el('historyArtistFilter').value);
  el('historyList').innerHTML = '';
  if (!visible.length) {
    el('historyList').innerHTML = '<div class="history-empty">还没有保存记录。</div>';
    return;
  }
  for (const item of visible) {
    const card = document.createElement('article');
    card.className = 'history-item';
    const summary = (item.fullTranslation || '').split('\n').filter(Boolean).slice(0, 2).join(' / ') || '无译文';
    card.innerHTML = `
      <strong></strong>
      <span></span>
      <p></p>
      <p></p>
      <div class="history-actions">
        <button class="button ghost compact" data-action="load">打开</button>
        <button class="button ghost compact" data-action="download">下载 DOCX</button>
        <button class="button ghost compact" data-action="retranslate">应用反馈重译</button>
        <button class="button ghost compact" data-action="delete">删除</button>
      </div>`;
    $('strong', card).textContent = item.title || '未填写歌名';
    $('span', card).textContent = `${item.artist || '未填写歌手'} · ${item.sourceLanguage || 'auto'} · ${new Date(item.createdAt).toLocaleString('zh-CN')}`;
    $$('p', card)[0].textContent = `偏好：${preferenceSnapshot(item.preferences)}`;
    $$('p', card)[1].textContent = summary;
    card.dataset.id = item.id;
    el('historyList').append(card);
  }
}
function preferenceSnapshot(preferences) {
  if (!preferences) return '未记录';
  const normalized = normalizeUiPreferences(preferences);
  return [
    labels.purpose[normalized.purpose],
    labels.translationApproach[normalized.translationApproach],
    labels.emotionIntensity[normalized.emotionIntensity],
    labels.delivery[normalized.delivery],
  ].filter(Boolean).join(' · ') || '自然歌词';
}
function loadHistoryEntry(id) {
  const item = historyItems().find((entry) => entry.id === id);
  if (!item) return;
  el('songTitleInput').value = item.title || '';
  el('artistInput').value = item.artist || '';
  el('sourceLanguageSelect').value = item.sourceLanguage || 'auto';
  el('lyricsInput').value = item.lyrics || '';
  el('charCount').textContent = `${el('lyricsInput').value.length} 字`;
  currentHistoryId = item.id;
  applyPreferences(item.preferences || {});
  renderTranslations(item.lines || [], item.notes || []);
  el('historyModal').close();
  showMessage(`已打开历史记录：${item.title || '未填写歌名'}。`);
}
async function saveDocx(item, mode) {
  if (mode === 'download' && downloadDirectoryHandle) {
    try {
      await ensureDirectoryPermission(downloadDirectoryHandle);
      const filename = docxFilename(item);
      const fileHandle = await downloadDirectoryHandle.getFileHandle(filename, { create: true });
      const response = await fetch('/api/history/save-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'download', entry: item }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'DOCX 下载失败。');
      }
      const writable = await fileHandle.createWritable();
      await writable.write(await response.blob());
      await writable.close();
      showMessage(`DOCX 已保存到选择的文件夹：${filename}`);
      return;
    } catch (error) {
      downloadDirectoryHandle = null;
      el('historyDirInput').value = '浏览器默认下载路径';
      localStorage.setItem(storeKeys.historyDir, el('historyDirInput').value);
      showMessage('选择路径不可用 已改用浏览器默认下载。', true);
    }
  }
  submitDocxDownload(item);
  showMessage('DOCX 已交给浏览器下载。');
}

async function ensureDirectoryPermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return;
  const options = { mode: 'readwrite' };
  if (await handle.queryPermission(options) === 'granted') return;
  if (typeof handle.requestPermission === 'function' && await handle.requestPermission(options) === 'granted') return;
  throw new Error('没有文件夹写入权限。');
}

function submitDocxDownload(item) {
  const frameName = 'docx-download-frame';
  let frame = document.querySelector(`iframe[name="${frameName}"]`);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.name = frameName;
    frame.hidden = true;
    document.body.append(frame);
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/history/save-docx';
  form.target = frameName;
  form.enctype = 'application/x-www-form-urlencoded';
  form.hidden = true;

  const payload = document.createElement('input');
  payload.type = 'hidden';
  payload.name = 'payload';
  payload.value = JSON.stringify({ mode: 'download', entry: item });
  form.append(payload);
  document.body.append(form);
  form.submit();
  form.remove();
}

function docxFilename(item) {
  return safeFilename(`${item.artist || '未填写歌手'} - ${item.title || '未填写歌名'} - ${timestamp(item.createdAt)}.docx`);
}

function safeFilename(value) {
  return String(value || 'lyrics.docx').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'lyrics.docx';
}

function timestamp(value) {
  const date = new Date(value || Date.now());
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function openFeedback() {
  const entry = ensureCurrentEntry();
  if (!entry) {
    showMessage('请先完成翻译，再填写反馈。', true);
    return;
  }
  const feedback = entry.feedback || {};
  el('feedbackMeta').textContent = `${entry.artist || '未填写歌手'} · ${entry.title || '未填写歌名'} · ${entry.sourceLanguage || 'auto'}`;
  el('feedbackRating').value = feedback.rating || 0;
  el('feedbackIssue').value = feedback.issue || '';
  el('feedbackPreferred').value = feedback.preferred || '';
  el('feedbackLineList').innerHTML = '';
  translationLines.forEach((line, index) => {
    if (!line.source && !line.translation) return;
    const saved = (feedback.lineFeedback || []).find((item) => Number(item.index) === index) || {};
    const item = document.createElement('article');
    item.className = 'feedback-line-item';
    item.dataset.index = index;
    item.innerHTML = `
      <div class="feedback-line-text">
        <div><span>原词 ${index + 1}</span></div>
        <div><span>当前译文</span></div>
      </div>
      <div class="feedback-line-controls">
        <label class="feedback-line-field"><span>问题说明</span><textarea class="line-issue"></textarea></label>
        <label class="feedback-line-field"><span>期望改法</span><textarea class="line-preferred"></textarea></label>
        <button class="button ghost compact" type="button" data-feedback-action="adopt">直接采用</button>
        <button class="button primary compact" type="button" data-feedback-action="rewrite">按反馈调整</button>
      </div>`;
    $$('.feedback-line-text div', item)[0].append(document.createTextNode(line.source || ' '));
    $$('.feedback-line-text div', item)[1].append(document.createTextNode(line.translation || ' '));
    $('.line-issue', item).value = saved.issue || '';
    $('.line-preferred', item).value = saved.preferred || '';
    el('feedbackLineList').append(item);
  });
  el('feedbackModal').showModal();
}
function readFeedback() {
  return {
    rating: Number(el('feedbackRating').value || 0),
    issue: trimText(el('feedbackIssue').value),
    preferred: trimText(el('feedbackPreferred').value),
    lineFeedback: $$('.feedback-line-item', el('feedbackLineList')).map((item) => {
      const index = Number(item.dataset.index);
      return {
        index,
        source: translationLines[index]?.source || '',
        currentTranslation: translationLines[index]?.translation || '',
        issue: trimText($('.line-issue', item).value),
        preferred: noPunctuation($('.line-preferred', item).value),
      };
    }).filter((item) => item.issue || item.preferred),
  };
}
function replaceLine(index, value) {
  const translation = noPunctuation(value);
  if (!translation || !translationLines[index]) return false;
  translationLines[index] = { ...translationLines[index], translation };
  renderTranslations(translationLines, translationNotes);
  if (currentHistoryId) {
    patchHistory(currentHistoryId, {
      lines: translationLines,
      notes: translationNotes,
      fullTranslation: fullTranslation(),
      feedback: readFeedback(),
    });
  }
  return true;
}

async function translate() {
  const lyrics = normalizeLyrics(el('lyricsInput').value);
  if (!lyrics) {
    showMessage('请先粘贴外文歌词。', true);
    return;
  }
  el('lyricsInput').value = lyrics;
  el('translateButton').disabled = true;
  el('translateButton').textContent = '翻译中...';
  el('statusPill').textContent = '正在翻译';
  const preferences = savePreferences();
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: trimText(el('songTitleInput').value) || '未填写歌名',
        artist: trimText(el('artistInput').value) || '未填写歌手',
        sourceLanguage: el('sourceLanguageSelect').value,
        lyrics,
        preferences,
        purpose: preferences.purpose,
        style: preferences.style,
        api: apiConfig(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '翻译失败。');
    renderTranslations(data.lines || [], data.notes || []);
    saveNewHistory({
      title: trimText(el('songTitleInput').value) || '未填写歌名',
      artist: trimText(el('artistInput').value) || '未填写歌手',
      lyrics,
      provider: data.provider,
      model: data.model,
      sourceLanguage: data.sourceLanguage || el('sourceLanguageSelect').value,
      purpose: data.purpose,
      style: data.style,
      preferences: data.preferences || preferences,
      lines: translationLines,
      notes: translationNotes,
      fullTranslation: fullTranslation(),
    });
    showMessage(`完成，识别为 ${data.sourceLanguage || '外语'}，共 ${translationLines.length} 行。`);
  } catch (error) {
    showMessage(error.message || '翻译失败，请稍后重试。', true);
  } finally {
    el('translateButton').disabled = false;
    el('translateButton').textContent = '开始翻译';
    el('statusPill').textContent = '浏览器本地保存';
  }
}

function bindEvents() {
  el('translateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    translate();
  });
  el('lyricsInput').addEventListener('input', () => {
    el('charCount').textContent = `${el('lyricsInput').value.length} 字`;
  });
  el('clearButton').addEventListener('click', () => {
    el('songTitleInput').value = '';
    el('artistInput').value = '';
    el('sourceLanguageSelect').value = 'auto';
    el('lyricsInput').value = '';
    el('charCount').textContent = '0 字';
    showMessage('');
    renderEmptyResult();
  });

  el('openApiModalButton').addEventListener('click', () => {
    applyProfileToForm(activeProfile());
    renderApiProfiles();
    el('apiModal').showModal();
  });
  el('closeApiModalButton').addEventListener('click', () => el('apiModal').close());
  el('saveApiModalButton').addEventListener('click', () => {
    updateActiveProfileFromForm();
    el('apiModal').close();
    showMessage('API 接口配置已保存。');
  });
  el('addApiProfileButton').addEventListener('click', addApiProfile);
  el('forgetKeyButton').addEventListener('click', () => {
    el('apiKeyInput').value = '';
    el('saveKeyInput').checked = false;
    updateActiveProfileFromForm();
    showMessage('已忘记当前配置的 API Key。');
  });
  el('providerSelect').addEventListener('change', () => {
    const preset = providerPresets[el('providerSelect').value] || providerPresets.openai;
    el('baseUrlInput').value = preset.baseUrl;
    el('modelInput').value = preset.model;
    populateModels(preset.models, preset.model);
    updateActiveProfileFromForm();
  });
  for (const input of [el('modelInput'), el('baseUrlInput'), el('apiKeyInput'), el('saveKeyInput')]) {
    input.addEventListener('input', updateActiveProfileFromForm);
    input.addEventListener('change', updateActiveProfileFromForm);
  }
  el('modelSelect').addEventListener('change', () => {
    el('modelInput').value = el('modelSelect').value;
    updateActiveProfileFromForm();
  });
  el('fetchModelsButton').addEventListener('click', async () => {
    el('fetchModelsButton').disabled = true;
    el('fetchModelsButton').textContent = '检索中...';
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api: apiConfig() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '模型检索失败。');
      populateModels(data.models || [], el('modelInput').value || data.defaultModel);
      updateActiveProfileFromForm();
      showMessage(`已加载 ${data.models?.length || 0} 个模型${data.source === 'remote' ? '' : '（内置列表）'}。`);
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      el('fetchModelsButton').disabled = false;
      el('fetchModelsButton').textContent = '检索模型';
    }
  });

  el('openHistoryButton').addEventListener('click', () => {
    renderHistory();
    el('historyModal').showModal();
  });
  el('closeHistoryButton').addEventListener('click', () => el('historyModal').close());
  el('clearHistoryButton').addEventListener('click', () => {
    if (confirm('确定清空历史吗？')) {
      saveHistoryItems([]);
      renderHistory();
    }
  });
  el('historyArtistFilter').addEventListener('change', renderHistory);
  el('saveHistoryDirButton').addEventListener('click', async () => {
    if (!window.showDirectoryPicker) {
      downloadDirectoryHandle = null;
      el('historyDirInput').value = '浏览器默认下载路径';
      localStorage.setItem(storeKeys.historyDir, el('historyDirInput').value);
      showMessage('当前浏览器不支持选择文件夹，DOCX 会保存到浏览器默认下载位置。');
      return;
    }
    try {
      downloadDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      el('historyDirInput').value = downloadDirectoryHandle.name || '已选择下载文件夹';
      localStorage.setItem(storeKeys.historyDir, el('historyDirInput').value);
      showMessage('已选择下载文件夹，本次页面打开期间会保存到这里。');
    } catch (error) {
      if (error.name !== 'AbortError') showMessage('选择路径失败，请使用浏览器默认下载路径。', true);
    }
  });
  el('historyList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('.history-item')?.dataset.id;
    const item = historyItems().find((entry) => entry.id === id);
    if (!item) return;
    try {
      if (button.dataset.action === 'load') loadHistoryEntry(id);
      if (button.dataset.action === 'delete') {
        saveHistoryItems(historyItems().filter((entry) => entry.id !== id));
        renderHistory();
      }
      if (button.dataset.action === 'retranslate') {
        loadHistoryEntry(id);
        el('translateForm').requestSubmit();
      }
      if (button.dataset.action === 'download') await saveDocx(item, 'download');
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  el('feedbackButton').addEventListener('click', openFeedback);
  el('closeFeedbackButton').addEventListener('click', () => el('feedbackModal').close());
  el('saveFeedbackButton').addEventListener('click', async () => {
    const entry = ensureCurrentEntry();
    if (!entry) return;
    const feedback = readFeedback();
    if (!feedback.rating && !feedback.issue && !feedback.preferred && !feedback.lineFeedback.length) {
      showMessage('请先填写评分或反馈内容。', true);
      return;
    }
    const response = await fetch('/api/quality-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
        sourceLanguage: entry.sourceLanguage,
        provider: entry.provider,
        model: entry.model,
        ...feedback,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showMessage(data.error || '反馈保存失败。', true);
      return;
    }
    patchHistory(entry.id, { feedback, lines: translationLines, notes: translationNotes, fullTranslation: fullTranslation() });
    showMessage('反馈已保存。');
  });
  el('feedbackLineList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-feedback-action]');
    if (!button) return;
    const item = button.closest('.feedback-line-item');
    const index = Number(item.dataset.index);
    if (button.dataset.feedbackAction === 'adopt') {
      if (replaceLine(index, $('.line-preferred', item).value)) showMessage(`第 ${index + 1} 行已采用。`);
      else showMessage('请先填写期望改法。', true);
      return;
    }
    button.disabled = true;
    button.textContent = '调整中...';
    try {
      const response = await fetch('/api/translate-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: translationLines[index].source,
          currentTranslation: translationLines[index].translation,
          issue: $('.line-issue', item).value,
          preferred: $('.line-preferred', item).value,
          sourceLanguage: el('sourceLanguageSelect').value,
          preferences: getPreferences(),
          api: apiConfig(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '调整失败。');
      replaceLine(index, data.translation);
      showMessage(`第 ${index + 1} 行已调整。`);
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '按反馈调整';
    }
  });

  el('preferenceTranslationApproach').addEventListener('change', syncApproachDefaults);
  for (const input of $$('[data-preference]')) {
    input.addEventListener('input', savePreferences);
    input.addEventListener('change', savePreferences);
  }
}

async function initHistoryPath() {
  el('historyDirInput').value = localStorage.getItem(storeKeys.historyDir) || '浏览器默认下载路径';
}

function init() {
  bindEvents();
  applyPreferences(readJson(storeKeys.preferences, {}));
  applyProfileToForm(activeProfile());
  renderApiProfiles();
  initHistoryPath();
  renderEmptyResult();
  el('charCount').textContent = '0 字';
}

init();
