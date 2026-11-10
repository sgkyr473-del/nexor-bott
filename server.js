// سازنده: محمد متین ارامتن
// ربات روبیکا: جوین اجباری + ارسال متن | Node.js 18+ | بدون نیاز به نصب پکیج
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PASS = process.env.PANEL_PASSWORD || crypto.randomBytes(4).toString('hex');
const CFG_FILE = path.join(__dirname, 'config.json');

let cfg = {
  token: '',
  channelGuid: '',
  channelLink: '',
  startMsg: 'سلام 👋 خوش اومدی!',
  joinMsg: 'برای دریافت متن، اول باید داخل کانال عضو بشی 👇',
  notJoinedMsg: 'هنوز عضو کانال نشدی ❗️ لطفاً اول عضو شو، بعد دکمه رو بزن.',
  content: 'اینجا متنی که می‌خوای بعد از عضویت به کاربر داده بشه رو بنویس.',
  btnText: '✅ عضو شدم',
  running: false,
};
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}
const save = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));

const stats = { users: new Set(), delivered: 0, lastError: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, data, token = cfg.token) {
  const res = await fetch(`https://botapi.rubika.ir/v3/${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });
  return res.json();
}

async function memberRaw(userId) {
  return api('getChatMember', { chat_id: cfg.channelGuid, user_id: userId });
}

async function isMember(userId) {
  const r = await memberRaw(userId);
  if (r.status !== 'OK') throw new Error('getChatMember: ' + JSON.stringify(r));
  const s = JSON.stringify(r).toLowerCase();
  return !/(left|kicked|banned|removed|not.?member|none)/.test(s);
}

const keypad = () => ({
  rows: [{ buttons: [{ id: 'check_join', type: 'Simple', button_text: cfg.btnText }] }],
});

async function send(chat_id, text, withBtn) {
  const body = { chat_id, text };
  if (withBtn) body.inline_keypad = keypad();
  return api('sendMessage', body);
}

async function handle(u) {
  const msg = u.new_message;
  const inl = u.inline_message;
  const chat = u.chat_id || (msg && msg.chat_id) || (inl && inl.chat_id);
  if (!chat) return;
  if (msg && msg.sender_type && msg.sender_type !== 'User') return;
  if (!msg && !inl) return;
  const userId = (inl && inl.sender_id) || (msg && msg.sender_id) || chat;
  const text = ((msg && msg.text) || '').trim();
  const isButton = !!inl;
  stats.users.add(userId);

  if (!cfg.channelGuid) {
    await send(chat, cfg.content);
    stats.delivered++;
    return;
  }

  let joined = false;
  try { joined = await isMember(userId); }
  catch (e) { stats.lastError = String(e.message || e); }

  if (joined) {
    await send(chat, cfg.content);
    stats.delivered++;
    return;
  }
  const link = cfg.channelLink ? '\n\n' + cfg.channelLink : '';
  if (isButton || text === cfg.btnText.replace('✅ ', '') || text === 'عضو شدم') {
    await send(chat, cfg.notJoinedMsg + link, true);
  } else {
    await send(chat, cfg.startMsg + '\n\n' + cfg.joinMsg + link, true);
  }
}

let offset = null;
let loopId = 0;
async function loop(id) {
  while (cfg.running && id === loopId) {
    try {
      const r = await api('getUpdates', { offset_id: offset || undefined, limit: 50 });
      if (r.status === 'OK') {
        const d = r.data || {};
        if (d.next_offset_id) offset = d.next_offset_id;
        for (const u of d.updates || []) {
          try { await handle(u); } catch (e) { stats.lastError = String(e.message || e); }
        }
      } else {
        stats.lastError = JSON.stringify(r);
        await sleep(3000);
      }
    } catch (e) {
      stats.lastError = String(e.message || e);
      await sleep(3000);
    }
    await sleep(1000);
  }
}
function restart() {
  loopId++;
  if (cfg.running && cfg.token) loop(loopId);
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((ok) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
  });

http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'panel.html')));
  }
  if (!req.url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (req.headers['x-pass'] !== PASS) return json(res, 401, { error: 'رمز پنل اشتباهه' });

  try {
    if (req.url === '/api/config' && req.method === 'GET') {
      return json(res, 200, { cfg, users: stats.users.size, delivered: stats.delivered, lastError: stats.lastError });
    }
    if (req.url === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      for (const k of ['token', 'channelGuid', 'channelLink', 'startMsg', 'joinMsg', 'notJoinedMsg', 'content', 'btnText']) {
        if (typeof b[k] === 'string') cfg[k] = b[k].trim();
      }
      if (typeof b.running === 'boolean') cfg.running = b.running;
      save(); restart();
      return json(res, 200, { ok: true });
    }
    if (req.url === '/api/test-token' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await api('getMe', {}, (b.token || cfg.token || '').trim()));
    }
    if (req.url === '/api/test-member' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await memberRaw((b.userId || '').trim()));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => {
  console.log('Panel: http://localhost:' + PORT);
  console.log('Panel password:', PASS, process.env.PANEL_PASSWORD ? '' : '(random - set PANEL_PASSWORD to keep it fixed)');
  restart();
});
