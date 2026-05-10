const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1024 * 1024;
const MAX_LYRICS = 12000;
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(root, '历史库');
const QUALITY_MODE = 'contextual-polished-2pass';

const providers = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: process.env.TRANSLATION_MODEL || 'gpt-5.4-mini', env: 'OPENAI_API_KEY', models: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-4.1-mini'] },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', env: 'DEEPSEEK_API_KEY', models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', env: 'DASHSCOPE_API_KEY', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
  moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', env: 'MOONSHOT_API_KEY', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', env: 'ZHIPU_API_KEY', models: ['glm-4-flash', 'glm-4-plus'] },
  custom: { label: '自定义', baseUrl: process.env.CUSTOM_BASE_URL || '', model: process.env.CUSTOM_MODEL || '', env: 'CUSTOM_API_KEY', models: [] },
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

loadEnv(path.join(root, '.env.local'));

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/translate') return await handleTranslate(req, res);
    if (url.pathname === '/api/translate-line') return await handleTranslateLine(req, res);
    if (url.pathname === '/api/models') return await handleModels(req, res);
    if (url.pathname === '/api/share-info') return sendJson(res, 200, { port: PORT, host: HOST, urls: shareUrls() });
    if (url.pathname === '/api/history/settings') return sendJson(res, 200, { historyDir: HISTORY_DIR, defaultHistoryDir: HISTORY_DIR });
    if (url.pathname === '/api/history/save-docx') return await handleSaveDocx(req, res);
    if (url.pathname === '/api/quality-feedback') return await handleFeedback(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持的请求方法。' });
    return serveStatic(url.pathname, res, req.method === 'HEAD');
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || '服务器内部错误。' });
  }
}).listen(PORT, HOST, () => {
  console.log('听译集已启动');
  shareUrls().forEach((url) => console.log('- ' + url));
});

async function handleTranslate(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const lyrics = normalizeLyrics(body.lyrics || '');
  if (!lyrics) return sendJson(res, 400, { error: '请先输入外文歌词。' });
  if (lyrics.length > MAX_LYRICS) return sendJson(res, 400, { error: `歌词太长了，请控制在 ${MAX_LYRICS} 字以内。` });

  const api = normalizeApi(body.api || {});
  if (!api.apiKey) return sendJson(res, 400, { error: `缺少 ${api.label} API Key。请在顶部 API 接口里填写，或在 .env.local 配置 ${api.env}。` });

  const sourceLines = lyrics.split('\n');
  const preferences = normalizePreferences(body.preferences || {}, body.purpose, body.style);
  const metadata = {
    title: clean(body.title || ''),
    artist: clean(body.artist || ''),
    sourceLanguage: clean(body.sourceLanguage || 'auto') || 'auto',
    preferences,
    feedbackSummary: loadFeedbackSummary(),
  };

  const draft = await buildContextDraft(api, sourceLines, metadata);
  const polished = await polishContextualTranslation(api, sourceLines, metadata, draft);
  const translations = Array.isArray(polished.translations) ? polished.translations : [];
  const lines = sourceLines.map((source, index) => ({
    source,
    translation: source.trim() ? removePunctuation(translations[index] || '') : '',
  }));

  return sendJson(res, 200, {
    provider: api.label,
    model: api.model,
    purpose: preferences.purpose,
    style: preferences.style,
    preferences,
    qualityMode: QUALITY_MODE,
    sourceLanguage: clean(polished.sourceLanguage || draft.sourceLanguage || metadata.sourceLanguage || 'auto'),
    lines,
    notes: Array.isArray(polished.notes) ? polished.notes.map(clean).filter(Boolean).slice(0, 5) : [],
    fullTranslation: lines.map((line) => line.translation).join('\n'),
  });
}

async function buildContextDraft(api, sourceLines, metadata) {
  const payload = {
    model: api.model,
    messages: [
      { role: 'system', content: buildDraftPrompt(metadata) },
      { role: 'user', content: JSON.stringify({ task: 'Build a context-aware lyric translation draft.', ...metadata, lines: sourceLines }) },
    ],
    temperature: 0.15,
  };
  const parsed = parseJsonObject(await chat(api, payload));
  if (!Array.isArray(parsed.literalDrafts)) throw new Error('模型没有返回可用初译，请重试。');
  return parsed;
}

