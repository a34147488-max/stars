const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 8080;
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PACKAGES = {
  50: { coins: 500, title: 'Стартовый пакет — 500 звёзд', stars: 50 },
  75: { coins: 900, title: 'Бронзовый пакет — 900 звёзд', stars: 75 },
  100: { coins: 1200, title: 'Серебряный пакет — 1200 звёзд', stars: 100 },
  159: { coins: 1459, title: 'Золотой пакет — 1459 звёзд', stars: 159 },
  200: { coins: 2199, title: 'Платиновый пакет — 2199 звёзд', stars: 200 },
  500: { coins: 8999, title: 'Алмазный пакет — 8999 звёзд', stars: 500 }
};

function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const user = JSON.parse(params.get('user') || '{}');
    return user.id ? user : null;
  } catch (_) { return null; }
}

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.post('/api/payments/create-invoice', async (req, res) => {
  try {
    const token = process.env.BOT_TOKEN;
    if (!token) return res.status(503).json({ ok: false, error: 'На сервере не настроен BOT_TOKEN.' });
    const user = validateTelegramInitData(req.get('X-Telegram-Init-Data'), token);
    if (!user) return res.status(401).json({ ok: false, error: 'Не удалось подтвердить Telegram-профиль. Перезапусти приложение из бота.' });
    const pack = PACKAGES[Number(req.body && req.body.stars)];
    if (!pack) return res.status(400).json({ ok: false, error: 'Неизвестный пакет пополнения.' });
    const payload = JSON.stringify({ userId: user.id, stars: pack.stars, coins: pack.coins, nonce: crypto.randomBytes(12).toString('hex') });
    const telegramResponse = await fetch('https://api.telegram.org/bot' + token + '/createInvoiceLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pack.title,
        description: 'Пополнение игрового баланса на ' + pack.coins + ' звёзд.',
        payload,
        currency: 'XTR',
        prices: [{ label: pack.title, amount: pack.stars }]
      }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await telegramResponse.json();
    if (!telegramResponse.ok || !data.ok || !data.result) {
      console.error('Telegram invoice creation failed:', data.description || telegramResponse.status);
      return res.status(502).json({ ok: false, error: 'Telegram не смог создать счёт. Попробуй позже.' });
    }
    return res.json({ ok: true, url: data.result, package: { stars: pack.stars, coins: pack.coins } });
  } catch (e) {
    console.error('Invoice creation error:', e.message);
    return res.status(502).json({ ok: false, error: 'Не удалось связаться с Telegram для создания счёта.' });
  }
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log('Stars UI listening on ' + PORT));