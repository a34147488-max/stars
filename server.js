const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 8080;
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
const PACKAGES = {
  50: { coins: 500, title: 'Стартовый пакет — 500 звёзд', stars: 50 },
  75: { coins: 900, title: 'Бронзовый пакет — 900 звёзд', stars: 75 },
  100: { coins: 1200, title: 'Серебряный пакет — 1200 звёзд', stars: 100 },
  159: { coins: 1459, title: 'Золотой пакет — 1459 звёзд', stars: 159 },
  200: { coins: 2199, title: 'Платиновый пакет — 2199 звёзд', stars: 200 },
  500: { coins: 8999, title: 'Алмазный пакет — 8999 звёзд', stars: 500 }
};
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 5 }) : null;
let dbReady = false;
async function ensureDb() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (dbReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stars_users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, balance BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_payments (telegram_payment_charge_id TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, package_stars INTEGER NOT NULL, coins BIGINT NOT NULL, currency TEXT NOT NULL, total_amount INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  dbReady = true;
}
function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData), hash = params.get('hash'), authDate = Number(params.get('auth_date'));
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const user = JSON.parse(params.get('user') || '{}'); return user.id ? user : null; } catch (_) { return null; }
}
async function telegramApi(method, body) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not configured');
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram API error');
  return data.result;
}
app.get('/health', (_req, res) => res.status(200).json({ ok: true, databaseConfigured: Boolean(pool) }));
app.post('/api/payments/create-invoice', async (req, res) => {
  try {
    await ensureDb();
    const user = validateTelegramInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN);
    if (!user) return res.status(401).json({ ok: false, error: 'Не удалось подтвердить Telegram-профиль. Перезапусти приложение из бота.' });
    const pack = PACKAGES[Number(req.body && req.body.stars)];
    if (!pack) return res.status(400).json({ ok: false, error: 'Неизвестный пакет пополнения.' });
    await pool.query('INSERT INTO stars_users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()', [String(user.id), user.username || null, user.first_name || null]);
    const payload = JSON.stringify({ userId: String(user.id), stars: pack.stars, coins: pack.coins, nonce: crypto.randomBytes(16).toString('hex') });
    const url = await telegramApi('createInvoiceLink', { title: pack.title, description: 'Пополнение игрового баланса на ' + pack.coins + ' звёзд.', payload, currency: 'XTR', prices: [{ label: pack.title, amount: pack.stars }] });
    return res.json({ ok: true, url, package: { stars: pack.stars, coins: pack.coins } });
  } catch (e) {
    console.error('Invoice creation error:', e.message);
    return res.status(503).json({ ok: false, error: e.message === 'DATABASE_URL is not configured' ? 'Не настроена база данных для баланса (DATABASE_URL).' : 'Не удалось создать счёт Telegram Stars. Проверь настройки сервера и попробуй снова.' });
  }
});
app.get('/api/balance', async (req, res) => {
  try {
    await ensureDb();
    const user = validateTelegramInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN);
    if (!user) return res.status(401).json({ ok: false, error: 'Telegram-профиль не подтверждён.' });
    await pool.query('INSERT INTO stars_users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO NOTHING', [String(user.id), user.username || null, user.first_name || null]);
    const result = await pool.query('SELECT balance FROM stars_users WHERE telegram_id=$1', [String(user.id)]);
    return res.json({ ok: true, balance: Number(result.rows[0]?.balance || 0) });
  } catch (e) { console.error('Balance read error:', e.message); return res.status(503).json({ ok: false, error: 'Не удалось загрузить баланс.' }); }
});
app.post('/api/telegram/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(403);
  const update = req.body || {};
  try {
    await ensureDb();
    if (update.message && /^\/start(?:@\w+)?(?:\s|$)/i.test(String(update.message.text || ''))) {
      const chatId = update.message.chat?.id;
      if (chatId) {
        const appUrl = (process.env.WEB_APP_URL || process.env.WEBHOOK_URL || '').replace(/\/$/, '');
        if (!appUrl || !/^https:\/\//i.test(appUrl)) throw new Error('WEB_APP_URL must be an HTTPS URL');
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: 'Добро пожаловать в Stars! Открой приложение, чтобы посмотреть баланс, копить игровые звёзды и пополнять его настоящими Telegram Stars.',
          reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: appUrl } }]] }
        });
      }
      return res.sendStatus(200);
    }
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let valid = false;
      try { const payload = JSON.parse(q.invoice_payload || '{}'), pack = PACKAGES[Number(payload.stars)]; valid = Boolean(pack && String(q.from?.id) === String(payload.userId) && q.currency === 'XTR' && q.total_amount === pack.stars && Number(payload.coins) === pack.coins); } catch (_) {}
      await telegramApi('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: valid, ...(!valid ? { error_message: 'Счёт недействителен. Создай новый счёт.' } : {}) });
      return res.sendStatus(200);
    }
    const payment = update.message?.successful_payment;
    if (!payment) return res.sendStatus(200);
    const sender = update.message.from, payload = JSON.parse(payment.invoice_payload || '{}'), pack = PACKAGES[Number(payload.stars)];
    if (!pack || String(sender?.id) !== String(payload.userId) || payment.currency !== 'XTR' || payment.total_amount !== pack.stars || Number(payload.coins) !== pack.coins || !payment.telegram_payment_charge_id) { console.error('Rejected mismatched successful_payment update'); return res.sendStatus(200); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO stars_users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO NOTHING', [String(sender.id), sender.username || null, sender.first_name || null]);
      const inserted = await client.query('INSERT INTO stars_payments (telegram_payment_charge_id, telegram_id, package_stars, coins, currency, total_amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (telegram_payment_charge_id) DO NOTHING RETURNING telegram_payment_charge_id', [payment.telegram_payment_charge_id, String(sender.id), pack.stars, pack.coins, payment.currency, payment.total_amount]);
      if (inserted.rowCount) await client.query('UPDATE stars_users SET balance=balance+$2, username=$3, first_name=$4, updated_at=NOW() WHERE telegram_id=$1', [String(sender.id), pack.coins, sender.username || null, sender.first_name || null]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.sendStatus(200);
  } catch (e) {
    console.error('Telegram webhook processing error:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', async () => {
  console.log('Stars UI listening on ' + PORT);
  if (process.env.WEBHOOK_URL && process.env.TELEGRAM_WEBHOOK_SECRET && process.env.BOT_TOKEN) {
    try { const url = new URL('/api/telegram/webhook', process.env.WEBHOOK_URL).toString(); await telegramApi('setWebhook', { url, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: false }); console.log('Telegram payment webhook configured'); }
    catch (e) { console.error('Webhook setup failed:', e.message); }
  } else console.log('Webhook setup skipped: set WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET');
});
