# Environment Variables Setup

All sensitive credentials are now managed via environment variables (`.env` file) instead of the dashboard UI. This is more secure and follows best practices.

## Setup Steps

### 1. Create `.env` file in the `server/` directory

Copy the template:
```bash
cp server/.env.example server/.env
```

### 2. Open `server/.env` and fill in your credentials

```
KITE_API_KEY=your_api_key_here
KITE_ACCESS_TOKEN=your_access_token_here
TELEGRAM_BOT_TOKEN=your_bot_token_here
PORT=3001
```

**Replace with your actual values:**
- **KITE_API_KEY**: Your Zerodha API Key (from Zerodha Console)
- **KITE_ACCESS_TOKEN**: Your Zerodha Access Token (generated via login)
- **TELEGRAM_BOT_TOKEN**: Your Telegram Bot Token (from @BotFather)

### 3. Install dependencies

```bash
npm run install:all
# or
cd server && npm install && cd ../client && npm install
```

### 4. Start the server

```bash
npm run server
```

The server will automatically load credentials from `.env`.

## Important Security Notes

⚠️ **Never commit `.env` to git!**
- The `.env` file is in `.gitignore` and will NOT be committed
- Keep this file private — it contains your API tokens

✅ **For production/deployment:**
- Use your platform's environment variable management (Vercel, Railway, etc.)
- Set `KITE_API_KEY`, `KITE_ACCESS_TOKEN`, and `TELEGRAM_BOT_TOKEN` directly
- Do NOT create a `.env` file in production

## Verifying Setup

1. Start the server: `npm run server`
2. Go to **Settings** tab in the dashboard
3. You should see a section showing credentials are loaded from environment variables
4. Click **Start Polling** — if it works, your credentials are correct!

## Troubleshooting

**"Kite API key and access token are not configured"**
- Check that `KITE_API_KEY` and `KITE_ACCESS_TOKEN` are set in `.env`
- Restart the server after editing `.env`

**"Telegram bot token is not configured"**
- Check that `TELEGRAM_BOT_TOKEN` is set in `.env`
- Restart the server

**"Invalid credentials"**
- Verify your API Key and Access Token are correct
- Make sure the Access Token hasn't expired (some tokens expire after time)
- Regenerate a new Access Token if needed
