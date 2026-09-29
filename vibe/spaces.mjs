/* 운영자 명령 — 공간을 만들고 코드를 다시 낸다. 가입 화면이 없어서 공간은 운영자만 만든다.
   node spaces.mjs add <주소이름> <조직이름> [--invite] [--curriculum common|special|none] [--lede 한줄] [--builtin] [--import 파일]
   node spaces.mjs list
   node spaces.mjs access <주소이름> open|invite   들어오는 방식 바꾸기
   node spaces.mjs code <주소이름>     초대 코드를 새로 낸다(옛 초대 링크는 바로 막힌다)
   node spaces.mjs admin <주소이름>    담당자 열쇠를 새로 낸다
   open 은 조직 이름만 치면 누구나 들어온다. invite 는 초대 링크(코드가 든 주소)가 있어야 한다.
   코드와 열쇠는 해시로만 남으니 화면에 나온 것을 그 자리에서 전해 주어야 한다.
   초대 링크의 앞부분은 PUBLIC_URL 환경변수(기본 http://localhost:8790). */
import fs from 'node:fs';
import { db, getSpace, hashSecret, newCode, newToken, importLegacy, CURRICULA, ACCESS, normName } from './db.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf('--' + k); return i < 0 ? null : (rest[i + 1] || ''); };
const has = k => rest.includes('--' + k);
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const die = m => { console.error(m); process.exit(1); };
const BASE = (process.env.PUBLIC_URL || 'http://localhost:8790').replace(/\/$/, '');
const invite = (id, code) => BASE + '/s/' + id + '/?k=' + code;
const showCode = (id, access, code) => console.log(access === 'invite'
  ? '초대 링크   ' + invite(id, code) + '   ← 선생님들에게 (한 번 누르면 브라우저가 기억)'
  : '들어오기    조직 이름만 치면 됩니다. 나중에 초대로 바꾸면 쓸 코드: ' + code);

if (cmd === 'add') {
  const [id, name] = rest;
  if (!SLUG.test(id || '')) die('주소이름은 영문 소문자·숫자·- 로 2~40자입니다. 예: seojin');
  if (!name || name.startsWith('--')) die('조직 이름을 적어 주세요.');
  if (db.prepare('SELECT name FROM spaces').all().some(r => normName(r.name) === normName(name))) {
    die('같은 이름의 조직이 이미 있습니다. 이름으로 찾아 들어오므로 이름이 겹치면 안 됩니다: ' + name);
  }
  const access = has('invite') ? 'invite' : 'open';
  if (getSpace(id)) die('이미 있는 주소이름입니다: ' + id);
  const curriculum = opt('curriculum') || 'common';
  if (!CURRICULA.includes(curriculum)) die('교육과정은 ' + CURRICULA.join(' · ') + ' 중 하나입니다.');
  const file = opt('import');
  let legacy = null;   // 못 읽으면 공간도 안 만든다
  if (file) { try { legacy = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('옮길 파일을 읽지 못했습니다: ' + e.message); } }
  const code = newCode(), admin = newToken();
  let moved = null;
  /* 공간 만들기와 옛 자료 옮기기는 한 묶음 — 옮기다 틀리면 공간도 남지 않는다 */
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO spaces (id, name, lede, curriculum, builtin, code_hash, admin_hash, at, access)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, opt('lede') || '', curriculum, has('builtin') ? 1 : 0,
      hashSecret(code), hashSecret(admin), new Date().toISOString(), access);
    if (legacy) moved = importLegacy(id, legacy);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); die('만들지 못했습니다: ' + e.message); }
  console.log('만들었습니다: ' + name + '  /s/' + id + '/  (' + curriculum + ', ' + (access === 'open' ? '공개' : '초대') + ')');
  if (moved) console.log('옮겼습니다:', moved);
  showCode(id, access, code);
  console.log('담당자 열쇠 ' + admin + '   ← 담당자 한 분에게만 (주소 끝에 #admin)');
} else if (cmd === 'list') {
  const rows = db.prepare(`SELECT s.id, s.name, s.curriculum, s.access,
      (SELECT COUNT(*) FROM requests r WHERE r.space = s.id AND r.tool_id = '') AS reqs,
      (SELECT COUNT(*) FROM tools t WHERE t.space = s.id) AS tools
    FROM spaces s ORDER BY s.at`).all();
  rows.forEach(r => console.log(r.id.padEnd(16) + r.name + '  ' + r.curriculum + '  ' + (r.access === 'open' ? '공개' : '초대') + '  요청 ' + r.reqs + ' · 도구 ' + r.tools));
  if (!rows.length) console.log('아직 공간이 없습니다.');
} else if (cmd === 'access') {
  const [id, a] = rest;
  if (!getSpace(id)) die('없는 공간입니다: ' + id);
  if (!ACCESS.includes(a)) die('open(조직 이름만으로) 또는 invite(초대 링크) 중 하나입니다.');
  db.prepare('UPDATE spaces SET access = ? WHERE id = ?').run(a, id);
  console.log(a === 'open' ? '이제 조직 이름만 치면 누구나 들어옵니다.'
    : '이제 초대 링크가 있어야 들어옵니다. node spaces.mjs code ' + id + ' 로 새 초대 링크를 내어 전해 주세요.');
} else if (cmd === 'code' || cmd === 'admin') {
  const id = rest[0];
  if (!getSpace(id)) die('없는 공간입니다: ' + id);
  const v = cmd === 'code' ? newCode() : newToken();
  db.prepare(`UPDATE spaces SET ${cmd === 'code' ? 'code_hash' : 'admin_hash'} = ? WHERE id = ?`).run(hashSecret(v), id);
  if (cmd === 'code') showCode(id, getSpace(id).access, v);
  else console.log('새 담당자 열쇠 ' + v);
} else {
  die('쓰는 법: node spaces.mjs add|list|code|admin  (파일 맨 위 설명 참조)');
}
