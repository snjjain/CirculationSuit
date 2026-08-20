'use strict';

/**
 * telegram.js — Telegram bot integration (free, no external services)
 *
 * Executives link themselves ONCE: open the bot in Telegram → /start →
 * "Share my number" button → chat_id is stored against their mobile.
 * After that the dashboard can send them visit plans / alerts by mobile.
 *
 * .env:
 *   TELEGRAM_BOT_TOKEN=123456:ABC...   (from @BotFather)
 *   TELEGRAM_POLL=0                    (optional — disable polling on extra
 *                                       instances; only ONE server may poll)
 *
 * Table: telegram_users (chat_id PK, mobile, tg_name, emp_code, linked_at)
 */

module.exports = function ({ app, q }) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const API   = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';
  let botUsername = null;

  q(`CREATE TABLE IF NOT EXISTS telegram_users (
      chat_id    BIGINT PRIMARY KEY,
      mobile     VARCHAR(15),
      tg_name    VARCHAR(150),
      emp_code   VARCHAR(20),
      linked_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_send_at DATETIME NULL,
      KEY idx_mobile (mobile),
      KEY idx_emp (emp_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => console.error('[tg] table init:', e.message));

  const norm = m => String(m || '').replace(/\D/g, '').slice(-10);

  async function tg(method, payload, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: ctrl.signal,
      });
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function sendTG(chatId, text) {
    return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // ── Long-poll loop (getUpdates) — free, works behind NAT, no webhook ──────
  let offset = 0, polling = false;
  async function pollLoop() {
    if (polling) return; polling = true;
    console.log('[tg] bot polling started');
    while (true) {
      try {
        const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000);
        if (!r.ok) { await new Promise(s => setTimeout(s, 5000)); continue; }
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg) continue;
          const chatId = msg.chat.id;
          const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').slice(0, 150);

          if (msg.contact && msg.contact.phone_number) {
            // Only accept the user's OWN contact (Telegram sets user_id on own contact)
            if (msg.contact.user_id && msg.contact.user_id !== msg.from.id) {
              await sendTG(chatId, '⚠ Please share <b>your own</b> number using the button below.');
              continue;
            }
            const mobile = norm(msg.contact.phone_number);
            await q(
              `INSERT INTO telegram_users (chat_id, mobile, tg_name) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE mobile=VALUES(mobile), tg_name=VALUES(tg_name)`,
              [chatId, mobile, name]
            );
            await tg('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `✅ <b>Number linked:</b> ${mobile}\n\nआपका Telegram अब Patrika Vitran Suite से जुड़ गया है।\nआपके visit plans और alerts अब यहाँ मिलेंगे। 🗞`,
              reply_markup: { remove_keyboard: true },
            });
            console.log(`[tg] linked ${mobile} -> chat ${chatId} (${name})`);
          } else if ((msg.text || '').startsWith('/start')) {
            await tg('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `नमस्ते ${name || ''}! 🙏\n\nयह <b>Patrika Vitran Suite</b> का bot है — यहाँ आपको अपने daily visit plans और alerts मिलेंगे।\n\nजुड़ने के लिए नीचे का बटन दबाकर अपना mobile number share करें 👇`,
              reply_markup: { keyboard: [[{ text: '📱 Share my number / नंबर भेजें', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
            });
          } else {
            await sendTG(chatId, 'ℹ Visit plans आपको automatic मिलेंगे. दोबारा link करने के लिए /start भेजें.');
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.error('[tg] poll error:', e.message);
        await new Promise(s => setTimeout(s, 5000));
      }
    }
  }

  if (TOKEN && process.env.TELEGRAM_POLL !== '0') {
    tg('getMe', {}).then(r => {
      if (r.ok) { botUsername = r.result.username; console.log(`[tg] bot @${botUsername} ready`); pollLoop(); }
      else console.error('[tg] getMe failed — check TELEGRAM_BOT_TOKEN:', r.description);
    }).catch(e => console.error('[tg] getMe:', e.message));
  }

  // ── GET /api/telegram/status — is the bot configured, and its username ────
  app.get('/api/telegram/status', async (req, res) => {
    if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
    res.json({ enabled: !!TOKEN, bot_username: botUsername });
  });

  // ── GET /api/telegram/resolve?emp_code=&name= — best-effort mobile prefill ─
  app.get('/api/telegram/resolve', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const empCode = String(req.query.emp_code || '').trim();
      const name    = String(req.query.name || '').trim();
      let mobile = '', linked = false, source = '';

      if (empCode) {
        const { rows } = await q(`SELECT mobile FROM telegram_users WHERE emp_code = ? LIMIT 1`, [empCode]);
        if (rows.length) { mobile = rows[0].mobile; linked = true; source = 'telegram_link'; }
      }
      if (!mobile && name) {
        // DCR exec names and app_users names come from the same HR master — match by name
        const { rows } = await q(
          `SELECT mobile FROM app_users WHERE UPPER(TRIM(name)) = UPPER(?) AND mobile IS NOT NULL AND mobile != '' LIMIT 1`,
          [name]
        );
        if (rows.length) { mobile = norm(rows[0].mobile); source = 'app_users_name'; }
      }
      if (mobile && !linked) {
        const { rows } = await q(`SELECT chat_id FROM telegram_users WHERE mobile = ? LIMIT 1`, [mobile]);
        linked = rows.length > 0;
      }
      res.json({ mobile, linked, source, bot_username: botUsername, enabled: !!TOKEN });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/telegram/send — send text to a linked mobile ────────────────
  app.post('/api/telegram/send', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      if (!TOKEN) return res.status(503).json({ detail: 'TELEGRAM_BOT_TOKEN not configured' });
      const { mobile, text, emp_code } = req.body || {};
      const mob = norm(mobile);
      if (!mob || mob.length !== 10) return res.status(400).json({ detail: 'Valid 10-digit mobile required' });
      if (!text || !String(text).trim()) return res.status(400).json({ detail: 'text required' });

      const { rows } = await q(`SELECT chat_id FROM telegram_users WHERE mobile = ? LIMIT 1`, [mob]);
      if (!rows.length) {
        return res.status(404).json({ detail: 'not_linked', bot_username: botUsername });
      }
      const r = await sendTG(rows[0].chat_id, String(text).slice(0, 4000));
      if (!r.ok) return res.status(502).json({ detail: 'Telegram send failed: ' + (r.description || 'unknown') });

      await q(
        `UPDATE telegram_users SET last_send_at = NOW()${emp_code ? ', emp_code = ?' : ''} WHERE chat_id = ?`,
        emp_code ? [String(emp_code), rows[0].chat_id] : [rows[0].chat_id]
      ).catch(() => {});
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