async function polishContextualTranslation(api, sourceLines, metadata, draft) {
  const payload = {
    model: api.model,
    messages: [
      { role: 'system', content: buildPolishPrompt(metadata) },
      { role: 'user', content: JSON.stringify({ task: 'Polish the lyric translation with full-song narrative continuity.', ...metadata, lines: sourceLines, draft }) },
    ],
    temperature: ['singing', 'polished'].includes(metadata.preferences.purpose) ? 0.35 : 0.25,
  };
  const parsed = parseJsonObject(await chat(api, payload));
  if (!Array.isArray(parsed.translations)) throw new Error('模型没有返回可用译文，请重试。');
  return parsed;
}

async function handleTranslateLine(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const api = normalizeApi(body.api || {});
  if (!api.apiKey) return sendJson(res, 400, { error: `缺少 ${api.label} API Key。请在顶部 API 接口里填写，或在 .env.local 配置 ${api.env}。` });
  if (!clean(body.source) && !clean(body.currentTranslation)) return sendJson(res, 400, { error: '缺少要调整的歌词行。' });
  if (!clean(body.issue) && !clean(body.preferred)) return sendJson(res, 400, { error: '请先填写这一句的问题说明或期望改法。' });

  const preferences = normalizePreferences(body.preferences || {}, body.preferences?.purpose, body.preferences?.style);
  const payload = {
    model: api.model,
    messages: [
      { role: 'system', content: buildLinePrompt(body.sourceLanguage || 'auto', preferences, loadFeedbackSummary()) },
      { role: 'user', content: JSON.stringify({ source: body.source, currentTranslation: body.currentTranslation, issue: body.issue, preferred: body.preferred }) },
    ],
    temperature: 0.2,
  };
  const parsed = parseJsonObject(await chat(api, payload));
  const translation = removePunctuation(parsed.translation || '');
  if (!translation) throw new Error('模型没有返回可用译文。');
  return sendJson(res, 200, { provider: api.label, model: api.model, translation });
}

