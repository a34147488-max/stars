import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { fal } from "@fal-ai/client";
import pg from "pg";

const { Pool } = pg;
const TOKEN = process.env.BOT_TOKEN;
const FAL_KEY = process.env.FAL_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMINS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const FREE_LIMIT = Math.max(0, Number.parseInt(process.env.FREE_LIMIT || "3", 10));
const MODEL = process.env.FAL_MODEL || "minimax/h3-max/text-to-video";
const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || "minimax/h3-max/image-to-video";
const RESOLUTION = process.env.VIDEO_RESOLUTION || "480P";
const POLL_MS = Math.max(3000, Number(process.env.POLL_MS || "7000"));
const MAX_PROMPT = 1800;
if (!TOKEN || !FAL_KEY || !DATABASE_URL) {
  console.error("Missing BOT_TOKEN, FAL_KEY or DATABASE_URL");
  process.exit(1);
}
fal.config({ credentials: FAL_KEY });
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  max: 10,
  connectionTimeoutMillis: 10000
});
const bot = new Bot(TOKEN);
const states = new Map();
const busyUsers = new Set();
const packs = [
  { id: "pack5", title: "5 генераций", count: 5, price: 300 },
  { id: "pack10", title: "10 генераций", count: 10, price: 600 },
  { id: "pack25", title: "25 генераций", count: 25, price: 1500 }
];
let polling = false;
const admin = id => ADMINS.has(String(id));

