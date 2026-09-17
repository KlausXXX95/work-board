'use strict';
/* 个人工作看板 · 零依赖后端（node:http + node:sqlite）
 * 启动：node server.js  （默认端口 3210，可用 PORT 环境变量覆盖）
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3210;
const ROOT = __dirname;
/* DB_PATH 环境变量可指定数据库位置，用于"开发库 / 正式库"分离 */
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data.sqlite');
const db = new DatabaseSync(DB_PATH);

/* ---------- 备份：启动时 + 每 24 小时，保留最近 30 份 ---------- */
const BACKUP_DIR = path.join(ROOT, 'backups');
function backup(reason) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const dest = path.join(BACKUP_DIR, 'data-' + stamp + '-' + reason + '.sqlite');
    db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    console.log('已备份数据库 ->', dest);
  } catch (e) {
    console.error('数据库备份失败:', e);
  }
}
backup('boot');
setInterval(() => backup('daily'), 24 * 3600 * 1000);

/* ---------- 迁移：以后改表结构，只往 MIGRATIONS 里追加 ---------- */
const MIGRATIONS = [
  // 示例：{ v: 1, sql: `ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0` },
];
(function migrate() {
  const cur = db.prepare('PRAGMA user_version').get().user_version;
  for (const m of MIGRATIONS) {
    if (m.v > cur) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.exec('PRAGMA user_version = ' + m.v);
        db.exec('COMMIT');
        console.log('数据库已迁移到 v' + m.v);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  }
})();

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS boards(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  board TEXT NOT NULL,
  start TEXT NOT NULL,
  due TEXT NOT NULL,
  urgency TEXT NOT NULL,
  importance TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0
);
`);

const PALETTE_KEYS = ['blue', 'green', 'red', 'gold', 'purple', 'teal', 'gray'];
const URGENCY = ['紧急', '一般', '不紧急'];
const IMPORTANCE = ['重要', '一般', '不重要'];
const STATUS = ['待办', '进行中', '已完成'];
const SESSION_DAYS = 30;

/* ---------- 工具 ---------- */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const todayStr = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function getSessionUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)wb_session=([a-f0-9]{64})/);
  if (!m) return null;
  const row = db.prepare('SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
    .get(m[1], Date.now());
  return row || null;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', 'wb_session=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400);
}
const cleanStr = (v, max) => String(v == null ? '' : v).slice(0, max);

/* ---------- 新用户种子数据 ---------- */
function seedFor(userId) {
  const boards = [
    ['文化体系', 'blue'], ['文宣工作', 'green'], ['活动工作', 'red'], ['其他工作', 'gray'],
  ];
  const ib = db.prepare('INSERT INTO boards(id, user_id, name, color, pos) VALUES(?,?,?,?,?)');
  boards.forEach((b, i) => ib.run(uid(), userId, b[0], b[1], i));
  const t = todayStr();
  const samples = [
    ['季度文化活动策划方案', '活动工作', t, addDays(t, 14), '紧急', '重要', '进行中', '这是示例任务，可以直接编辑或删除。'],
    ['月度文化数据整理', '文宣工作', addDays(t, -3), addDays(t, 4), '一般', '一般', '待办', ''],
    ['新员工文化课课件开发', '文化体系', addDays(t, -20), addDays(t, -5), '一般', '不重要', '已完成', ''],
  ];
  const it = db.prepare('INSERT INTO tasks(id, user_id, title, board, start, due, urgency, importance, status, note, pos) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  samples.forEach((s, i) => it.run(uid(), userId, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], i));
}

/* ---------- 校验 ---------- */
function validTask(raw, i) {
  const t = {
    id: cleanStr(raw.id, 40) || uid(),
    title: cleanStr(raw.title, 200).trim(),
    board: cleanStr(raw.board, 40),
    start: cleanStr(raw.start, 10),
    due: cleanStr(raw.due, 10),
    urgency: cleanStr(raw.urgency, 10),
    importance: cleanStr(raw.importance, 10),
    status: cleanStr(raw.status, 10),
    note: cleanStr(raw.note, 2000),
    pos: i,
  };
  if (!t.title) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.start) || !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) return null;
  if (!URGENCY.includes(t.urgency)) t.urgency = '一般';
  if (!IMPORTANCE.includes(t.importance)) t.importance = '一般';
  if (!STATUS.includes(t.status)) t.status = '待办';
  return t;
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const username = cleanStr(body.username, 20).trim();
      const password = String(body.password || '');
      if (username.length < 2) return sendJson(res, 400, { error: '用户名至少 2 个字符。' });
      if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位。' });
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) return sendJson(res, 409, { error: '该用户名已被注册。' });
      const id = uid();
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users(id, username, salt, hash, created_at) VALUES(?,?,?,?,?)')
        .run(id, username, salt, hashPassword(password, salt), new Date().toISOString());
      seedFor(id);
      createSession(res, id);
      return sendJson(res, 200, { username });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = cleanStr(body.username, 20).trim();
      const password = String(body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const ok = user && crypto.timingSafeEqual(
        Buffer.from(user.hash, 'hex'),
        Buffer.from(hashPassword(password, user.salt), 'hex')
      );
      if (!ok) return sendJson(res, 401, { error: '用户名或密码不正确。' });
      createSession(res, user.id);
      return sendJson(res, 200, { username: user.username });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/(?:^|;\s*)wb_session=([a-f0-9]{64})/);
      if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
      res.setHeader('Set-Cookie', 'wb_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    /* ---------- 静态页面（登录态由页面内的 /api/me 判断） ---------- */
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(html);
      }
      if (p === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(ROOT, 'sw.js')));
      }
      if (p === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest')));
      }
      if (p.startsWith('/icons/') && /^[\w.-]+\.png$/.test(p.slice(7))) {
        const f = path.join(ROOT, 'icons', p.slice(7));
        if (fs.existsSync(f)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
          return res.end(fs.readFileSync(f));
        }
      }
    }

    const me = getSessionUser(req);

    if (p === '/api/me' && req.method === 'GET') {
      if (!me) return sendJson(res, 401, { error: '未登录' });
      return sendJson(res, 200, { username: me.username });
    }

    if (!me) return sendJson(res, 401, { error: '未登录' });

    if (p === '/api/state' && req.method === 'GET') {
      const boards = db.prepare('SELECT id, name, color FROM boards WHERE user_id = ? ORDER BY pos').all(me.user_id);
      const tasks = db.prepare('SELECT id, title, board, start, due, urgency, importance, status, note FROM tasks WHERE user_id = ? ORDER BY pos').all(me.user_id);
      return sendJson(res, 200, { username: me.username, boards, tasks });
    }

    if (p === '/api/tasks' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body) || body.length > 2000) return sendJson(res, 400, { error: '数据格式不正确。' });
      const items = body.map(validTask).filter(Boolean);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM tasks WHERE user_id = ?').run(me.user_id);
        const ins = db.prepare('INSERT INTO tasks(id, user_id, title, board, start, due, urgency, importance, status, note, pos) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        items.forEach(t => ins.run(t.id, me.user_id, t.title, t.board, t.start, t.due, t.urgency, t.importance, t.status, t.note, t.pos));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sendJson(res, 200, { ok: true, count: items.length });
    }

    if (p === '/api/boards' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body) || body.length < 1 || body.length > 50) return sendJson(res, 400, { error: '至少保留一个板块。' });
      const items = [];
      const seen = new Set();
      for (let i = 0; i < body.length; i++) {
        const name = cleanStr(body[i] && body[i].name, 20).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const color = PALETTE_KEYS.includes(body[i].color) ? body[i].color : 'gray';
        items.push({ id: cleanStr(body[i].id, 40) || uid(), name, color, pos: items.length });
      }
      if (!items.length) return sendJson(res, 400, { error: '至少保留一个板块。' });
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM boards WHERE user_id = ?').run(me.user_id);
        const ins = db.prepare('INSERT INTO boards(id, user_id, name, color, pos) VALUES(?,?,?,?,?)');
        items.forEach(b => ins.run(b.id, me.user_id, b.name, b.color, b.pos));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sendJson(res, 200, { ok: true, boards: items });
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log('工作看板已启动: http://localhost:' + PORT);
});
