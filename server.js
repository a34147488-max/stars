const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname, { setHeaders(res, filePath) {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
} }));
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = (process.env.APP_URL || 'https://stars-production-0668.up.railway.app').replace(/\/$/, '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
let bot = null;
let dbReady = false;
const STAR_PRODUCTS = {
  stars_1: { title: 'Stars 1', description: 'Постоянная награда за клик: +0.005 звезды', stars: 25, multiplier: 50 },
  stars_2: { title: 'Stars 2', description: 'Постоянная награда за клик: +0.015 звезды', stars: 50, multiplier: 150 },
  stars_3: { title: 'Stars 3', description: 'Постоянная награда за клик: +0.050 звезды', stars: 100, multiplier: 500 },
  stars_4: { title: 'Stars 4', description: 'Постоянная награда за клик: +0.100 звезды', stars: 200, multiplier: 1000 },
  stars_5: { title: 'Stars 5', description: 'Постоянная награда за клик: +0.200 звезды', stars: 400, multiplier: 2000 }
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT UNIQUE,
      display_name TEXT NOT NULL DEFAULT 'Игрок',
      avatar TEXT NOT NULL DEFAULT '⭐',
      clicks_count BIGINT NOT NULL DEFAULT 0,
      balance NUMERIC(24,8) NOT NULL DEFAULT 0,
      total NUMERIC(24,8) NOT NULL DEFAULT 0,
      click_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1,
      referred_by BIGINT REFERENCES players(telegram_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id BIGSERIAL PRIMARY KEY,
      from_id BIGINT NOT NULL REFERENCES players(telegram_id),
      to_id BIGINT NOT NULL REFERENCES players(telegram_id),
      amount NUMERIC(24,8) NOT NULL CHECK (amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE players ADD COLUMN IF NOT EXISTS click_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS clicks_count BIGINT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS star_orders (
      id UUID PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      product_id TEXT NOT NULL,
      stars INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      charge_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS olympus_sessions (telegram_id BIGINT PRIMARY KEY REFERENCES players(telegram_id), free_spins INTEGER NOT NULL DEFAULT 0, multiplier NUMERIC(12,2) NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS daily_spins (
      telegram_id BIGINT PRIMARY KEY REFERENCES players(telegram_id),
      spin_date DATE NOT NULL,
      reward NUMERIC(24,8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      amount NUMERIC(24,8) NOT NULL CHECK(amount > 0),
      max_uses INTEGER NOT NULL CHECK(max_uses > 0),
      uses INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_wagers (
      code TEXT NOT NULL REFERENCES promo_codes(code),
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      reward NUMERIC(24,8) NOT NULL,
      target NUMERIC(24,8) NOT NULL,
      wagered NUMERIC(24,8) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY(code,telegram_id)
    );
    CREATE INDEX IF NOT EXISTS promo_wagers_player_idx ON promo_wagers(telegram_id,status);
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS wagering_multiplier INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      code TEXT NOT NULL REFERENCES promo_codes(code),
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(code, telegram_id)
    );
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      amount NUMERIC(24,8) NOT NULL CHECK(amount >= 300),
      username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by BIGINT
    );
    CREATE INDEX IF NOT EXISTS withdrawal_requests_player_idx ON withdrawal_requests(telegram_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS players_username_lower_idx ON players (LOWER(username));
  `);
  // Existing one-time code.
  await pool.query(
    "INSERT INTO promo_codes(code,amount,max_uses) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING",
    ['MONETY10000',10000,1]
  );
  // Ten single-use Olympus wagering promos: 150 Stars each, x20 wagering (3,000 Stars).
  for (const code of ['OLYMPUS150A','OLYMPUS150B','OLYMPUS150C','OLYMPUS150D','OLYMPUS150E','OLYMPUS150F','OLYMPUS150G','OLYMPUS150H','OLYMPUS150I','OLYMPUS150J']) {
    await pool.query(
      "INSERT INTO promo_codes(code,amount,max_uses,wagering_multiplier) VALUES($1,150,1,20) ON CONFLICT(code) DO NOTHING",
      [code]
    );
  }
}

function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

async function upsertPlayer(user, startParam) {
  const id = String(user.id);
  const username = user.username || null;
  const telegramAvatar = typeof user.photo_url === 'string' && /^https:\/\//i.test(user.photo_url) ? user.photo_url : null;
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 48) || 'Игрок';
  const refMatch = /^ref_(\d+)$/.exec(startParam || '');
  const referrer = refMatch && refMatch[1] !== id ? refMatch[1] : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT telegram_id FROM players WHERE telegram_id=$1', [id]);
    if (!existing.rowCount) {
      let validRef = null;
      if (referrer) {
        const r = await client.query('SELECT telegram_id FROM players WHERE telegram_id=$1', [referrer]);
        if (r.rowCount) validRef = referrer;
      }
      const inserted = await client.query(
        'INSERT INTO players (telegram_id, username, display_name, avatar, referred_by) VALUES ($1,$2,$3,COALESCE($4,\'⭐\'),$5) ON CONFLICT (telegram_id) DO NOTHING RETURNING telegram_id',
        [id, username, displayName, telegramAvatar, validRef]
      );
      if (inserted.rowCount && validRef) {
        await client.query('UPDATE players SET balance=balance+15,total=total+15,updated_at=NOW() WHERE telegram_id=$1', [validRef]);
      }
    } else {
      await client.query('UPDATE players SET username=$2, avatar=CASE WHEN avatar=\'⭐\' AND $3::text IS NOT NULL THEN $3 ELSE avatar END, updated_at=NOW() WHERE telegram_id=$1', [id, username, telegramAvatar]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getPlayer(id);
}
async function getPlayer(id) {
  const r = await pool.query('SELECT telegram_id, username, display_name, avatar, balance, total, referred_by, clicks_count, click_multiplier FROM players WHERE telegram_id=$1', [String(id)]);
  return r.rows[0] || null;
}
function publicPlayer(p) {
  const clicks=Number(p.clicks_count||0); const level=clicks<100?0:clicks<500?1:2+Math.floor((clicks-500)/500); const clickBonus=level>=100?0.05:level>=30?0.005:0;
  return { id: String(p.telegram_id), username: p.username, name: p.display_name, avatar: p.avatar, balance: Number(p.balance), total: Number(p.total), clicks, level, clickBonus, clickMultiplier:Number(p.click_multiplier||1), referredBy: p.referred_by ? String(p.referred_by) : null };
}
async function auth(req, res, next) {
  try {
    const user = verifyInitData(req.get('x-telegram-init-data'));
    if (!user) return res.status(401).json({ error: 'Открой приложение через Telegram-бота, чтобы синхронизировать баланс.' });
    req.player = await upsertPlayer(user, '');
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка базы данных' }); }
}
function mainKeyboard(id) {
  return { inline_keyboard: [[{ text: '⭐ Открыть приложение', web_app: { url: APP_URL } }]] };
}
async function botStart(msg) {
  const user = msg.from;
  const payload = (msg.text || '').split(/\s+/)[1] || '';
  await upsertPlayer(user, payload);
  await bot.sendMessage(msg.chat.id, '❄️ Добро пожаловать в Stars! Нажми кнопку ниже, чтобы открыть приложение.', {
    reply_markup: mainKeyboard(user.id),
    disable_web_page_preview: true
  });
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function botClick(chatId, from) {
  const p = await upsertPlayer(from, '');
  const r = await pool.query('UPDATE players SET clicks_count=clicks_count+1,updated_at=NOW() WHERE telegram_id=$1 RETURNING clicks_count,click_multiplier');
  const clicks=Number(r.rows[0].clicks_count);const level=clicks<100?0:clicks<500?1:2+Math.floor((clicks-500)/500);const bonus=level>=100?0.05:level>=30?0.005:0;const gain=0.0001*Number(r.rows[0].click_multiplier)+bonus;
  const credited=await pool.query('UPDATE players SET balance=balance+$2,total=total+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(from.id),gain]);
  await bot.sendMessage(chatId, `⭐ +${gain.toFixed(4)} звезды!\nБаланс: ${Number(credited.rows[0].balance).toFixed(4)} звёзд`, { reply_markup: mainKeyboard(from.id) });
}
async function transfer(fromId, recipient, amount) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new Error('Укажи положительную сумму перевода.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const from = await client.query('SELECT telegram_id,balance FROM players WHERE telegram_id=$1 FOR UPDATE', [String(fromId)]);
    if (!from.rowCount) throw new Error('Сначала нажми /start.');
    const to = await client.query('SELECT telegram_id,display_name,username FROM players WHERE LOWER(username)=LOWER($1) FOR UPDATE', [recipient.replace(/^@/, '')]);
    if (!to.rowCount) throw new Error('Игрок не найден. Он должен хотя бы раз нажать /start в боте.');
    if (String(to.rows[0].telegram_id) === String(fromId)) throw new Error('Нельзя переводить звёзды самому себе.');
    const value = amount.toFixed(4);
    if (Number(from.rows[0].balance) + 1e-10 < Number(value)) throw new Error('Недостаточно звёзд на балансе.');
    await client.query('UPDATE players SET balance=balance-$2,updated_at=NOW() WHERE telegram_id=$1', [String(fromId), value]);
    await client.query('UPDATE players SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1', [String(to.rows[0].telegram_id), value]);
    await client.query('INSERT INTO transfers(from_id,to_id,amount) VALUES($1,$2,$3)', [String(fromId), String(to.rows[0].telegram_id), value]);
    await client.query('COMMIT');
    return { recipient: to.rows[0], amount: Number(value), balance: Number(from.rows[0].balance) - Number(value) };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
function registerBot() {
  if (!BOT_TOKEN) { console.warn('BOT_TOKEN is not set; Telegram bot is disabled.'); return; }
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.on('error', e => console.error('Telegram bot error:', e.message));
  bot.on('pre_checkout_query', async q => {
    try {
      const order = await pool.query('SELECT telegram_id,stars,status FROM star_orders WHERE id=$1', [q.invoice_payload]);
      const valid = order.rowCount && String(order.rows[0].telegram_id) === String(q.from.id) && Number(order.rows[0].stars) === Number(q.total_amount) && q.currency === 'XTR' && order.rows[0].status === 'pending';
      await bot.answerPreCheckoutQuery(q.id, Boolean(valid), valid ? undefined : { error_message: 'Заказ не найден или уже обработан. Открой магазин и попробуй ещё раз.' });
    } catch (e) { console.error('Ошибка pre-checkout:', e.message); await bot.answerPreCheckoutQuery(q.id, false, { error_message: 'Не удалось проверить заказ. Попробуй позже.' }).catch(()=>{}); }
  });
  bot.on('message', async msg => {
    const payment = msg.successful_payment;
    if (!payment || payment.currency !== 'XTR' || !dbReady) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderResult = await client.query('SELECT * FROM star_orders WHERE id=$1 FOR UPDATE', [payment.invoice_payload]);
      if (!orderResult.rowCount) throw new Error('Заказ для платежа не найден: ' + payment.invoice_payload);
      const order = orderResult.rows[0];
      const product = STAR_PRODUCTS[order.product_id];
      if (!product || String(order.telegram_id) !== String(msg.from.id) || Number(order.stars) !== Number(payment.total_amount)) throw new Error('Платёж не совпал с заказом');
      if (order.status !== 'paid') {
        const inserted = await client.query('UPDATE star_orders SET status=\'paid\',charge_id=$2,paid_at=NOW() WHERE id=$1 AND status=\'pending\' RETURNING id', [order.id, payment.telegram_payment_charge_id]);
        if (inserted.rowCount) {
          await client.query('UPDATE players SET click_multiplier=GREATEST(click_multiplier,$2),updated_at=NOW() WHERE telegram_id=$1', [String(order.telegram_id), product.multiplier]);
          await client.query('UPDATE star_orders SET status=\'paid\',charge_id=$2,paid_at=NOW() WHERE id=$1', [order.id, payment.telegram_payment_charge_id]);
        }
      }
      await client.query('COMMIT');
      await bot.sendMessage(msg.chat.id, '✅ Оплата получена! Улучшение «' + product.title + '» активно. Множитель клика: x' + product.multiplier + '.');
    } catch (e) { await client.query('ROLLBACK'); console.error('Ошибка выдачи улучшения:', e.message); await bot.sendMessage(msg.chat.id, 'Платёж получен, но возникла ошибка активации. Напиши администратору и укажи ID платежа: ' + payment.telegram_payment_charge_id).catch(()=>{}); }
    finally { client.release(); }
  });
  bot.onText(/^\/start(?:\s+(.+))?/, async msg => { try { await botStart(msg); } catch (e) { console.error('Ошибка /start:', e.message); const hint = !dbReady ? 'База данных Stars пока недоступна. Администратору нужно подключить PostgreSQL в Railway: DATABASE_URL должен ссылаться на базу Railway, а не на localhost.' : 'Не удалось загрузить профиль. Попробуй позже.'; bot.sendMessage(msg.chat.id, hint).catch(err => console.error('Не удалось ответить на /start:', err.message)); } });
  bot.onText(/^\/name(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    try {
      const name = String(match[1] || '').trim().slice(0, 32);
      if (name.length < 2) return bot.sendMessage(msg.chat.id, 'Напиши имя так: /name Новое имя');
      await upsertPlayer(msg.from, '');
      await pool.query('UPDATE players SET display_name=$2,updated_at=NOW() WHERE telegram_id=$1', [String(msg.from.id), name]);
      await bot.sendMessage(msg.chat.id, '✅ Имя изменено на: ' + escapeHtml(name), { parse_mode: 'HTML', reply_markup: mainKeyboard(msg.from.id) });
    } catch (e) { console.error(e); bot.sendMessage(msg.chat.id, 'Не удалось изменить имя. Попробуй позже.'); }
  });
  bot.on('message', async msg => {
    if (!msg.from || !msg.photo || msg.chat.type !== 'private' || !dbReady) return;
    try {
      const largest = msg.photo[msg.photo.length - 1];
      const fileUrl = await bot.getFileLink(largest.file_id);
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error('Не удалось скачать фото Telegram');
      const image = Buffer.from(await response.arrayBuffer());
      if (image.length > 5 * 1024 * 1024) return bot.sendMessage(msg.chat.id, 'Фото слишком большое. Отправь изображение до 5 МБ.');
      const mime = response.headers.get('content-type') || 'image/jpeg';
      if (!mime.startsWith('image/')) throw new Error('Получен файл не изображения');
      const dataUrl = 'data:' + mime + ';base64,' + image.toString('base64');
      await upsertPlayer(msg.from, '');
      await pool.query('UPDATE players SET avatar=$2,updated_at=NOW() WHERE telegram_id=$1', [String(msg.from.id), dataUrl]);
      await bot.sendMessage(msg.chat.id, '✅ Фото сохранено как твой аватар в Stars!', { reply_markup: mainKeyboard(msg.from.id) });
    } catch (e) { console.error('Ошибка аватара:', e.message); bot.sendMessage(msg.chat.id, 'Не удалось сохранить фото. Попробуй отправить его ещё раз.'); }
  });
  bot.onText(/^\/promocreate\s+([A-Za-z0-9_-]{3,32})\s+(\d+(?:[.,]\d{1,8})?)\s+(\d+)$/i, async (msg,m)=>{
    try {
      if(!process.env.ADMIN_ID||String(msg.from.id)!==String(process.env.ADMIN_ID)) return bot.sendMessage(msg.chat.id,'Эта команда доступна только администратору.');
      const code=m[1].toUpperCase(), amount=Number(m[2].replace(',','.')), uses=Number(m[3]);
      if(!(amount>0)||!Number.isFinite(amount)||!Number.isInteger(uses)||uses<1||uses>100000) return bot.sendMessage(msg.chat.id,'Формат: /promocreate CODE СУММА КОЛИЧЕСТВО_АКТИВАЦИЙ');
      await pool.query('INSERT INTO promo_codes(code,amount,max_uses) VALUES($1,$2,$3)',[code,amount,uses]);
      await bot.sendMessage(msg.chat.id,'Промокод '+code+' создан. Награда: '+amount+' звёзд, активаций: '+uses+'.');
    } catch(e) { bot.sendMessage(msg.chat.id,e.code==='23505'?'Такой промокод уже существует.':'Не удалось создать промокод: '+e.message); }
  });
  bot.onText(/^\/balance/, async msg => { try { const p=await upsertPlayer(msg.from,''); bot.sendMessage(msg.chat.id, `⭐ Твой баланс: ${Number(p.balance).toFixed(4)} звёзд`, {reply_markup:mainKeyboard(msg.from.id)}); } catch(e) { bot.sendMessage(msg.chat.id,'Ошибка получения баланса.'); } });
  // Admin diagnostics: show the numeric Telegram ID and test withdrawal notifications.
  bot.onText(/^\/id$/, async msg => {
    await bot.sendMessage(msg.chat.id, 'Твой Telegram ID: ' + msg.from.id + '\\nДля Railway переменная ADMIN_ID должна содержать только это число.');
  });
  bot.onText(/^\/testwithdraw$/, async msg => {
    const adminId = String(process.env.ADMIN_ID || '').trim();
    if (!adminId || String(msg.from.id) !== adminId) return bot.sendMessage(msg.chat.id, 'Доступ запрещён. ADMIN_ID должен совпадать с твоим числовым Telegram ID. Твой ID: ' + msg.from.id);
    try {
      await bot.sendMessage(adminId, '✅ Тест уведомлений о выводе работает. Если видишь это сообщение, ADMIN_ID и доступ бота настроены верно.');
    } catch (e) {
      console.error('Withdrawal test notification failed:', e.message);
      await bot.sendMessage(msg.chat.id, '❌ Не удалось отправить сообщение на ADMIN_ID=' + adminId + '. Ошибка Telegram: ' + e.message + '. Убедись, что ты нажал /start у этого же бота.');
    }
  });
  bot.onText(/^\/transfer\s+(@?[A-Za-z0-9_]{5,32})\s+([0-9]+(?:[.,][0-9]{1,8})?)/, async (msg, m) => {
    try { await upsertPlayer(msg.from,''); const result=await transfer(msg.from.id,m[1],Number(m[2].replace(',','.'))); await bot.sendMessage(msg.chat.id,`✅ Переведено ${result.amount.toFixed(4)} звёзд игроку ${escapeHtml(result.recipient.display_name)}. Остаток: ${result.balance.toFixed(4)} звёзд.`,{parse_mode:'HTML',reply_markup:mainKeyboard(msg.from.id)}); await bot.sendMessage(String(result.recipient.telegram_id),`✨ Тебе поступило ${result.amount.toFixed(4)} звёзд от игрока ${escapeHtml(msg.from.first_name || 'Игрок')}!`,{parse_mode:'HTML'}).catch(()=>{}); }
    catch(e) { bot.sendMessage(msg.chat.id, '❌ '+e.message); }
  });
  bot.on('callback_query', async q => {
    try {
      if (q.data && /^withdraw_(paid|reject):\d+$/.test(q.data)) {
        if(!process.env.ADMIN_ID||String(q.from.id)!==String(process.env.ADMIN_ID)){
          await bot.answerCallbackQuery(q.id,{text:'Доступ запрещён.',show_alert:true});return;
        }
        const match=/^withdraw_(paid|reject):(\d+)$/.exec(q.data);
        const next=match[1]==='paid'?'paid':'rejected',requestId=match[2];
        const client=await pool.connect();
        let updated;
        try{
          await client.query('BEGIN');
          const r=await client.query('SELECT id,telegram_id,amount,username,status FROM withdrawal_requests WHERE id=$1 FOR UPDATE',[requestId]);
          if(!r.rowCount||r.rows[0].status!=='pending'){await client.query('ROLLBACK');await bot.answerCallbackQuery(q.id,{text:'Заявка уже обработана или не найдена.',show_alert:true});return;}
          updated=r.rows[0];
          await client.query('UPDATE withdrawal_requests SET status=$2,updated_at=NOW(),reviewed_by=$3 WHERE id=$1',[requestId,next,String(q.from.id)]);
          if(next==='rejected') await client.query('UPDATE players SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[String(updated.telegram_id),updated.amount]);
          await client.query('COMMIT');
        }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
        const statusText=next==='paid'?'✅ Выплачено':'❌ Отказано — звёзды возвращены на баланс игрока';
        await bot.answerCallbackQuery(q.id,{text:next==='paid'?'Заявка отмечена как выплаченная.':'Заявка отклонена, баланс возвращён.'});
        await bot.editMessageReplyMarkup({inline_keyboard:[]},{chat_id:q.message.chat.id,message_id:q.message.message_id}).catch(()=>{});
        await bot.sendMessage(q.message.chat.id,'Заявка #'+requestId+': '+statusText+'.');
        await bot.sendMessage(String(updated.telegram_id),next==='paid'?'✅ Заявка на вывод #'+requestId+' выполнена. Сумма: '+Number(updated.amount).toLocaleString('ru-RU')+' ⭐, аккаунт: '+updated.username+'.':'❌ Заявка на вывод #'+requestId+' отклонена. '+Number(updated.amount).toLocaleString('ru-RU')+' ⭐ возвращены на баланс.',{reply_markup:mainKeyboard(updated.telegram_id)}).catch(e=>console.error('Withdrawal player notification failed:',e.message));
      } else if (q.data === 'click') {
        await upsertPlayer(q.from,'');
        const r=await pool.query('UPDATE players SET clicks_count=clicks_count+1,updated_at=NOW() WHERE telegram_id=$1 RETURNING clicks_count,click_multiplier',[String(q.from.id)]);
        const clicks=Number(r.rows[0].clicks_count);const level=clicks<100?0:clicks<500?1:2+Math.floor((clicks-500)/500);const bonus=level>=100?0.05:level>=30?0.005:0;const gain=0.0001*Number(r.rows[0].click_multiplier)+bonus;
        const credited=await pool.query('UPDATE players SET balance=balance+$2,total=total+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(q.from.id),gain]);
        await bot.answerCallbackQuery(q.id,{text:'+'+gain.toFixed(4)+' звезды'});
        await bot.sendMessage(q.message.chat.id,`⭐ +${gain.toFixed(4)} звезды! Баланс: ${Number(credited.rows[0].balance).toFixed(4)}`,{reply_markup:mainKeyboard(q.from.id)});
      } else if(q.data==='star_shop') {
        await bot.answerCallbackQuery(q.id);
        const rows = [];
        for (const [id, product] of Object.entries(STAR_PRODUCTS)) {
          const orderId = crypto.randomUUID();
          await pool.query("INSERT INTO star_orders(id,telegram_id,product_id,stars,status) VALUES($1,$2,$3,$4,'pending')", [orderId, String(q.from.id), id, product.stars]);
          const invoiceUrl = await bot.createInvoiceLink(product.title, product.description, orderId, '', 'XTR', [{ label: product.title, amount: product.stars }]);
          rows.push([{ text: '⭐ ' + product.stars + ' — ' + product.title, url: invoiceUrl }]);
        }
        await bot.sendMessage(q.message.chat.id, '✨ <b>Улучшения за Telegram Stars</b>\n\nВыбери покупку ниже — оплата откроется в Telegram. Множитель клика действует постоянно.\n\nТакже магазин доступен в приложении.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [...rows, [{ text: '🛍 Открыть магазин в приложении', web_app: { url: APP_URL + '#shopPanel' } }], ...mainKeyboard(q.from.id).inline_keyboard] } });
      } else if(q.data==='balance') {
        const p=await upsertPlayer(q.from,''); await bot.answerCallbackQuery(q.id,{text:`Баланс: ${Number(p.balance).toFixed(4)} звёзд`,show_alert:true});
      } else if(q.data==='referral') {
        const me=await bot.getMe(); const link=`https://t.me/${me.username}?start=ref_${q.from.id}`;
        await bot.answerCallbackQuery(q.id,{text:'Ссылка готова'});
        await bot.sendMessage(q.message.chat.id,`🔗 Твоя реферальная ссылка:\n<code>${link}</code>\n\nОтправь её другу, чтобы он запустил Stars.`,{parse_mode:'HTML',reply_markup:mainKeyboard(q.from.id),disable_web_page_preview:true});
      } else if(q.data==='transfer_help') {
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(q.message.chat.id,'💸 Перевод звёзд:\nОтправь команду в таком формате:\n<code>/transfer @username 1.5</code>\n\nПолучатель должен заранее нажать /start в боте.',{parse_mode:'HTML'});
      }
    } catch(e) { console.error(e); bot.answerCallbackQuery(q.id,{text:'Ошибка. Попробуй ещё раз.'}).catch(()=>{}); }
  });
  bot.on('polling_error', e => console.error('Telegram polling error:', e.message));
}
app.get('/health', (_req,res)=>res.status(200).json({ok:true,dbReady,botEnabled:Boolean(bot),message:dbReady?(bot?'Stars is ready':'Database ready; BOT_TOKEN is not configured'):'PostgreSQL is not ready; check DATABASE_URL and Railway database logs'}));
app.get('/api/me', auth, async (req,res)=>res.json({player:publicPlayer(await getPlayer(req.player.telegram_id))}));
app.get('/api/shop/products', (_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({products:Object.entries(STAR_PRODUCTS).map(([id,p])=>({id,title:p.title,description:p.description,stars:p.stars,multiplier:p.multiplier}))});});
app.post('/api/shop/invoice', auth, async (req,res)=>{
  try {
    if (!bot) return res.status(503).json({error:'Telegram-бот сейчас недоступен.'});
    const product = STAR_PRODUCTS[String(req.body && req.body.productId || '')];
    if (!product) return res.status(400).json({error:'Неизвестное улучшение.'});
    const orderId = crypto.randomUUID();
    await pool.query('INSERT INTO star_orders(id,telegram_id,product_id,stars,status) VALUES($1,$2,$3,$4,\'pending\')', [orderId,String(req.player.telegram_id),String(req.body.productId),product.stars]);
    const invoiceUrl = await bot.createInvoiceLink(product.title, product.description, orderId, '', 'XTR', [{label:product.title,amount:product.stars}]);
    res.json({url:invoiceUrl,stars:product.stars});
  } catch(e) { console.error('Не удалось создать Stars invoice:',e.message); res.status(500).json({error:'Не удалось создать окно оплаты. Попробуй ещё раз.'}); }
});
app.post('/api/olympus/spin', auth, async (req,res)=>{
  const bet=Number(req.body && req.body.bet);
  const buyBonus=Boolean(req.body && req.body.buyBonus);
  const ante=Boolean(req.body && req.body.ante);
  if(!Number.isFinite(bet)||bet<0.1||bet>5||![0.1,0.25,0.5,1,2,5].some(v=>Math.abs(v-bet)<0.000001))
    return res.status(400).json({error:'Некорректная ставка.'});
  const symbols=[['ruby',.25],['amethyst',.2],['topaz',.18],['emerald',.22],['sapphire',.2],['cup',.5],['ring',.7],['hourglass',1],['crown',1.5]];
  const pick=()=>symbols[crypto.randomInt(symbols.length)][0];
  const lightningMultipliers=[2,2,2,3,3,5,5,10,10,25,50,100,250,500,1000];
  const pickLightningMultiplier=()=>lightningMultipliers[crypto.randomInt(lightningMultipliers.length)];
  const makeBoard=()=>Array.from({length:30},()=>{const r=crypto.randomInt(10000)/10000;return r<.003?'orb':r<.011?'zeus':pick()});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const id=String(req.player.telegram_id);
    const locked=await client.query('SELECT balance,total FROM players WHERE telegram_id=$1 FOR UPDATE',[id]);
    if(!locked.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Игрок не найден.'});}
    let session=(await client.query('SELECT free_spins,multiplier FROM olympus_sessions WHERE telegram_id=$1 FOR UPDATE',[id])).rows[0];
    if(!session){await client.query('INSERT INTO olympus_sessions(telegram_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);session={free_spins:0,multiplier:1};}
    let freeSpins=Number(session.free_spins)||0, multiplier=Number(session.multiplier)||1;
    let balance=Number(locked.rows[0].balance), total=Number(locked.rows[0].total), wagerAmount=0;
    if(buyBonus&&freeSpins===0){
      const cost=Number((bet*100).toFixed(8));
      wagerAmount=cost;
      if(balance+1e-9<cost){await client.query('ROLLBACK');return res.status(400).json({error:'Недостаточно монет для покупки 15 фриспинов. Нужно '+cost.toFixed(4)+'.'});}
      balance-=cost;freeSpins=15;multiplier=1;
    } else if(freeSpins===0){
      const cost=Number((bet*(ante?1.25:1)).toFixed(8));
      wagerAmount=cost;
      if(balance+1e-9<cost){await client.query('ROLLBACK');return res.status(400).json({error:'Недостаточно монет для ставки '+cost.toFixed(4)+'. Пополни баланс кликами.'});}
      balance-=cost;
    }
    const freeAtStart=freeSpins>0;
    let board=makeBoard();
    if(crypto.randomInt(10000)<(ante?80:30)){for(let n=0;n<4;n++)board[n]='zeus';}
    else if(crypto.randomInt(10000)<15){for(let n=0;n<3;n++)board[n]='zeus';}
    if(crypto.randomInt(100)<18){const sym=pick();for(let n=0;n<8;n++)board[n]=sym;}
    const scatter=board.filter(x=>x==='zeus').length;
    const displayBoard=[...board];
    const orbValues=displayBoard.map(x=>x==='orb'?pickLightningMultiplier():0);
    const effectiveBet=bet*(ante?1.25:1);
    let win=0,cascades=0;
    const cascadeSteps=[];
    for(let step=0;step<8;step++){
      const counts={};board.forEach(x=>counts[x]=(counts[x]||0)+1);
      const hits=Object.keys(counts).filter(x=>counts[x]>=8&&!['zeus','orb'].includes(x));
      if(!hits.length)break;
      const removed=board.map((x,i)=>hits.includes(x)?i:-1).filter(i=>i>=0);
      for(const sym of hits){const data=symbols.find(x=>x[0]===sym);win+=effectiveBet*data[1]*(counts[sym]/8);}
      // Apply gravity independently in each of the 6 columns so symbols outside
      // winning positions never jump sideways into another column.
      const nextBoard=Array(30);
      for(let col=0;col<6;col++){
        const kept=[];
        for(let row=4;row>=0;row--){
          const value=board[row*6+col];
          if(!hits.includes(value))kept.push(value);
        }
        while(kept.length<5)kept.push(pick());
        for(let row=4;row>=0;row--)nextBoard[row*6+col]=kept[4-row];
      }
      board=nextBoard;cascades++;
      cascadeSteps.push({removed,board:[...board]});
    }
    const orbSum=orbValues.reduce((sum,value)=>sum+value,0);
    if(freeAtStart&&orbSum>0)multiplier=Math.min(5000,multiplier+orbSum);
    if(freeAtStart)freeSpins=Math.max(0,freeSpins-1);
    if(freeAtStart&&scatter>=3)freeSpins+=5;
    if(scatter>=4&&!freeAtStart&&!buyBonus){freeSpins+=15;multiplier=1;}
    if(freeAtStart)win*=multiplier;else if(orbSum)win*=orbSum;
    win=Math.max(0,Math.min(Number(win.toFixed(8)),bet*5000));
    balance+=win;total+=win;
    await client.query('UPDATE players SET balance=$2,total=$3,updated_at=NOW() WHERE telegram_id=$1',[id,balance,total]);
    const completedPromos=[];
    if(wagerAmount>0){
      const activePromos=await client.query("SELECT code,reward,target,wagered FROM promo_wagers WHERE telegram_id=$1 AND status='pending' FOR UPDATE",[id]);
      for(const promo of activePromos.rows){
        const nextWagered=Number(promo.wagered)+wagerAmount;
        if(nextWagered+1e-8>=Number(promo.target)){
          balance+=Number(promo.reward);total+=Number(promo.reward);
          await client.query("UPDATE promo_wagers SET wagered=$3,status='completed',completed_at=NOW() WHERE code=$1 AND telegram_id=$2",[promo.code,id,nextWagered]);
          completedPromos.push({code:promo.code,reward:Number(promo.reward)});
        }else{
          await client.query("UPDATE promo_wagers SET wagered=$3 WHERE code=$1 AND telegram_id=$2",[promo.code,id,nextWagered]);
        }
      }
      if(completedPromos.length){
        await client.query('UPDATE players SET balance=$2,total=$3,updated_at=NOW() WHERE telegram_id=$1',[id,balance,total]);
      }
    }
    const promoProgress=await client.query("SELECT code,reward,target,wagered,status FROM promo_wagers WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 10",[id]);
    await client.query('INSERT INTO olympus_sessions(telegram_id,free_spins,multiplier,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(telegram_id) DO UPDATE SET free_spins=EXCLUDED.free_spins,multiplier=EXCLUDED.multiplier,updated_at=NOW()',[id,freeSpins,multiplier]);
    await client.query('COMMIT');
    res.setHeader('Cache-Control','no-store');
    res.json({balance,total,win,freeSpins,multiplier,cascades,scatter,orbSum,orbValues,board:displayBoard,finalBoard:board,cascadeSteps,completedPromos,promoProgress:promoProgress.rows.map(p=>({code:p.code,reward:Number(p.reward),target:Number(p.target),wagered:Number(p.wagered),status:p.status}))});
  }catch(e){await client.query('ROLLBACK');console.error('Olympus spin error:',e.stack||e.message);res.status(500).json({error:'Не удалось провести спин. Баланс не изменён.'});}
  finally{client.release();}
});
app.post('/api/roulette/spin', auth, async (req,res)=>{
  const bet=Number(req.body&&req.body.bet);
  const pick=String(req.body&&req.body.pick||'');
  const validBets=[0.1,0.25,0.5,1,2,5];
  if(!Number.isFinite(bet)||!validBets.some(v=>Math.abs(v-bet)<1e-8))
    return res.status(400).json({error:'Некорректная ставка рулетки.'});
  if(!/^(red|black|even|odd|green|number:(?:[0-9]|[12][0-9]|3[0-6]))$/.test(pick))
    return res.status(400).json({error:'Выбери цвет, чёт/нечёт или число от 0 до 36.'});
  const red=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const locked=await client.query('SELECT balance,total FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.player.telegram_id)]);
    if(!locked.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Игрок не найден.'});}
    const cost=Number((bet*100).toFixed(8)),balanceNow=Number(locked.rows[0].balance);
    if(balanceNow+1e-9<cost){await client.query('ROLLBACK');return res.status(400).json({error:'Недостаточно монет для ставки '+cost.toFixed(4)+'.'});}
    const number=crypto.randomInt(37);
    const color=number===0?'green':red.has(number)?'red':'black';
    const won=pick==='green'?number===0:pick==='red'?color==='red':pick==='black'?color==='black':pick==='even'?number!==0&&number%2===0:pick==='odd'?number%2===1:pick.startsWith('number:')&&number===Number(pick.slice(7));
    const multiplier=pick==='green'?36:pick.startsWith('number:')?36:2;
    const win=won?Number((cost*multiplier).toFixed(8)):0;
    const balance=Number((balanceNow-cost+win).toFixed(8));
    const total=Number(locked.rows[0].total)+win;
    await client.query('UPDATE players SET balance=$2,total=total+$3,updated_at=NOW() WHERE telegram_id=$1',[String(req.player.telegram_id),balance,win]);
    await client.query('COMMIT');
    res.setHeader('Cache-Control','no-store');
    res.json({number,color,win,balance,total,pick,multiplier:won?multiplier:0});
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Roulette spin error:',e.stack||e.message);
    res.status(500).json({error:'Не удалось прокрутить рулетку.'});
  }finally{client.release();}
});
app.post('/api/click', auth, async (req,res)=>{
  try {
    const id=String(req.player.telegram_id);
    const r=await pool.query(`
      UPDATE players
      SET clicks_count=clicks_count+1,
          balance=balance+(0.0001*click_multiplier + CASE WHEN clicks_count+1>=49500 THEN 0.05 WHEN clicks_count+1>=14500 THEN 0.005 ELSE 0 END),
          total=total+(0.0001*click_multiplier + CASE WHEN clicks_count+1>=49500 THEN 0.05 WHEN clicks_count+1>=14500 THEN 0.005 ELSE 0 END),
          updated_at=NOW()
      WHERE telegram_id=$1
      RETURNING clicks_count,balance,total,click_multiplier,
        (0.0001*click_multiplier + CASE WHEN clicks_count>=49500 THEN 0.05 WHEN clicks_count>=14500 THEN 0.005 ELSE 0 END) AS gain
    `,[id]);
    if(!r.rowCount) return res.status(404).json({error:'Игрок не найден. Закрой приложение и открой его через Telegram-бота.'});
    const p=r.rows[0], clicks=Number(p.clicks_count);
    const level=clicks<100?0:clicks<500?1:2+Math.floor((clicks-500)/500);
    const bonus=clicks>=49500?0.05:clicks>=14500?0.005:0;
    res.setHeader('Cache-Control','no-store');
    res.json({balance:Number(p.balance),total:Number(p.total),gain:Number(p.gain),clickMultiplier:Number(p.click_multiplier),clicks,level,clickBonus:bonus});
  } catch(e) {
    console.error('Click API error:',e.stack||e.message);
    res.status(500).json({error:'Ошибка начисления в базе данных. Попробуй ещё раз.'});
  }
});
app.post('/api/profile', auth, async (_req,res)=>res.status(403).json({error:'Имя и аватар можно изменить только через Telegram-бота.'}));
app.get('/api/referral', auth, async (req,res)=>{
  try{
    const info=await bot?.getMe();
    if(!info?.username) return res.status(503).json({error:'Бот временно недоступен.'});
    res.json({url:'https://t.me/'+info.username+'?start=ref_'+String(req.player.telegram_id)});
  }catch(e){res.status(503).json({error:'Не удалось получить ссылку приглашения.'});}
});
app.post('/api/transfer', auth, async (req,res)=>{
  try {
    const amount=Number(req.body.amount);
    const username=String(req.body.username||'').trim();
    if(!/^@?[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(400).json({error:'Укажи корректный @username получателя.'});
    const result=await transfer(req.player.telegram_id,username,amount);
    res.json({amount:result.amount,balance:result.balance,recipient:result.recipient.display_name});
    if(bot) bot.sendMessage(String(result.recipient.telegram_id),'✨ Тебе поступило '+result.amount.toFixed(4)+' звёзд от игрока '+escapeHtml(req.player.first_name||'Игрок')+'!',{parse_mode:'HTML'}).catch(()=>{});
  } catch(e) { res.status(400).json({error:e.message||'Не удалось выполнить перевод.'}); }
});
app.get('/api/withdrawals', auth, async (req,res)=>{
  try {
    const r=await pool.query('SELECT id,amount,username,status,created_at FROM withdrawal_requests WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 30',[String(req.player.telegram_id)]);
    res.setHeader('Cache-Control','no-store');
    res.json({requests:r.rows.map(x=>({id:String(x.id),amount:Number(x.amount),username:x.username,status:x.status,createdAt:x.created_at}))});
  } catch(e) { console.error('Withdrawal list error:',e.message);res.status(500).json({error:'Не удалось загрузить заявки на вывод.'}); }
});
app.post('/api/withdrawals', auth, async (req,res)=>{
  const amount=Number(req.body&&req.body.amount);
  const username=String(req.body&&req.body.username||'').trim();
  if(!Number.isInteger(amount)||amount<300||amount>1000000000) return res.status(400).json({error:'Минимальный вывод — 300 звёзд. Укажи целую сумму.'});
  if(!/^@?[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(400).json({error:'Укажи корректный Telegram @username.'});
  const normalized='@'+username.replace(/^@/,'');
  const client=await pool.connect();
  let request,balance;
  try{
    await client.query('BEGIN');
    const p=await client.query('SELECT balance FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.player.telegram_id)]);
    if(!p.rowCount) throw new Error('Игрок не найден.');
    if(Number(p.rows[0].balance)+1e-9<amount) throw new Error('Недостаточно звёзд на балансе для вывода.');
    await client.query('UPDATE players SET balance=balance-$2,updated_at=NOW() WHERE telegram_id=$1',[String(req.player.telegram_id),amount]);
    const r=await client.query("INSERT INTO withdrawal_requests(telegram_id,amount,username) VALUES($1,$2,$3) RETURNING id,amount,username,status,created_at",[String(req.player.telegram_id),amount,normalized]);
    request=r.rows[0];
    const b=await client.query('SELECT balance FROM players WHERE telegram_id=$1',[String(req.player.telegram_id)]);
    balance=Number(b.rows[0].balance);
    await client.query('COMMIT');
    res.setHeader('Cache-Control','no-store');
    res.json({request:{id:String(request.id),amount:Number(request.amount),username:request.username,status:request.status,createdAt:request.created_at},balance});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});return res.status(400).json({error:e.message||'Не удалось создать заявку.'});}
  finally{client.release();}
  if(bot){
    const adminId=process.env.ADMIN_ID;
    if(adminId){
      const who=req.player.username?'@'+req.player.username:req.player.display_name;
      const text='📤 <b>Новая заявка на вывод звёзд</b>\n\nЗаявка: <code>#'+request.id+'</code>\nСумма: <b>'+Number(request.amount).toLocaleString('ru-RU')+' ⭐</b>\nКуда зачислить: <b>'+escapeHtml(request.username)+'</b>\nИгрок: '+escapeHtml(who)+'\nTelegram ID: <code>'+escapeHtml(req.player.telegram_id)+'</code>\nСтатус: ⏳ Ожидание';
      bot.sendMessage(String(adminId).trim(),text,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'✅ Выплачено',callback_data:'withdraw_paid:'+request.id},{text:'❌ Отказать',callback_data:'withdraw_reject:'+request.id}]]}}).then(()=>console.log('Withdrawal notification sent to ADMIN_ID='+String(adminId).trim()+' for request #'+request.id)).catch(e=>console.error('Withdrawal admin notification failed for request #'+request.id+' to ADMIN_ID='+String(adminId).trim()+':',e.message));
    }else console.error('ADMIN_ID is not configured; withdrawal notification was not sent.');
  }
});
app.get('/api/daily-wheel', auth, async (req,res)=>{
  const r=await pool.query('SELECT spin_date,reward FROM daily_spins WHERE telegram_id=$1',[String(req.player.telegram_id)]);
  const today= (await pool.query("SELECT CURRENT_DATE AS today")).rows[0].today;
  const last=r.rows[0];
  res.json({canSpin:!last||String(last.spin_date).slice(0,10)!==String(today).slice(0,10),lastReward:last?Number(last.reward):null});
});
app.post('/api/daily-wheel/spin', auth, async (req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const today=(await client.query('SELECT CURRENT_DATE AS today')).rows[0].today;
    const old=await client.query('SELECT spin_date,reward FROM daily_spins WHERE telegram_id=$1 FOR UPDATE',[String(req.player.telegram_id)]);
    if(old.rowCount&&String(old.rows[0].spin_date).slice(0,10)===String(today).slice(0,10)){await client.query('ROLLBACK');return res.status(409).json({error:'Колесо уже использовано сегодня.',canSpin:false,lastReward:Number(old.rows[0].reward)});}
    const reward=1+Math.floor(Math.random()*5);
    await client.query('UPDATE players SET balance=balance+$2,total=total+$2,updated_at=NOW() WHERE telegram_id=$1',[String(req.player.telegram_id),reward]);
    await client.query('INSERT INTO daily_spins(telegram_id,spin_date,reward) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET spin_date=EXCLUDED.spin_date,reward=EXCLUDED.reward,created_at=NOW()',[String(req.player.telegram_id),today,reward]);
    const p=await client.query('SELECT balance,total FROM players WHERE telegram_id=$1',[String(req.player.telegram_id)]);
    await client.query('COMMIT');
    res.json({reward,balance:Number(p.rows[0].balance),total:Number(p.rows[0].total),canSpin:false});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Daily wheel error:',e.message);res.status(500).json({error:'Не удалось прокрутить колесо.'});}
  finally{client.release();}
});
app.post('/api/promo/activate', auth, async (req,res)=>{
  const code=String(req.body.code||'').trim().toUpperCase();
  if(!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({error:'Проверь промокод.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const p=await client.query('SELECT amount,max_uses,uses,active,wagering_multiplier FROM promo_codes WHERE code=$1 FOR UPDATE',[code]);
    if(!p.rowCount||!p.rows[0].active) throw new Error('Промокод не найден или отключён.');
    if(Number(p.rows[0].uses)>=Number(p.rows[0].max_uses)) throw new Error('Активации этого промокода закончились.');
    await client.query('INSERT INTO promo_redemptions(code,telegram_id) VALUES($1,$2)',[code,String(req.player.telegram_id)]);
    const amount=Number(p.rows[0].amount), wageringMultiplier=Number(p.rows[0].wagering_multiplier||1);
    await client.query('UPDATE promo_codes SET uses=uses+1 WHERE code=$1',[code]);
    let balance,total,wagering=null;
    if(wageringMultiplier>1){
      const target=amount*wageringMultiplier;
      await client.query('INSERT INTO promo_wagers(code,telegram_id,reward,target,wagered,status) VALUES($1,$2,$3,$4,0,\'pending\')',[code,String(req.player.telegram_id),amount,target]);
      const pNow=await client.query('SELECT balance,total FROM players WHERE telegram_id=$1',[String(req.player.telegram_id)]);
      balance=Number(pNow.rows[0].balance);total=Number(pNow.rows[0].total);
      wagering={target,wagered:0,remaining:target,reward:amount,status:'pending'};
    }else{
      const bal=await client.query('UPDATE players SET balance=balance+$2,total=total+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance,total',[String(req.player.telegram_id),amount]);
      balance=Number(bal.rows[0].balance);total=Number(bal.rows[0].total);
    }
    await client.query('COMMIT');
    res.json({code,amount,balance,total,wageringMultiplier,wagering});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.code==='23505'?'Ты уже активировал этот промокод.':e.message||'Не удалось активировать промокод.'});}
  finally{client.release();}
});
app.get('/api/promo/progress', auth, async (req,res)=>{
  try{
    const r=await pool.query("SELECT code,reward,target,wagered,status,created_at FROM promo_wagers WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 10",[String(req.player.telegram_id)]);
    res.setHeader('Cache-Control','no-store');
    res.json({promos:r.rows.map(p=>({code:p.code,reward:Number(p.reward),target:Number(p.target),wagered:Number(p.wagered),remaining:Math.max(0,Number(p.target)-Number(p.wagered)),status:p.status,createdAt:p.created_at}))});
  }catch(e){console.error('Promo progress error:',e.message);res.status(500).json({error:'Не удалось загрузить прогресс промокодов.'});}
});
app.get('/api/leaderboard', auth, async (req,res)=>{
  const r=await pool.query('SELECT telegram_id,username,display_name,avatar,balance,total,clicks_count,click_multiplier FROM players ORDER BY balance DESC,total DESC,created_at ASC LIMIT 100');
  res.json({players:r.rows.map((p,i)=>({...publicPlayer(p),rank:i+1,isMe:String(p.telegram_id)===String(req.player.telegram_id)}))});
});
app.get('/api/players/:id', auth, async (req,res)=>{
  const r=await pool.query('SELECT telegram_id,username,display_name,avatar,balance,total,clicks_count,click_multiplier,created_at FROM players WHERE telegram_id=$1',[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Игрок не найден.'});
  const p=r.rows[0]; res.json({player:{...publicPlayer(p),createdAt:p.created_at}});
});

app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,()=>console.log('Stars web server listening on '+PORT));
pool.on('error', e => console.error('PostgreSQL pool error:', e.message));
// Start Telegram polling independently from PostgreSQL so /start can explain a DB outage.
registerBot();
(async()=>{
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL is not configured. In Railway, reference the PostgreSQL service variable DATABASE_URL.');
    if (/localhost|127\\.0\\.0\\.1|\\[::1\\]/i.test(dbUrl)) throw new Error('DATABASE_URL points to localhost. Use the DATABASE_URL value from the Railway PostgreSQL service, not localhost.');
    await initDb();
    dbReady = true;
    console.log('PostgreSQL connected; database ready.');
  } catch(e) {
    dbReady = false;
    console.error('PostgreSQL initialization failed. Check Railway Variables: DATABASE_URL must reference the PostgreSQL service. Error:',e.message);
  }
})();