async function initDb() {
  await pool.query("CREATE TABLE IF NOT EXISTS video_bot_users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, free_used INTEGER NOT NULL DEFAULT 0, paid_credits INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS video_bot_jobs (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL REFERENCES video_bot_users(telegram_id), prompt TEXT NOT NULL, duration INTEGER NOT NULL, aspect_ratio TEXT NOT NULL DEFAULT '16:9', image_url TEXT, model_id TEXT NOT NULL DEFAULT 'minimax/h3-max/text-to-video', status TEXT NOT NULL DEFAULT 'submitting', request_id TEXT, video_url TEXT, error_text TEXT, credit_source TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("ALTER TABLE video_bot_jobs ADD COLUMN IF NOT EXISTS image_url TEXT");
  await pool.query("ALTER TABLE video_bot_jobs ADD COLUMN IF NOT EXISTS model_id TEXT NOT NULL DEFAULT 'minimax/h3-max/text-to-video'");
  await pool.query("CREATE INDEX IF NOT EXISTS video_bot_jobs_status_idx ON video_bot_jobs(status, created_at)");
  await pool.query("CREATE TABLE IF NOT EXISTS video_bot_payments (telegram_charge_id TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, payload TEXT NOT NULL, stars INTEGER NOT NULL, credits INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}
async function upsertUser(from) {
  await pool.query("INSERT INTO video_bot_users (telegram_id,username,first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()", [String(from.id), from.username || null, from.first_name || null]);
}
async function getUser(id) {
  const r = await pool.query("SELECT * FROM video_bot_users WHERE telegram_id=$1", [String(id)]);
  return r.rows[0];
}
async function balanceText(id) {
  const u = await getUser(id);
  const free = Math.max(0, FREE_LIMIT - Number(u?.free_used || 0));
  return "Баланс генераций\n\nБесплатных осталось: " + free + "\nКупленных доступно: " + Number(u?.paid_credits || 0) + "\nВсего доступно: " + (free + Number(u?.paid_credits || 0));
}
function mainKeyboard() {
  return new InlineKeyboard().text("По тексту", "make").text("По фото", "make_photo").row()
    .text("Тарифы", "buy").text("Мой баланс", "balance").row()
    .text("Примеры запросов", "prompt_help");
}
function buyKeyboard() {
  const kb = new InlineKeyboard();
  for (const p of packs) kb.text(p.title + " — " + p.price + " ⭐", "buy:" + p.id).row();
  return kb;
}
function adminKeyboard() {
  return new InlineKeyboard().text("Статистика", "adm:stats").row()
    .text("Выдать генерации", "adm:grant").row()
    .text("Сбросить бесплатные попытки всем", "adm:reset_confirm").row()
    .text("Команды", "adm:help");
}
async function reserve(from, prompt, duration, imageUrl = null, modelId = MODEL) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const u = await c.query("SELECT * FROM video_bot_users WHERE telegram_id=$1 FOR UPDATE", [String(from.id)]);
    if (!u.rowCount) throw new Error("USER_NOT_FOUND");
    let source;
    if (Number(u.rows[0].free_used) < FREE_LIMIT) {
      source = "free";
      await c.query("UPDATE video_bot_users SET free_used=free_used+1,updated_at=NOW() WHERE telegram_id=$1", [String(from.id)]);
    } else if (Number(u.rows[0].paid_credits) > 0) {
      source = "paid";
      await c.query("UPDATE video_bot_users SET paid_credits=paid_credits-1,updated_at=NOW() WHERE telegram_id=$1", [String(from.id)]);
    } else {
      await c.query("ROLLBACK");
      return null;
    }
    const j = await c.query("INSERT INTO video_bot_jobs (telegram_id,prompt,duration,image_url,model_id,status,credit_source) VALUES ($1,$2,$3,$4,$5,'submitting',$6) RETURNING id", [String(from.id), prompt, duration, imageUrl, modelId, source]);
    await c.query("COMMIT");
    return { id: j.rows[0].id, source };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch {}
    throw e;
  } finally { c.release(); }
}
async function refund(jobId, telegramId, source, error) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const changed = await c.query("UPDATE video_bot_jobs SET status='failed',error_text=$2,updated_at=NOW() WHERE id=$1 AND status IN ('submitting','queued','processing') RETURNING id", [jobId, String(error || "failed").slice(0, 500)]);
    if (changed.rowCount) {
      if (source === "free") await c.query("UPDATE video_bot_users SET free_used=GREATEST(0,free_used-1),updated_at=NOW() WHERE telegram_id=$1", [String(telegramId)]);
      else await c.query("UPDATE video_bot_users SET paid_credits=paid_credits+1,updated_at=NOW() WHERE telegram_id=$1", [String(telegramId)]);
    }
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch {}
    console.error("Refund failed", e);
  } finally { c.release(); }
}
async function generate(ctx, prompt, duration, imageUrl = null) {
  const uid = String(ctx.from.id);
  if (busyUsers.has(uid)) return ctx.reply("У тебя уже есть активный запрос. Дождись результата.");
  busyUsers.add(uid);
  try {
    const modelId = imageUrl ? IMAGE_MODEL : MODEL;
    const reserved = await reserve(ctx.from, prompt, duration, imageUrl, modelId);
    if (!reserved) return ctx.reply("Бесплатные попытки закончились. Выбери пакет дополнительных генераций:", { reply_markup: buyKeyboard() });
    await ctx.reply("Запрос принят. Генерирую 3D-анимацию на " + duration + " секунд. Обычно это занимает несколько минут. Если API вернёт ошибку, попытка будет восстановлена.");
    try {
      const input = {
        prompt: "High-quality stylized 3D animated film, polished 3D character design, expressive characters, detailed materials, cinematic lighting, smooth natural motion, coherent camera movement, professional family animation, no subtitles, no on-screen text. Scene description: " + prompt,
        enable_safety_checker: true
      };
      if (imageUrl) input.image_url = imageUrl;
      else { input.duration = duration; input.resolution = RESOLUTION; input.aspect_ratio = "16:9"; input.prompt_expansion_mode = "balanced"; }
      const submitted = await fal.queue.submit(modelId, { input });
      await pool.query("UPDATE video_bot_jobs SET request_id=$2,status='queued',updated_at=NOW() WHERE id=$1", [reserved.id, submitted.request_id]);
    } catch (e) {
      await refund(reserved.id, uid, reserved.source, e?.message || e);
      await ctx.reply("Не удалось отправить запрос в видеосервис. Попытка возвращена. Попробуй позже.");
      console.error("fal submit failed", e);
    }
  } catch (e) {
    console.error("Generate failed", e);
    await ctx.reply("Внутренняя ошибка. Попробуй ещё раз позже.");
  } finally { busyUsers.delete(uid); }
}
async function stats(ctx) {
  const u = await pool.query("SELECT COUNT(*)::int AS n FROM video_bot_users");
  const j = await pool.query("SELECT status,COUNT(*)::int AS n FROM video_bot_jobs GROUP BY status");
  const lines = j.rows.map(x => x.status + ": " + x.n).join("\n") || "пока нет";
  await ctx.reply("Админ-статистика\nПользователей: " + u.rows[0].n + "\nЗадачи:\n" + lines);
}

