const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1024 * 1024;
const MAX_LYRICS = 12000;
const UPSTREAM_TIMEOUT_MS = 180000;
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(root, '历史库');
const QUALITY_MODE = 'lyric-master-v3-compact';

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

  const revised = await translateLyricV3(api, sourceLines, metadata);
  const translations = Array.isArray(revised.translations) ? revised.translations : [];
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
    sourceLanguage: clean(revised.sourceLanguage || metadata.sourceLanguage || 'auto'),
    lines,
    notes: Array.isArray(revised.notes) ? revised.notes.map(clean).filter(Boolean).slice(0, 5) : [],
    fullTranslation: lines.map((line) => line.translation).join('\n'),
  });
}

async function translateLyricV3(api, sourceLines, metadata) {
  const payload = {
    model: api.model,
    messages: [
      { role: 'system', content: buildCompactV3Prompt(metadata) },
      { role: 'user', content: JSON.stringify({ task: 'Translate these foreign song lyrics into polished Chinese lyrics.', ...metadata, lines: sourceLines }) },
    ],
    temperature: ['singing', 'polished'].includes(metadata.preferences.purpose) ? 0.35 : 0.25,
  };
  const parsed = parseJsonObject(await chat(api, payload));
  if (!Array.isArray(parsed.translations)) throw new Error('模型没有返回可用译文，请重试。');
  return parsed;
}

async function buildTranslationPlan(api, sourceLines, metadata) {
  const payload = {
    model: api.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildTranslationPlanPrompt(metadata) },
      { role: 'user', content: JSON.stringify({ task: 'Build the full v3 lyric translation plan before final revision.', ...metadata, lines: sourceLines }) },
    ],
    temperature: 0.15,
  };
  const parsed = parseJsonObject(await chat(api, payload));
  if (!Array.isArray(parsed.literalDrafts)) throw new Error('模型没有返回可用初译，请重试。');
  return parsed;
}

