/* 바이브 코딩 저장소 — 여러 공간이 쓰는 작은 서버 (의존성 없음, node:sqlite).
   모임마다 공간이 따로다: /s/{공간}/ 화면, /api/s/{공간}/... 자료.
   로그인은 없다. 첫 화면에서 조직 이름을 치면 찾아 들어간다. 공개(open) 공간은 그걸로 끝이고,
   초대(invite) 공간은 초대 코드(X-Space-Code, 초대 링크 ?k= 에 들어 있음)가 있어야 한다. 글을 고치려면 넣을 때 받은 열쇠,
   담당자는 공간의 담당자 열쇠(X-Admin-Token), 운영자는 OPERATOR_TOKEN 환경변수. 공간은 spaces.mjs 로 만든다. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { db, DB_FILE, EPHEMERAL, snapshot, getSpace, findSpaces, catOf, checkSecret, hashSecret, newCode, CURRICULA, ACCESS, newId, newToken,
  insertRequest as seedRequest,
  rowToRequest, rowToTool, rowToNote, insertRequest, insertTool, insertNote } from './db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CURR_DIR = path.join(ROOT, 'curricula');
const PORT = process.env.PORT || 8790;
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || '';
/* 다른 정적 사이트(예: 수업 자료실)와 한 주소를 같이 쓸 때 — 그 폴더를 주면 / 는 그 사이트의 첫 화면이 되고,
   조직 이름을 넣는 첫 화면은 /s/ 로 간다. 없으면 / 가 곧 조직 이름 화면이다 */
const STATIC_ROOT = process.env.STATIC_ROOT ? path.resolve(process.env.STATIC_ROOT) : '';
const HERE_REL = STATIC_ROOT ? path.relative(STATIC_ROOT, ROOT) : '';   // 서버 폴더는 정적으로 내보내지 않는다
/* 제품 이름 — 정해지면 여기와 저장소.html 의 BRAND 두 곳만 바꾼다 */
const BRAND = '바이브 코딩 저장소';

const MAX_POSTS = 300;           // 공간 하나에 요청글과 도구글을 합쳐서
const MAX_NOTES = 50;            // 글 하나에 달리는 의견
const CAPS = { name: 60, line: 200, url: 500, maker: 40, knobs: 140, ask: 400, round: 40,
  note: 600, by: 40 };
const STATUS = ['ask', 'making'];   // 요청글의 상태. 만들어지면 도구글이 따로 생긴다
const MAX_STDS = 6;
/* 성취기준 코드는 모양만 본다(2국01-01 · 9정통02-03 · 10공국1-01-01). 실재하는지는 화면이 목록과 대조해 거른다 */
const STD_CODE = /^\d{1,2}[가-힣][가-힣0-9]{0,6}-\d{2}(-\d{2})?$/;
const cleanStds = v => Array.isArray(v)
  ? [...new Set(v.map(x => String(x).trim()).filter(x => STD_CODE.test(x)))].slice(0, MAX_STDS)
  : [];