bot.command("start", async ctx => {
  await upsertUser(ctx.from);
  const mode = String(ctx.match || "").trim().toLowerCase();
  if (mode === "text") { states.set(String(ctx.from.id), { step: "prompt" }); return ctx.reply("✍️ Генерация по тексту\n\nОпиши сцену для 3D-мультфильма одним сообщением."); }
  if (mode === "photo") { states.set(String(ctx.from.id), { step: "photo" }); return ctx.reply("🖼 Оживление фото\n\nПришли фотографию, которую нужно превратить в видео. После этого можно будет описать движение."); }
  if (mode === "buy") return ctx.reply("⭐ Тарифы на генерации:", { reply_markup: buyKeyboard() });
  if (mode === "balance") return ctx.reply(await balanceText(ctx.from.id), { reply_markup: mainKeyboard() });
  if (mode === "examples") return ctx.reply("Пример: «Маленький лисёнок в синем шарфе бежит по зимнему лесу, стряхивает снег с ветки, мягкий свет фонарей, плавное движение камеры, детализированная семейная 3D-анимация». Можно писать по-русски.", { reply_markup: mainKeyboard() });
  await ctx.reply("🎬 Генерация видео\n\nСоздавай 3D-анимации по тексту или оживляй фотографии. Новым пользователям доступны 3 бесплатные попытки. Затем можно купить дополнительные генерации за Telegram Stars.\n\nВыбери действие:", { reply_markup: mainKeyboard() });
});
bot.command("help", async ctx => ctx.reply("Нажми «Создать видео», отправь описание сцены и выбери длительность. Пример: маленький робот поливает цветы на крыше футуристического дома на закате, плавный объезд камеры, семейная 3D-анимация."));
bot.command("balance", async ctx => { await upsertUser(ctx.from); await ctx.reply(await balanceText(ctx.from.id)); });
bot.command("buy", async ctx => { await upsertUser(ctx.from); await ctx.reply("Выбери пакет:", { reply_markup: buyKeyboard() }); });
bot.command("admin", async ctx => {
  if (!admin(ctx.from.id)) return ctx.reply("Нет доступа.");
  await ctx.reply("Панель администратора", { reply_markup: adminKeyboard() });
});
bot.command("give", async ctx => {
  if (!admin(ctx.from.id)) return ctx.reply("Нет доступа.");
  const a = (ctx.match || "").trim().split(/\s+/);
  const id = a[0], n = Number.parseInt(a[1], 10);
  if (!/^\d+$/.test(id || "") || !Number.isInteger(n) || n < 1 || n > 10000) return ctx.reply("Формат: /give TELEGRAM_ID КОЛИЧЕСТВО");
  const r = await pool.query("UPDATE video_bot_users SET paid_credits=paid_credits+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING paid_credits", [id, n]);
  await ctx.reply(r.rowCount ? "Выдано " + n + ". На балансе пользователя " + r.rows[0].paid_credits + " генераций." : "Пользователь не найден — пусть сначала нажмёт /start.");
});
bot.command("setfree", async ctx => {
  if (!admin(ctx.from.id)) return ctx.reply("Нет доступа.");
  const a = (ctx.match || "").trim().split(/\s+/);
  const id = a[0], n = Number.parseInt(a[1], 10);
  if (!/^\d+$/.test(id || "") || !Number.isInteger(n) || n < 0 || n > 10000) return ctx.reply("Формат: /setfree TELEGRAM_ID ИСПОЛЬЗОВАНО");
  const r = await pool.query("UPDATE video_bot_users SET free_used=$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING telegram_id", [id, n]);
  await ctx.reply(r.rowCount ? "Обновлено. Бесплатных осталось: " + Math.max(0, FREE_LIMIT - n) : "Пользователь не найден.");
});

