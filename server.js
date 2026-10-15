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
    CREATE TABLE IF NOT EXISTS stars_admins (telegram_id BIGINT PRIMARY KEY, username TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_withdrawals (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, username TEXT, first_name TEXT, target_username TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount >= 1000), payout_stars BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_payments (telegram_payment_charge_id TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, package_stars INTEGER NOT NULL, coins BIGINT NOT NULL, currency TEXT NOT NULL, total_amount INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_promocodes (code TEXT PRIMARY KEY, reward BIGINT NOT NULL CHECK (reward > 0), max_activations INTEGER NOT NULL CHECK (max_activations > 0), activations INTEGER NOT NULL DEFAULT 0 CHECK (activations >= 0 AND activations <= max_activations));
    CREATE TABLE IF NOT EXISTS stars_promocode_uses (code TEXT NOT NULL REFERENCES stars_promocodes(code), telegram_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (code, telegram_id));
  `);
  const promoCodes = ['STARS10-A7K2', 'STARS10-M4Q9', 'STARS10-P8D3', 'STARS10-R6X1', 'STARS10-Z2N5'];
  for (const code of promoCodes) await pool.query('INSERT INTO stars_promocodes (code,reward,max_activations) VALUES ($1,10,10) ON CONFLICT (code) DO NOTHING', [code]);
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

function authUser(req) { return validateTelegramInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN); }
app.get('/api/withdrawals', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ ok:false, error:'Открой приложение через Telegram-бота.' });
    const admin = await pool.query('SELECT 1 FROM stars_admins WHERE telegram_id=$1', [String(user.id)]);
    const rows = await pool.query(
      admin.rowCount
        ? "SELECT id, telegram_id, username, first_name, target_username, amount, payout_stars, status, created_at FROM stars_withdrawals ORDER BY created_at DESC LIMIT 200"
        : "SELECT id, target_username, amount, payout_stars, status, created_at FROM stars_withdrawals WHERE telegram_id=$1 ORDER BY created_at DESC",
      admin.rowCount ? [] : [String(user.id)]
    );
    return res.json({ok:true, isAdmin:Boolean(admin.rowCount), requests:rows.rows});
  } catch(e) { console.error('Withdrawals list error:',e.message); return res.status(503).json({ok:false,error:'Не удалось загрузить заявки.'}); }
});
app.post('/api/withdrawals', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    const amount = Number(req.body && req.body.amount);
    const target = String(req.body && req.body.targetUsername || '').trim().replace(/^@/,'');
    if (!Number.isSafeInteger(amount) || amount < 1000) return res.status(400).json({ok:false,error:'Минимальный вывод — 1000 наших звёзд.'});
    if (!/^[A-Za-z0-9_]{5,32}$/.test(target)) return res.status(400).json({ok:false,error:'Укажи корректный Telegram username получателя.'});
    const payout = Math.floor(amount * 30 / 500);
    if (payout < 1) return res.status(400).json({ok:false,error:'Сумма вывода слишком мала.'});
    const client = await pool.connect();
    let request;
    try {
      await client.query('BEGIN');
      const bal = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);
      const balance = Number(bal.rows[0]?.balance || 0);
      if (balance < amount) { await client.query('ROLLBACK'); return res.status(400).json({ok:false,error:'Недостаточно звёзд на балансе.'}); }
      await client.query('UPDATE stars_users SET balance=balance-$2, updated_at=NOW() WHERE telegram_id=$1',[String(user.id),amount]);
      const inserted = await client.query("INSERT INTO stars_withdrawals (telegram_id,username,first_name,target_username,amount,payout_stars,status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, target_username, amount, payout_stars, status, created_at",[String(user.id),user.username||null,user.first_name||null,'@'+target,amount,payout]);
      request = inserted.rows[0];
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const admins = await pool.query('SELECT telegram_id FROM stars_admins');
    const msg = 'Новая заявка на вывод #'+request.id+'\nПользователь: '+(user.username?'@'+user.username:'без username')+' (ID '+user.id+')\nПолучатель: @'+target+'\nСумма списания: '+amount+' наших звёзд\nК выплате: '+payout+' Telegram Stars\nСтатус: ожидание';
    for (const a of admins.rows) { try { await telegramApi('sendMessage',{chat_id:a.telegram_id,text:msg}); } catch(e) { console.error('Admin notification failed:',e.message); } }
    return res.json({ok:true,request,balanceUpdated:true});
  } catch(e) { console.error('Withdrawal creation error:',e.message); return res.status(503).json({ok:false,error:'Не удалось создать заявку.'}); }
});
app.post('/api/withdrawals/:id/status', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Telegram-профиль не подтверждён.'});
    const admin = await pool.query('SELECT 1 FROM stars_admins WHERE telegram_id=$1',[String(user.id)]);
    if (!admin.rowCount) return res.status(403).json({ok:false,error:'Нет прав администратора.'});
    const id = Number(req.params.id), status = String(req.body && req.body.status);
    if (!Number.isSafeInteger(id) || id < 1 || !['paid','rejected'].includes(status)) return res.status(400).json({ok:false,error:'Некорректный статус.'});
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT * FROM stars_withdrawals WHERE id=$1 FOR UPDATE',[id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ok:false,error:'Заявка не найдена.'}); }
      const row = found.rows[0];
      if (row.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ok:false,error:'Статус этой заявки уже изменён.'}); }
      await client.query('UPDATE stars_withdrawals SET status=$2,updated_at=NOW() WHERE id=$1',[id,status]);
      if (status === 'rejected') await client.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[String(row.telegram_id),row.amount]);
      result = {...row,status};
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    try { await telegramApi('sendMessage',{chat_id:String(result.telegram_id),text:'Заявка на вывод #'+id+': '+(status==='paid'?'выплачено. Получено: '+result.payout_stars+' Telegram Stars.':'отказано. Сумма возвращена на игровой баланс.')}); } catch(e) { console.error('User withdrawal status notification failed:',e.message); }
    return res.json({ok:true,id,status});
  } catch(e) { console.error('Withdrawal status error:',e.message); return res.status(503).json({ok:false,error:'Не удалось изменить статус заявки.'}); }
});


app.post('/api/promocodes/activate', async (req, res) => {
  const client = await (async () => { try { await ensureDb(); return await pool.connect(); } catch (e) { throw e; } })().catch(e => { throw e; });
  try {
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    const code = String(req.body && req.body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) return res.status(400).json({ok:false,error:'Введи корректный промокод.'});
    await client.query('BEGIN');
    const promo = await client.query('SELECT code,reward,max_activations,activations FROM stars_promocodes WHERE code=$1 FOR UPDATE',[code]);
    if (!promo.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ok:false,error:'Такого промокода не существует.'}); }
    const row = promo.rows[0];
    const used = await client.query('SELECT 1 FROM stars_promocode_uses WHERE code=$1 AND telegram_id=$2',[code,String(user.id)]);
    if (used.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ok:false,error:'Ты уже активировал этот промокод.'}); }
    if (Number(row.activations) >= Number(row.max_activations)) { await client.query('ROLLBACK'); return res.status(409).json({ok:false,error:'Лимит активаций этого промокода исчерпан.'}); }
    await client.query('INSERT INTO stars_users (telegram_id,username,first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO NOTHING',[String(user.id),user.username||null,user.first_name||null]);
    await client.query('INSERT INTO stars_promocode_uses (code,telegram_id) VALUES ($1,$2)',[code,String(user.id)]);
    await client.query('UPDATE stars_promocodes SET activations=activations+1 WHERE code=$1',[code]);
    await client.query('UPDATE stars_users SET balance=balance+$2,username=$3,first_name=$4,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),Number(row.reward),user.username||null,user.first_name||null]);
    const balance = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
    await client.query('COMMIT');
    return res.json({ok:true,reward:Number(row.reward),balance:Number(balance.rows[0].balance),message:'Промокод активирован! Начислено '+Number(row.reward)+' наших звёзд.'});
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Promocode activation error:',e.message);
    return res.status(503).json({ok:false,error:'Не удалось активировать промокод. Попробуй ещё раз.'});
  } finally { client.release(); }
});


app.post('/api/starsslots/spin', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ ok:false, error:'Открой приложение через Telegram-бота.' });
    const bet = Number(req.body && req.body.bet);
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > 1000000000) return res.status(400).json({ ok:false, error:'Ставка должна быть целым числом от 1.' });
    const palette = [...Array(85).fill('blue'), ...Array(11).fill('cyan'), ...Array(3).fill('yellow'), 'green'];
    const symbols = [palette[crypto.randomInt(0,palette.length)],palette[crypto.randomInt(0,palette.length)],palette[crypto.randomInt(0,palette.length)]];
    const counts = symbols.reduce((m,c)=>(m[c]=(m[c]||0)+1,m),{});
    const match = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const count = match[1];
    let multiplier = 0;
    if (count >= 2) {
      const [color, n] = match;
      const table = { blue:{2:1.2,3:2}, yellow:{2:3,3:2}, green:{2:25,3:100}, cyan:{2:0,3:0} };
      multiplier = table[color][n] || 0;
    }
    const payout = Math.floor(bet * multiplier);
    const client = await pool.connect();
    let balance;
    try {
      await client.query('BEGIN');
      const row = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);
      const current = Number(row.rows[0]?.balance || 0);
      if (current < bet) { await client.query('ROLLBACK'); return res.status(400).json({ok:false,error:'Недостаточно звёзд на балансе для этой ставки.'}); }
      await client.query('UPDATE stars_users SET balance=balance-$2+$3, updated_at=NOW() WHERE telegram_id=$1',[String(user.id),bet,payout]);
      const updated = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
      balance = Number(updated.rows[0]?.balance || 0);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return res.json({ok:true,symbols,multiplier,payout,bet,balance});
  } catch(e) { console.error('StarsSlots spin error:',e.message); return res.status(503).json({ok:false,error:'Не удалось выполнить спин. Попробуй ещё раз.'}); }
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
        const sender = update.message.from || {};
        if (String(sender.username || '').toLowerCase() === 'vladubrat7') {
          await pool.query('INSERT INTO stars_admins (telegram_id,username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username',[String(sender.id),'vladubrat7']);
        }
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
    try { const url = new URL('/api/telegram/webhook', process.env.WEBHOOK_URL).toString(); await telegramApi('setWebhook', { url, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query', 'callback_query'], drop_pending_updates: false }); console.log('Telegram payment webhook configured'); }
    catch (e) { console.error('Webhook setup failed:', e.message); }
  } else console.log('Webhook setup skipped: set WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET');
});