/* ---- 손질: 보이지 않는 글자를 걷어 내고 길이를 자른다 ---- */
const CTRL = /[\u0000-\u001F\u007F]/g;
const isUrl = v => /^https?:\/\/\S+$/i.test(v || '');
const URLMSG = '주소는 https://로 시작해야 합니다. 다른 선생님도 열 수 있어야 합니다.';
const clean = (v, n) => String(v == null ? '' : v).replace(CTRL, ' ').trim().slice(0, n);
/* 의견은 여러 줄로 쓴다. 줄바꿈만 남기고 나머지 보이지 않는 글자는 걷어 낸다. */
const NL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;
const cleanLines = (v, n) => String(v == null ? '' : v)
  .replace(NL, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const cleanAsk = v => Array.isArray(v) ? v.slice(0, 6).map(x => clean(x, CAPS.ask)) : [];

function validateNote(b) {
  const rec = {
    on: clean(b.on, 40),
    by: clean(b.by, CAPS.by),
    text: cleanLines(b.text, CAPS.note),
    slot: Number.isInteger(b.slot) && b.slot >= 0 && b.slot <= 5 ? b.slot : null
  };
  if (!rec.text) return { error: '의견을 적어 주세요.' };
  return { rec };
}

/* 요청글 — 아직 없는 것. 주소가 없다 */
function validateRequest(b) {
  const rec = {
    name: clean(b.name, CAPS.name),
    line: clean(b.line, CAPS.line),
    by: clean(b.by, CAPS.maker),
    round: clean(b.round, CAPS.round),
    use: b.use === 'teacher' ? 'teacher' : 'student',
    cam: !!b.cam,
    status: STATUS.includes(b.status) ? b.status : 'ask',
    ask: cleanAsk(b.ask),
    stds: cleanStds(b.stds),
    category: catOf(b.category),
    needs: 0,
    toolId: ''
  };
  /* 요청은 한 문장(line)이면 된다. 이름이 없으면 그 문장 앞부분으로 */
  if (!rec.line) return { error: '필요한 도구를 한 문장으로 적어 주세요.' };
  if (!rec.name) rec.name = rec.line.length <= 24 ? rec.line : rec.line.slice(0, 24) + '…';
  return { rec };
}

/* 도구글 — 이미 만든 것. 주소가 반드시 있다 */
function validateTool(b) {
  const rec = {
    name: clean(b.name, CAPS.name),
    line: clean(b.line, CAPS.line),
    url: clean(b.url, CAPS.url),
    maker: clean(b.maker, CAPS.maker),
    knobs: clean(b.knobs, CAPS.knobs),
    use: b.use === 'teacher' ? 'teacher' : 'student',
    cam: !!b.cam,
    ask: cleanAsk(b.ask),
    stds: cleanStds(b.stds),
    category: catOf(b.category),
    source: clean(b.source, CAPS.url),
    from: ''
  };
  if (!rec.name) return { error: '도구 이름을 채워 주세요.' };
  if (!rec.line) return { error: '한 줄 설명을 채워 주세요.' };
  if (!isUrl(rec.url)) return { error: URLMSG };
  if (rec.source && !isUrl(rec.source)) return { error: '소스 코드 주소는 https://로 시작해야 합니다.' };
  return { rec };
}

/* ---- 한 주소에서 한 시간에 몇 번까지 ---- */
const hits = new Map();
const needHits = new Map();
const noteHits = new Map();
const codeFails = new Map();
const findHits = new Map();
const reportHits = new Map();
function tooMany(ip, map = hits, cap = 20) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now);
  map.set(ip, list);
  if (map.size > 500) map.clear();
  return list.length > cap;
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
/* 본문은 32KB 까지. 넘으면 연결을 끊지 않고 413 으로 알려 준다 */
const TOO_BIG = Object.assign(new Error('too big'), { status: 413 });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '', over = false;
    req.on('data', c => {
      if (over) return;
      d += c;
      if (d.length > 32 * 1024) { over = true; d = ''; reject(TOO_BIG); }
    });
    req.on('end', () => { if (over) return; try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
/* 큰 글자 응답은 gzip 으로 — 학교망에서 체감이 크다. 같은 내용은 한 번만 압축한다 */
const gzCache = new Map();
function sendText(req, res, status, type, body, extra, key) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Object.assign({ 'Content-Type': type, 'Vary': 'Accept-Encoding' }, extra || {});
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let gz = key && gzCache.get(key);
    if (!gz) { gz = zlib.gzipSync(buf); if (key) { if (gzCache.size > 200) gzCache.clear(); gzCache.set(key, gz); } }
    res.writeHead(status, Object.assign(head, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length }));
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  res.writeHead(status, Object.assign(head, { 'Content-Length': buf.length }));
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/* 내보내는 목록에서는 열쇠를 뺀다 */
const strip = x => { const { token, ...rest } = x; return rest; };
const HIDE_AT = 3;                // 서로 다른 세 사람이 신고하면 숨긴다
function boardView(space, admin) {
  const q = t => db.prepare(`SELECT * FROM ${t} WHERE space = ? ORDER BY at`).all(space);
  const count = new Map(db.prepare('SELECT target, COUNT(*) AS n FROM reports WHERE space = ? GROUP BY target')
    .all(space).map(r => [r.target, r.n]));
  const keep = x => admin || (count.get(x.id) || 0) < HIDE_AT;
  const mark = x => admin && count.get(x.id) ? Object.assign(x, { reports: count.get(x.id) }) : x;
  return { requests: q('requests').map(rowToRequest).filter(keep).map(strip).map(mark),
    tools: q('tools').map(rowToTool).filter(keep).map(strip).map(mark),
    notes: q('notes').map(rowToNote).filter(keep).map(strip).map(mark) };
}
const TABLE = { requests: ['requests', rowToRequest], tools: ['tools', rowToTool] };
const find = (kind, space, id) => {
  const [t, conv] = TABLE[kind];
  const r = db.prepare(`SELECT * FROM ${t} WHERE id = ? AND space = ?`).get(id, space);
  return r && conv(r);
};

/* ---- 누구인가 ---- */
const sameText = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isOperator = req => !!OPERATOR_TOKEN && sameText(String(req.headers['x-admin-token'] || ''), OPERATOR_TOKEN);
/* scrypt 는 느려서, 한 번 맞은 코드는 기억해 둔다. 해시가 열쇠에 들어가 코드를 새로 내면 옛 기억은 저절로 안 맞는다 */
const passed = new Set();
function isMember(req, s) {
  const code = String(req.headers['x-space-code'] || '').trim().toUpperCase();
  if (!code) return false;
  const key = s.id + ':' + s.code_hash + ':' + crypto.createHash('sha256').update(code).digest('hex');
  if (passed.has(key)) return true;
  if (checkSecret(code, s.code_hash)) { passed.add(key); return true; }
  return false;
}
const isAdmin = (req, s) => isOperator(req) || checkSecret(String(req.headers['x-admin-token'] || ''), s.admin_hash);
/* 넣은 사람인지 담당자인지 — 글을 고치거나 지울 수 있는 사람 */
const mayEdit = (req, s, rec, body) =>
  (!!body && !!rec.token && typeof body.token === 'string' && sameText(body.token, rec.token)) || isAdmin(req, s);

/* ---- 정적 ---- */
const LANDING = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${BRAND}</title>
<meta name="description" content="선생님들이 필요한 도구를 요청하고, 만든 도구를 함께 쓰는 곳입니다.">
<meta property="og:title" content="${BRAND}"><meta property="og:description" content="선생님들이 필요한 도구를 요청하고, 만든 도구를 함께 쓰는 곳입니다.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232F6F78'/%3E%3Cpath d='M25 22l-10 10 10 10M39 22l10 10-10 10M35 18l-6 28' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>:root{--bg:#EFECE6;--ink:#1F2226;--mut:#7C838B;--rule:#D5D1C8;--sheet:#FAF8F4;--warn:#B8435A}
@media (prefers-color-scheme:dark){:root{--bg:#14171A;--ink:#EFEDE6;--mut:#8E949A;--rule:#333940;--sheet:#1D2125;--warn:#F492A2}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
word-break:keep-all;padding:64px 16px}main{max-width:520px;margin:0 auto}h1{font-size:28px;margin:0 0 8px}
p{color:var(--mut);margin:0 0 24px}form{display:flex;gap:8px;flex-wrap:wrap}
input{flex:1 1 220px;min-width:0;font:inherit;padding:11px 13px;border:1px solid var(--rule);background:var(--sheet);color:var(--ink)}
button{font:inherit;font-weight:700;padding:11px 18px;border:0;background:var(--ink);color:var(--bg);cursor:pointer}
ul{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
li a{display:flex;justify-content:space-between;gap:12px;padding:12px 14px;background:var(--sheet);border:1px solid var(--rule);
color:var(--ink);text-decoration:none}li a:hover{border-color:var(--ink)}li small{color:var(--mut)}
#msg{margin:14px 0 0;font-size:14px;color:var(--warn)}</style></head>
<body><main><h1>${BRAND}</h1>
<p>선생님들이 필요한 도구를 요청하고, 만든 도구를 함께 쓰는 곳입니다.</p>
<form id="f"><input id="q" placeholder="조직 이름을 입력하세요 (예: 서울서진학교)" aria-label="조직 이름" autocomplete="off" autofocus>
<button>들어가기</button></form><ul id="list"></ul><p id="msg"></p>
<script>
const q = document.getElementById('q'), list = document.getElementById('list'), msg = document.getElementById('msg');
const go = s => { location.href = '/s/' + s.id + '/'; };
const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function find(enter){
  const v = q.value.trim();
  msg.textContent = '';
  if (v.replace(/\\s+/g, '').length < 2) { list.innerHTML = ''; return; }
  const r = await fetch('/api/find?q=' + encodeURIComponent(v)).then(r => r.json()).catch(() => ({spaces: []}));
  const ss = r.spaces || [];
  if (enter && ss.length === 1) return go(ss[0]);
  list.innerHTML = ss.map(s => '<li><a href="/s/' + s.id + '/">' + esc(s.name)
    + (s.invite ? '<small>초대 링크가 있어야 합니다</small>' : s.view ? '<small>둘러보기만</small>' : '') + '</a></li>').join('');
  if (enter && !ss.length) msg.textContent = r.error || '찾는 조직이 없습니다. 이름을 다시 확인해 주세요.';
}
let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => find(false), 250); });
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); find(true); });
</script></main></body></html>`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
/* 정적 파일 — 폴더 밖으로 나가는 경로·숨김 파일·서버 폴더는 막는다. 영상 앞뒤로 넘기기(Range)를 받는다 */
function serveStatic(req, res, p) {
  let rel;
  try { rel = decodeURIComponent(p); } catch { return false; }
  const file = path.resolve(STATIC_ROOT, '.' + rel);
  const inside = path.relative(STATIC_ROOT, file);
  if (inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).some(x => x.startsWith('.'))) return false;
  if (HERE_REL && (inside === HERE_REL || inside.startsWith(HERE_REL + path.sep))) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (st.isDirectory()) {
    if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); res.end(); return true; }
    return serveStatic(req, res, p + 'index.html');
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]);
    let end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return true;
    }
    res.writeHead(206, Object.assign(head, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  /* 글자로 된 파일(html·css·js·json·svg)은 압축해서 */
  if (/^(text\/|application\/json|image\/svg)/.test(type) && st.size < 8e6) {
    sendText(req, res, 200, type, fs.readFileSync(file), { 'Cache-Control': head['Cache-Control'] }, 'static:' + file + ':' + st.mtimeMs);
    return true;
  }
  res.writeHead(200, Object.assign(head, { 'Content-Length': st.size }));
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

/* 저장소에 적어 둔 공간(spaces.json)이 없으면 켜질 때 만든다 — 서버에 들어가지 않고 push 만으로 공간을 연다.
   코드와 열쇠는 로그에 한 번 찍힌다. 담당자 일은 운영자 열쇠(OPERATOR_TOKEN)로도 된다 */
function seedSpaces() {
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(ROOT, 'spaces.json'), 'utf8')); } catch { return; }
  (Array.isArray(list) ? list : []).forEach(x => {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(x.id || '') || !x.name) return;
    /* 이미 있으면 이름과 소개 문구만 적어 둔 대로 맞춘다(코드·자료는 그대로) */
    if (getSpace(x.id)) {
      db.prepare('UPDATE spaces SET name = ?, lede = ? WHERE id = ?').run(x.name, x.lede || '', x.id);
      return;
    }
    const code = newCode(), admin = newToken();
    db.prepare(`INSERT INTO spaces (id, name, lede, curriculum, builtin, code_hash, admin_hash, at, access)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(x.id, x.name, x.lede || '', CURRICULA.includes(x.curriculum) ? x.curriculum : 'common',
      x.builtin ? 1 : 0, hashSecret(code), hashSecret(admin), new Date().toISOString(),
      ACCESS.includes(x.access) ? x.access : 'open');
    /* 둘러보기용 견본 요청 — 한 문장(line)과 분류만 적어 둔다 */
    (Array.isArray(x.requests) ? x.requests : []).forEach((r, i) => seedRequest(x.id, {
      id: x.id + '-r' + i, name: r.name || (r.line.length <= 24 ? r.line : r.line.slice(0, 24) + '…'), line: r.line,
      status: r.status, category: r.category, needs: r.needs || 0, use: r.use, at: new Date(Date.now() - i * 864e5).toISOString() }));
    console.log('공간을 만들었습니다: ' + x.name + ' /s/' + x.id + '/  초대 코드 ' + code + '  담당자 열쇠 ' + admin);
  });
}
seedSpaces();