bot.callbackQuery("make", async ctx => {
  await ctx.answerCallbackQuery();
  states.set(String(ctx.from.id), { step: "prompt" });
  await ctx.reply("✍️ Опиши сцену для 3D-мультфильма одним сообщением. Лучше описывать одно действие, персонажей, окружение и движение камеры.");
});
bot.callbackQuery("make_photo", async ctx => {
  await ctx.answerCallbackQuery();
  states.set(String(ctx.from.id), { step: "photo" });
  await ctx.reply("🖼 Пришли фотографию, которую нужно оживить. Затем я попрошу описать движение в видео.");
});
bot.callbackQuery("buy", async ctx => { await ctx.answerCallbackQuery(); await ctx.reply("Выбери пакет дополнительных генераций:", { reply_markup: buyKeyboard() }); });
bot.callbackQuery("balance", async ctx => { await ctx.answerCallbackQuery(); await ctx.reply(await balanceText(ctx.from.id)); });
bot.callbackQuery("prompt_help", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Пример: «Маленький лисёнок в синем шарфе бежит по волшебному зимнему лесу, стряхивает снег с ветки, мягкий свет фонарей, плавное движение камеры, детализированная семейная 3D-анимация». Можно писать по-русски.");
});
bot.callbackQuery(/^buy:(.+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const p = packs.find(x => x.id === ctx.match[1]);
  if (!p) return ctx.reply("Пакет не найден. Открой /buy.");
  const payload = p.id + ":" + ctx.from.id + ":" + Date.now();
  await ctx.api.sendInvoice(ctx.chat.id, "Генерации видео: " + p.count, "Дополнительные " + p.count + " генераций 3D-видео", payload, "", "XTR", [{ label: p.title, amount: p.price }], { protect_content: true });
});
bot.on("pre_checkout_query", async ctx => {
  const parts = String(ctx.preCheckoutQuery.invoice_payload || "").split(":");
  const p = packs.find(x => x.id === parts[0]);
  if (!p || parts[1] !== String(ctx.from.id) || ctx.preCheckoutQuery.currency !== "XTR" || ctx.preCheckoutQuery.total_amount !== p.price) {
    return ctx.answerPreCheckoutQuery(false, "Не удалось проверить платёж. Открой /buy и попробуй снова.");
  }
  await ctx.answerPreCheckoutQuery(true);
});
bot.on("message:successful_payment", async ctx => {
  const pay = ctx.message.successful_payment;
  const parts = String(pay.invoice_payload || "").split(":");
  const p = packs.find(x => x.id === parts[0]);
  if (!p || parts[1] !== String(ctx.from.id) || pay.currency !== "XTR" || pay.total_amount !== p.price) {
    await ctx.reply("Платёж получен, но пакет не удалось сопоставить. Не оплачивай повторно; обратись к администратору.");
    return;
  }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ins = await c.query("INSERT INTO video_bot_payments (telegram_charge_id,telegram_id,payload,stars,credits) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_charge_id) DO NOTHING RETURNING telegram_charge_id", [pay.telegram_payment_charge_id, String(ctx.from.id), pay.invoice_payload, pay.total_amount, p.count]);
    if (ins.rowCount) await c.query("UPDATE video_bot_users SET paid_credits=paid_credits+$2,updated_at=NOW() WHERE telegram_id=$1", [String(ctx.from.id), p.count]);
    await c.query("COMMIT");
    await ctx.reply(ins.rowCount ? "Оплата прошла! Добавлено генераций: " + p.count + ".\n\n" + await balanceText(ctx.from.id) : "Этот платёж уже обработан; повторное начисление не выполнено.", { reply_markup: mainKeyboard() });
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch {}
    console.error("Payment credit failed", e);
    await ctx.reply("Платёж получен, но зачисление задержалось. Не оплачивай повторно — администратор проверит платёж.");
  } finally { c.release(); }
});

