const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY = 1024 * 1024 * 2;
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(__dirname, '历史库');
const downloads = new Map();
const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(listener) {
  return originalCreateServer.call(http, async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/api/history/prepare-docx') return await prepareDocx(req, res);
      if (url.pathname === '/api/history/download-docx') return downloadDocx(req, res, url);
      if (url.pathname === '/api/history/save-docx') return await saveDocx(req, res, url);
      return listener(req, res);
    } catch (error) {
      console.error(error);
      json(res, 500, { error: error.message || '服务器内部错误。' });
    }
  });
};

require('./server.js');

async function prepareDocx(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const entry = body.entry || body;
  const file = buildFile(entry);
  const id = crypto.randomBytes(12).toString('hex');
  downloads.set(id, { ...file, expiresAt: Date.now() + 10 * 60 * 1000 });
  cleanupDownloads();
  return json(res, 200, { id, filename: file.filename, downloadUrl: `/api/history/download-docx?id=${id}` });
}

function downloadDocx(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '请使用 GET 请求下载 DOCX。' });
  cleanupDownloads();
  const id = url.searchParams.get('id') || '';
  if (!id) return json(res, 400, { error: '下载链接缺少文件编号，请回到历史库重新点击下载 DOCX。' });
  const file = downloads.get(id);
  if (!file) return json(res, 404, { error: '下载链接已过期，请回到历史库重新点击下载 DOCX。' });
  return sendDocx(req, res, file);
}

async function saveDocx(req, res, url) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const id = url.searchParams.get('id');
    if (id) return downloadDocx(req, res, url);
    return json(res, 400, { error: '下载链接缺少文件编号，请回到历史库重新点击下载 DOCX。' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: '请使用 POST 请求。' });
  const body = await readBody(req);
  const entry = body.entry || body;
  const file = buildFile(entry);

  if (body.mode === 'download' || body.forceDownload) return sendDocx(req, res, file);

  const targetDir = clean(body.historyDir) || HISTORY_DIR;
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(targetDir)) {
    return json(res, 409, { error: '公网服务器不能直接写入你设备上的本地磁盘路径，请使用下载 DOCX。', downloadAvailable: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, file.filename);
  fs.writeFileSync(filePath, file.buffer);
  return json(res, 200, { filename: file.filename, filePath });
}

function buildFile(entry) {
  const filename = safeFilename(`${entry.artist || '未填写歌手'} - ${entry.title || '未填写歌名'} - ${stamp(entry.createdAt)}.docx`);
  return { filename, buffer: createDocx(entry) };
}

function sendDocx(req, res, file) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'Content-Length': file.buffer.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(file.buffer);
}

function cleanupDownloads() {
  const now = Date.now();
  for (const [id, file] of downloads) {
    if (file.expiresAt <= now) downloads.delete(id);
  }
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
      try {
        if (!raw) return resolve({});
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(raw);
          const payload = params.get('payload');
          return resolve(payload ? JSON.parse(payload) : Object.fromEntries(params.entries()));
        }
        return resolve(JSON.parse(raw));
      } catch {
        return reject(new Error('请求 JSON 格式不正确。'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function clean(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
function safeFilename(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'lyrics.docx';
}
function stamp(value) {
  const date = new Date(value || Date.now());
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createDocx(entry) {
  const title = paragraph(entry.title || '未填写歌名', { align: 'center', size: 32, eastAsia: '黑体', ascii: 'Times New Roman' });
  const artist = paragraph(entry.artist || '未填写歌手', { align: 'center', size: 24, eastAsia: '宋体', ascii: 'Times New Roman' });
  const meta = [
    paragraph(new Date(entry.createdAt || Date.now()).toLocaleString('zh-CN'), { align: 'right', size: 24 }),
    paragraph(entry.sourceLanguage || 'auto', { align: 'right', size: 24 }),
    paragraph(preferenceSummary(entry.preferences), { align: 'right', size: 24 }),
    paragraph(' ', { size: 24 }),
  ].join('');
  const source = String(entry.lyrics || '').split('\n').map((line) => paragraph(line, { size: 24, eastAsia: '宋体', ascii: 'Times New Roman' })).join('');
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const translation = String(entry.fullTranslation || '').split('\n').map((line) => paragraph(line, { size: 24, eastAsia: '宋体', ascii: 'Times New Roman' })).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${title}${artist}${meta}${source}${pageBreak}${translation}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document,
  });
}
function paragraph(value, options = {}) {
  const align = options.align || 'left';
  const size = options.size || 24;
  const eastAsia = options.eastAsia || '宋体';
  const ascii = options.ascii || 'Times New Roman';
  const bold = options.bold ? '<w:b/><w:bCs/>' : '';
  return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${ascii}" w:hAnsi="${ascii}" w:eastAsia="${eastAsia}" w:cs="Times New Roman"/>${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(value || ' ')}</w:t></w:r></w:p>`;
}
function preferenceSummary(preferences = {}) {
  const labels = {
    purpose: { reading: '阅读', subtitle: '字幕', singing: '演唱', polished: '精修' },
    translationApproach: { naturalLyrics: '自然歌词', faithful: '忠实准确', poetic: '更有诗意', concise: '简洁直白' },
    emotionIntensity: { original: '贴近原歌', restrained: '更克制', intense: '更浓烈' },
    delivery: { match: '贴近原行', short: '更短句', smooth: '更顺滑', singable: '更可唱' },
    style: { literal: '直译', natural: '自然', lyrical: '歌词化' },
    faithfulness: { balanced: '均衡', faithful: '更忠实', adaptive: '更灵活' },
    chineseTone: { lyric: '中文歌词感', plain: '清楚直白', poetic: '更有诗意', spoken: '更口语' },
  };
  const approach = preferences.translationApproach
    || (preferences.chineseTone === 'poetic' ? 'poetic' : preferences.faithfulness === 'faithful' ? 'faithful' : preferences.chineseTone === 'plain' ? 'concise' : 'naturalLyrics');
  const delivery = preferences.delivery
    || (preferences.rhythm === 'singable' ? 'singable' : preferences.lineLength === 'short' ? 'short' : (preferences.rhythm === 'smooth' || preferences.lineLength === 'flexible') ? 'smooth' : 'match');
  return [
    labels.purpose[preferences.purpose],
    labels.translationApproach[approach] || labels.style[preferences.style],
    labels.emotionIntensity[preferences.emotionIntensity],
    labels.delivery[delivery] || labels.faithfulness[preferences.faithfulness] || labels.chineseTone[preferences.chineseTone],
  ].filter(Boolean).join(' · ') || '自然歌词';
}
function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const dataBuffer = Buffer.from(data, 'utf8');
    const crc = crc32(dataBuffer);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuffer.length, 18);
    local.writeUInt32LE(dataBuffer.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, dataBuffer);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuffer.length, 20);
    central.writeUInt32LE(dataBuffer.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + dataBuffer.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
