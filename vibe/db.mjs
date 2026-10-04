/* 저장소 플랫폼의 저장 — SQLite 파일 한 장(node:sqlite, 의존성 없음).
   서버(server.mjs)와 운영자 명령(spaces.mjs)이 같이 쓴다.
   모든 글은 공간에 속한다. 공간 코드(교사들이 나눠 갖는 입장 암호)와 담당자 열쇠는 소금 친 해시로만 둔다. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const DB_FILE = path.join(DATA_DIR, 'shelf.db');
export const CURRICULA = ['common', 'special', 'none'];   // 2022 개정 공통 교육과정 · 특수교육 기본 교육과정 · 쓰지 않음

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, lede TEXT NOT NULL DEFAULT '',
    curriculum TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0,
    code_hash TEXT NOT NULL, admin_hash TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT, line TEXT, by TEXT, round TEXT,
    use TEXT, cam INTEGER, status TEXT, ask TEXT, stds TEXT, needs INTEGER DEFAULT 0,
    tool_id TEXT DEFAULT '', token TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT, line TEXT, url TEXT, maker TEXT,
    knobs TEXT, use TEXT, cam INTEGER, ask TEXT, stds TEXT, from_req TEXT DEFAULT '',
    token TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, space TEXT NOT NULL, on_id TEXT NOT NULL, by TEXT, text TEXT,
    slot INTEGER, applied INTEGER DEFAULT 0, token TEXT, at TEXT);
  CREATE INDEX IF NOT EXISTS requests_space ON requests(space);
  CREATE INDEX IF NOT EXISTS tools_space ON tools(space);
  CREATE INDEX IF NOT EXISTS notes_space ON notes(space);
`);
/* 들어오는 방식 — open: 조직 이름만 알면 누구나 · invite: 초대 링크(코드가 든 주소)가 있어야.
   먼저 만든 파일에는 이 칸이 없어 한 번 붙인다 */
