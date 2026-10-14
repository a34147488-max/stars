const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = (process.env.APP_URL || 'https://stars-production-0668.up.railway.app').replace(/\/$/, '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
let bot = null;
let dbReady = false;
const STAR_PRODUCTS = {
  boost_50: { title: 'Искра x2', description: 'Постоянный множитель клика x2', stars: 50, multiplier: 2 },
  boost_75: { title: 'Импульс x2.5', description: 'Постоянный множитель клика x2.5', stars: 75, multiplier: 2.5 },
  boost_100: { title: 'Сияние x3', description: 'Постоянный множитель клика x3', stars: 100, multiplier: 3 },
  boost_150: { title: 'Пульсар x4', description: 'Постоянный множитель клика x4', stars: 150, multiplier: 4 },
  boost_200: { title: 'Сверхновая x5', description: 'Постоянный множитель клика x5', stars: 200, multiplier: 5 },
  boost_250: { title: 'Квант x6', description: 'Постоянный множитель клика x6', stars: 250, multiplier: 6 },
  boost_300: { title: 'Галактика x7', description: 'Постоянный множитель клика x7', stars: 300, multiplier: 7 },
  boost_350: { title: 'Космос x8', description: 'Постоянный множитель клика x8', stars: 350, multiplier: 8 },
  boost_400: { title: 'Вселенная x9', description: 'Постоянный множитель клика x9', stars: 400, multiplier: 9 },
  boost_500: { title: 'Бог звёзд x10', description: 'Постоянный множитель клика x10', stars: 500, multiplier: 10 }
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT UNIQUE,
      display_name TEXT NOT NULL DEFAULT 'Игрок',
      avatar TEXT NOT NULL DEFAULT '⭐',
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
    CREATE INDEX IF NOT EXISTS players_username_lower_idx ON players (LOWER(username));
  `);
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
      await client.query(
        'INSERT INTO players (telegram_id, username, display_name, referred_by) VALUES ($1,$2,$3,$4) ON CONFLICT (telegram_id) DO NOTHING',
        [id, username, displayName, validRef]
      );
    } else {
      await client.query('UPDATE players SET username=$2, updated_at=NOW() WHERE telegram_id=$1', [id, username]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getPlayer(id);
}
async function getPlayer(id) {
  const r = await pool.query('SELECT telegram_id, username, display_name, avatar, balance, total, referred_by FROM players WHERE telegram_id=$1', [String(id)]);
  return r.rows[0] || null;
}
function publicPlayer(p) {
  return { id: String(p.telegram_id), username: p.username, name: p.display_name, avatar: p.avatar, balance: Number(p.balance), total: Number(p.total), referredBy: p.referred_by ? String(p.referred_by) : null };
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
  return {
    inline_keyboard: [
      [{ text: '⭐ Открыть кликер', web_app: { url: APP_URL } }],
      [{ text: '✨ Улучшения за Telegram Stars', callback_data: 'star_shop' }],
      [{ text: '👤 Профиль и аватар', web_app: { url: APP_URL + '#profilePanel' } }],
      [{ text: '✨ Кликнуть +0.0001', callback_data: 'click' }, { text: '💰 Баланс', callback_data: 'balance' }],
      [{ text: '🔗 Реферальная ссылка', callback_data: 'referral' }],
      [{ text: '💸 Перевод звёзд', callback_data: 'transfer_help' }]
    ]
  };
}
async function botStart(msg) {
  const user = msg.from;
  const payload = (msg.text || '').split(/\s+/)[1] || '';
  const p = await upsertPlayer(user, payload);
  const botInfo = await bot.getMe();
  const link = `https://t.me/${botInfo.username}?start=ref_${user.id}`;
  const text = `❄️ <b>Добро пожаловать в Stars!</b>\n\n⭐ Баланс: <b>${Number(p.balance).toFixed(4)} звёзд</b>\n👤 Имя: <b>${escapeHtml(p.display_name)}</b>\n\nНажимай на звезду в приложении. Чтобы изменить имя, отправь боту команду <code>/name Новое имя</code>, а чтобы сменить аватар — пришли боту фотографию. Приглашай друзей и отправляй звёзды другим игрокам.\n\n🔗 Твоя ссылка:\n<code>${link}</code>\n\nДля перевода используй: <code>/transfer @username 1.5</code>`;
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', reply_markup: mainKeyboard(user.id), disable_web_page_preview: true });
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function botClick(chatId, from) {
  const p = await upsertPlayer(from, '');
  const r = await pool.query('UPDATE players SET balance=balance+0.0001,total=total+0.0001,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance', [String(from.id)]);
  await bot.sendMessage(chatId, `⭐ +0.0001 звезды!\nБаланс: ${Number(r.rows[0].balance).toFixed(4)} звёзд`, { reply_markup: mainKeyboard(from.id) });
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
  bot.onText(/^\/balance/, async msg => { try { const p=await upsertPlayer(msg.from,''); bot.sendMessage(msg.chat.id, `⭐ Твой баланс: ${Number(p.balance).toFixed(4)} звёзд`, {reply_markup:mainKeyboard(msg.from.id)}); } catch(e) { bot.sendMessage(msg.chat.id,'Ошибка получения баланса.'); } });
  bot.onText(/^\/transfer\s+(@?[A-Za-z0-9_]{5,32})\s+([0-9]+(?:[.,][0-9]{1,8})?)/, async (msg, m) => {
    try { await upsertPlayer(msg.from,''); const result=await transfer(msg.from.id,m[1],Number(m[2].replace(',','.'))); await bot.sendMessage(msg.chat.id,`✅ Переведено ${result.amount.toFixed(4)} звёзд игроку ${escapeHtml(result.recipient.display_name)}. Остаток: ${result.balance.toFixed(4)} звёзд.`,{parse_mode:'HTML',reply_markup:mainKeyboard(msg.from.id)}); await bot.sendMessage(String(result.recipient.telegram_id),`✨ Тебе поступило ${result.amount.toFixed(4)} звёзд от игрока ${escapeHtml(msg.from.first_name || 'Игрок')}!`,{parse_mode:'HTML'}).catch(()=>{}); }
    catch(e) { bot.sendMessage(msg.chat.id, '❌ '+e.message); }
  });
  bot.on('callback_query', async q => {
    try {
      if (q.data === 'click') {
        const p=await upsertPlayer(q.from,'');
        const r=await pool.query('UPDATE players SET balance=balance+0.0001,total=total+0.0001,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(q.from.id)]);
        await bot.answerCallbackQuery(q.id,{text:'+0.0001 звезды'});
        await bot.sendMessage(q.message.chat.id,`⭐ +0.0001 звезды! Баланс: ${Number(r.rows[0].balance).toFixed(4)}`,{reply_markup:mainKeyboard(q.from.id)});
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
app.get('/api/shop/products', (_req,res)=>res.json({products:Object.entries(STAR_PRODUCTS).map(([id,p])=>({id,title:p.title,description:p.description,stars:p.stars,multiplier:p.multiplier}))}));
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
app.post('/api/click', auth, async (req,res)=>{const r=await pool.query('UPDATE players SET balance=balance+(0.0001*click_multiplier),total=total+(0.0001*click_multiplier),updated_at=NOW() WHERE telegram_id=$1 RETURNING balance,total,click_multiplier',[String(req.player.telegram_id)]);const amount=0.0001*Number(r.rows[0].click_multiplier);res.json({balance:Number(r.rows[0].balance),total:Number(r.rows[0].total),gain:amount,clickMultiplier:Number(r.rows[0].click_multiplier)});});
app.post('/api/profile', auth, async (_req,res)=>res.status(403).json({error:'Имя и аватар можно изменить только через Telegram-бота.'}));
app.get('/api/leaderboard', auth, async (req,res)=>{
  const r=await pool.query('SELECT telegram_id,username,display_name,avatar,balance,total FROM players ORDER BY balance DESC,total DESC,created_at ASC LIMIT 100');
  res.json({players:r.rows.map((p,i)=>({...publicPlayer(p),rank:i+1,isMe:String(p.telegram_id)===String(req.player.telegram_id)}))});
});
app.get('/api/players/:id', auth, async (req,res)=>{
  const r=await pool.query('SELECT telegram_id,username,display_name,avatar,balance,total,created_at FROM players WHERE telegram_id=$1',[req.params.id]);
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
