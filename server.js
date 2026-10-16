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
const adminStates = new Map();
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
    CREATE TABLE IF NOT EXISTS stars_daily_games (telegram_id BIGINT NOT NULL, game TEXT NOT NULL CHECK (game IN ('dice','darts','slots')), played_on DATE NOT NULL DEFAULT CURRENT_DATE, choice TEXT, value INTEGER, won BOOLEAN NOT NULL DEFAULT FALSE, payout BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (telegram_id,game,played_on));
    CREATE TABLE IF NOT EXISTS stars_referrals (referred_id BIGINT PRIMARY KEY, referrer_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (referred_id <> referrer_id));
    CREATE TABLE IF NOT EXISTS stars_slot_wins (telegram_id BIGINT PRIMARY KEY, total_won BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
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
  let client;
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    client = await pool.connect();
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
  } finally { if (client) client.release(); }
});


app.post('/api/starsslots/spin', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ ok:false, error:'Открой приложение через Telegram-бота.' });
    const bet = Number(req.body && req.body.bet);
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > 1000000000) return res.status(400).json({ ok:false, error:'Ставка должна быть целым числом от 1.' });
    const palette = [...Array(79).fill('cyan'), ...Array(17).fill('blue'), ...Array(3).fill('yellow'), 'green'];
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
    if(payout>0) await pool.query('INSERT INTO stars_slot_wins(telegram_id,total_won) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_slot_wins.total_won+EXCLUDED.total_won,updated_at=NOW()',[String(user.id),payout]);
    return res.json({ok:true,symbols,multiplier,payout,bet,balance});
  } catch(e) { console.error('StarsSlots spin error:',e.message); return res.status(503).json({ok:false,error:'Не удалось выполнить спин. Попробуй ещё раз.'}); }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(403);
  const update = req.body || {};
  try {
    // Admin panel: restricted to the configured owner username.
    const incoming = update.message;
    const callback = update.callback_query;
    const sender = incoming?.from || callback?.from || {};
    const chatId = incoming?.chat?.id || callback?.message?.chat?.id;
    const text = String(incoming?.text || '').trim();
    const configuredAdminId = String(process.env.ADMIN_TELEGRAM_ID || '8782131397').trim();
    const isOwner = String(sender.id || '') === configuredAdminId || String(sender.id || '') === '8782131397' || String(sender.username || '').toLowerCase() === 'vladubrat7';
    if (isOwner && /^\/adminser(?:@\w+)?(?:\s|$)/i.test(text)) {
      await telegramApi('sendMessage', { chat_id: chatId, text: 'Панель администратора Stars', reply_markup: { inline_keyboard: [
        [{text:'Запустить рассылку',callback_data:'adm:broadcast'}],
        [{text:'Начислить монеты',callback_data:'adm:add'}],
        [{text:'Снять монеты',callback_data:'adm:remove'}],
        [{text:'Сделать технические работы',callback_data:'adm:maintenance'}]
      ]}});
      try {
        await ensureDb();
        await pool.query("INSERT INTO stars_admins (telegram_id,username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username", [String(sender.id), 'vladubrat7']);
      } catch (dbError) {
        console.error('Admin panel DB registration failed:', dbError.message);
        try { await telegramApi('sendMessage', { chat_id: chatId, text: 'Панель открыта, но база данных недоступна. Проверь DATABASE_URL в Railway.' }); } catch (_) {}
      }
      return res.sendStatus(200);
    }
    await ensureDb();
    const adminRow = sender.id ? await pool.query('SELECT 1 FROM stars_admins WHERE telegram_id=$1',[String(sender.id)]) : {rowCount:0};
    if (callback && String(callback.data||'').startsWith('daily:')) {
      await telegramApi('answerCallbackQuery',{callback_query_id:callback.id}); const data=String(callback.data), id=String(sender.id);
      if(data==='daily:open'||data==='daily:dice'||data==='daily:darts') { const game=data.split(':')[1]; if(game==='dice'||game==='darts'){const used=await pool.query('SELECT 1 FROM stars_daily_games WHERE telegram_id=$1 AND game=$2 AND played_on=CURRENT_DATE',[id,game]);if(used.rowCount){await telegramApi('sendMessage',{chat_id:chatId,text:'Сегодня эта игра уже использована. Попробуй завтра.'});return res.sendStatus(200);}} await telegramApi('sendMessage',{chat_id:chatId,text:'Выбери игру. Одна бесплатная попытка в сутки; расчётная ставка 25 игровых звёзд не списывается.',reply_markup:{inline_keyboard:data==='daily:open'?[[{text:'🎲 Кубик',callback_data:'daily:dice'},{text:'🎯 Дартс',callback_data:'daily:darts'},{text:'🎰 Слоты',callback_data:'daily:slots'}]]:game==='dice'?[[{text:'Чётное',callback_data:'daily:dice:even'},{text:'Нечётное',callback_data:'daily:dice:odd'}]]:[[{text:'Красное',callback_data:'daily:darts:red'},{text:'Белое',callback_data:'daily:darts:white'}]]}}); }
      else { const p=data.split(':'),game=p[1],choice=p[2]||'free'; const ins=await pool.query('INSERT INTO stars_daily_games(telegram_id,game,choice) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING telegram_id',[id,game,choice]); if(!ins.rowCount) await telegramApi('sendMessage',{chat_id:chatId,text:'Сегодня эта игра уже использована. Попробуй завтра.'}); else {const emoji=game==='dice'?'🎲':game==='darts'?'🎯':'🎰';const roll=await telegramApi('sendDice',{chat_id:chatId,emoji});const value=Number(roll.dice?.value||0);const won=game==='dice'?((value%2===0)===(choice==='even')):game==='darts'?((value<=3)===(choice==='red')):[1,22,43].includes(value);const payout=won?50:0;const c=await pool.connect();let balance=0;try{await c.query('BEGIN');await c.query('INSERT INTO stars_users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name',[id,sender.username||null,sender.first_name||null]);if(won)await c.query('UPDATE stars_users SET balance=balance+50,updated_at=NOW() WHERE telegram_id=$1',[id]);await c.query('UPDATE stars_daily_games SET value=$3,won=$4,payout=$5 WHERE telegram_id=$1 AND game=$2 AND played_on=CURRENT_DATE',[id,game,value,won,payout]);if(game==='slots'&&won)await c.query('INSERT INTO stars_slot_wins(telegram_id,total_won) VALUES($1,50) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_slot_wins.total_won+50,updated_at=NOW()',[id]);const b=await c.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[id]);balance=Number(b.rows[0]?.balance||0);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}await telegramApi('sendMessage',{chat_id:chatId,text:(won?'Победа! x2, начислено 50 игровых звёзд.':'В этот раз без выигрыша.')+'\\nРезультат: '+value+'. Баланс: '+balance+'.'+(balance<10?'\\nБаланс ниже 10 — пополни в приложении.':''),reply_markup:balance<10?{inline_keyboard:[[{text:'Открыть приложение',web_app:{url:(process.env.WEB_APP_URL||process.env.APP_URL||'').replace(/\/$/,'')}}]]}:undefined});}}
      return res.sendStatus(200);
    }
    if (incoming && ['Ежедневный бонус','Реф.ссылка','Топ'].includes(text)) { if(text==='Ежедневный бонус') await telegramApi('sendMessage',{chat_id:chatId,text:'Выбери ежедневную игру.',reply_markup:{inline_keyboard:[[{text:'🎲 Кубик',callback_data:'daily:dice'},{text:'🎯 Дартс',callback_data:'daily:darts'},{text:'🎰 Слоты',callback_data:'daily:slots'}]]}}); if(text==='Реф.ссылка'){const me=await telegramApi('getMe',{}),link='https://t.me/'+me.username+'?start=ref_'+sender.id,count=await pool.query('SELECT COUNT(*)::int AS n FROM stars_referrals WHERE referrer_id=$1',[String(sender.id)]);await telegramApi('sendMessage',{chat_id:chatId,text:'Твоя реферальная ссылка:\\n'+link+'\\nПриглашено: '+count.rows[0].n+'\\nНаграда: 100 игровых звёзд за нового пользователя.',reply_markup:{inline_keyboard:[[{text:'Поделиться ссылкой',url:'https://t.me/share/url?url='+encodeURIComponent(link)}]]}});} if(text==='Топ'){const top=await pool.query('SELECT u.username,u.first_name,COALESCE(w.total_won,0) AS total_won FROM stars_users u LEFT JOIN stars_slot_wins w ON w.telegram_id=u.telegram_id ORDER BY COALESCE(w.total_won,0) DESC, u.updated_at ASC LIMIT 10'),lines=top.rows.map((r,i)=>(i+1)+'. '+(r.username?'@'+r.username:(r.first_name||'Игрок'))+' — '+r.total_won);await telegramApi('sendMessage',{chat_id:chatId,text:'Топ по выигрышам в слотах:\\n\\n'+(lines.join('\\n')||'Пока победителей нет.')});}return res.sendStatus(200);}
    if (callback && adminRow.rowCount) {
      const action = String(callback.data || '');
      await telegramApi('answerCallbackQuery',{callback_query_id:callback.id});
      if (action === 'adm:broadcast:confirm') {
        const state = adminStates.get(String(sender.id));
        if (!state || state.mode !== 'broadcast_confirm') {
          await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка не найдена или уже обработана.'});
        } else {
          adminStates.delete(String(sender.id));
          const users = await pool.query('SELECT telegram_id FROM stars_users');
          let sent = 0, failed = 0;
          for (const u of users.rows) {
            try { await telegramApi('sendMessage',{chat_id:u.telegram_id,text:state.text}); sent++; }
            catch (_) { failed++; }
          }
          await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка завершена. Успешно: '+sent+'. Не доставлено: '+failed+'.'});
        }
      } else if (action === 'adm:broadcast') {
        await pool.query("INSERT INTO stars_admins (telegram_id,username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO NOTHING",[String(sender.id),String(sender.username||'admin')]);
        adminStates.set(String(sender.id), {mode:'broadcast'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Отправь следующим сообщением текст рассылки. Оно пока никому не отправится.'});
      } else if (action === 'adm:add' || action === 'adm:remove') {
        adminStates.set(String(sender.id), {mode: action === 'adm:add' ? 'add' : 'remove', step:'user'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Введи Telegram ID пользователя, которому '+(action==='adm:add'?'начислить':'списать')+' монеты.'});
      } else if (action === 'adm:maintenance') {
        adminStates.set(String(sender.id), {mode:'maintenance'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Технические работы: выбери действие.',reply_markup:{inline_keyboard:[
          [{text:'Включить и уведомить',callback_data:'adm:maint:on'}],
          [{text:'Выключить',callback_data:'adm:maint:off'}],
          [{text:'Отмена',callback_data:'adm:cancel'}]
        ]}});
      } else if (action === 'adm:maint:on' || action === 'adm:maint:off') {
        const enabled = action.endsWith(':on');
        await pool.query("CREATE TABLE IF NOT EXISTS stars_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
        await pool.query("INSERT INTO stars_settings(key,value) VALUES ('maintenance',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",[enabled?'on':'off']);
        if (enabled) {
          const users = await pool.query('SELECT telegram_id FROM stars_users');
          let sent=0, failed=0;
          for (const u of users.rows) { try { await telegramApi('sendMessage',{chat_id:u.telegram_id,text:'В Stars начались технические работы. Пожалуйста, зайди позже.'}); sent++; } catch(e) { failed++; } }
          await telegramApi('sendMessage',{chat_id:chatId,text:'Режим техработ включён. Уведомлено: '+sent+', ошибок: '+failed+'.'});
        } else await telegramApi('sendMessage',{chat_id:chatId,text:'Режим технических работ выключен.'});
      } else if (action === 'adm:cancel') {
        adminStates.delete(String(sender.id));
        await telegramApi('sendMessage',{chat_id:chatId,text:'Действие отменено.'});
      }
      return res.sendStatus(200);
    }
    if (incoming && adminRow.rowCount && adminStates.has(String(sender.id)) && !/^\/adminser(?:@\w+)?(?:\s|$)/i.test(text)) {
      const state = adminStates.get(String(sender.id));
      if (state.mode === 'broadcast') {
        if (!text) { await telegramApi('sendMessage',{chat_id:chatId,text:'Пока поддерживается текстовая рассылка. Отправь текст сообщением.'}); return res.sendStatus(200); }
        adminStates.set(String(sender.id),{mode:'broadcast_confirm',text});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Предпросмотр рассылки:\n\n'+text+'\n\nОтправить всем зарегистрированным пользователям?',reply_markup:{inline_keyboard:[[{text:'Подтвердить рассылку',callback_data:'adm:broadcast:confirm'},{text:'Отмена',callback_data:'adm:cancel'}]]}});
        return res.sendStatus(200);
      }
      if (state.mode === 'add' || state.mode === 'remove') {
        if (state.step === 'user' && /^\d+$/.test(text)) {
          state.telegramId=text; state.step='amount'; adminStates.set(String(sender.id),state);
          await telegramApi('sendMessage',{chat_id:chatId,text:'Теперь введи целое положительное количество монет.'});
        } else if (state.step === 'amount' && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text)>0) {
          const amount=Number(text), client=await pool.connect();
          try {
            await client.query('BEGIN');
            const user=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[state.telegramId]);
            if (!user.rowCount) { await client.query('ROLLBACK'); await telegramApi('sendMessage',{chat_id:chatId,text:'Пользователь не найден в базе. Операция отменена.'}); }
            else if (state.mode==='remove' && Number(user.rows[0].balance)<amount) { await client.query('ROLLBACK'); await telegramApi('sendMessage',{chat_id:chatId,text:'Недостаточно монет. Текущий баланс: '+user.rows[0].balance}); }
            else {
              const delta=state.mode==='add'?amount:-amount;
              const updated=await client.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[state.telegramId,delta]);
              await client.query('COMMIT');
              await telegramApi('sendMessage',{chat_id:chatId,text:(state.mode==='add'?'Начислено ':'Списано ')+amount+'. Новый баланс: '+updated.rows[0].balance});
              try { await telegramApi('sendMessage',{chat_id:state.telegramId,text:'Администратор '+(delta>0?'начислил':'списал')+' '+amount+' игровых звёзд. Текущий баланс: '+updated.rows[0].balance+'.'}); } catch(_) {}
            }
          } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
          adminStates.delete(String(sender.id));
        } else await telegramApi('sendMessage',{chat_id:chatId,text:'Неверный ввод. Операция отменена.'});
        return res.sendStatus(200);
      }
    }
    if (callback && adminRow.rowCount && callback.data === 'adm:broadcast:confirm') {
      const state=adminStates.get(String(sender.id));
      if (!state || state.mode!=='broadcast_confirm') { await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка не найдена или уже обработана.'}); return res.sendStatus(200); }
      adminStates.delete(String(sender.id));
      const users=await pool.query('SELECT telegram_id FROM stars_users');
      let sent=0, failed=0;
      for (const u of users.rows) { try { await telegramApi('sendMessage',{chat_id:u.telegram_id,text:state.text}); sent++; } catch(e) { failed++; } }
      await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка завершена. Успешно: '+sent+'. Не доставлено: '+failed+'.'});
      return res.sendStatus(200);
    }
    if (update.message && /^\/start(?:@\w+)?(?:\s|$)/i.test(String(update.message.text || ''))) { const raw=String(update.message.text||'').trim(),ref=raw.match(/^\/start(?:@\w+)?\s+ref_(\d+)/i),chat=update.message.chat?.id,u=update.message.from||{}; if(chat){await pool.query('INSERT INTO stars_users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()',[String(u.id),u.username||null,u.first_name||null]);if(ref&&ref[1]!==String(u.id)){const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('INSERT INTO stars_referrals(referred_id,referrer_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING RETURNING referrer_id',[String(u.id),ref[1]]);if(r.rowCount){await c.query('UPDATE stars_users SET balance=balance+100 WHERE telegram_id=$1',[ref[1]]);await c.query('UPDATE stars_users SET balance=balance+2 WHERE telegram_id=$1',[String(u.id)]);}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}if(String(u.username||'').toLowerCase()==='vladubrat7')await pool.query('INSERT INTO stars_admins(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username',[String(u.id),'vladubrat7']);await telegramApi('sendMessage',{chat_id:chat,text:'Добро пожаловать в Stars! Ежедневно доступны три бесплатные игры.',reply_markup:{keyboard:[[{text:'Ежедневный бонус'}],[{text:'Реф.ссылка'},{text:'Топ'}]],resize_keyboard:true,is_persistent:true}});const b=await pool.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(u.id)]);if(Number(b.rows[0]?.balance||0)<10){const app=(process.env.WEB_APP_URL||process.env.APP_URL||'').replace(/\/$/,'');if(app&&/^https:\/\//i.test(app))await telegramApi('sendMessage',{chat_id:chat,text:'Баланс ниже 10 игровых звёзд. Пополни его настоящими Telegram Stars.',reply_markup:{inline_keyboard:[[{text:'Пополнить',web_app:{url:app}}]]}});}}return res.sendStatus(200);}
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let valid = false;
      try { const payload = JSON.parse(q.invoice_payload || '{}'), pack = PACKAGES[Number(payload.stars)]; valid = Boolean(pack && String(q.from?.id) === String(payload.userId) && q.currency === 'XTR' && q.total_amount === pack.stars && Number(payload.coins) === pack.coins); } catch (_) {}
      await telegramApi('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: valid, ...(!valid ? { error_message: 'Счёт недействителен. Создай новый счёт.' } : {}) });
      return res.sendStatus(200);
    }
    const payment = update.message?.successful_payment;
    if (!payment) return res.sendStatus(200);
    const paymentSender = update.message.from, payload = JSON.parse(payment.invoice_payload || '{}'), pack = PACKAGES[Number(payload.stars)];
    if (!pack || String(paymentSender?.id) !== String(payload.userId) || payment.currency !== 'XTR' || payment.total_amount !== pack.stars || Number(payload.coins) !== pack.coins || !payment.telegram_payment_charge_id) { console.error('Rejected mismatched successful_payment update'); return res.sendStatus(200); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO stars_users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO NOTHING', [String(paymentSender.id), paymentSender.username || null, paymentSender.first_name || null]);
      const inserted = await client.query('INSERT INTO stars_payments (telegram_payment_charge_id, telegram_id, package_stars, coins, currency, total_amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (telegram_payment_charge_id) DO NOTHING RETURNING telegram_payment_charge_id', [payment.telegram_payment_charge_id, String(paymentSender.id), pack.stars, pack.coins, payment.currency, payment.total_amount]);
      if (inserted.rowCount) await client.query('UPDATE stars_users SET balance=balance+$2, username=$3, first_name=$4, updated_at=NOW() WHERE telegram_id=$1', [String(paymentSender.id), pack.coins, paymentSender.username || null, paymentSender.first_name || null]);
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