if (!db.prepare('PRAGMA table_info(spaces)').all().some(c => c.name === 'access')) {
  db.exec(`ALTER TABLE spaces ADD COLUMN access TEXT NOT NULL DEFAULT 'open'`);
}
/* open: 조직 이름만 알면 누구나 · invite: 초대 링크가 있어야 · view: 누구나 보기만(둘러보기용 예시 공간) */
export const ACCESS = ['open', 'invite', 'view'];
/* 바이브 코딩으로 만드는 것의 분류 — 화면(저장소.html 의 CATEGORIES)과 같아야 한다. 모르는 값은 '기타' */
export const CATEGORIES = ['수업 활동', '게임·놀이', '표현·미디어아트', '연습·익히기', '수업 준비', '기록·학급 운영', '기타'];
export const catOf = v => CATEGORIES.includes(v) ? v : '기타';
for (const t of ['requests', 'tools']) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'category')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN category TEXT NOT NULL DEFAULT '기타'`);
  }
}
/* 이름으로 찾기 — 띄어쓰기와 대소문자를 무시하고, 앞뒤를 줄여 쳐도("서진학교" → "서울서진학교") 찾는다 */
export const normName = v => String(v || '').replace(/\s+/g, '').toLowerCase();
export function findSpaces(q) {
  const n = normName(q);
  if (n.length < 2) return [];
  const all = db.prepare('SELECT id, name, access FROM spaces').all();
  const exact = all.filter(s => normName(s.name) === n || s.id === n);
  return (exact.length ? exact : all.filter(s => normName(s.name).includes(n))).slice(0, 8);
}

/* ---- 비밀 ---- */
export function hashSecret(v) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(String(v), salt, 32).toString('hex');
}
export function checkSecret(v, stored) {
  if (!v || !stored) return false;
  const [salt, hex] = stored.split(':');
  const a = crypto.scryptSync(String(v), salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* 공간 코드는 교사가 입으로 전하니 헷갈리는 글자(0·O·1·I·L)를 뺀다 */
export function newCode(n = 8) {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(n)].map(b => abc[b % abc.length]).join('');
}
export const newToken = () => crypto.randomBytes(12).toString('hex');
export const newId = pre => pre + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

/* ---- 행 ↔ 글 ---- */
const arr = v => { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
export const rowToRequest = r => ({ id: r.id, name: r.name, line: r.line, by: r.by, round: r.round,
  use: r.use, cam: !!r.cam, status: r.status, ask: arr(r.ask), stds: arr(r.stds), needs: r.needs || 0,
  toolId: r.tool_id || '', category: catOf(r.category), token: r.token, at: r.at });
export const rowToTool = r => ({ id: r.id, name: r.name, line: r.line, url: r.url, maker: r.maker,
  knobs: r.knobs, use: r.use, cam: !!r.cam, ask: arr(r.ask), stds: arr(r.stds), from: r.from_req || '',
  category: catOf(r.category), token: r.token, at: r.at });
export const rowToNote = r => ({ id: r.id, on: r.on_id, by: r.by, text: r.text, slot: r.slot,
  applied: !!r.applied, token: r.token, at: r.at });

/* 옛 자료에는 빠진 칸이 있다 — SQLite 는 undefined 를 받지 않는다 */
const str = v => v == null ? '' : String(v);
const useOf = v => v === 'teacher' ? 'teacher' : 'student';

export function insertRequest(space, x) {
  db.prepare(`INSERT INTO requests (id, space, name, line, by, round, use, cam, status, ask, stds, needs, tool_id, token, at, category)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(x.id, space, str(x.name), str(x.line), str(x.by), str(x.round),
    useOf(x.use), x.cam ? 1 : 0, x.status === 'making' ? 'making' : 'ask', JSON.stringify(x.ask || []), JSON.stringify(x.stds || []),
    x.needs || 0, str(x.toolId), str(x.token), str(x.at), catOf(x.category));
}
export function insertTool(space, x) {
  db.prepare(`INSERT INTO tools (id, space, name, line, url, maker, knobs, use, cam, ask, stds, from_req, token, at, category)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(x.id, space, str(x.name), str(x.line), str(x.url), str(x.maker),
    str(x.knobs), useOf(x.use), x.cam ? 1 : 0, JSON.stringify(x.ask || []), JSON.stringify(x.stds || []),
    str(x.from), str(x.token), str(x.at), catOf(x.category));
}
export function insertNote(space, x) {
  db.prepare(`INSERT INTO notes (id, space, on_id, by, text, slot, applied, token, at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(x.id, space, str(x.on), str(x.by), str(x.text),
    Number.isInteger(x.slot) ? x.slot : null, x.applied ? 1 : 0, str(x.token), str(x.at));
}

export const getSpace = id => db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);

/* 옛 단일 학교 자료(board.json 의 {requests, tools, notes}, 또는 더 옛날 tools.json 배열) → 한 공간으로.
   트랜잭션은 부르는 쪽이 연다(공간 만들기와 한 묶음이어야 해서) */
export function importLegacy(space, data) {
  const d = Array.isArray(data) ? migrateV1(data) : data;
  (d.requests || []).forEach(x => insertRequest(space, x));
  (d.tools || []).forEach(x => insertTool(space, x));
  (d.notes || []).forEach(x => insertNote(space, x));
  return { requests: (d.requests || []).length, tools: (d.tools || []).length, notes: (d.notes || []).length };
}
function migrateV1(old) {
  const out = { requests: [], tools: [], notes: [] };
  old.forEach(t => {
    (t.notes || []).forEach(n => out.notes.push(Object.assign({}, n, { on: t.id })));
    const base = { id: t.id, name: t.name, line: t.line, use: t.use, cam: !!t.cam,
      stds: t.stds || [], ask: t.ask || [], token: t.token, at: t.at };
    if ((t.state || 'done') === 'done') {
      out.tools.push(Object.assign(base, { url: t.url, maker: t.maker || '', knobs: t.knobs || '', from: '' }));
    } else {
      const ask = base.ask.slice();
      if (t.knobs && !ask[3]) ask[3] = t.knobs;   // 요청에는 교사 설정 칸이 없다 — 조건 칸으로
      out.requests.push(Object.assign(base, { ask, by: t.maker || '', round: t.round || '',
        needs: t.needs || 0, status: t.state, toolId: '' }));
    }
  });
  return out;
}