bot.callbackQuery("adm:stats", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
  await ctx.answerCallbackQuery(); await stats(ctx);
});
bot.callbackQuery("adm:grant", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
  await ctx.answerCallbackQuery(); states.set(String(ctx.from.id), { step: "grant" });
  await ctx.reply("Отправь одним сообщением: TELEGRAM_ID КОЛИЧЕСТВО. Например: 123456789 5");
});
bot.callbackQuery("adm:reset_confirm", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
  await ctx.answerCallbackQuery();
  await ctx.reply("Сбросить использованные бесплатные попытки всем? Купленные генерации не изменятся.", { reply_markup: new InlineKeyboard().text("Да, сбросить всем", "adm:reset_all").text("Отмена", "adm:cancel") });
});
bot.callbackQuery("adm:reset_all", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
  await ctx.answerCallbackQuery();
  const r = await pool.query("UPDATE video_bot_users SET free_used=0,updated_at=NOW()");
  await ctx.reply("Готово. Бесплатные попытки сброшены у " + r.rowCount + " пользователей. Купленные генерации не менялись.");
});
bot.callbackQuery("adm:cancel", async ctx => { await ctx.answerCallbackQuery("Отменено."); await ctx.deleteMessage().catch(() => {}); });
bot.callbackQuery("adm:help", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
  await ctx.answerCallbackQuery();
  await ctx.reply("Команды:\n/admin — панель\n/give ID КОЛИЧЕСТВО — выдать купленные генерации\n/setfree ID ИСПОЛЬЗОВАНО — изменить использованные бесплатные попытки.\nВ панели есть статистика и сброс бесплатных попыток всем.");
});
bot.callbackQuery(/^duration:(5|10)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const state = states.get(String(ctx.from.id));
  if (!state || state.step !== "duration") return ctx.reply("Сначала выбери генерацию и отправь описание.");
  states.delete(String(ctx.from.id));
  await ctx.editMessageText("Готовлю запрос на " + ctx.match[1] + " секунд...").catch(() => {});
  await generate(ctx, state.prompt, Number(ctx.match[1]), state.imageUrl || null);
});
bot.on("message:photo", async ctx => {
  const uid = String(ctx.from.id);
  const state = states.get(uid);
  if (!state || state.step !== "photo") return;
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (photo.file_size && photo.file_size > 18 * 1024 * 1024) return ctx.reply("Фото слишком большое. Пришли изображение меньше 18 МБ.");
    await ctx.reply("Фото получено, загружаю его для генерации...");
    const tgFile = await ctx.api.getFile(photo.file_id);
    const response = await fetch("https://api.telegram.org/file/bot" + TOKEN + "/" + tgFile.file_path);
    if (!response.ok) throw new Error("Telegram image download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    const uploaded = await fal.storage.upload(new File([bytes], "source-image.jpg", { type: "image/jpeg" }));
    states.set(uid, { step: "photo_prompt", imageUrl: uploaded });
    await ctx.reply("Теперь опиши, что должно происходить на фото: движение персонажа, камеры, окружения или атмосфера. Например: «Персонаж улыбается, ветер слегка шевелит волосы, камера плавно приближается».");
  } catch (e) {
    console.error("Photo upload failed", e);
    states.delete(uid);
    await ctx.reply("Не удалось загрузить фото. Попробуй отправить его ещё раз как обычное фото, не как файл.");
  }
});
bot.on("message:text", async ctx => {
  if (ctx.from.is_bot || ctx.message.text.startsWith("/")) return;
  await upsertUser(ctx.from);
  const uid = String(ctx.from.id);
  const state = states.get(uid);
  if (!state) return;
  if (state.step === "prompt" || state.step === "photo_prompt") {
    const prompt = ctx.message.text.trim();
    if (prompt.length < 8 || prompt.length > MAX_PROMPT) return ctx.reply("Описание должно быть от 8 до " + MAX_PROMPT + " символов. Попробуй ещё раз.");
    states.set(uid, { step: "duration", prompt, imageUrl: state.imageUrl || null });
    return ctx.reply("Выбери длительность:", { reply_markup: new InlineKeyboard().text("5 секунд", "duration:5").text("10 секунд", "duration:10") });
  }
  if (state.step === "grant" && admin(ctx.from.id)) {
    states.delete(uid);
    const a = ctx.message.text.trim().split(/\s+/);
    const id = a[0], n = Number.parseInt(a[1], 10);
    if (!/^\d+$/.test(id || "") || !Number.isInteger(n) || n < 1 || n > 10000) return ctx.reply("Неверный формат. Повтори: TELEGRAM_ID КОЛИЧЕСТВО");
    const r = await pool.query("UPDATE video_bot_users SET paid_credits=paid_credits+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING paid_credits", [id, n]);
    return ctx.reply(r.rowCount ? "Выдано " + n + ". Новый баланс: " + r.rows[0].paid_credits : "Пользователь не найден. Пусть сначала нажмёт /start.");
  }
});

