const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 8080;
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use('/api', async (req, res, next) => {
  if (req.path === '/telegram/webhook' || req.path === '/health') return next();
  try {
    const user = validateTelegramInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN);
    if (!user) return next();
    await ensureDb();
    const status = await pool.query('SELECT is_blocked FROM stars_users WHERE telegram_id=$1', [String(user.id)]);
    await pool.query('UPDATE stars_users SET last_seen_at=NOW() WHERE telegram_id=$1', [String(user.id)]);
    if (status.rows[0]?.is_blocked) return res.status(403).json({ok:false,error:'Доступ к Stars ограничен администрацией.'});
    if (req.method === 'POST') { const m=await pool.query("SELECT value FROM stars_settings WHERE key='maintenance'"); const admin=await pool.query('SELECT 1 FROM stars_admins WHERE telegram_id=$1',[String(user.id)]); if(m.rows[0]?.value==='on'&&!admin.rowCount) return res.status(503).json({ok:false,error:'Ведутся технические работы. Действия в приложении временно ограничены.'}); }
    return next();
  } catch (e) {
    console.error('Player access check failed:', e.message);
    return res.status(503).json({ok:false,error:'Не удалось проверить доступ к приложению.'});
  }
});
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
const activeAppUsers = new Map();
app.post('/api/presence', async (req,res) => { const user=validateTelegramInitData(req.get('X-Telegram-Init-Data'),process.env.BOT_TOKEN); if(!user)return res.status(401).json({ok:false}); const now=Date.now(); for(const [id,t] of activeAppUsers)if(now-t>90000)activeAppUsers.delete(id); activeAppUsers.set(String(user.id),now); return res.json({ok:true,online:activeAppUsers.size}); });
app.get('/api/status', async (req,res) => { try { await ensureDb(); const r=await pool.query("SELECT value FROM stars_settings WHERE key='maintenance'"); const user=validateTelegramInitData(req.get('X-Telegram-Init-Data'),process.env.BOT_TOKEN); const admin=user?await pool.query('SELECT 1 FROM stars_admins WHERE telegram_id=$1',[String(user.id)]):{rowCount:0}; return res.json({ok:true,maintenance:r.rows[0]?.value==='on',isAdmin:Boolean(admin.rowCount),online:activeAppUsers.size}); } catch(e) { return res.json({ok:true,maintenance:false,isAdmin:false,online:activeAppUsers.size}); } });
async function ensureDb() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  if (dbReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stars_users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, balance BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), is_blocked BOOLEAN NOT NULL DEFAULT FALSE);\n    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();\n    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS cashback_balance BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS cashback_expires_at TIMESTAMPTZ;
    UPDATE stars_users SET last_seen_at=registered_at WHERE last_seen_at IS NULL;
    CREATE TABLE IF NOT EXISTS stars_admins (telegram_id BIGINT PRIMARY KEY, username TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_withdrawals (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, username TEXT, first_name TEXT, target_username TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount >= 1000), payout_stars BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_payments (telegram_payment_charge_id TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, package_stars INTEGER NOT NULL, coins BIGINT NOT NULL, currency TEXT NOT NULL, total_amount INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_promocodes (code TEXT PRIMARY KEY, reward BIGINT NOT NULL CHECK (reward > 0), max_activations INTEGER NOT NULL CHECK (max_activations > 0), activations INTEGER NOT NULL DEFAULT 0 CHECK (activations >= 0 AND activations <= max_activations));
    CREATE TABLE IF NOT EXISTS stars_promocode_uses (code TEXT NOT NULL REFERENCES stars_promocodes(code), telegram_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (code, telegram_id));
    CREATE TABLE IF NOT EXISTS stars_bonus_links (token TEXT PRIMARY KEY, balance_type TEXT NOT NULL CHECK (balance_type IN ('main','city')), reward NUMERIC(20,2) NOT NULL CHECK (reward > 0), max_activations INTEGER NOT NULL CHECK (max_activations > 0), activations INTEGER NOT NULL DEFAULT 0 CHECK (activations >= 0 AND activations <= max_activations), created_by BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_bonus_link_uses (token TEXT NOT NULL REFERENCES stars_bonus_links(token), telegram_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(token,telegram_id));
    CREATE TABLE IF NOT EXISTS stars_box_promos (telegram_id BIGINT PRIMARY KEY, code TEXT NOT NULL, activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, free_spins_remaining INTEGER NOT NULL DEFAULT 2 CHECK (free_spins_remaining >= 0));
    CREATE TABLE IF NOT EXISTS stars_door_game_state (telegram_id BIGINT PRIMARY KEY REFERENCES stars_users(telegram_id) ON DELETE CASCADE, stage INTEGER NOT NULL DEFAULT 1 CHECK(stage BETWEEN 1 AND 3), lost BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE stars_door_game_state ADD COLUMN IF NOT EXISTS free_attempt_at TIMESTAMPTZ;
    ALTER TABLE stars_door_game_state ADD COLUMN IF NOT EXISTS pending_reward NUMERIC(20,2) NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS stars_daily_games (telegram_id BIGINT NOT NULL, game TEXT NOT NULL CHECK (game IN ('dice','darts','slots')), played_on DATE NOT NULL DEFAULT CURRENT_DATE, choice TEXT, value INTEGER, won BOOLEAN NOT NULL DEFAULT FALSE, payout BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (telegram_id,game,played_on));
    CREATE TABLE IF NOT EXISTS stars_referrals (referred_id BIGINT PRIMARY KEY, referrer_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (referred_id <> referrer_id));
    CREATE TABLE IF NOT EXISTS stars_slot_wins (telegram_id BIGINT PRIMARY KEY, total_won BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_double_wins (telegram_id BIGINT PRIMARY KEY, total_won BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_cup_wins (telegram_id BIGINT PRIMARY KEY, total_won BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS stars_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE stars_withdrawals ADD COLUMN IF NOT EXISTS rejection_comment TEXT;
    ALTER TABLE stars_users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE stars_users ALTER COLUMN balance TYPE NUMERIC(20,2) USING balance::numeric;
    CREATE TABLE IF NOT EXISTS stars_city_stats (
      telegram_id BIGINT PRIMARY KEY REFERENCES stars_users(telegram_id) ON DELETE CASCADE,
      city TEXT NOT NULL DEFAULT 'egorshino' CHECK (city IN ('egorshino','rezh','alapaevsk','berezovsky','ekaterinburg','bulanash')),
      clicks BIGINT NOT NULL DEFAULT 0,
      balance NUMERIC(20,2) NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      golden_frame BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stars_world_stats (telegram_id BIGINT PRIMARY KEY REFERENCES stars_users(telegram_id) ON DELETE CASCADE, clicks BIGINT NOT NULL DEFAULT 0, energy INTEGER NOT NULL DEFAULT 500 CHECK (energy BETWEEN 0 AND 500), energy_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_steal_at TIMESTAMPTZ);
    INSERT INTO stars_city_stats(telegram_id) SELECT telegram_id FROM stars_users ON CONFLICT(telegram_id) DO NOTHING;
  `);
  await pool.query('ALTER TABLE stars_city_stats ADD COLUMN IF NOT EXISTS balance NUMERIC(20,2) NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE stars_city_stats DROP CONSTRAINT IF EXISTS stars_city_stats_city_check");
  await pool.query("ALTER TABLE stars_city_stats ADD CONSTRAINT stars_city_stats_city_check CHECK (city IN ('egorshino','rezh','alapaevsk','berezovsky','ekaterinburg','bulanash'))");
  await pool.query("ALTER TABLE stars_city_stats ADD COLUMN IF NOT EXISTS district TEXT");
  await pool.query("ALTER TABLE stars_city_stats ADD COLUMN IF NOT EXISTS district_auto_rate NUMERIC(10,4) NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE stars_city_stats ADD COLUMN IF NOT EXISTS auto_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  const cityBalanceMigration = await pool.query("SELECT 1 FROM stars_settings WHERE key='city_balance_split_v1'");
  if (!cityBalanceMigration.rowCount) {
    await pool.query(`UPDATE stars_city_stats cs SET balance=LEAST(u.balance::numeric, cs.clicks * CASE cs.city WHEN 'egorshino' THEN 0.50 WHEN 'rezh' THEN 0.90 WHEN 'alapaevsk' THEN 1.25 WHEN 'berezovsky' THEN 1.55 WHEN 'ekaterinburg' THEN 2.25 ELSE 0.50 END), updated_at=NOW() FROM stars_users u WHERE u.telegram_id=cs.telegram_id`);
    await pool.query(`UPDATE stars_users u SET balance=GREATEST(0,u.balance::numeric-LEAST(u.balance::numeric,cs.clicks * CASE cs.city WHEN 'egorshino' THEN 0.50 WHEN 'rezh' THEN 0.90 WHEN 'alapaevsk' THEN 1.25 WHEN 'berezovsky' THEN 1.55 WHEN 'ekaterinburg' THEN 2.25 ELSE 0.50 END)),updated_at=NOW() FROM stars_city_stats cs WHERE cs.telegram_id=u.telegram_id`);
    await pool.query("INSERT INTO stars_settings(key,value) VALUES('city_balance_split_v1','done') ON CONFLICT(key) DO NOTHING");
  }
  const promoCodes = ['STAR200-K7Q4', 'STAR200-M9X2', 'STAR200-P5L8', 'STAR200-R3V6', 'STAR200-T8N4', 'STAR200-W2D7', 'STAR200-B6H9', 'STAR200-C4Z1', 'STAR200-F7J3', 'STAR200-Y5G8'];
  for (const code of promoCodes) await pool.query('INSERT INTO stars_promocodes (code,reward,max_activations) VALUES ($1,200,1) ON CONFLICT (code) DO NOTHING', [code]);
  await pool.query("INSERT INTO stars_promocodes (code,reward,max_activations) VALUES ('STAR-12BOX',1,10) ON CONFLICT (code) DO NOTHING");
  // One-time global leaderboard reset requested by the owner. Balances are not modified.
  const resetMarker = await pool.query("SELECT 1 FROM stars_settings WHERE key='leaderboard_reset_all_v1'");
  if (!resetMarker.rowCount) {
    await pool.query('UPDATE stars_slot_wins SET total_won=0, updated_at=NOW()');
    await pool.query('UPDATE stars_double_wins SET total_won=0, updated_at=NOW()');
    await pool.query('UPDATE stars_cup_wins SET total_won=0, updated_at=NOW()');
    await pool.query("INSERT INTO stars_settings (key,value) VALUES ('leaderboard_reset_all_v1','done') ON CONFLICT (key) DO NOTHING");
  }
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
app.post('/api/payments/create-custom-invoice',async(req,res)=>{try{await ensureDb();const user=validateTelegramInitData(req.get('X-Telegram-Init-Data'),process.env.BOT_TOKEN);if(!user)return res.status(401).json({ok:false,error:'Не удалось подтвердить Telegram-профиль.'});const coins=Math.floor(Number(req.body?.coins)),stars=Math.ceil(coins/10);if(!Number.isSafeInteger(coins)||coins<500||coins>531914||Number(req.body?.stars)!==stars)return res.status(400).json({ok:false,error:'Некорректная сумма пополнения.'});await pool.query('INSERT INTO stars_users (telegram_id,username,first_name) VALUES ($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW(),last_seen_at=NOW()',[String(user.id),user.username||null,user.first_name||null]);const payload=JSON.stringify({userId:String(user.id),stars,coins,custom:true,nonce:crypto.randomBytes(16).toString('hex')}),title='Пополнение Stars — '+coins+' игровых звёзд';const url=await telegramApi('createInvoiceLink',{title,description:'Пополнение игрового баланса на '+coins+' звёзд.',payload,currency:'XTR',prices:[{label:title,amount:stars}]});return res.json({ok:true,url,package:{stars,coins}});}catch(e){console.error('Custom invoice error:',e.message);return res.status(503).json({ok:false,error:'Не удалось создать счёт Telegram Stars.'});}});
async function addCashback(client, telegramId, stake) { const amount=Math.floor(Number(stake)*0.10); if(!Number.isSafeInteger(amount)||amount<1)return; await client.query("UPDATE stars_users SET cashback_balance=CASE WHEN cashback_expires_at IS NULL OR cashback_expires_at<=NOW() THEN $2 ELSE cashback_balance+$2 END, cashback_expires_at=((date_trunc('week',NOW() AT TIME ZONE 'Europe/Moscow')+INTERVAL '8 days') AT TIME ZONE 'Europe/Moscow') WHERE telegram_id=$1",[String(telegramId),amount]); }
app.get('/api/cashback',async(req,res)=>{try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const r=await pool.query("SELECT CASE WHEN cashback_expires_at IS NULL OR cashback_expires_at<=NOW() THEN 0 ELSE cashback_balance END AS balance,cashback_expires_at,(EXTRACT(DOW FROM NOW() AT TIME ZONE 'Europe/Moscow') IN (0,1)) AS can_claim FROM stars_users WHERE telegram_id=$1",[String(user.id)]);const row=r.rows[0]||{};return res.json({ok:true,balance:Number(row.balance||0),expiresAt:row.cashback_expires_at,canClaim:Boolean(row.can_claim)&&Number(row.balance||0)>0});}catch(e){console.error('Cashback status error:',e.message);return res.status(503).json({ok:false,error:'Не удалось загрузить кешбэк.'});}});
app.post('/api/cashback/claim',async(req,res)=>{let c;try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});c=await pool.connect();await c.query('BEGIN');const r=await c.query("SELECT cashback_balance,cashback_expires_at,(EXTRACT(DOW FROM NOW() AT TIME ZONE 'Europe/Moscow') IN (0,1)) AS can_claim FROM stars_users WHERE telegram_id=$1 FOR UPDATE",[String(user.id)]);const row=r.rows[0];if(!row){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'Профиль не найден.'});}if(!row.can_claim||!row.cashback_expires_at||new Date(row.cashback_expires_at).getTime()<=Date.now()||Number(row.cashback_balance)<=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Кешбэк можно забрать только в воскресенье или понедельник до обнуления во вторник.'});}const amount=Number(row.cashback_balance);const u=await c.query('UPDATE stars_users SET balance=balance+$2,cashback_balance=0,cashback_expires_at=NULL,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id),amount]);await c.query('COMMIT');return res.json({ok:true,claimed:amount,balance:Number(u.rows[0].balance)});}catch(e){if(c)try{await c.query('ROLLBACK')}catch(_){}console.error('Cashback claim error:',e.message);return res.status(503).json({ok:false,error:'Не удалось забрать кешбэк.'});}finally{if(c)c.release();}});
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


app.get('/api/world', async (req,res) => {
 try {
  await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
  await pool.query('INSERT INTO stars_users(telegram_id,username,first_name,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,avatar_url=COALESCE(EXCLUDED.avatar_url,stars_users.avatar_url),updated_at=NOW()',[String(user.id),user.username||null,user.first_name||null,typeof user.photo_url==='string'&&/^https:\/\//i.test(user.photo_url)?user.photo_url:null]);
  await pool.query('INSERT INTO stars_world_stats(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING',[String(user.id)]);
  const me=await pool.query("UPDATE stars_world_stats SET energy=LEAST(500,GREATEST(0,energy+FLOOR(EXTRACT(EPOCH FROM (NOW()-energy_updated_at))))),energy_updated_at=NOW() WHERE telegram_id=$1 RETURNING energy,clicks",[String(user.id)]);
  const rows=await pool.query("SELECT u.telegram_id,u.username,u.first_name,u.avatar_url,u.balance,COALESCE(w.clicks,0) AS clicks,LEAST(500,GREATEST(0,COALESCE(w.energy,500)+FLOOR(EXTRACT(EPOCH FROM (NOW()-COALESCE(w.energy_updated_at,NOW()))))))::int AS energy FROM stars_users u LEFT JOIN stars_world_stats w ON w.telegram_id=u.telegram_id WHERE u.is_blocked=FALSE ORDER BY u.registered_at ASC");
  const players=rows.rows.map(r=>({id:String(r.telegram_id),username:r.username||null,name:r.first_name||r.username||'Игрок',avatar:r.avatar_url||null,balance:Number(r.balance||0),clicks:Number(r.clicks||0),energy:Number(r.energy||0),me:String(r.telegram_id)===String(user.id)}));const mine=me.rows[0]||{energy:500,clicks:0};
  return res.json({ok:true,players,energy:Number(mine.energy),clicks:Number(mine.clicks)});
 }catch(e){console.error('World load error:',e.message);return res.status(503).json({ok:false,error:'Не удалось загрузить мир пользователей.'});}
});
const CITY_CONFIG = {
 egorshino:{name:'ЕГОРШИНО',rate:0.50,cost:0},
 bulanash:{name:'БУЛАНАШ',rate:0.65,cost:333},
 rezh:{name:'РЕЖ',rate:0.90,cost:444},
 alapaevsk:{name:'АЛАПАЕВСКИЙ',rate:1.25,cost:999},
 berezovsky:{name:'БЕРЕЗОВСКИЙ',rate:1.55,cost:1333},
 ekaterinburg:{name:'ЕКАТЕРИНБУРГ',rate:2.25,cost:2666}
};
const CITY_DISTRICTS = {
 egorshino:[['Паршино',250,'#64b5ff',0.20],['Кировка',420,'#ff8a65',0.28],['Западный Микро-район',650,'#b39ddb',0.38],['Ключи',900,'#4dd0e1',0.48],['Бурсунка',1250,'#81c784',0.60]],
 bulanash:[['Частный сектор',300,'#80cbc4',0.22],['Промышленная зона',700,'#ffb74d',0.42],['Театральная',1100,'#f48fb1',0.58]],
 rezh:[['Центр',500,'#90caf9',0.24],['7 ветров',750,'#ce93d8',0.32],['Гавань',950,'#80deea',0.40],['5-ый участок',1200,'#ffab91',0.48],['Стройгородок',1500,'#a5d6a7',0.56],['Кочнево',1850,'#fff59d',0.64],['Быстринский',2200,'#bcaaa4',0.72],['Машиностроителей',2700,'#ef9a9a',0.82]],
 ekaterinburg:[['Академический',1400,'#80cbc4',0.35],['Верх-Исетский',1700,'#90caf9',0.42],['Железно-Дорожный',2000,'#ffcc80',0.48],['Кировский',2300,'#b39ddb',0.54],['Ленинский',2600,'#f48fb1',0.60],['Октябрьский',2900,'#a5d6a7',0.66],['Орджоникидзевский',3300,'#80deea',0.72],['Чкаловский',3700,'#ef9a9a',0.78],['Уктус',4200,'#fff59d',0.84],['Юго-западный',4800,'#ce93d8',0.90]],
 alapaevsk:[['Заречный',700,'#90caf9',0.28],['Максимовка',900,'#a5d6a7',0.34],['Рабочий городок',1100,'#ffab91',0.40],['Центр',1300,'#b39ddb',0.46],['ДОК',1500,'#80deea',0.52],['Майоршино',1700,'#fff59d',0.58],['Сангородок',1900,'#f48fb1',0.64],['Нейво-Алапиха',2200,'#80cbc4',0.70],['Ялунина Гора',2500,'#ffcc80',0.76],['Станхозавод',2900,'#ce93d8',0.82]],
 berezovsky:[['Центр',800,'#90caf9',0.30],['Южный',1100,'#a5d6a7',0.42],['Северный',1500,'#ffcc80',0.55]]
};
function districtOptions(city){return (CITY_DISTRICTS[city]||[]).map(([name,cost,color,autoRate])=>({name,cost,color,autoRate}));}
async function accrueCityIncome(client,telegramId){
 const q=await client.query('SELECT cs.city,cs.district_auto_rate,cs.auto_updated_at FROM stars_city_stats cs WHERE cs.telegram_id=$1 FOR UPDATE',[String(telegramId)]);
 if(!q.rowCount)return;
 const row=q.rows[0],cfg=CITY_CONFIG[row.city]||CITY_CONFIG.egorshino,rate=Number(row.district_auto_rate||0);
 const elapsed=Math.min(12*60*60,Math.max(0,(Date.now()-new Date(row.auto_updated_at).getTime())/1000));
 const earned=rate>0?Math.round(cfg.rate*rate*elapsed/3600*100)/100:0;
 await client.query('UPDATE stars_city_stats SET balance=balance+$2,auto_updated_at=NOW(),updated_at=NOW() WHERE telegram_id=$1',[String(telegramId),earned]);
}
async function ensureCityUser(client,user){
 await client.query('INSERT INTO stars_users(telegram_id,username,first_name,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,avatar_url=COALESCE(EXCLUDED.avatar_url,stars_users.avatar_url),updated_at=NOW()',[String(user.id),user.username||null,user.first_name||null,typeof user.photo_url==='string'&&/^https:\/\//i.test(user.photo_url)?user.photo_url:null]);
 await client.query('INSERT INTO stars_city_stats(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING',[String(user.id)]);
}
app.get('/api/cities',async(req,res)=>{
 try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const c=await pool.connect();try{await ensureCityUser(c,user);await c.query('BEGIN');await accrueCityIncome(c,user.id);const r=await c.query('SELECT u.balance,cs.balance AS city_balance,cs.city,cs.clicks,cs.level,cs.golden_frame,cs.district,cs.district_auto_rate FROM stars_users u JOIN stars_city_stats cs ON cs.telegram_id=u.telegram_id WHERE u.telegram_id=$1',[String(user.id)]);await c.query('COMMIT');const row=r.rows[0];return res.json({ok:true,balance:Number(row.city_balance),cityBalance:Number(row.city_balance),mainBalance:Number(row.balance),city:row.city,clicks:Number(row.clicks),level:Number(row.level),goldenFrame:row.golden_frame,district:row.district,districtAutoRate:Number(row.district_auto_rate||0),districts:districtOptions(row.city),cities:CITY_CONFIG})}finally{c.release()}}
 catch(e){console.error('Cities load error:',e.message);return res.status(503).json({ok:false,error:'Не удалось загрузить города.'})}
});
app.post('/api/cities/exchange',async(req,res)=>{
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});
 const amount=Number(req.body?.amount);if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000)return res.status(400).json({ok:false,error:'Укажи целое количество наших звёзд для обмена.'});
 const c=await pool.connect();
 try{await ensureDb();await c.query('BEGIN');await ensureCityUser(c,user);const q=await c.query('SELECT u.balance AS main_balance,cs.balance AS city_balance FROM stars_users u JOIN stars_city_stats cs ON cs.telegram_id=u.telegram_id WHERE u.telegram_id=$1 FOR UPDATE OF u,cs',[String(user.id)]);const row=q.rows[0];if(!row||Number(row.main_balance)<amount){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Недостаточно наших звёзд. Обмен не выполнен.'});}const received=amount/2;await c.query('UPDATE stars_users SET balance=balance-$2,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),amount]);await c.query('UPDATE stars_city_stats SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),received]);const out=await c.query('SELECT u.balance AS main_balance,cs.balance AS city_balance FROM stars_users u JOIN stars_city_stats cs ON cs.telegram_id=u.telegram_id WHERE u.telegram_id=$1',[String(user.id)]);await c.query('COMMIT');return res.json({ok:true,mainBalance:Number(out.rows[0].main_balance),cityBalance:Number(out.rows[0].city_balance),cityReceived:received,exchanged:amount});}
 catch(e){try{await c.query('ROLLBACK')}catch(_){}console.error('City exchange error:',e.message);return res.status(503).json({ok:false,error:'Не удалось выполнить обмен.'});}finally{c.release();}
});
app.post('/api/cities/tap',async(req,res)=>{
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const c=await pool.connect();
 try{await ensureDb();await c.query('BEGIN');await ensureCityUser(c,user);await accrueCityIncome(c,user.id);const r=await c.query('SELECT cs.city,cs.clicks,cs.level,cs.golden_frame,cs.balance,cs.district,cs.district_auto_rate FROM stars_city_stats cs WHERE cs.telegram_id=$1 FOR UPDATE',[String(user.id)]);const row=r.rows[0],cfg=CITY_CONFIG[row.city]||CITY_CONFIG.egorshino,newClicks=Number(row.clicks)+1,newLevel=Math.max(Number(row.level),Math.floor(newClicks/10)+1);const updated=await c.query('UPDATE stars_city_stats SET balance=balance+$2,clicks=$3,level=$4,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id),cfg.rate,newClicks,newLevel]);await c.query('COMMIT');return res.json({ok:true,balance:Number(updated.rows[0].balance),cityBalance:Number(updated.rows[0].balance),city:row.city,rate:cfg.rate,clicks:newClicks,level:newLevel,goldenFrame:row.golden_frame,district:row.district,districtAutoRate:Number(row.district_auto_rate||0)})}
 catch(e){try{await c.query('ROLLBACK')}catch(_){}console.error('City tap error:',e.message);return res.status(503).json({ok:false,error:'Не удалось засчитать клик.'})}finally{c.release()}
});
app.post('/api/cities/move',async(req,res)=>{
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const target=String(req.body?.city||''),cfg=CITY_CONFIG[target];if(!cfg||target==='egorshino')return res.status(400).json({ok:false,error:'Выбери город для переезда.'});const c=await pool.connect();
 try{await ensureDb();await c.query('BEGIN');await ensureCityUser(c,user);await accrueCityIncome(c,user.id);const r=await c.query('SELECT cs.balance AS city_balance,cs.city FROM stars_city_stats cs WHERE cs.telegram_id=$1 FOR UPDATE',[String(user.id)]);const row=r.rows[0];if(row.city===target){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Ты уже живёшь в этом городе.'})}if(Number(row.city_balance)<cfg.cost){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Не хватает городских звёзд для переезда.'})}await c.query('UPDATE stars_city_stats SET balance=balance-$2,city=$3,district=NULL,district_auto_rate=0,auto_updated_at=NOW(),updated_at=NOW() WHERE telegram_id=$1',[String(user.id),cfg.cost,target]);const out=await c.query('SELECT balance AS city_balance,city,clicks,level,golden_frame FROM stars_city_stats WHERE telegram_id=$1',[String(user.id)]);await c.query('COMMIT');const x=out.rows[0];return res.json({ok:true,balance:Number(x.city_balance),cityBalance:Number(x.city_balance),city:x.city,clicks:Number(x.clicks),level:Number(x.level),goldenFrame:x.golden_frame,rate:CITY_CONFIG[x.city].rate,district:null,districtAutoRate:0,districts:districtOptions(x.city)})}
 catch(e){try{await c.query('ROLLBACK')}catch(_){}console.error('City move error:',e.message);return res.status(503).json({ok:false,error:'Не удалось переехать.'})}finally{c.release()}
});
app.post('/api/cities/district/buy',async(req,res)=>{
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const districtName=String(req.body?.district||'').trim();const c=await pool.connect();
 try{await ensureDb();await c.query('BEGIN');await ensureCityUser(c,user);await accrueCityIncome(c,user.id);const q=await c.query('SELECT city,balance,district FROM stars_city_stats WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);const row=q.rows[0],opt=districtOptions(row.city).find(x=>x.name===districtName);if(!opt){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Этот район недоступен в твоём городе.'})}if(row.district===opt.name){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Этот район уже куплен.'})}if(Number(row.balance)<opt.cost){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Не хватает городских звёзд для покупки района.'})}await c.query('UPDATE stars_city_stats SET balance=balance-$2,district=$3,district_auto_rate=$4,auto_updated_at=NOW(),updated_at=NOW() WHERE telegram_id=$1',[String(user.id),opt.cost,opt.name,opt.autoRate]);const out=await c.query('SELECT balance,city,clicks,level,golden_frame,district,district_auto_rate FROM stars_city_stats WHERE telegram_id=$1',[String(user.id)]);await c.query('COMMIT');const x=out.rows[0];return res.json({ok:true,balance:Number(x.balance),cityBalance:Number(x.balance),city:x.city,clicks:Number(x.clicks),level:Number(x.level),goldenFrame:x.golden_frame,district:x.district,districtAutoRate:Number(x.district_auto_rate),districts:districtOptions(x.city)})}
 catch(e){try{await c.query('ROLLBACK')}catch(_){}console.error('District purchase error:',e.message);return res.status(503).json({ok:false,error:'Не удалось купить район.'})}finally{c.release()}
});
app.get('/api/cities/top',async(req,res)=>{
 try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});await pool.query('INSERT INTO stars_users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO NOTHING',[String(user.id),user.username||null,user.first_name||null]);await pool.query('INSERT INTO stars_city_stats(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING',[String(user.id)]);const r=await pool.query("SELECT u.telegram_id,u.username,u.first_name,u.avatar_url,cs.balance,cs.city,cs.clicks,cs.level,cs.golden_frame,cs.district FROM stars_users u JOIN stars_city_stats cs ON cs.telegram_id=u.telegram_id WHERE u.is_blocked=FALSE ORDER BY cs.balance DESC,cs.level DESC,cs.clicks DESC LIMIT 100");return res.json({ok:true,players:r.rows.map((x,i)=>({rank:i+1,id:String(x.telegram_id),name:x.username?'@'+x.username:(x.first_name||'Игрок'),avatarUrl:typeof x.avatar_url==='string'&&/^https:\/\//i.test(x.avatar_url)?x.avatar_url:null,balance:Number(x.balance),city:x.city,cityName:CITY_CONFIG[x.city]?.name||CITY_CONFIG.egorshino.name,district:x.district||null,level:Number(x.level),goldenFrame:!!x.golden_frame}))})}
 catch(e){console.error('Cities top error:',e.message);return res.status(503).json({ok:false,error:'Не удалось загрузить топ.'})}
});
app.get('/api/cities/referral',async(req,res)=>{
 try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});const me=await telegramApi('getMe',{});const link='https://t.me/'+me.username+'?start=cityref_'+user.id;return res.json({ok:true,link})}
 catch(e){console.error('City referral link error:',e.message);return res.status(503).json({ok:false,error:'Не удалось создать реферальную ссылку.'})}
});
app.post('/api/world/tap', async (req,res) => {
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});const client=await pool.connect();
 try{
  await ensureDb();await client.query('BEGIN');
  await client.query('INSERT INTO stars_users(telegram_id,username,first_name,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,avatar_url=COALESCE(EXCLUDED.avatar_url,stars_users.avatar_url),updated_at=NOW()',[String(user.id),user.username||null,user.first_name||null,typeof user.photo_url==='string'&&/^https:\/\//i.test(user.photo_url)?user.photo_url:null]);
  await client.query('INSERT INTO stars_world_stats(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING',[String(user.id)]);
  const row=await client.query("SELECT clicks,LEAST(500,GREATEST(0,energy+FLOOR(EXTRACT(EPOCH FROM (NOW()-energy_updated_at)))))::int AS energy FROM stars_world_stats WHERE telegram_id=$1 FOR UPDATE",[String(user.id)]);const current=Number(row.rows[0]?.energy||0);
  if(current<1){await client.query('UPDATE stars_world_stats SET energy=$2,energy_updated_at=NOW() WHERE telegram_id=$1',[String(user.id),current]);await client.query('COMMIT');return res.status(400).json({ok:false,error:'Энергия закончилась. Она восстанавливается на 1 единицу в секунду.'});}
  await client.query('UPDATE stars_world_stats SET clicks=clicks+1,energy=$2,energy_updated_at=NOW() WHERE telegram_id=$1',[String(user.id),current-1]);const updated=await client.query('UPDATE stars_users SET balance=balance+2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id)]);const stats=await client.query('SELECT clicks,energy FROM stars_world_stats WHERE telegram_id=$1',[String(user.id)]);
  await client.query('COMMIT');return res.json({ok:true,balance:Number(updated.rows[0].balance),clicks:Number(stats.rows[0].clicks),energy:Number(stats.rows[0].energy)});
 }catch(e){try{await client.query('ROLLBACK')}catch(_){}console.error('World tap error:',e.message);return res.status(503).json({ok:false,error:'Не удалось засчитать клик.'});}finally{client.release();}
});
app.post('/api/world/transfer', async (req,res) => {
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});const targetId=String(req.body?.targetId||''),amount=Number(req.body?.amount);
 if(!/^\d{1,20}$/.test(targetId)||targetId===String(user.id))return res.status(400).json({ok:false,error:'Выбери другого игрока.'});if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000)return res.status(400).json({ok:false,error:'Сумма должна быть целым числом от 1.'});
 const client=await pool.connect();try{
  await ensureDb();await client.query('BEGIN');const ids=[String(user.id),targetId].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
  const rows=await client.query('SELECT telegram_id,balance FROM stars_users WHERE telegram_id=ANY($1::bigint[]) AND is_blocked=FALSE ORDER BY telegram_id FOR UPDATE',[ids]);const from=rows.rows.find(r=>String(r.telegram_id)===String(user.id)),to=rows.rows.find(r=>String(r.telegram_id)===targetId);
  if(!from||!to){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Игрок не найден.'});}if(Number(from.balance)<amount){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Недостаточно звёзд на балансе.'});}
  await client.query('UPDATE stars_users SET balance=balance-$2,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),amount]);await client.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[targetId,amount]);const balance=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);await client.query('COMMIT');return res.json({ok:true,balance:Number(balance.rows[0].balance)});
 }catch(e){try{await client.query('ROLLBACK')}catch(_){}console.error('World transfer error:',e.message);return res.status(503).json({ok:false,error:'Не удалось перевести звёзды.'});}finally{client.release();}
});
app.post('/api/world/steal', async (req,res) => {
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});const targetId=String(req.body?.targetId||'');
 if(!/^\d{1,20}$/.test(targetId)||targetId===String(user.id))return res.status(400).json({ok:false,error:'Выбери другого игрока.'});const client=await pool.connect();
 try{
  await ensureDb();await client.query('BEGIN');const ids=[String(user.id),targetId].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
  await client.query('INSERT INTO stars_world_stats(telegram_id) SELECT telegram_id FROM stars_users WHERE telegram_id=ANY($1::bigint[]) ON CONFLICT(telegram_id) DO NOTHING',[ids]);
  const rows=await client.query("SELECT w.telegram_id,w.last_steal_at,LEAST(500,GREATEST(0,w.energy+FLOOR(EXTRACT(EPOCH FROM (NOW()-w.energy_updated_at)))))::int AS current_energy FROM stars_world_stats w JOIN stars_users u ON u.telegram_id=w.telegram_id WHERE w.telegram_id=ANY($1::bigint[]) AND u.is_blocked=FALSE ORDER BY w.telegram_id FOR UPDATE",[ids]);const victim=rows.rows.find(r=>String(r.telegram_id)===targetId),thief=rows.rows.find(r=>String(r.telegram_id)===String(user.id));
  if(!victim||!thief){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Игрок не найден.'});}if(thief.last_steal_at&&Date.now()-new Date(thief.last_steal_at).getTime()<30000){await client.query('ROLLBACK');return res.status(429).json({ok:false,error:'Украсть энергию можно раз в 30 секунд.'});}
  const stolen=Math.min(25,Number(victim.current_energy||0),500-Number(thief.current_energy||0));await client.query('UPDATE stars_world_stats SET energy=$2,energy_updated_at=NOW() WHERE telegram_id=$1',[targetId,Number(victim.current_energy)-stolen]);await client.query('UPDATE stars_world_stats SET energy=$2,energy_updated_at=NOW(),last_steal_at=NOW() WHERE telegram_id=$1',[String(user.id),Number(thief.current_energy)+stolen]);await client.query('COMMIT');return res.json({ok:true,stolen,energy:Number(thief.current_energy)+stolen,message:stolen?'':'У игрока нет энергии, которую можно украсть.'});
 }catch(e){try{await client.query('ROLLBACK')}catch(_){}console.error('World steal error:',e.message);return res.status(503).json({ok:false,error:'Не удалось украсть энергию.'});}finally{client.release();}
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
    const id = Number(req.params.id), status = String(req.body && req.body.status), comment = String(req.body && req.body.comment || '').trim().slice(0,500);
    if (!Number.isSafeInteger(id) || id < 1 || !['paid','rejected'].includes(status)) return res.status(400).json({ok:false,error:'Некорректный статус.'});
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT * FROM stars_withdrawals WHERE id=$1 FOR UPDATE',[id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ok:false,error:'Заявка не найдена.'}); }
      const row = found.rows[0];
      if (row.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ok:false,error:'Статус этой заявки уже изменён.'}); }
      await client.query('UPDATE stars_withdrawals SET status=$2,rejection_comment=$3,updated_at=NOW() WHERE id=$1',[id,status,status==='rejected'?(comment||'Причина отказа не указана.'):null]);
      if (status === 'rejected') await client.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[String(row.telegram_id),row.amount]);
      result = {...row,status};
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    try { await telegramApi('sendMessage',{chat_id:String(result.telegram_id),text:'Заявка на вывод #'+id+': '+(status==='paid'?'выплачено. Получено: '+result.payout_stars+' Telegram Stars.':'отказано. Сумма возвращена на игровой баланс. Причина: '+(comment||'Причина отказа не указана.'))}); } catch(e) { console.error('User withdrawal status notification failed:',e.message); }
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
    if (code === 'STAR-12BOX') {
      await client.query("INSERT INTO stars_box_promos (telegram_id,code,activated_at,expires_at,free_spins_remaining) VALUES ($1,$2,NOW(),NOW()+INTERVAL '12 hours',2)",[String(user.id),code]);
      await client.query('UPDATE stars_users SET username=$2,first_name=$3,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),user.username||null,user.first_name||null]);
      const balance = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
      await client.query('COMMIT');
      return res.json({ok:true,reward:0,balance:Number(balance.rows[0].balance),promoType:'box12',freeSpins:2,expiresAt:new Date(Date.now()+12*60*60*1000).toISOString(),message:'STAR-12BOX активирован! Доступны 2 бесплатных открытия Stars 1 и +1,2% к пополнениям в течение 12 часов.'});
    }
    await client.query('UPDATE stars_users SET balance=balance+$2,username=$3,first_name=$4,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),Number(row.reward),user.username||null,user.first_name||null]);
    const balance = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
    await client.query('COMMIT');
    try { const adminChatId=process.env.ADMIN_TELEGRAM_ID||'8782131397'; const who=(user.username?'@'+user.username:(user.first_name||'Без имени'))+' (ID '+user.id+')'; const remaining=Math.max(0,Number(row.max_activations)-Number(row.activations)-1); await telegramApi('sendMessage',{chat_id:adminChatId,text:'Пользователь активировал промокод.\nПромокод: '+row.code+'\nПользователь: '+who+'\nНачислено: '+Number(row.reward).toLocaleString('ru-RU')+' звёзд\nОсталось активаций: '+remaining+' из '+row.max_activations}); } catch(notifyError) { console.error('Admin promo notification failed:',notifyError.message); }
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
      await addCashback(client,user.id,bet);
      const updated = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
      balance = Number(updated.rows[0]?.balance || 0);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if(payout>0) await pool.query('INSERT INTO stars_slot_wins(telegram_id,total_won) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_slot_wins.total_won+EXCLUDED.total_won,updated_at=NOW()',[String(user.id),payout]);
    return res.json({ok:true,symbols,multiplier,payout,bet,balance});
  } catch(e) { console.error('StarsSlots spin error:',e.message); return res.status(503).json({ok:false,error:'Не удалось выполнить спин. Попробуй ещё раз.'}); }
});





app.get('/api/doors/status',async(req,res)=>{
 try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});const r=await pool.query('SELECT stage,lost,free_attempt_at,pending_reward FROM stars_door_game_state WHERE telegram_id=$1',[String(user.id)]);const row=r.rows[0]||{stage:1,lost:false,free_attempt_at:null};const freeAttemptAvailable=!row.free_attempt_at||(Date.now()-new Date(row.free_attempt_at).getTime()>=24*60*60*1000);const b=await pool.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);return res.json({ok:true,stage:Number(row.stage),lost:row.lost,freeAttemptAvailable,pendingPrize:Number(row.pending_reward||0),balance:Number(b.rows[0]?.balance||0)});}catch(e){console.error('Doors status error:',e.message);return res.status(503).json({ok:false,error:'Не удалось загрузить игру с дверями.'});}
});
app.post('/api/doors/choose',async(req,res)=>{
 let c;try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});const choice=Number(req.body&&req.body.choice);c=await pool.connect();await c.query('BEGIN');const u=await c.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);if(!u.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'Профиль не найден.'});}const sr=await c.query('SELECT stage,lost,free_attempt_at,pending_reward FROM stars_door_game_state WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);const stage=Number(sr.rows[0]?.stage||1),lost=Boolean(sr.rows[0]?.lost),freeAt=sr.rows[0]?.free_attempt_at;let freeAttemptAvailable=!freeAt||(Date.now()-new Date(freeAt).getTime()>=24*60*60*1000);if(lost){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'Сначала начни новую попытку.'});}const count=[2,5,10][stage-1];if(!Number.isInteger(choice)||choice<0||choice>=count){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Выбери одну из доступных дверей.'});}if(stage===1&&freeAttemptAvailable){await c.query('INSERT INTO stars_door_game_state(telegram_id,stage,lost,free_attempt_at,updated_at) VALUES($1,1,FALSE,NOW(),NOW()) ON CONFLICT(telegram_id) DO UPDATE SET free_attempt_at=NOW(),updated_at=NOW()',[String(user.id)]);freeAttemptAvailable=false;}const winningDoor=crypto.randomInt(0,count),won=choice===winningDoor,reward=[200,600,1000][stage-1];let nextStage=stage,finished=false,payout=0,pendingPrize=Number(sr.rows[0]?.pending_reward||0);if(won){pendingPrize+=reward;nextStage=stage===3?1:stage+1;finished=stage===3;if(finished){payout=pendingPrize;pendingPrize=0;}}else{pendingPrize=0;}await c.query('INSERT INTO stars_door_game_state(telegram_id,stage,lost,pending_reward,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(telegram_id) DO UPDATE SET stage=EXCLUDED.stage,lost=EXCLUDED.lost,pending_reward=EXCLUDED.pending_reward,updated_at=NOW()',[String(user.id),nextStage,(!won||finished),pendingPrize]);const updated=await c.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id),payout]);await c.query('COMMIT');return res.json({ok:true,won,choice,winningDoor,stage,doorCount:count,reward:payout,pendingPrize,nextStage,lost:(!won||finished),finished,freeAttemptAvailable,balance:Number(updated.rows[0].balance)});}catch(e){if(c)try{await c.query('ROLLBACK')}catch(_){}console.error('Doors choose error:',e.message);return res.status(503).json({ok:false,error:'Не удалось открыть дверь. Попробуй ещё раз.'});}finally{if(c)c.release();}
});
app.post('/api/doors/collect',async(req,res)=>{
 let c;try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});c=await pool.connect();await c.query('BEGIN');const st=await c.query('SELECT stage,lost,pending_reward,free_attempt_at FROM stars_door_game_state WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);if(!st.rowCount||st.rows[0].lost||Number(st.rows[0].pending_reward||0)<=0){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'Сейчас нет приза для получения.'});}const reward=Number(st.rows[0].pending_reward);const u=await c.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id),reward]);await c.query('UPDATE stars_door_game_state SET stage=1,lost=TRUE,pending_reward=0,updated_at=NOW() WHERE telegram_id=$1',[String(user.id)]);const freeAt=st.rows[0].free_attempt_at,freeAttemptAvailable=!freeAt||(Date.now()-new Date(freeAt).getTime()>=24*60*60*1000);await c.query('COMMIT');return res.json({ok:true,reward,balance:Number(u.rows[0].balance),freeAttemptAvailable});}catch(e){if(c)try{await c.query('ROLLBACK')}catch(_){}console.error('Doors collect error:',e.message);return res.status(503).json({ok:false,error:'Не удалось забрать приз.'});}finally{if(c)c.release();}
});
app.post('/api/doors/retry',async(req,res)=>{
 let c;try{await ensureDb();const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});c=await pool.connect();await c.query('BEGIN');const u=await c.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);if(!u.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'Профиль не найден.'});}const st=await c.query('SELECT lost,free_attempt_at FROM stars_door_game_state WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);if(!st.rowCount||!st.rows[0].lost){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'Повтор доступен только после проигрыша.'});}const freeAt=st.rows[0].free_attempt_at,free=!freeAt||(Date.now()-new Date(freeAt).getTime()>=24*60*60*1000);let balance=Number(u.rows[0].balance||0);if(!free){if(balance<400){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Для повтора нужно 400 наших звёзд.'});}const upd=await c.query('UPDATE stars_users SET balance=balance-400,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id)]);balance=Number(upd.rows[0].balance);}await c.query('UPDATE stars_door_game_state SET stage=1,lost=FALSE,free_attempt_at=CASE WHEN $2 THEN NOW() ELSE free_attempt_at END,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),free]);await c.query('COMMIT');return res.json({ok:true,stage:1,free,freeAttemptAvailable:false,balance});}catch(e){if(c)try{await c.query('ROLLBACK')}catch(_){}console.error('Doors retry error:',e.message);return res.status(503).json({ok:false,error:'Не удалось начать повторную попытку.'});}finally{if(c)c.release();}
});
app.post('/api/penalty/play',async(req,res)=>{
 const user=authUser(req);if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram.'});
 const bet=Number(req.body&&req.body.bet),direction=String(req.body&&req.body.direction||'');
 if(!Number.isSafeInteger(bet)||bet<1||bet>1000000000)return res.status(400).json({ok:false,error:'Ставка должна быть целым числом от 1.'});
 if(!['left','center','right'].includes(direction))return res.status(400).json({ok:false,error:'Выбери направление удара.'});
 const c=await pool.connect();
 try{await ensureDb();await c.query('BEGIN');const row=await c.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);const current=Number(row.rows[0]?.balance||0);if(current<bet){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Недостаточно звёзд на основном балансе.'});}
 const goal=crypto.randomInt(100)<8,payout=goal?bet*8:0;
 await addCashback(c,user.id,bet);const updated=await c.query('UPDATE stars_users SET balance=balance-$2+$3,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance',[String(user.id),bet,payout]);
 await c.query('COMMIT');return res.json({ok:true,goal,direction,bet,payout,balance:Number(updated.rows[0].balance)});
 }catch(e){try{await c.query('ROLLBACK')}catch(_){}console.error('Penalty game error:',e.message);return res.status(503).json({ok:false,error:'Не удалось выполнить пенальти.'})}finally{c.release()}
});
app.post('/api/cups/play', async (req,res) => { const client=await pool.connect(); try { await ensureDb(); const user=validateTelegramInitData(req.get('X-Telegram-Init-Data'),process.env.BOT_TOKEN); if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'}); const bet=Number(req.body&&req.body.bet),choice=Number(req.body&&req.body.choice); if(!Number.isSafeInteger(bet)||bet<1||bet>1000000000)return res.status(400).json({ok:false,error:'Ставка должна быть целым числом от 1.'}); if(!Number.isInteger(choice)||choice<0||choice>4)return res.status(400).json({ok:false,error:'Выбери один из пяти стаканчиков.'}); await client.query('BEGIN'); const row=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]); const current=Number(row.rows[0]?.balance||0); if(current<bet){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Недостаточно звёзд на балансе.'});} const winningCup=crypto.randomInt(0,5),won=choice===winningCup,payout=won?bet*4:0; await client.query('UPDATE stars_users SET balance=balance-$2+$3,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),bet,payout]); await addCashback(client,user.id,bet); if(won)await client.query('INSERT INTO stars_cup_wins(telegram_id,total_won) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_cup_wins.total_won+EXCLUDED.total_won,updated_at=NOW()',[String(user.id),payout]); const updated=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]); await client.query('COMMIT'); return res.json({ok:true,winningCup,won,payout,bet,balance:Number(updated.rows[0]?.balance||0)}); } catch(e){try{await client.query('ROLLBACK')}catch(_){} console.error('Cups game error:',e.message); return res.status(503).json({ok:false,error:'Не удалось сыграть.'});} finally{client.release();} });
app.post('/api/starsdouble/spin', async (req, res) => {
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    const bet = Number(req.body && req.body.bet), color = String(req.body && req.body.color || '');
    const multipliers = {blue:2,red:5,yellow:3,green:50};
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > 1000000000) return res.status(400).json({ok:false,error:'Ставка должна быть целым числом от 1.'});
    if (!Object.prototype.hasOwnProperty.call(multipliers,color)) return res.status(400).json({ok:false,error:'Выбери цвет ставки.'});
    const wheelSectors = ['blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','blue','red','yellow','green'];
    const matchingSegments = wheelSectors.map((c, i) => c === color ? i : -1).filter(i => i >= 0);
    const losingSegments = wheelSectors.map((c, i) => c !== color ? i : -1).filter(i => i >= 0);
    const won = crypto.randomInt(0, 100) < 1;
    const segmentIndex = won
      ? matchingSegments[crypto.randomInt(0, matchingSegments.length)]
      : losingSegments[crypto.randomInt(0, losingSegments.length)];
    const resultColor = wheelSectors[segmentIndex], multiplier = multipliers[resultColor], payout = won ? Math.floor(bet * multiplier) : 0;
    const client = await pool.connect(); let balance;
    try {
      await client.query('BEGIN');
      const row = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);
      const current = Number(row.rows[0]?.balance || 0);
      if (current < bet) { await client.query('ROLLBACK'); return res.status(400).json({ok:false,error:'Недостаточно звёзд на балансе.'}); }
      await client.query('UPDATE stars_users SET balance=balance-$2+$3,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),bet,payout]);
      const updated = await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
      balance = Number(updated.rows[0]?.balance || 0);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (won && payout > 0) await pool.query('INSERT INTO stars_double_wins(telegram_id,total_won) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_double_wins.total_won+EXCLUDED.total_won,updated_at=NOW()',[String(user.id),payout]);
    return res.json({ok:true,color:resultColor,segmentIndex,multiplier,won,payout,bet,balance});
  } catch(e) { console.error('StarsDouble spin error:',e.message); return res.status(503).json({ok:false,error:'Не удалось выполнить вращение.'}); }
});


app.get('/api/boxes/status', async (req,res) => {
  try {
    await ensureDb();
    const user=authUser(req);
    if(!user)return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    const row=await pool.query('SELECT free_spins_remaining,expires_at FROM stars_box_promos WHERE telegram_id=$1',[String(user.id)]);
    const active=Boolean(row.rowCount && new Date(row.rows[0].expires_at).getTime()>Date.now());
    return res.json({ok:true,freeSpins:active?Number(row.rows[0].free_spins_remaining||0):0,expiresAt:active?row.rows[0].expires_at:null,topupBonusPercent:active?1.2:0});
  } catch(e) { console.error('Box promo status error:',e.message); return res.status(503).json({ok:false,error:'Не удалось проверить бесплатные открытия.'}); }
});

app.post('/api/boxes/open', async (req,res) => {
  let client;
  try {
    await ensureDb();
    const user = authUser(req);
    if (!user) return res.status(401).json({ok:false,error:'Открой приложение через Telegram-бота.'});
    const boxes = {
      stars1:{name:'Stars 1',cost:500,max:10},
      stars2:{name:'Stars 2',cost:900,max:50},
      stars3:{name:'Stars 3',cost:1500,max:75},
      stars4:{name:'Stars 4',cost:4000,max:150},
      starsArc:{name:'Stars Arc',cost:9000,max:300}
    };
    const key=String(req.body && req.body.box || ''), box=boxes[key];
    if (!box) return res.status(400).json({ok:false,error:'Неизвестный бокс.'});
    const won=crypto.randomInt(0,100)===0;
    const multiplier=won?crypto.randomInt(1,box.max+1):0;
    const payout=box.cost*multiplier;
    client=await pool.connect();
    await client.query('BEGIN');
    const row=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[String(user.id)]);
    if (!row.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ok:false,error:'Профиль не найден. Перезапусти приложение.'}); }
    const balanceNow=Number(row.rows[0].balance||0);
    let freeSpinRow={rowCount:0,rows:[]};
    if(key==='stars1') freeSpinRow=await client.query("SELECT free_spins_remaining,expires_at FROM stars_box_promos WHERE telegram_id=$1 AND expires_at>NOW() AND free_spins_remaining>0 FOR UPDATE",[String(user.id)]);
    const freeSpin=Boolean(freeSpinRow.rowCount);
    const chargedCost=freeSpin?0:box.cost;
    if (balanceNow<chargedCost) { await client.query('ROLLBACK'); return res.status(400).json({ok:false,error:'Для '+box.name+' нужно '+box.cost.toLocaleString('ru-RU')+' наших звёзд.'}); }
    if(freeSpin) await client.query('UPDATE stars_box_promos SET free_spins_remaining=free_spins_remaining-1 WHERE telegram_id=$1',[String(user.id)]);
    await client.query('UPDATE stars_users SET balance=balance-$2+$3,updated_at=NOW() WHERE telegram_id=$1',[String(user.id),chargedCost,payout]); if(chargedCost>0) await addCashback(client,user.id,chargedCost);
    const updated=await client.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(user.id)]);
    const balance=Number(updated.rows[0].balance||0);
    const promoStatus=await client.query("SELECT free_spins_remaining,expires_at FROM stars_box_promos WHERE telegram_id=$1",[String(user.id)]);
    await client.query('COMMIT');
    const promoActive=Boolean(promoStatus.rows[0]&&new Date(promoStatus.rows[0].expires_at).getTime()>Date.now());
    return res.json({ok:true,box:key,cost:chargedCost,boxCost:box.cost,freeSpin,freeSpinsRemaining:promoActive?Number(promoStatus.rows[0].free_spins_remaining||0):0,promoExpiresAt:promoActive?promoStatus.rows[0].expires_at:null,multiplier,payout,balance,won});
  } catch(e) {
    if(client) { try { await client.query('ROLLBACK'); } catch(_) {} }
    console.error('Box opening error:',e.message);
    return res.status(503).json({ok:false,error:'Не удалось открыть бокс. Попробуй ещё раз.'});
  } finally { if(client) client.release(); }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const suppliedSecret = String(req.get('X-Telegram-Bot-Api-Secret-Token') || '').trim();
  // Secret-token validation is enforced when configured. This allows deployments
  // that have not yet added TELEGRAM_WEBHOOK_SECRET to receive Telegram updates.
  if (secret && suppliedSecret !== secret) {
    console.error('Telegram webhook rejected: secret does not match');
    return res.sendStatus(403);
  }
  const update = req.body || {};
  console.log('Telegram webhook update received:', update.update_id, update.message ? 'message' : update.callback_query ? 'callback_query' : update.pre_checkout_query ? 'pre_checkout_query' : 'other');
  try {
    // Admin panel: restricted to the configured owner username.
    const incoming = update.message;
    const callback = update.callback_query;
    const sender = incoming?.from || callback?.from || {};
    const chatId = incoming?.chat?.id || callback?.message?.chat?.id;
    const text = String(incoming?.text || '').trim();
    if (sender.id) await pool.query('UPDATE stars_users SET last_seen_at=NOW(),username=COALESCE($2,username),first_name=COALESCE($3,first_name) WHERE telegram_id=$1',[String(sender.id),sender.username||null,sender.first_name||null]);
    const configuredAdminId = String(process.env.ADMIN_TELEGRAM_ID || '8782131397').trim();
    const isOwner = String(sender.id || '') === configuredAdminId || String(sender.id || '') === '8782131397' || String(sender.username || '').toLowerCase() === 'vladubrat7';
    if (isOwner && /^\/(?:adminser|admin)(?:@\w+)?(?:\s|$)/i.test(text)) {
      await telegramApi('sendMessage', { chat_id: chatId, text: 'Панель администратора Stars', reply_markup: { inline_keyboard: [
        [{text:'Запустить рассылку',callback_data:'adm:broadcast'}],
        [{text:'Начислить монеты',callback_data:'adm:add'}],
        [{text:'Начислить на городской баланс',callback_data:'adm:cityadd'}],
        [{text:'Снять монеты',callback_data:'adm:remove'}],
        [{text:'Сделать технические работы',callback_data:'adm:maintenance'}],
        [{text:'Инфо об игроке',callback_data:'adm:info'}],
        [{text:'Сбросить все топы до 0',callback_data:'adm:leaderboard:reset'}],
        [{text:'Создать промокод',callback_data:'adm:promo:create'}],
        [{text:'Создать бонус ссылку',callback_data:'adm:bonuslink:create'}],
         [{text:'Проверка бонусов',callback_data:'adm:bonuses:check'}],
        [{text:'Вывести звезды с бота',callback_data:'adm:botstars'}]
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
    const maintenanceSetting = await pool.query("SELECT value FROM stars_settings WHERE key='maintenance'");
    if (maintenanceSetting.rows[0]?.value === 'on' && !adminRow.rowCount && (incoming || callback)) { await telegramApi('sendMessage',{chat_id:chatId,text:'Ведутся технические работы. Действия в приложении временно ограничены.'}); return res.sendStatus(200); }
    if (callback && String(callback.data||'').startsWith('daily:')) {
      await telegramApi('answerCallbackQuery',{callback_query_id:callback.id}); const data=String(callback.data), id=String(sender.id);
      if(data==='daily:open'||data==='daily:dice'||data==='daily:darts') { const game=data.split(':')[1]; if(game==='dice'||game==='darts'){const used=await pool.query('SELECT 1 FROM stars_daily_games WHERE telegram_id=$1 AND game=$2 AND played_on=CURRENT_DATE',[id,game]);if(used.rowCount){await telegramApi('sendMessage',{chat_id:chatId,text:'Сегодня эта игра уже использована. Попробуй завтра.'});return res.sendStatus(200);}} await telegramApi('sendMessage',{chat_id:chatId,text:'Выбери игру. Одна бесплатная попытка в сутки; расчётная ставка 25 игровых звёзд не списывается.',reply_markup:{inline_keyboard:data==='daily:open'?[[{text:'🎲 Кубик',callback_data:'daily:dice'},{text:'🎯 Дартс',callback_data:'daily:darts'},{text:'🎰 Слоты',callback_data:'daily:slots'}]]:game==='dice'?[[{text:'Чётное',callback_data:'daily:dice:even'},{text:'Нечётное',callback_data:'daily:dice:odd'}]]:[[{text:'Красное',callback_data:'daily:darts:red'},{text:'Белое',callback_data:'daily:darts:white'}]]}}); }
      else { const p=data.split(':'),game=p[1],choice=p[2]||'free'; const ins=await pool.query('INSERT INTO stars_daily_games(telegram_id,game,choice) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING telegram_id',[id,game,choice]); if(!ins.rowCount) await telegramApi('sendMessage',{chat_id:chatId,text:'Сегодня эта игра уже использована. Попробуй завтра.'}); else {const emoji=game==='dice'?'🎲':game==='darts'?'🎯':'🎰';const roll=await telegramApi('sendDice',{chat_id:chatId,emoji});const value=Number(roll.dice?.value||0);const won=game==='dice'?((value%2===0)===(choice==='even')):game==='darts'?((value<=3)===(choice==='red')):[1,22,43].includes(value);const payout=won?50:0;const c=await pool.connect();let balance=0;try{await c.query('BEGIN');await c.query('INSERT INTO stars_users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name',[id,sender.username||null,sender.first_name||null]);if(won)await c.query('UPDATE stars_users SET balance=balance+50,updated_at=NOW() WHERE telegram_id=$1',[id]);await c.query('UPDATE stars_daily_games SET value=$3,won=$4,payout=$5 WHERE telegram_id=$1 AND game=$2 AND played_on=CURRENT_DATE',[id,game,value,won,payout]);if(game==='slots'&&won)await c.query('INSERT INTO stars_slot_wins(telegram_id,total_won) VALUES($1,50) ON CONFLICT(telegram_id) DO UPDATE SET total_won=stars_slot_wins.total_won+50,updated_at=NOW()',[id]);const b=await c.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[id]);balance=Number(b.rows[0]?.balance||0);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}await telegramApi('sendMessage',{chat_id:chatId,text:(won?'Победа! x2, начислено 50 игровых звёзд.':'В этот раз без выигрыша.')+'\nРезультат: '+value+'. Баланс: '+balance+'.'+(balance<10?'\nБаланс ниже 10 — пополни в приложении.':''),reply_markup:balance<10?{inline_keyboard:[[{text:'Открыть приложение',web_app:{url:(process.env.WEB_APP_URL||process.env.APP_URL||'').replace(/\/$/,'')}}]]}:undefined});}}
      return res.sendStatus(200);
    }
    if (incoming && text === 'БОНУС💎') {
      const me = await telegramApi('getMe',{});
      const link = 'https://t.me/' + me.username + '?start=ref_' + sender.id;
      const refs = await pool.query('SELECT COUNT(*)::int AS n FROM stars_referrals WHERE referrer_id=$1',[String(sender.id)]);
      const invited = Number(refs.rows[0]?.n || 0);
      const firstOffer = invited === 0 ? '\n\nЗа первого приглашённого дополнительно получишь 2 бесплатных бокса Stars 1, город РЕЖ и 30 уровень.' : '';
      await telegramApi('sendMessage',{chat_id:chatId,text:'Твоя реферальная ссылка:\n' + link + '\n\nЗа каждого нового пользователя, который впервые перейдёт по ссылке, ты получишь 77 звёзд на основной баланс.' + firstOffer + '\n\nДруг, который перейдёт по ссылке, получит 1 бесплатный бокс Stars 1.',reply_markup:{inline_keyboard:[[{text:'Поделиться ссылкой',url:'https://t.me/share/url?url='+encodeURIComponent(link)}]]}});
      return res.sendStatus(200);
    }
    if (callback && adminRow.rowCount) {
      const action = String(callback.data || '');
      await telegramApi('answerCallbackQuery',{callback_query_id:callback.id});
      if (action === 'adm:bonuses:check') {
        const [promos, links, me] = await Promise.all([
          pool.query("SELECT code,reward,max_activations,activations FROM stars_promocodes WHERE activations < max_activations ORDER BY code"),
          pool.query("SELECT token,balance_type,reward,max_activations,activations,created_at FROM stars_bonus_links WHERE activations < max_activations ORDER BY created_at DESC"),
          telegramApi('getMe', {})
        ]);
        const botUsername = String(me?.username || '');
        const lines = ['АКТИВНЫЕ БОНУСЫ', '', 'ПРОМОКОДЫ (' + promos.rowCount + '):'];
        if (!promos.rowCount) lines.push('— Активных промокодов нет.');
        for (const p of promos.rows) lines.push('• ' + p.code + ' — осталось ' + Math.max(0, Number(p.max_activations)-Number(p.activations)) + ' из ' + p.max_activations + ' активаций; награда: ' + Number(p.reward).toLocaleString('ru-RU') + ' звёзд.');
        lines.push('', 'БОНУС-СCЫЛКИ (' + links.rowCount + '):');
        if (!links.rowCount) lines.push('— Активных бонус-ссылок нет.');
        for (const b of links.rows) {
          const remaining = Math.max(0, Number(b.max_activations)-Number(b.activations));
          const link = botUsername ? 'https://t.me/' + botUsername + '?start=bonus_' + b.token : '';
          lines.push('• ' + (link || ('Токен: ' + b.token)) + '\n  Баланс: ' + (b.balance_type === 'city' ? 'городской' : 'основной') + '; награда: ' + Number(b.reward).toLocaleString('ru-RU') + ' звёзд.\n  Осталось активаций: ' + remaining + ' из ' + b.max_activations + '.');
        }
        await telegramApi('sendMessage', {chat_id:chatId, text:lines.join('\n'), disable_web_page_preview:true, reply_markup:{inline_keyboard:[[{text:'Обновить список',callback_data:'adm:bonuses:check'}],[{text:'В админ-панель',callback_data:'adm:cancel'}]]}});
      } else if (action === 'adm:botstars') {
        const balance = await telegramApi('getMyStarBalance', {});
        const amount = Number(balance?.amount || 0);
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: 'Баланс Telegram Stars бота: ' + amount.toLocaleString('ru-RU') + ' ⭐️\nВывод доступен владельцу через Fragment. Минимум, срок доступности и возможность вывода определяет Telegram.',
          reply_markup: { inline_keyboard: [
            [{ text: 'Открыть Fragment для вывода', url: 'https://fragment.com/' }],
            [{ text: 'Обновить баланс', callback_data: 'adm:botstars' }]
          ]}
        });
      } else if (action === 'adm:broadcast:confirm') {
        const state = adminStates.get(String(sender.id));
        if (!state || state.mode !== 'broadcast_confirm') {
          await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка не найдена или уже обработана.'});
        } else {
          adminStates.delete(String(sender.id));
          const users = await pool.query("SELECT telegram_id FROM stars_users WHERE is_blocked=FALSE AND last_seen_at >= NOW()-INTERVAL '7 days' ORDER BY last_seen_at DESC");
          let sent = 0, failed = 0;
          for (const u of users.rows) {
            try { await telegramApi('copyMessage',{chat_id:u.telegram_id,from_chat_id:state.sourceChatId,message_id:state.sourceMessageId}); sent++; }
            catch (_) { failed++; }
          }
          await telegramApi('sendMessage',{chat_id:chatId,text:'Рассылка завершена. Успешно: '+sent+'. Не доставлено: '+failed+'.'});
        }
      } else if (action === 'adm:broadcast') {
        await pool.query("INSERT INTO stars_admins (telegram_id,username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO NOTHING",[String(sender.id),String(sender.username||'admin')]);
        adminStates.set(String(sender.id), {mode:'broadcast'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Отправь следующим сообщением текст рассылки. Оно пока никому не отправится.'});
      } else if (action === 'adm:leaderboard:reset') {
        await telegramApi('sendMessage',{chat_id:chatId,text:'Подтверди сброс всех топов выигрышей до 0. Игровые балансы пользователей останутся без изменений.',reply_markup:{inline_keyboard:[
          [{text:'Да, сбросить все топы',callback_data:'adm:leaderboard:reset:confirm'}],
          [{text:'Отмена',callback_data:'adm:cancel'}]
        ]}});
      } else if (action === 'adm:leaderboard:reset:confirm') {
        const client=await pool.connect();
        try {
          await client.query('BEGIN');
          const slots=await client.query('UPDATE stars_slot_wins SET total_won=0, updated_at=NOW()');
          const doubles=await client.query('UPDATE stars_double_wins SET total_won=0, updated_at=NOW()');
          const cups=await client.query('UPDATE stars_cup_wins SET total_won=0, updated_at=NOW()');
          await client.query('COMMIT');
          await telegramApi('sendMessage',{chat_id:chatId,text:'Все топы сброшены до 0. Обнулено записей — StarsSlots: '+slots.rowCount+', StarsDouble: '+doubles.rowCount+', стаканчики: '+cups.rowCount+'. Балансы игроков не затронуты.'});
        } catch(e) {
          try { await client.query('ROLLBACK'); } catch(_) {}
          throw e;
        } finally { client.release(); }
      } else if (action === 'adm:bonuslink:create') {
        adminStates.set(String(sender.id),{mode:'bonus_link_create',step:'type'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Создание бонус-ссылки. Выбери, на какой баланс начислять бонус.',reply_markup:{inline_keyboard:[[{text:'Основной баланс',callback_data:'adm:bonuslink:type:main'}],[{text:'Городской баланс',callback_data:'adm:bonuslink:type:city'}],[{text:'Отмена',callback_data:'adm:cancel'}]]}});
      } else if (action === 'adm:bonuslink:type:main' || action === 'adm:bonuslink:type:city') {
        adminStates.set(String(sender.id),{mode:'bonus_link_create',step:'activations',balanceType:action.endsWith(':city')?'city':'main'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Сколько активаций разрешить? Введи целое число от 1 до 1000000.',reply_markup:{inline_keyboard:[[{text:'Отмена',callback_data:'adm:cancel'}]]}});
      } else if (action === 'adm:promo:create') {
        adminStates.set(String(sender.id), {mode:'promo_create',step:'activations'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Создание промокода. Сколько активаций разрешить? Введи целое число от 1 до 1000000.',reply_markup:{inline_keyboard:[[{text:'Отмена',callback_data:'adm:cancel'}]]}});
      } else if (action === 'adm:info') {
        adminStates.set(String(sender.id), {mode:'info',step:'user'});
        await telegramApi('sendMessage',{chat_id:chatId,text:'Отправь Telegram username игрока (@username) или его числовой Telegram ID, чтобы получить информацию.'});
      } else if (action.startsWith('adm:player:block:')) {
        const targetId=action.slice('adm:player:block:'.length);
        if (!/^\d+$/.test(targetId)) { await telegramApi('sendMessage',{chat_id:chatId,text:'Некорректный ID игрока.'}); return res.sendStatus(200); }
        const changed=await pool.query('UPDATE stars_users SET is_blocked=TRUE,updated_at=NOW() WHERE telegram_id=$1 RETURNING telegram_id',[targetId]);
        await telegramApi('sendMessage',{chat_id:chatId,text:changed.rowCount?'Игрок '+targetId+' заблокирован.':'Игрок не найден.'});
      } else if (action.startsWith('adm:player:unblock:')) {
        const targetId=action.slice('adm:player:unblock:'.length);
        const changed=await pool.query('UPDATE stars_users SET is_blocked=FALSE,updated_at=NOW() WHERE telegram_id=$1 RETURNING telegram_id',[targetId]);
        await telegramApi('sendMessage',{chat_id:chatId,text:changed.rowCount?'Блокировка игрока '+targetId+' снята.':'Игрок не найден.'});
      } else if (action === 'adm:add' || action === 'adm:remove' || action === 'adm:cityadd') {
        const mode = action === 'adm:add' ? 'add' : action === 'adm:remove' ? 'remove' : 'cityadd';
        adminStates.set(String(sender.id), {mode, step:'user'});
        await telegramApi('sendMessage',{chat_id:chatId,text:mode==='cityadd'?'Введи Telegram username (@username) или числовой Telegram ID игрока для начисления на городской баланс.':'Введи Telegram ID пользователя, которому '+(mode==='add'?'начислить':'списать')+' монеты.'});
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
    if (incoming && adminRow.rowCount && adminStates.has(String(sender.id)) && !/^\/(?:adminser|admin)(?:@\w+)?(?:\s|$)/i.test(text)) {
      const state = adminStates.get(String(sender.id));
      if (state.mode === 'bonus_link_create') {
        if(state.step==='activations'){
          const n=Number(text);
          if(!/^\d+$/.test(text)||!Number.isSafeInteger(n)||n<1||n>1000000){await telegramApi('sendMessage',{chat_id:chatId,text:'Введи целое число активаций от 1 до 1000000.'});return res.sendStatus(200);}
          state.maxActivations=n;state.step='reward';adminStates.set(String(sender.id),state);
          await telegramApi('sendMessage',{chat_id:chatId,text:'Введи сумму бонуса на одного пользователя (целое число от 1 до 1000000000).'});
          return res.sendStatus(200);
        }
        if(state.step==='reward'){
          const reward=Number(text);
          if(!/^\d+$/.test(text)||!Number.isSafeInteger(reward)||reward<1||reward>1000000000){await telegramApi('sendMessage',{chat_id:chatId,text:'Введи целую сумму от 1 до 1000000000.'});return res.sendStatus(200);}
          const token=crypto.randomBytes(9).toString('hex').toUpperCase();
          await pool.query('INSERT INTO stars_bonus_links(token,balance_type,reward,max_activations,created_by) VALUES($1,$2,$3,$4,$5)',[token,state.balanceType,reward,state.maxActivations,String(sender.id)]);
          adminStates.delete(String(sender.id));
          let botName;try{botName=(await telegramApi('getMe',{})).username;}catch(_){}
          const link=botName?'https://t.me/'+botName+'?start=bonus_'+token:null;
          await telegramApi('sendMessage',{chat_id:chatId,text:'Бонус-ссылка создана!\nТип баланса: '+(state.balanceType==='city'?'городской':'основной')+'\nБонус за активацию: '+reward.toLocaleString('ru-RU')+' звёзд\nЛимит активаций: '+state.maxActivations+'\n\nСсылка: '+(link||'Не удалось получить username бота; проверь настройки Telegram-бота.'),reply_markup:link?{inline_keyboard:[[{text:'Открыть ссылку',url:link}],[{text:'Создать ещё',callback_data:'adm:bonuslink:create'}]]}:undefined});
          return res.sendStatus(200);
        }
      }
      if (state.mode === 'promo_create') {
        if (state.step === 'activations') {
          const activations = Number(text);
          if (!/^\d+$/.test(text) || !Number.isSafeInteger(activations) || activations < 1 || activations > 1000000) {
            await telegramApi('sendMessage',{chat_id:chatId,text:'Введи целое число активаций от 1 до 1000000. Или нажми «Отмена».'});
            return res.sendStatus(200);
          }
          state.maxActivations = activations;
          state.step = 'reward';
          adminStates.set(String(sender.id), state);
          await telegramApi('sendMessage',{chat_id:chatId,text:'Теперь введи сумму игровых звёзд, которую получит каждый активировавший промокод. Целое число от 1 до 1000000000.'});
          return res.sendStatus(200);
        }
        if (state.step === 'reward') {
          const reward = Number(text);
          if (!/^\d+$/.test(text) || !Number.isSafeInteger(reward) || reward < 1 || reward > 1000000000) {
            await telegramApi('sendMessage',{chat_id:chatId,text:'Введи целую сумму от 1 до 1000000000. Или нажми «Отмена».'});
            return res.sendStatus(200);
          }
          let code, inserted = false;
          for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
            code = 'STAR-' + crypto.randomBytes(5).toString('hex').toUpperCase();
            const result = await pool.query('INSERT INTO stars_promocodes(code,reward,max_activations,activations) VALUES($1,$2,$3,0) ON CONFLICT(code) DO NOTHING RETURNING code',[code,reward,state.maxActivations]);
            inserted = result.rowCount === 1;
          }
          adminStates.delete(String(sender.id));
          if (!inserted) {
            await telegramApi('sendMessage',{chat_id:chatId,text:'Не удалось создать уникальный промокод. Попробуй снова.'});
          } else {
            await telegramApi('sendMessage',{chat_id:chatId,text:'Промокод создан: ' + code + '\nНаграда: ' + reward.toLocaleString('ru-RU') + ' игровых звёзд каждому.\nЛимит активаций: ' + state.maxActivations + '.\nКод можно активировать в приложении Stars.',reply_markup:{inline_keyboard:[[{text:'Скопировать код',copy_text:{text:code}}],[{text:'Создать ещё',callback_data:'adm:promo:create'}]]}});
          }
          return res.sendStatus(200);
        }
      }
      if (state.mode === 'info') {
        const target=text.replace(/^@/,'').trim();
        let found;
        if (/^\d+$/.test(target)) found=await pool.query('SELECT * FROM stars_users WHERE telegram_id=$1',[target]);
        else if (/^[A-Za-z0-9_]{5,32}$/.test(target)) found=await pool.query('SELECT * FROM stars_users WHERE LOWER(username)=LOWER($1) ORDER BY registered_at ASC LIMIT 1',[target]);
        else { await telegramApi('sendMessage',{chat_id:chatId,text:'Введи числовой Telegram ID или корректный username (от 5 до 32 символов).'}); return res.sendStatus(200); }
        adminStates.delete(String(sender.id));
        if (!found.rowCount) { await telegramApi('sendMessage',{chat_id:chatId,text:'Игрок не найден. Пользователь должен хотя бы раз запустить бота или открыть приложение.'}); return res.sendStatus(200); }
        const player=found.rows[0];
        const [refs,wins,payments,withdrawals]=await Promise.all([
          pool.query('SELECT COUNT(*)::int AS n FROM stars_referrals WHERE referrer_id=$1',[String(player.telegram_id)]),
          pool.query('SELECT COALESCE(total_won,0)::bigint AS total_won FROM stars_slot_wins WHERE telegram_id=$1',[String(player.telegram_id)]),
          pool.query('SELECT COALESCE(SUM(coins),0)::bigint AS purchased,COUNT(*)::int AS count FROM stars_payments WHERE telegram_id=$1',[String(player.telegram_id)]),
          pool.query('SELECT COUNT(*)::int AS count,COALESCE(SUM(payout_stars),0)::bigint AS payout FROM stars_withdrawals WHERE telegram_id=$1',[String(player.telegram_id)])
        ]);
        const joined=player.registered_at?new Date(player.registered_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'неизвестно';
        const username=player.username?'@'+player.username:'не указан';
        const won=Number(wins.rows[0]?.total_won||0), invited=Number(refs.rows[0]?.n||0);
        await telegramApi('sendMessage',{chat_id:chatId,text:'Информация об игроке — ID: '+player.telegram_id+'\nUsername: '+username+'\nИмя: '+(player.first_name||'не указано')+'\nРегистрация: '+joined+'\nБаланс: '+Number(player.balance||0).toLocaleString('ru-RU')+' звёзд\nВсего выигрышей в StarsSlots: '+won.toLocaleString('ru-RU')+' звёзд\nРефералов: '+invited+'\nПокупки: '+Number(payments.rows[0]?.purchased||0).toLocaleString('ru-RU')+' игровых звёзд ('+Number(payments.rows[0]?.count||0)+' платежей)\nЗаявок на вывод: '+Number(withdrawals.rows[0]?.count||0)+'\nВыплачено Telegram Stars по заявкам: '+Number(withdrawals.rows[0]?.payout||0)+'\nСтатус: '+(player.is_blocked?'ЗАБЛОКИРОВАН':'активен'),reply_markup:{inline_keyboard:player.is_blocked?[[{text:'Разблокировать игрока',callback_data:'adm:player:unblock:'+player.telegram_id}]]:[[ {text:'Заблокировать игрока',callback_data:'adm:player:block:'+player.telegram_id} ]]}});
        return res.sendStatus(200);
      }
      if (state.mode === 'broadcast') {
        const hasText = Boolean(incoming?.text || incoming?.caption);
        const hasMedia = Boolean(incoming?.photo?.length || incoming?.voice || incoming?.audio || incoming?.video || incoming?.document || incoming?.animation);
        if (!hasText && !hasMedia) { await telegramApi('sendMessage',{chat_id:chatId,text:'Отправь текст, картинку с подписью или голосовое сообщение. Форматирование и подпись сохранятся.'}); return res.sendStatus(200); }
        adminStates.set(String(sender.id),{mode:'broadcast_confirm',sourceMessageId:Number(incoming.message_id),sourceChatId:incoming.chat.id});
        await telegramApi('copyMessage',{chat_id:chatId,from_chat_id:incoming.chat.id,message_id:incoming.message_id});
        const activeCount=await pool.query("SELECT COUNT(*)::int AS count FROM stars_users WHERE is_blocked=FALSE AND last_seen_at >= NOW()-INTERVAL '7 days'");
         const totalRegistered=await pool.query('SELECT COUNT(*)::int AS count FROM stars_users');
         await telegramApi('sendMessage',{chat_id:chatId,text:'Предпросмотр выше.\n\nАктивных пользователей за последние 7 дней: '+Number(activeCount.rows[0]?.count||0).toLocaleString('ru-RU')+'\nВсего зарегистрировано: '+Number(totalRegistered.rows[0]?.count||0).toLocaleString('ru-RU')+'\n\nОтправить рассылку активным пользователям?',reply_markup:{inline_keyboard:[[{text:'Подтвердить рассылку',callback_data:'adm:broadcast:confirm'},{text:'Отмена',callback_data:'adm:cancel'}]]}});
        return res.sendStatus(200);
      }
      if (state.mode === 'add' || state.mode === 'remove' || state.mode === 'cityadd') {
        if (state.step === 'user') {
          let targetId = null;
          if (/^\d+$/.test(text)) targetId = text;
          else if (state.mode === 'cityadd' && /^@?[A-Za-z0-9_]{5,32}$/.test(text)) {
            const username = text.replace(/^@/, '');
            const found = await pool.query('SELECT telegram_id FROM stars_users WHERE LOWER(username)=LOWER($1) ORDER BY registered_at ASC LIMIT 1',[username]);
            if (found.rowCount) targetId = String(found.rows[0].telegram_id);
          }
          if (targetId) {
            state.telegramId=targetId; state.step='amount'; adminStates.set(String(sender.id),state);
            await telegramApi('sendMessage',{chat_id:chatId,text:'Теперь введи целое положительное количество '+(state.mode==='cityadd'?'городских звёзд':'монет')+'.'});
          } else await telegramApi('sendMessage',{chat_id:chatId,text:state.mode==='cityadd'?'Игрок не найден. Проверь username или введи числовой Telegram ID.':'Введи числовой Telegram ID пользователя.'});
        } else if (state.step === 'amount' && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text)>0) {
          const amount=Number(text), client=await pool.connect();
          try {
            await client.query('BEGIN');
            if (state.mode==='cityadd') {
              const user=await client.query('SELECT telegram_id FROM stars_users WHERE telegram_id=$1 FOR UPDATE',[state.telegramId]);
              if (!user.rowCount) { await client.query('ROLLBACK'); await telegramApi('sendMessage',{chat_id:chatId,text:'Пользователь не найден в базе. Операция отменена.'}); }
              else {
                await client.query('INSERT INTO stars_city_stats(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING',[state.telegramId]);
                const updated=await client.query('UPDATE stars_city_stats SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING balance,city',[state.telegramId,amount]);
                await client.query('COMMIT');
                await telegramApi('sendMessage',{chat_id:chatId,text:'Начислено '+amount.toLocaleString('ru-RU')+' городских звёзд игроку '+state.telegramId+'. Новый городской баланс: '+Number(updated.rows[0].balance).toLocaleString('ru-RU')+'. Город: '+(CITY_CONFIG[updated.rows[0].city]?.name||updated.rows[0].city)+'.'});
                try { await telegramApi('sendMessage',{chat_id:state.telegramId,text:'Администратор начислил '+amount.toLocaleString('ru-RU')+' городских звёзд. Текущий городской баланс: '+Number(updated.rows[0].balance).toLocaleString('ru-RU')+'.'}); } catch(_) {}
              }
            } else {
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
            }
          } catch(e) { try { await client.query('ROLLBACK'); } catch(_) {} throw e; } finally { client.release(); }
          adminStates.delete(String(sender.id));
        } else await telegramApi('sendMessage',{chat_id:chatId,text:'Неверный ввод. Операция отменена.'});
        return res.sendStatus(200);
      }
    }
    if (update.message && /^\/start(?:@\w+)?(?:\s|$)/i.test(String(update.message.text || ''))) { const raw=String(update.message.text||'').trim(),ref=raw.match(/^\/start(?:@\w+)?\s+ref_(\d+)/i),cityRef=raw.match(/^\/start(?:@\w+)?\s+cityref_(\d+)/i),bonusLink=raw.match(/^\/start(?:@\w+)?\s+bonus_([A-F0-9]{18})/i),refId=cityRef&&cityRef[1]||ref&&ref[1],isCityRef=!!cityRef,chat=update.message.chat?.id,u=update.message.from||{}; if(chat){await pool.query('INSERT INTO stars_users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()',[String(u.id),u.username||null,u.first_name||null]);if(bonusLink){const client=await pool.connect();try{await client.query('BEGIN');const bonus=await client.query('SELECT * FROM stars_bonus_links WHERE token=$1 FOR UPDATE',[bonusLink[1]]);if(!bonus.rowCount){await client.query('ROLLBACK');await telegramApi('sendMessage',{chat_id:chat,text:'Бонус-ссылка не найдена.'});}else{const b=bonus.rows[0],used=await client.query('SELECT 1 FROM stars_bonus_link_uses WHERE token=$1 AND telegram_id=$2',[b.token,String(u.id)]);if(used.rowCount){await client.query('COMMIT');await telegramApi('sendMessage',{chat_id:chat,text:'Ты уже активировал эту бонус-ссылку.'});}else if(Number(b.activations)>=Number(b.max_activations)){await client.query('COMMIT');await telegramApi('sendMessage',{chat_id:chat,text:'У этой бонус-ссылки закончились активации.'});}else{await client.query('INSERT INTO stars_bonus_link_uses(token,telegram_id) VALUES($1,$2)',[b.token,String(u.id)]);if(b.balance_type==='city'){await client.query('INSERT INTO stars_city_stats(telegram_id,balance) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET balance=stars_city_stats.balance+EXCLUDED.balance,updated_at=NOW()',[String(u.id),b.reward]);}else{await client.query('UPDATE stars_users SET balance=balance+$2,updated_at=NOW() WHERE telegram_id=$1',[String(u.id),b.reward]);}await client.query('UPDATE stars_bonus_links SET activations=activations+1 WHERE token=$1',[b.token]);await client.query('COMMIT');try{const adminChatId=process.env.ADMIN_TELEGRAM_ID||'8782131397',who=(u.username?'@'+u.username:(u.first_name||'Без имени'))+' (ID '+u.id+')',remaining=Math.max(0,Number(b.max_activations)-Number(b.activations)-1);await telegramApi('sendMessage',{chat_id:adminChatId,text:'Пользователь активировал бонус-ссылку.\nСсылка-токен: '+b.token+'\nПользователь: '+who+'\nНачислено: '+Number(b.reward).toLocaleString('ru-RU')+' звёзд ('+(b.balance_type==='city'?'городской':'основной')+' баланс)\nОсталось активаций: '+remaining+' из '+b.max_activations});}catch(notifyError){console.error('Admin bonus-link notification failed:',notifyError.message);}await telegramApi('sendMessage',{chat_id:chat,text:'Бонус активирован! Начислено '+Number(b.reward).toLocaleString('ru-RU')+' звёзд на '+(b.balance_type==='city'?'городской':'основной')+' баланс.',reply_markup:{inline_keyboard:[[{text:'Открыть приложение',web_app:{url:(process.env.WEB_APP_URL||process.env.APP_URL||'').replace(/\/$/,'')}}]]}});}}}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}if(refId&&refId!==String(u.id)){const c=await pool.connect();try{await c.query('BEGIN');const prior=await c.query('SELECT COUNT(*)::int AS n FROM stars_referrals WHERE referrer_id=$1',[refId]);const firstReferral=Number(prior.rows[0]?.n||0)===0;const r=await c.query('INSERT INTO stars_referrals(referred_id,referrer_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING RETURNING referrer_id',[String(u.id),refId]);if(r.rowCount){await c.query('UPDATE stars_users SET balance=balance+77,updated_at=NOW() WHERE telegram_id=$1',[refId]);if(firstReferral){await c.query("INSERT INTO stars_box_promos(telegram_id,code,activated_at,expires_at,free_spins_remaining) VALUES($1,'REFERRAL-77',NOW(),NOW()+INTERVAL '10 years',2) ON CONFLICT(telegram_id) DO UPDATE SET expires_at=GREATEST(stars_box_promos.expires_at,EXCLUDED.expires_at),free_spins_remaining=stars_box_promos.free_spins_remaining+2",[refId]);}await c.query("INSERT INTO stars_box_promos(telegram_id,code,activated_at,expires_at,free_spins_remaining) VALUES($1,'REFERRAL-GIFT',NOW(),NOW()+INTERVAL '10 years',1) ON CONFLICT(telegram_id) DO UPDATE SET expires_at=GREATEST(stars_box_promos.expires_at,EXCLUDED.expires_at),free_spins_remaining=stars_box_promos.free_spins_remaining+1",[String(u.id)]);if(firstReferral){await c.query("INSERT INTO stars_city_stats(telegram_id,city,level) VALUES($1,'rezh',30) ON CONFLICT(telegram_id) DO UPDATE SET city='rezh',level=GREATEST(stars_city_stats.level,30),updated_at=NOW()",[refId]);}}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}if(String(u.username||'').toLowerCase()==='vladubrat7')await pool.query('INSERT INTO stars_admins(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username',[String(u.id),'vladubrat7']);await telegramApi('sendMessage',{chat_id:chat,text:'Добро пожаловать в Stars! Нажми «БОНУС💎», чтобы получить реферальную ссылку и узнать условия акции.',reply_markup:{keyboard:[[{text:'БОНУС💎'}]],resize_keyboard:true,is_persistent:true}});const b=await pool.query('SELECT balance FROM stars_users WHERE telegram_id=$1',[String(u.id)]);if(Number(b.rows[0]?.balance||0)<10){const app=(process.env.WEB_APP_URL||process.env.APP_URL||'').replace(/\/$/,'');if(app&&/^https:\/\//i.test(app))await telegramApi('sendMessage',{chat_id:chat,text:'Баланс ниже 10 игровых звёзд. Пополни его настоящими Telegram Stars.',reply_markup:{inline_keyboard:[[{text:'Пополнить',web_app:{url:app}}]]}});}}return res.sendStatus(200);}
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let valid = false;
      try { const p=JSON.parse(q.invoice_payload||'{}'),k=PACKAGES[Number(p.stars)],c=p.custom===true&&Number.isSafeInteger(Number(p.coins))&&Number(p.coins)>=500&&Number(p.coins)<=531914&&Number(p.stars)===Math.ceil(Number(p.coins)/10);valid=String(q.from?.id)===String(p.userId)&&q.currency==='XTR'&&q.total_amount===Number(p.stars)&&(c||(!!k&&Number(p.coins)===k.coins)); } catch (_) {}
      await telegramApi('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: valid, ...(!valid ? { error_message: 'Счёт недействителен. Создай новый счёт.' } : {}) });
      return res.sendStatus(200);
    }
    const payment = update.message?.successful_payment;
    if (!payment) return res.sendStatus(200);
    const paymentSender=update.message.from,payload=JSON.parse(payment.invoice_payload||'{}'),pack=PACKAGES[Number(payload.stars)],custom=payload.custom===true&&Number.isSafeInteger(Number(payload.coins))&&Number(payload.coins)>=500&&Number(payload.coins)<=531914&&Number(payload.stars)===Math.ceil(Number(payload.coins)/10),paidStars=custom?Number(payload.stars):pack?.stars,paidCoins=custom?Number(payload.coins):pack?.coins;
    if ((!pack&&!custom)||String(paymentSender?.id)!==String(payload.userId)||payment.currency!=='XTR'||payment.total_amount!==paidStars||!paidCoins||!payment.telegram_payment_charge_id) { console.error('Rejected mismatched successful_payment update'); return res.sendStatus(200); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO stars_users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO NOTHING', [String(paymentSender.id), paymentSender.username || null, paymentSender.first_name || null]);
      const inserted = await client.query('INSERT INTO stars_payments (telegram_payment_charge_id, telegram_id, package_stars, coins, currency, total_amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (telegram_payment_charge_id) DO NOTHING RETURNING telegram_payment_charge_id', [payment.telegram_payment_charge_id,String(paymentSender.id),paidStars,paidCoins,payment.currency,payment.total_amount]);
      let topupBonus=0;
      if (inserted.rowCount) {
        const activePromo=await client.query("SELECT telegram_id FROM stars_box_promos WHERE telegram_id=$1 AND expires_at>NOW() FOR UPDATE",[String(paymentSender.id)]);
        if(activePromo.rowCount) topupBonus=Math.floor(paidCoins*0.012);
        await client.query('UPDATE stars_users SET balance=balance+$2, username=$3, first_name=$4, updated_at=NOW() WHERE telegram_id=$1', [String(paymentSender.id), paidCoins+topupBonus, paymentSender.username || null, paymentSender.first_name || null]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.sendStatus(200);
  } catch (e) {
    console.error('Telegram webhook processing error:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});
app.get('*', (_req, res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, '0.0.0.0', async () => {
  console.log('Stars UI listening on ' + PORT);
  if (process.env.WEBHOOK_URL && process.env.BOT_TOKEN) {
    try {
      const url = new URL('/api/telegram/webhook', process.env.WEBHOOK_URL).toString();
      const webhookOptions = { url, allowed_updates: ['message', 'pre_checkout_query', 'callback_query'], drop_pending_updates: false };
      if (process.env.TELEGRAM_WEBHOOK_SECRET) webhookOptions.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
      await telegramApi('setWebhook', webhookOptions);
      console.log('Telegram webhook configured' + (webhookOptions.secret_token ? ' with secret token' : ' WITHOUT secret token; set TELEGRAM_WEBHOOK_SECRET in Railway'));
    } catch (e) { console.error('Webhook setup failed:', e.message); }
  } else console.log('Webhook setup skipped: BOT_TOKEN and WEBHOOK_URL are required');
});