async function reviseLyricTranslation(api, sourceLines, metadata, plan) {
  const payload = {
    model: api.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildRevisionPrompt(metadata) },
      { role: 'user', content: JSON.stringify({ task: 'Revise into the final Chinese lyric translation.', ...metadata, lines: sourceLines, plan }) },
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
    response_format: { type: 'json_object' },
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(api.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `${api.label} 请求失败，状态码 ${response.status}。`);
    const content = data.choices?.[0]?.message?.content;
    return Array.isArray(content) ? content.map((part) => part.text || part.content || '').join('') : String(content || '');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${api.label} 响应超时，请稍后重试或换用更快的模型。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildPreferenceBrief(preferences) {
  const p = preferences;
  return [
    `用途 ${p.purpose}`,
    `译文取向 ${p.translationApproach}`,
    `风格 ${p.style}`,
    `忠实度 ${p.faithfulness}`,
    `中文气质 ${p.chineseTone}`,
    `情绪 ${p.emotionIntensity}`,
    `节奏 ${p.rhythm}`,
    `行长 ${p.lineLength}`,
    `押韵 ${p.rhyme}`,
    `俚语 ${p.slangPolicy}`,
    p.preserveImagery ? '保留意象' : '',
    p.keepHookConsistent ? '统一 hook 和重复句' : '',
    p.moderateSubjectFill ? '中文需要时适度补主语' : '尽量不补主语',
    p.avoidOverExplain ? '避免解释腔' : '',
    p.avoidOverLiterary ? '避免过度文艺' : '',
    p.avoidInventing ? '避免乱加剧情' : '',
    p.customInstruction ? `自定义 ${p.customInstruction}` : '',
  ].filter(Boolean).join('；');
}

function buildCompactV3Prompt(metadata) {
  const p = metadata.preferences;
  return [
    '你是听译集 Lyric Master v3 歌词译者 只输出最终 JSON',
    `源语言 ${metadata.sourceLanguage === 'auto' ? '自动识别' : metadata.sourceLanguage}`,
    `偏好 ${buildPreferenceBrief(p)}`,
    buildReferenceStyleBrief(metadata),
    '内部流程 通读全歌 理清叙事 人物关系 情绪曲线 意象 hook 重复句 再逐行翻译和自检',
    '所有行都参考上下文 跨行句先整体理解再拆回原行',
    '统一 我 你 我们 他 她 称呼 时态 语气 重复意象 hook',
    p.moderateSubjectFill ? '省略主语时结合上下文判断 中文不补会误解才自然补出我 你 我们等主语' : '尽量保留无主语留白',
    '原文暧昧处不硬补 不把关系说死 不新增剧情 因果 告白 情绪结论',
    '韩语日语英语混写要处理省略主语 语气 词序 称呼 外文夹杂词',
    '韩语跨行助词和连接尾要合并理解 如 으론 接下一行 곳으로 时 上行可译以我贫瘠的想象力 下行译去往无法想象的地方',
    '韩语 실수 在歌词语境里优先译作差错 阴差阳错 机缘差池 不要生硬译成错误',
    '韩语 줄래 주렴 要译成你可否 请你 能否 再一次 等柔软请求',
    '译文要准确 连贯 有中文歌词感 避免机器腔 解释腔 成语堆砌 过度文艺 网络腔 口号腔',
    '不要过度省字 如果原句是请求 疑问 祈愿 要译出可否 能否 请 再一次 等语气',
    '韩语 줄래 주렴 까 等语尾要译出柔软请求或疑问 不要只译成短命令',
    '意象抽象句要保留诗意骨架 如 孤独的反义词 想象力贫瘠 世界尽头 支离破碎',
    '英文夹杂词优先服务记忆点 My lover 通常译作我的爱人 Run on 通常译作不停奔跑 Love wins all 通常译作爱胜过一切',
    '保持输入行数 空行返回空字符串',
    '最终译文无任何标点 只用空格和换行表达停顿',
    '只返回严格 JSON 格式 {"sourceLanguage":"...","translations":["..."],"notes":["..."]}',
    'translations 长度必须与输入 lines 完全一致 notes 最多 3 条 通常可为空数组',
    metadata.feedbackSummary ? `历史质量反馈摘要 ${metadata.feedbackSummary}` : '历史质量反馈摘要 暂无',
  ].filter(Boolean).join('\n');
}

function buildReferenceStyleBrief(metadata) {
  const title = clean(metadata.title || '').toLowerCase();
  const artist = clean(metadata.artist || '').toLowerCase();
  const lines = [
    '参考人工精修方向 准确基础上可适度展开半拍 让中文更像完整歌词 不要只给短促释义',
    '称呼和祈愿句要更柔软 例如 你可否带我去往 我的爱人 和我一起走到尽头',
    '重复 hook 要成为记忆点 同一原句前后译法保持稳定',
  ];
  if (title.includes('love wins all') || artist.includes('iu')) {
    lines.push('本歌风格参考 IU Love wins all 译法要有末日私奔感 克制但深情');
    lines.push('建议记忆点 Dearest Darling My universe 译作我亲爱的宇宙 或最亲爱的 我的宇宙');
    lines.push('날 데려가 줄래 译出你可否带我去往 不要只写能否带我走');
    lines.push('from Earth to Mars 译出从地球去往遥远的火星');
    lines.push('세상에게서 도망쳐 Run on 统一为逃离这个世界 不停奔跑');
    lines.push('저 끝까지 가줘 My lover 统一为我的爱人 和我一起走到尽头 或世界尽头');
    lines.push('부서지도록 나를 꼭 안아 译出紧紧拥抱我 直到支离破碎');
    lines.push('어떤 실수로 이토록 우리는 함께일까 译出是怎样的差错让我们如此在一起');
    lines.push('유영하듯 떠오른 译作如漂浮般浮现 不要译成游泳');
    lines.push('Ruiner 译作毁灭者 或保留 Ruiner 后用毁灭感表达');
    lines.push('Love wins all 统一为爱胜过一切 或我们的爱胜过一切');
  }
  if (title.includes('hiruno hoshi') || title.includes('昼の星') || artist.includes('radwimps')) {
    lines.push('日语 RADWIMPS 风格要保留矛盾修饰和轻微别扭的诗意 不要抹平成普通说明');
    lines.push('鮮やかな虚しさ 健やかな卑しさ したたかな優しさ あたたかな寂しさ 这类反差结构要保留反差');
    lines.push('そっと笑ってよ そこで叱ってよ もっといらってよ そっと祝うよ 要译出轻轻 请你 就在那里 等柔软请求语气');
    lines.push('夜に迷わぬように 星など探さぬように 要处理成不愿在夜里迷失 也不必寻找星星这类连贯祈愿');
    lines.push('昼の星 是白天的星 昼もそこにいるのに 要保留明明白天也在那里却看不见的意象');
    lines.push('夢の前で待ち合わせ 译作在梦的前方汇合或相约在梦的前方');
    lines.push('理由など一つもなくキスをしよう 译作不为任何理由地亲吻吧 保持重复句一致');
    lines.push('せーのでジャンプしよう 译作数着一二一起跳吧 或同时起跳吧');
    lines.push('同じ時と空の狭間 要译作相同的时空夹缝或同一时间与天空的缝隙');
  }
  return lines.join('\n');
}

function buildTranslationPlanPrompt(metadata) {
  const p = metadata.preferences;
  return [
    '你是听译集 Lyric Master v3 的翻译策划和审校专家',
    '本阶段合并完成 理解 初译 审校 三件事 不输出给用户 不做最终润色',
    `源语言 ${metadata.sourceLanguage === 'auto' ? '自动识别' : metadata.sourceLanguage}`,
    `偏好 ${buildPreferenceBrief(p)}`,
    buildReferenceStyleBrief(metadata),
    '第一步 全歌理解',
    '先通读全歌 建立叙事线 人物关系 情绪曲线 意象变化 hook 和重复句',
    '必须建立指代关系表 判断叙述者是谁 对谁说 我 你 他 她 我们分别指向谁',
    '必须找出哪些行省略了主语或宾语 并说明是否需要在中文中补出',
    '日语 韩语 西语 英语歌词常省略主语 必须结合上下文判断 不允许逐句猜',
    '处理韩语时特别注意主语省略 语尾语气 敬语 英韩混写 词序 暧昧指代',
    '处理日语时特别注意省略主语 助词关系 否定范围 暧昧指代 拟声拟态',
    '处理英语时特别注意习语 代词指代 称呼 比喻 押韵和跨行句',
    '不要把暧昧强行解释成爱情 死亡 命运 永远等原文没有的结论',
    '第二步 准确初译',
    '必须保持输入行数 空行返回空字符串',
    '每一行必须参考全歌理解和前后文 不允许孤立逐句硬译',
    '跨行句子先整体理解 再拆回原行',
    '主语省略时先按理解阶段的指代关系判断',
    p.moderateSubjectFill ? '中文不补主语会别扭或误解时 可以适度补出自然主语' : '尽量保留原文无主语的留白',
    '原文刻意暧昧或留白时 不要硬补主语',
    '补主语不能改变叙事视角 不能新增剧情 因果 告白或情绪结论',
    'hook 副歌 重复句的译法保持一致 除非原文确有变化',
    '第三步 审校诊断',
    '逐行检查误译 漏译 反译 指代错误 主语误补 该补未补 上下文断裂 情绪断裂',
    '检查 我 你 我们 他 她 的关系是否突然变化',
    '检查无主句是否被误译成泛泛陈述 或把原文暧昧补得太死',
    '检查 hook 副歌 重复句是否统一',
    '检查是否有机器翻译腔 解释腔 四字成语堆砌 过度文艺 网络流行腔 口号腔',
    '返回严格 JSON 格式 {"sourceLanguage":"...","narrative":"...","voice":"...","relationshipMap":[{"term":"...","referent":"..."}],"omittedSubjects":[{"line":1,"subject":"...","confidence":"high|medium|low","shouldFillInChinese":true}],"imagery":["..."],"hookMap":[{"source":"...","meaning":"...","recommendedChinese":"..."}],"glossary":[{"source":"...","meaning":"...","translationHint":"..."}],"literalDrafts":["..."],"review":{"issues":[{"line":1,"type":"...","problem":"...","fix":"..."}],"globalFixes":["..."],"subjectFixes":["..."],"hookFixes":["..."]},"risks":["..."]}',
    'literalDrafts 长度必须与输入 lines 完全一致',
    metadata.feedbackSummary ? `历史质量反馈摘要 ${metadata.feedbackSummary}` : '历史质量反馈摘要 暂无',
  ].filter(Boolean).join('\n');
}

function buildRevisionPrompt(metadata) {
  const p = metadata.preferences;
  return [
    '你是听译集 Lyric Master v3 的中文歌词修订专家',
    '根据全歌理解 初译和审校结果 输出最终中文歌词',
    `偏好 ${buildPreferenceBrief(p)}`,
    buildReferenceStyleBrief(metadata),
    '总目标 上下文连贯 中文歌词感 忠实不硬译 润色不乱编',
    '必须保持输入行数 空行返回空字符串',
    '每一行承接前后文 代词 称呼 时态 语气 重复意象 hook 译法保持一致',
    '跨行句子必须先整体理解 再拆回原行 避免上下句割裂',
    p.moderateSubjectFill ? '中文不补主语会别扭或误解时 适度补出我 你 我们等自然主语' : '尽量不补主语 保留原文留白',
    '原文刻意暧昧或留白时不硬补主语 不把关系说死',
    '补主语后不能改变叙事视角 不能新增剧情 因果 告白或情绪结论',
    '中文要自然 有节奏 有留白 像歌词 不是说明文',
    '准确基础上可适度展开半拍 让中文成为完整歌词句 不要为了短而损失语气和意象',
    '请求 疑问 祈愿 要译出可否 能否 请 再一次 等语气',
    '避免机器翻译腔 解释腔 四字成语堆砌 过度文艺 网络流行腔 口号腔',
    '最终译文不要使用逗号 句号 顿号 分号 冒号 问号 感叹号 引号 括号 省略号 破折号 日文标点或韩文标点',
    '如需停顿只能用一个空格',
    '只返回严格 JSON 格式 {"sourceLanguage":"...","translations":["..."],"notes":["..."]}',
    'translations 长度必须与输入 lines 完全一致 notes 最多 5 条 通常可为空数组',
    metadata.feedbackSummary ? `历史质量反馈摘要 ${metadata.feedbackSummary}` : '历史质量反馈摘要 暂无',
  ].filter(Boolean).join('\n');
}

function buildLinePrompt(sourceLanguage, preferences, feedbackSummary) {
  return [
    '你是资深歌词译者 现在只调整一行译文',
    `源语言 ${sourceLanguage === 'auto' ? '自动识别' : sourceLanguage}`,
    '目标 根据反馈修正这一句 保持原意 语气 意象 中文歌词感',
    preferences.moderateSubjectFill ? '如果这一句省略主语且中文不补会误解 可以结合当前句和反馈适度补出自然主语' : '尽量保留无主语留白',
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
    translationApproach: ['naturalLyrics', 'faithful', 'poetic', 'concise'],
    delivery: ['match', 'short', 'smooth', 'singable'],
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
  const approach = pick('translationApproach', inferTranslationApproach(raw));
  const delivery = pick('delivery', inferDelivery(raw));
  const approachDefaults = {
    naturalLyrics: { style: 'lyrical', faithfulness: 'balanced', chineseTone: 'lyric' },
    faithful: { style: 'natural', faithfulness: 'faithful', chineseTone: 'plain' },
    poetic: { style: 'lyrical', faithfulness: 'adaptive', chineseTone: 'poetic' },
    concise: { style: 'natural', faithfulness: 'balanced', chineseTone: 'plain' },
  }[approach];
  const deliveryDefaults = {
    match: { rhythm: 'pause', lineLength: 'match' },
    short: { rhythm: 'pause', lineLength: 'short' },
    smooth: { rhythm: 'smooth', lineLength: 'flexible' },
    singable: { rhythm: 'singable', lineLength: 'flexible' },
  }[delivery];
  return {
    purpose: pick('purpose', choices.purpose.includes(fallbackPurpose) ? fallbackPurpose : 'reading'),
    translationApproach: approach,
    delivery,
    style: pick('style', choices.style.includes(fallbackStyle) ? fallbackStyle : approachDefaults.style),
    faithfulness: pick('faithfulness', approachDefaults.faithfulness),
    chineseTone: pick('chineseTone', approachDefaults.chineseTone),
    emotionIntensity: pick('emotionIntensity', 'original'),
    rhythm: pick('rhythm', deliveryDefaults.rhythm),
    rhyme: pick('rhyme', 'none'),
    lineLength: pick('lineLength', deliveryDefaults.lineLength),
    slangPolicy: pick('slangPolicy', 'naturalize'),
    preserveImagery: raw.preserveImagery !== false,
    keepHookConsistent: raw.keepHookConsistent !== false,
    moderateSubjectFill: raw.moderateSubjectFill !== false,
    avoidOverExplain: raw.avoidOverExplain !== false,
    avoidOverLiterary: raw.avoidOverLiterary !== false,
    avoidInventing: raw.avoidInventing !== false,
    noPunctuation: true,
    customInstruction: clean(raw.customInstruction || '').slice(0, 240),
  };
}

function inferTranslationApproach(raw = {}) {
  if (raw.translationApproach) return raw.translationApproach;
  if (raw.chineseTone === 'poetic') return 'poetic';
  if (raw.faithfulness === 'faithful') return 'faithful';
  if (raw.chineseTone === 'plain') return 'concise';
  return 'naturalLyrics';
}

function inferDelivery(raw = {}) {
  if (raw.delivery) return raw.delivery;
  if (raw.rhythm === 'singable') return 'singable';
  if (raw.lineLength === 'short') return 'short';
  if (raw.rhythm === 'smooth' || raw.lineLength === 'flexible') return 'smooth';
  return 'match';
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
