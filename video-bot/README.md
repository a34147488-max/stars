# Telegram AI Video Bot

Telegram bot that creates short stylized 3D animated videos from text prompts using the fal.ai MiniMax H3 Max text-to-video API. Includes PostgreSQL-backed free quotas, paid generation credits purchased with Telegram Stars, and an admin panel.

## Features

- 3 free generations per Telegram account by default.
- Generate video from a text prompt or animate an uploaded photo.
- User chooses 5 or 10 seconds for text-to-video.
- 3D animated-film style is added automatically to the prompt.
- PostgreSQL stores users, quotas, jobs and Telegram Stars payments.
- Generation requests run through fal.ai's queue; the bot polls and sends the completed MP4.
- Failed API jobs restore the reserved generation.
- Telegram Stars packages: 5 for 300 Stars, 10 for 600 Stars, 25 for 1500 Stars.
- Admin panel: /admin; statistics, grant credits, reset free attempts for all users.
- Admin commands: /give TELEGRAM_ID COUNT and /setfree TELEGRAM_ID USED.

## API choice and cost

Default model: `minimax/h3-max/text-to-video` on fal.ai. At the standard published 480P rate of $0.05 per second, a 5-second generation is approximately $0.25 and a 10-second generation approximately $0.50. 768P and 1080P cost more. Prices may change; check the live [fal pricing page](https://fal.ai/pricing) before enabling public use. Three free 5-second generations can therefore cost the operator around $0.75 per user at 480P. Telegram Stars sale prices do not automatically cover API costs; set packages and prices with that cost in mind.

## Deploy on Railway

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create an account at [fal.ai](https://fal.ai), add billing/credits, and create an API key.
3. Add a PostgreSQL database to Railway. Copy its connection URL into `DATABASE_URL`.
4. Create a Railway service from this repository. Set its **Root Directory** to `/video-bot`.
5. Add these variables to the service:
   - `BOT_TOKEN`: token from BotFather
   - `FAL_KEY`: fal API key
   - `DATABASE_URL`: Railway PostgreSQL connection string
   - `ADMIN_IDS`: your numeric Telegram user ID (not @username)
   - Optional: `FREE_LIMIT=3`, `VIDEO_RESOLUTION=480P`, `FAL_MODEL=minimax/h3-max/text-to-video`, `FAL_IMAGE_MODEL=minimax/h3-max/image-to-video`
6. Deploy. On startup, the bot creates its tables automatically.
7. Open the bot in Telegram and send `/start`. Admin sends `/admin`.

If Railway's Postgres endpoint requires TLS, add `PGSSLMODE=require`. For an internal Railway database URL, normally leave it unset.

## Admin usage

- `/admin`: open admin panel.
- **Статистика**: user and job counts.
- **Выдать генерации**: enter `TELEGRAM_ID COUNT` in the next message.
- **Сбросить бесплатные попытки всем**: asks for confirmation; purchased credits are not changed.
- `/give TELEGRAM_ID COUNT`: grant paid generation credits.
- `/setfree TELEGRAM_ID USED`: set how many free attempts a user has used. Use `0` to restore their free quota.

## Important notes

- Never commit real tokens, API keys or database credentials to GitHub.
- Use the numeric Telegram user ID in `ADMIN_IDS`; find it through a trusted ID bot or bot logs.
- Generation consumes fal.ai credits. Configure spending limits in fal.ai if available and monitor usage.
- Payments use Telegram Stars currency `XTR`. Test a small purchase before advertising the bot.
- This initial version uses polling for fal queue results. Railway must keep this service running; do not scale it to many replicas without adding a distributed job lock.
- The generated MP4 is sent from fal's hosted URL. If Telegram cannot fetch the file, the bot sends the direct URL instead.