async function handleModels(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const api = normalizeApi(body.api || {});
  const preset = providers[api.provider] || providers.openai;
  if (!api.apiKey) return sendJson(res, 200, { provider: api.label, defaultModel: api.model, models: preset.models, source: 'builtin' });
  try {
    const response = await fetch(api.baseUrl + '/models', { headers: { Authorization: `Bearer ${api.apiKey}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || '模型检索失败。');
    const remote = Array.isArray(data.data) ? data.data.map((item) => typeof item === 'string' ? item : item.id || item.name || item.model).filter(Boolean) : [];
    return sendJson(res, 200, { provider: api.label, defaultModel: api.model, models: [...new Set(remote.length ? remote : preset.models)].sort(), source: remote.length ? 'remote' : 'builtin' });
  } catch (error) {
    return sendJson(res, 502, { error: error.message, provider: api.label, defaultModel: api.model, models: preset.models, source: 'builtin' });
  }
}

async function handleFeedback(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST 请求反馈接口。' });
  const body = await readBody(req);
  const item = {
    id: clean(body.id || String(Date.now())),
    createdAt: new Date().toISOString(),
    title: clean(body.title || '未填写歌名'),
    artist: clean(body.artist || '未填写歌手'),
    rating: Number(body.rating || 0),
    issue: clean(body.issue || ''),
    preferred: clean(body.preferred || ''),
    lineFeedback: normalizeLineFeedback(body.lineFeedback),
    sourceLanguage: clean(body.sourceLanguage || 'auto'),
    provider: clean(body.provider || ''),
    model: clean(body.model || ''),
  };
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const filePath = path.join(HISTORY_DIR, 'translation-feedback.json');
  const current = readJsonArray(filePath);
  current.unshift(item);
  fs.writeFileSync(filePath, JSON.stringify(current.slice(0, 200), null, 2), 'utf8');
  return sendJson(res, 200, { saved: true, filePath });
}

async function handleSaveDocx(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const entry = body.entry || body;
  const buffer = createDocx(entry);
  const filename = safeFilename(`${entry.artist || '未填写歌手'} - ${entry.title || '未填写歌名'} - ${timestamp(entry.createdAt)}.docx`);
  if (body.mode === 'download') {
    res.writeHead(200, { 'Content-Type': mime['.docx'], 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
    return res.end(buffer);
  }
  const targetDir = clean(body.historyDir) || HISTORY_DIR;
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, filename);
  fs.writeFileSync(filePath, buffer);
  return sendJson(res, 200, { filename, filePath });
}

async function chat(api, payload) {
  const response = await fetch(api.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `${api.label} 请求失败，状态码 ${response.status}。`);
  const content = data.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((part) => part.text || part.content || '').join('') : String(content || '');
}

function buildDraftPrompt(metadata) {
  return [
    '你是资深多语种歌词译者。第一步只做全歌上下文理解和准确初译 不输出给用户',
    `源语言 ${metadata.sourceLanguage === 'auto' ? '自动识别' : metadata.sourceLanguage}`,
    '先通读全歌 建立叙事线 谁在说话 对谁说 情绪如何推进 意象如何重复或变化',
    '每行都必须参考上下文 不允许孤立逐句硬译 跨行句子要合并理解再拆回原行',
    '处理韩语时特别注意主语省略 语尾语气 敬语 英韩混写 词序和暧昧指代',
    '处理日语时注意省略主语 助词关系 否定范围 暧昧指代和拟声拟态',
    '处理英语时注意习语 代词指代 称呼 比喻和押韵 不要逐词硬译',
    '返回严格 JSON 格式为 {"sourceLanguage":"...","narrative":"...","voice":"...","imagery":["..."],"hookMap":[{"source":"...","meaning":"..."}],"literalDrafts":["..."],"risks":["..."]}',
    'literalDrafts 长度必须与输入 lines 完全一致 空行返回空字符串',
    'literalDrafts 先求准确和连贯 可以有轻微解释 但不要添加原文没有的剧情 情绪结论或因果',
    metadata.feedbackSummary ? `历史质量反馈摘要 ${metadata.feedbackSummary}` : '历史质量反馈摘要 暂无',
  ].join('\n');
}

function buildPolishPrompt(metadata) {
  const p = metadata.preferences;
  return [
    '你是资深中文歌词编辑。第二步把初译精修成上下文连贯的中文歌词',
    '总目标 准确理解源语言 叙事连贯 中文像歌词 最后再去标点',
    '必须保持输入行数 空行返回空字符串',
    '每一行都要承接前后文 代词 称呼 时态 语气 重复意象 hook 译法要一致',
    '跨行句子必须先整体理解 再拆回原行输出 避免上下句割裂',
    '中文要自然 有节奏和留白 避免机器翻译腔 解释腔 四字成语堆砌 过度文艺 网络流行腔 口号腔',
    '不确定的暧昧处保留暧昧 不要擅自坐实为爱情 死亡 告别 命运 心碎 永远等原文没有的结论',
    '韩语和英韩混写要按上下文处理 My universe My lover 等称呼 不要机械逐字',
    `偏好 用途 ${p.purpose} 风格 ${p.style} 忠实度 ${p.faithfulness} 中文气质 ${p.chineseTone} 情绪 ${p.emotionIntensity} 节奏 ${p.rhythm} 押韵 ${p.rhyme} 行长 ${p.lineLength} 俚语 ${p.slangPolicy}`,
    p.customInstruction ? `用户自定义偏好 ${p.customInstruction}` : '',
    '自检后再输出 检查误译 漏译 反译 指代错误 情绪断裂 上下文不连贯 重复句不一致 中文不自然',
    '最终译文不要使用逗号 句号 顿号 分号 冒号 问号 感叹号 引号 括号 省略号 破折号 日文标点或韩文标点',
    '如需停顿只能用一个空格',
    '只返回严格 JSON 格式为 {"sourceLanguage":"...","translations":["..."],"notes":["..."]}',
    'translations 长度必须与输入 lines 完全一致 notes 最多 5 条 通常可为空数组',
    metadata.feedbackSummary ? `历史质量反馈摘要 ${metadata.feedbackSummary}` : '历史质量反馈摘要 暂无',
  ].filter(Boolean).join('\n');
}

function buildLinePrompt(sourceLanguage, preferences, feedbackSummary) {
  return [
    '你是资深歌词译者 现在只调整一行译文',
    `源语言 ${sourceLanguage === 'auto' ? '自动识别' : sourceLanguage}`,
    '目标 根据反馈修正这一句 保持原意 语气 意象 中文歌词感',
    '不要添加原文没有的剧情 因果 告白或情绪结论',
    '不要使用任何标点 如需停顿只用空格',
    `偏好 ${JSON.stringify(preferences)}`,
    feedbackSummary ? `历史质量反馈摘要 ${feedbackSummary}` : '历史质量反馈摘要 暂无',
    '只返回严格 JSON {"translation":"..."}',
  ].join('\n');
}

function normalizePreferences(raw = {}, fallbackPurpose = 'reading', fallbackStyle = 'natural') {
  const choices = {
    purpose: ['reading', 'subtitle', 'singing', 'polished'],
    style: ['literal', 'natural', 'lyrical'],
    faithfulness: ['balanced', 'faithful', 'adaptive'],
    chineseTone: ['lyric', 'plain', 'poetic', 'spoken'],
    emotionIntensity: ['original', 'restrained', 'intense'],
    rhythm: ['pause', 'smooth', 'singable'],
    rhyme: ['none', 'light', 'strong'],
    lineLength: ['match', 'short', 'flexible'],
    slangPolicy: ['naturalize', 'keepFlavor', 'plainExplain'],
  };
  const pick = (key, fallback) => choices[key].includes(raw[key]) ? raw[key] : fallback;
  return {
    purpose: pick('purpose', choices.purpose.includes(fallbackPurpose) ? fallbackPurpose : 'reading'),
    style: pick('style', choices.style.includes(fallbackStyle) ? fallbackStyle : 'lyrical'),
    faithfulness: pick('faithfulness', 'balanced'),
    chineseTone: pick('chineseTone', 'lyric'),
    emotionIntensity: pick('emotionIntensity', 'original'),
    rhythm: pick('rhythm', 'pause'),
    rhyme: pick('rhyme', 'none'),
    lineLength: pick('lineLength', 'match'),
    slangPolicy: pick('slangPolicy', 'naturalize'),
    preserveImagery: raw.preserveImagery !== false,
    keepHookConsistent: raw.keepHookConsistent !== false,
    avoidOverExplain: raw.avoidOverExplain !== false,
    avoidOverLiterary: raw.avoidOverLiterary !== false,
    avoidInventing: raw.avoidInventing !== false,
    noPunctuation: true,
    customInstruction: clean(raw.customInstruction || '').slice(0, 240),
  };
}

function normalizeApi(raw) {
  const provider = providers[raw.provider] ? raw.provider : 'openai';
  const preset = providers[provider];
  return {
    provider,
    label: preset.label,
    baseUrl: String(raw.baseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
    model: clean(raw.model || preset.model),
    apiKey: clean(raw.apiKey || process.env[preset.env] || ''),
    env: preset.env,
  };
}

function normalizeLineFeedback(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    index: Number(item?.index),
    source: clean(item?.source || '').slice(0, 500),
    currentTranslation: removePunctuation(item?.currentTranslation || '').slice(0, 500),
    issue: clean(item?.issue || '').slice(0, 500),
    preferred: removePunctuation(item?.preferred || '').slice(0, 500),
  })).filter((item) => Number.isInteger(item.index) && item.index >= 0 && (item.issue || item.preferred)).slice(0, 80);
}

function loadFeedbackSummary() {
  const feedback = readJsonArray(path.join(HISTORY_DIR, 'translation-feedback.json')).slice(0, 20);
  const liked = feedback.filter((item) => Number(item.rating) >= 4).map((item) => item.preferred || item.issue).filter(Boolean).slice(0, 5);
  const avoid = feedback.filter((item) => Number(item.rating) > 0 && Number(item.rating) <= 2).map((item) => item.issue || item.preferred).filter(Boolean).slice(0, 8);
  const lineAdvice = feedback.flatMap((item) => Array.isArray(item.lineFeedback) ? item.lineFeedback : []).filter((item) => item.issue || item.preferred).slice(0, 12).map((item) => `${item.source || '某句'} ${item.issue || ''} ${item.preferred || ''}`.trim());
  const parts = [];
  if (liked.length) parts.push(`用户喜欢 ${liked.join('；')}`);
  if (avoid.length) parts.push(`需要避免 ${avoid.join('；')}`);
  if (lineAdvice.length) parts.push(`单句反馈 ${lineAdvice.join('；')}`);
  return parts.join('。').slice(0, 1200);
}

function serveStatic(requestPath, res, headOnly) {
  const decoded = requestPath === '/' ? '/index.html' : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(root, decoded));
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return res.writeHead(403).end('Forbidden');
  fs.readFile(filePath, (error, data) => {
    if (error) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('找不到页面。');
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(headOnly ? undefined : data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大。'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求 JSON 格式不正确。')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function clean(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function normalizeLyrics(value) { return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim(); }
function removePunctuation(value) { return clean(value).replace(/[，,。．.、；;：:！？!?「」『』“”"‘’'（）()【】［］[\]《》<>…—–\-~～]/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseJsonObject(text) { try { return JSON.parse(text); } catch { const match = String(text).match(/\{[\s\S]*\}/); if (!match) throw new Error('模型没有返回 JSON。'); return JSON.parse(match[0]); } }
function readJsonArray(filePath) { try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : []; } catch { return []; } }
function loadEnv(filePath) { if (!fs.existsSync(filePath)) return; for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue; const index = trimmed.indexOf('='); const key = trimmed.slice(0, index).trim(); const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, ''); if (key && !process.env[key]) process.env[key] = value; } }
function shareUrls() { const urls = [`http://localhost:${PORT}`]; for (const group of Object.values(os.networkInterfaces())) for (const item of group || []) if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${PORT}`); return [...new Set(urls)]; }
function safeFilename(value) { return String(value || 'lyrics.docx').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'lyrics.docx'; }
function timestamp(value) { const date = new Date(value || Date.now()); const pad = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`; }

function createDocx(entry) {
  const paragraph = (text, align = 'left') => `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${escapeXml(text || ' ')}</w:t></w:r></w:p>`;
  const body = [
    paragraph(entry.title || '未填写歌名', 'center'),
    paragraph(entry.artist || '未填写歌手', 'center'),
    paragraph(new Date(entry.createdAt || Date.now()).toLocaleString('zh-CN'), 'right'),
    paragraph(entry.sourceLanguage || 'auto', 'right'),
    paragraph(' '),
    ...String(entry.lyrics || '').split('\n').map((line) => paragraph(line)),
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    ...String(entry.fullTranslation || '').split('\n').map((line) => paragraph(line)),
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document,
  });
}

function escapeXml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function zip(files) { const locals = [], centrals = []; let offset = 0; for (const [name, data] of Object.entries(files)) { const nameBuffer = Buffer.from(name); const dataBuffer = Buffer.from(data); const crc = crc32(dataBuffer); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(dataBuffer.length, 18); local.writeUInt32LE(dataBuffer.length, 22); local.writeUInt16LE(nameBuffer.length, 26); locals.push(local, nameBuffer, dataBuffer); const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(dataBuffer.length, 20); central.writeUInt32LE(dataBuffer.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42); centrals.push(central, nameBuffer); offset += local.length + nameBuffer.length + dataBuffer.length; } const centralBuffer = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, centralBuffer, end]); }
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let index = 0; index < 8; index += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