async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    const jobs = await pool.query("SELECT * FROM video_bot_jobs WHERE status IN ('queued','processing') AND request_id IS NOT NULL ORDER BY created_at ASC LIMIT 10");
    for (const job of jobs.rows) {
      try {
        const modelId = job.model_id || MODEL;
        const s = await fal.queue.status(modelId, { requestId: job.request_id, logs: false });
        if (s.status === "IN_QUEUE" || s.status === "IN_PROGRESS") {
          if (job.status !== "processing") await pool.query("UPDATE video_bot_jobs SET status='processing',updated_at=NOW() WHERE id=$1", [job.id]);
          continue;
        }
        if (s.status === "COMPLETED") {
          const out = await fal.queue.result(modelId, { requestId: job.request_id });
          const url = out?.data?.video?.url;
          if (!url) throw new Error("API returned no video URL");
          const done = await pool.query("UPDATE video_bot_jobs SET status='completed',video_url=$2,updated_at=NOW() WHERE id=$1 AND status IN ('queued','processing') RETURNING id", [job.id, url]);
          if (done.rowCount) {
            try {
              await bot.api.sendVideo(String(job.telegram_id), url, { caption: "Готово! Твоя 3D-анимация на " + job.duration + " сек.\nID задачи: " + job.id, supports_streaming: true });
            } catch (e) {
              await bot.api.sendMessage(String(job.telegram_id), "Видео готово, но Telegram не смог прикрепить его файлом. Вот ссылка: " + url);
              console.error("sendVideo failed", e);
            }
          }
        } else if (s.status === "FAILED" || s.status === "CANCELLED") {
          await refund(job.id, job.telegram_id, job.credit_source, s.error || s.status);
          await bot.api.sendMessage(String(job.telegram_id), "Не удалось сгенерировать видео. Попытка возвращена на баланс. Попробуй изменить описание.");
        }
      } catch (e) { console.error("Poll job failed", job.id, e); }
    }
  } catch (e) { console.error("Polling error", e); }
  finally { polling = false; }
}
bot.catch(err => console.error("Telegram bot error", err));
await initDb();
bot.start({ onStart: info => console.log("Bot @" + info.username + " started; model=" + MODEL + "; freeLimit=" + FREE_LIMIT) });
setInterval(() => { void pollJobs(); }, POLL_MS);
void pollJobs();
process.once("SIGINT", async () => { await bot.stop(); await pool.end(); process.exit(0); });
process.once("SIGTERM", async () => { await bot.stop(); await pool.end(); process.exit(0); });