/* 잘못된 주소 — 날것의 오류 대신 안내 화면. 조직을 다시 찾는 곳으로 보낸다 */
const SPACES_HOME = STATIC_ROOT ? '/s/' : '/';
const NOT_FOUND = (msg) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>찾을 수 없습니다 · ${BRAND}</title>
<style>:root{--bg:#EFECE6;--ink:#1F2226;--mut:#7C838B}
@media (prefers-color-scheme:dark){:root{--bg:#14171A;--ink:#EFEDE6;--mut:#8E949A}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
word-break:keep-all;padding:64px 16px}main{max-width:520px;margin:0 auto}h1{font-size:24px;margin:0 0 8px}
p{color:var(--mut);margin:0 0 24px}a{display:inline-block;font-weight:700;padding:11px 18px;background:var(--ink);color:var(--bg);text-decoration:none}</style></head>
<body><main><h1>${msg}</h1><p>주소를 다시 확인하거나, 조직 이름으로 찾아 들어가 주세요.</p>
<a href="${SPACES_HOME}">조직 찾기</a></main></body></html>`;
const sendNotFound = (res, msg) => {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(NOT_FOUND(msg));
};
const wantsHtml = req => /text\/html/.test(req.headers.accept || '');

/* 공간 화면 — 메신저에 주소를 붙였을 때 학교 이름과 소개가 미리보기로 뜨게 자리표시를 채운다 */
const pageMtime = () => fs.statSync(path.join(PUBLIC, 'index.html')).mtimeMs;
function pageFor(sp) {
  const attr = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replaceAll('__OG_TITLE__', attr(sp.name + ' ' + BRAND))
    .replaceAll('__OG_DESC__', attr(sp.lede || '선생님들이 필요한 도구를 요청하고, 만든 도구를 함께 씁니다.'));
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || '?';
  let m;

  try {
    if (req.method === 'GET' && (STATIC_ROOT ? (p === '/s/' || p === '/s') : p === '/')) {
      if (p === '/s') { res.writeHead(301, { Location: '/s/' }); return res.end(); }
      return sendText(req, res, 200, 'text/html; charset=utf-8', LANDING, { 'Cache-Control': 'no-cache' }, 'landing');
    }
    /* 공간 주소 — 대문자로 쳤거나(/s/SEOJIN) 뒤에 무언가 붙었으면(/s/seojin/extra) 그 공간 첫 화면으로 보낸다 */
    if ((req.method === 'GET' || req.method === 'HEAD') && (m = p.match(/^\/s\/([^/]+)(\/.*)?$/))) {
      let id;
      try { id = decodeURIComponent(m[1]).toLowerCase(); } catch { id = ''; }
      if (!/^[a-z0-9-]{2,40}$/.test(id) || !getSpace(id)) return sendNotFound(res, '찾는 조직이 없습니다');
      if (p !== '/s/' + id + '/') {
        const q = new URL(req.url, 'http://x').search;
        res.writeHead(301, { Location: '/s/' + id + '/' + q }); return res.end();
      }
      return sendText(req, res, 200, 'text/html; charset=utf-8', pageFor(getSpace(id)), { 'Cache-Control': 'no-cache' },
        'page:' + id + ':' + pageMtime());
    }
    if (req.method === 'GET' && (m = p.match(/^\/curricula\/(special|common)\.json$/))) {
      return sendText(req, res, 200, 'application/json; charset=utf-8', fs.readFileSync(path.join(CURR_DIR, m[1] + '.json')),
        { 'Cache-Control': 'public, max-age=3600' }, 'curr:' + m[1]);
    }

    /* 조직 이름으로 찾기 — 첫 화면이 부른다 */
    if (req.method === 'GET' && p === '/api/find') {
      if (tooMany(ip, findHits, 300)) return json(res, 429, { spaces: [], error: '너무 자주 찾았습니다. 잠시 뒤에 다시 해 주세요.' });
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      return json(res, 200, { spaces: findSpaces(q).map(s => ({ id: s.id, name: s.name, invite: s.access === 'invite', view: s.access === 'view' })) });
    }

    if (!(m = p.match(/^\/api\/s\/([a-z0-9-]{2,40})(\/.*)$/))) {
      if (STATIC_ROOT && (req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/') && serveStatic(req, res, p)) return;
      if (!p.startsWith('/api/') && wantsHtml(req)) return sendNotFound(res, '찾는 페이지가 없습니다');
      return json(res, 404, { error: 'not found' });
    }
    const s = getSpace(m[1]);
    if (!s) return json(res, 404, { error: '찾는 조직이 없습니다.' });
    const sub = m[2];

    /* 공간 이름과 교육과정은 코드 없이도 — 화면이 코드를 묻기 전에 누구 공간인지 보여 준다 */
    if (req.method === 'GET' && sub === '/info') {
      return json(res, 200, { id: s.id, name: s.name, lede: s.lede, curriculum: s.curriculum, builtin: !!s.builtin,
        access: s.access, ephemeral: EPHEMERAL });
    }
    /* 통째로 내려받기 — 담당자가 바뀌어도 자료를 옮길 수 있게 */
    if (req.method === 'GET' && sub === '/export') {
      if (!isAdmin(req, s)) return json(res, 403, { error: '담당자 열쇠가 있어야 내려받을 수 있습니다.' });
      return json(res, 200, Object.assign({ at: new Date().toISOString(), space: s.id }, boardView(s.id, true)));
    }

    /* 여기부터는 공개 공간이면 누구나, 초대 공간이면 초대 코드가 있어야 한다. 틀린 코드는 한 주소에서 한 시간에 30번까지 */
    if (s.access === 'invite' && !isMember(req, s) && !isAdmin(req, s)) {
      if (req.headers['x-space-code'] && tooMany(ip, codeFails, 30)) {
        return json(res, 429, { error: '코드를 너무 여러 번 틀렸습니다. 한 시간 뒤에 다시 해 주세요.' });
      }
      return json(res, 401, { error: '초대 링크가 필요합니다.' });
    }

    if (req.method === 'GET' && sub === '/board') return json(res, 200, boardView(s.id, isAdmin(req, s)));
    /* 둘러보기용 공간 — 보기만. 담당자·운영자만 고칠 수 있다 */
    if (s.access === 'view' && !isAdmin(req, s)) {
      return json(res, 403, { error: '둘러보기 전용이라 글을 남길 수 없습니다.' });
    }

    const count = () => db.prepare(`SELECT (SELECT COUNT(*) FROM requests WHERE space = ?)
      + (SELECT COUNT(*) FROM tools WHERE space = ?) AS n`).get(s.id, s.id).n;
    /* 막혔으면 답을 보내고 true */
    const full = () => count() >= MAX_POSTS
      && (json(res, 409, { error: '저장소가 가득 찼습니다. 담당자에게 알려 주세요.' }), true);
    const busy = () => tooMany(ip)
      && (json(res, 429, { error: '너무 자주 올렸습니다. 한 시간 뒤에 다시 해 주세요.' }), true);

    /* 요청글 넣기 */
    if (req.method === 'POST' && sub === '/requests') {
      if (full() || busy()) return;
      const { rec, error } = validateRequest(await readBody(req));
      if (error) return json(res, 400, { error });
      Object.assign(rec, { id: newId('r'), token: newToken(), at: new Date().toISOString() });
      insertRequest(s.id, rec);
      return json(res, 201, { id: rec.id, token: rec.token });
    }

    /* 도구글 넣기 — 이미 만든 것을 바로 올린다 */
    if (req.method === 'POST' && sub === '/tools') {
      if (full() || busy()) return;
      const { rec, error } = validateTool(await readBody(req));
      if (error) return json(res, 400, { error });
      Object.assign(rec, { id: newId('t'), token: newToken(), at: new Date().toISOString() });
      insertTool(s.id, rec);
      return json(res, 201, { id: rec.id, token: rec.token });
    }

    const ID = '([A-Za-z0-9_-]{1,40})';

    /* 만들어 볼게요 — 누구나 요청을 집어 든다. 이름을 남기면 '만드는 중 · 이름'으로 보인다 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/requests/' + ID + '/making$')))) {
      if (busy()) return;
      const body = await readBody(req).catch(() => ({}));
      const r = find('requests', s.id, m[1]);
      if (!r) return json(res, 404, { error: '없는 요청입니다.' });
      if (r.toolId) return json(res, 409, { error: '이미 완성된 요청입니다.' });
      db.prepare(`UPDATE requests SET status = 'making', making_by = ? WHERE id = ?`)
        .run(clean(body.maker, CAPS.maker), r.id);
      return json(res, 200, { ok: true });
    }

    /* 완성해서 올리기 — 누구나. 요청에서 도구글을 새로 만들고 서로 잇는다. 요청은 목록에서 빠진다 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/requests/' + ID + '/done$')))) {
      if (busy()) return;
      const body = await readBody(req).catch(() => ({}));
      const r = find('requests', s.id, m[1]);
      if (!r) return json(res, 404, { error: '없는 요청입니다.' });
      if (r.toolId) return json(res, 409, { error: '이미 완성된 요청입니다.' });
      const { rec, error } = validateTool({ name: r.name, line: r.line, url: body.url, maker: body.maker, source: body.source,
        use: r.use, cam: r.cam, ask: r.ask, stds: r.stds, category: r.category });
      if (error) return json(res, 400, { error: '주소를 먼저 붙여 주세요. ' + error });
      /* 도구의 주인은 올린 사람이다. 요청한 사람이 직접 올렸으면 요청과 같은 열쇠, 다른 사람이면 새 열쇠 */
      const own = !!body.token && !!r.token && body.token === r.token;
      Object.assign(rec, { id: newId('t'), token: own ? r.token : newToken(), from: r.id, at: new Date().toISOString() });
      db.exec('BEGIN');
      try {
        insertTool(s.id, rec);
        db.prepare('UPDATE requests SET tool_id = ? WHERE id = ?').run(rec.id, r.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return json(res, 200, { ok: true, toolId: rec.id, token: own ? undefined : rec.token });
    }

    /* 요청으로 되돌리기 — 엉뚱한 주소로 닫혔을 때. 요청한 사람이나 담당자만.
       도구는 도구 모음에 그대로 두고 요청과의 연결만 끊는다 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/requests/' + ID + '/reopen$')))) {
      const body = await readBody(req).catch(() => ({}));
      const r = find('requests', s.id, m[1]);
      if (!r) return json(res, 404, { error: '없는 요청입니다.' });
      if (!mayEdit(req, s, r, body)) return json(res, 403, { error: '요청한 사람이나 담당자만 되돌릴 수 있습니다.' });
      db.exec('BEGIN');
      try {
        if (r.toolId) db.prepare(`UPDATE tools SET from_req = '' WHERE id = ? AND space = ?`).run(r.toolId, s.id);
        db.prepare(`UPDATE requests SET tool_id = '', status = 'ask', making_by = '' WHERE id = ?`).run(r.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return json(res, 200, { ok: true });
    }

    /* 저도 필요해요 — 요청글에만. 다음에 무엇을 만들지 정하는 근거 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/requests/' + ID + '/need$')))) {
      if (tooMany(ip, needHits, 60)) {
        return json(res, 429, { error: '너무 자주 눌렀습니다. 한 시간 뒤에 다시 해 주세요.' });
      }
      const r = find('requests', s.id, m[1]);
      if (!r) return json(res, 404, { error: '없는 요청입니다.' });
      db.prepare('UPDATE requests SET needs = needs + 1 WHERE id = ?').run(r.id);
      return json(res, 200, { needs: r.needs + 1 });
    }

    /* 요청문 여섯 칸·성취기준 고쳐 쓰기 — 넣은 사람과 담당자만. 반영한 의견에 표시를 남긴다 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/(requests|tools)/' + ID + '/ask$')))) {
      const body = await readBody(req).catch(() => ({}));
      const t = find(m[1], s.id, m[2]);
      if (!t) return json(res, 404, { error: '없는 글입니다.' });
      if (!mayEdit(req, s, t, body)) {
        return json(res, 403, { error: '올린 사람이나 담당자만 고칠 수 있습니다. 의견으로 남기면 올린 사람이 반영합니다.' });
      }
      if (Array.isArray(body.ask)) t.ask = cleanAsk(body.ask);
      if (Array.isArray(body.stds)) t.stds = cleanStds(body.stds);
      if (typeof body.category === 'string') t.category = catOf(body.category);
      if (m[1] === 'tools' && typeof body.source === 'string') {
        const src = clean(body.source, CAPS.url);
        if (src && !isUrl(src)) return json(res, 400, { error: '소스 코드 주소는 https://로 시작해야 합니다.' });
        db.prepare('UPDATE tools SET source = ? WHERE id = ?').run(src, t.id);
      }
      db.prepare(`UPDATE ${m[1]} SET ask = ?, stds = ?, category = ? WHERE id = ?`)
        .run(JSON.stringify(t.ask), JSON.stringify(t.stds), t.category, t.id);
      if (Array.isArray(body.applied)) {
        const on = new Set(body.applied);
        db.prepare('SELECT id FROM notes WHERE space = ? AND on_id IN (?, ?)').all(s.id, t.id, t.from || t.id)
          .forEach(n => db.prepare('UPDATE notes SET applied = ? WHERE id = ?').run(on.has(n.id) ? 1 : 0, n.id));
      }
      return json(res, 200, { ok: true, ask: t.ask, stds: t.stds, category: t.category });
    }

    /* 글 지우기 — 그 글에 달린 의견도 같이 지운다. 도구를 지우면 그 요청은 게시판으로 돌아온다 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/(requests|tools)/' + ID + '/delete$')))) {
      const body = await readBody(req).catch(() => ({}));
      const t = find(m[1], s.id, m[2]);
      if (!t) return json(res, 404, { error: '이미 지워졌습니다.' });
      if (!mayEdit(req, s, t, body)) return json(res, 403, { error: '올린 사람이나 담당자만 지울 수 있습니다.' });
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM ${m[1]} WHERE id = ?`).run(t.id);
        db.prepare(`UPDATE requests SET tool_id = '' WHERE space = ? AND tool_id = ?`).run(s.id, t.id);
        db.prepare(`UPDATE tools SET from_req = '' WHERE space = ? AND from_req = ?`).run(s.id, t.id);
        db.prepare('DELETE FROM notes WHERE space = ? AND on_id = ?').run(s.id, t.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return json(res, 200, { ok: true });
    }

    /* 신고 — 누구나. 한 사람(주소)이 한 글에 한 번. 서로 다른 세 사람이 신고하면 목록에서 숨는다 */
    if (req.method === 'POST' && sub === '/report') {
      if (tooMany(ip, reportHits, 30)) return json(res, 429, { error: '너무 자주 신고했습니다. 잠시 뒤에 다시 해 주세요.' });
      const body = await readBody(req).catch(() => ({}));
      const target = clean(body.target, 40);
      const exists = ['requests', 'tools', 'notes'].some(t =>
        db.prepare(`SELECT 1 FROM ${t} WHERE id = ? AND space = ?`).get(target, s.id));
      if (!exists) return json(res, 404, { error: '없는 글입니다.' });
      const who = crypto.createHash('sha256').update(s.id + ':' + ip).digest('hex').slice(0, 24);
      db.prepare('INSERT OR IGNORE INTO reports (space, target, who, at) VALUES (?,?,?,?)')
        .run(s.id, target, who, new Date().toISOString());
      return json(res, 200, { ok: true });
    }
    /* 신고 풀기 — 담당자만. 괜찮은 글이면 다시 보이게 */
    if (req.method === 'POST' && sub === '/unreport') {
      if (!isAdmin(req, s)) return json(res, 403, { error: '담당자만 신고를 풀 수 있습니다.' });
      const body = await readBody(req).catch(() => ({}));
      db.prepare('DELETE FROM reports WHERE space = ? AND target = ?').run(s.id, clean(body.target, 40));
      return json(res, 200, { ok: true });
    }

    /* 의견 남기기 — 요청글이든 도구글이든. 코드가 있는 선생님은 누구나 쓴다 */
    if (req.method === 'POST' && sub === '/notes') {
      if (tooMany(ip, noteHits, 40)) {
        return json(res, 429, { error: '너무 자주 남겼습니다. 한 시간 뒤에 다시 해 주세요.' });
      }
      const { rec, error } = validateNote(await readBody(req));
      if (error) return json(res, 400, { error });
      if (!find('requests', s.id, rec.on) && !find('tools', s.id, rec.on)) {
        return json(res, 404, { error: '없는 글입니다.' });
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE on_id = ?').get(rec.on).n >= MAX_NOTES) {
        return json(res, 409, { error: '이 글의 의견이 가득 찼습니다. 담당자에게 알려 주세요.' });
      }
      Object.assign(rec, { id: newId('n'), token: newToken(), at: new Date().toISOString(), applied: false });
      insertNote(s.id, rec);
      return json(res, 201, { noteId: rec.id, token: rec.token });
    }

    /* 의견 지우기 — 쓴 사람과 담당자만 */
    if (req.method === 'POST' && (m = sub.match(new RegExp('^/notes/' + ID + '/delete$')))) {
      const body = await readBody(req).catch(() => ({}));
      const n = db.prepare('SELECT * FROM notes WHERE id = ? AND space = ?').get(m[1], s.id);
      if (!n) return json(res, 404, { error: '이미 지워졌습니다.' });
      if (!mayEdit(req, s, rowToNote(n), body)) return json(res, 403, { error: '쓴 사람이나 담당자만 지울 수 있습니다.' });
      db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e && e.status === 413) {
      res.setHeader('Connection', 'close');
      return json(res, 413, { error: '글이 너무 깁니다. 줄여서 다시 올려 주세요.' });
    }
    json(res, 500, { error: '서버가 처리하지 못했습니다.' });
  }
});

server.listen(PORT, () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM spaces').get().n;
  console.log('저장소 서버 http://localhost:' + PORT + '  (자료 ' + DB_FILE + ', 공간 ' + n + '곳)');
  if (EPHEMERAL) {
    console.log('!!! 경고: 볼륨 밖에 저장하고 있습니다. 다시 배포하면 요청·도구·의견이 모두 지워집니다.');
    console.log('!!! Railway 에서 이 서비스에 볼륨을 붙이고(예: /data) 변수 DATA_DIR=/data 를 넣어 주세요.');
  }
  /* 하루 한 장 스냅숏 — 켜질 때 한 번, 그 뒤로 여섯 시간마다 오늘 것이 없으면 남긴다 */
  const snap = () => { try { const f = snapshot(); if (f) console.log('백업: ' + f); } catch (e) { console.log('백업 실패: ' + e.message); } };
  snap();
  setInterval(snap, 6 * 3600e3).unref();
  if (!n) console.log('공간이 아직 없습니다. node spaces.mjs add <주소이름> <공간이름> 으로 만듭니다.');
});
