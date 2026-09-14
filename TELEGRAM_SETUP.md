# BitChord Addon — Telegram Music Server

Stream your personal lossless / hi-res audio files directly from a private Telegram channel into the **BitChord** YouTube Music Android app (with YouTube Music as automatic fallback).

---

## Architecture & How It Works

```
┌─────────────────────────────────┐
│     Telegram Private Channel    │ (Unlimited lossless/FLAC storage)
└────────────────┬────────────────┘
                 │ MTProto (User Session)
┌────────────────▼────────────────┐
│   TeleMusic Addon Server        │ (Node.js + GramJS + Express)
│   - /manifest.json              │
│   - /search?q=...               │
│   - /stream/:id                 │
│   - /artwork/:id                │
│   - /audio/:id (Range stream)   │
└────────────────┬────────────────┘
                 │ HTTPS
┌────────────────▼────────────────┐
│    BitChord Android App         │ (Settings → Sources → Add Source)
└─────────────────────────────────┘
```

---

## Security & Privacy Note

- This server logs in using a real Telegram user session (not a Bot API token). A user session is required because the standard Telegram Bot API has a strict 20MB file download limit, whereas hi-res FLAC tracks frequently exceed 30MB–100MB+.
- **Keep your session string secret**: The session string acts like a password. Never commit `.env` or session strings to public repositories.
- *Recommended*: You can create a dedicated/secondary Telegram account specifically for your music channel library, or revoke the session at any time via **Telegram Settings → Devices**.

---

## Step 1: Get Telegram API ID & Hash

1. Log in to **[https://my.telegram.org](https://my.telegram.org)** with your Telegram phone number.
2. Click on **API development tools**.
3. Create a basic application (App title and short name can be anything, e.g. `BitChordMusic`).
4. Copy your **`api_id`** (numeric) and **`api_hash`** (string).

---

## Step 2: Authenticate & Generate Session String

In this project folder, run:

```bash
npm run login
```

The interactive prompt will:
1. Ask for your `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (if not already in `.env`).
2. Ask for your phone number (international format, e.g. `+1234567890` or `+919876543210`).
3. Ask for the login code Telegram sends to your app.
4. Ask for your 2FA password (press Enter if you don't have one).
5. Prompt for your Telegram Music Channel name or ID.
6. **Automatically generate and save all credentials to `.env`!**

---

## Step 3: Setting Up Your Music Channel

1. In Telegram, create a **Channel** (Private or Public).
2. Get the channel identifier:
   - **Public Channel**: Use your handle, e.g. `@my_lossless_vault`.
   - **Private Channel**: Forward any message from your channel to `@userinfobot` or `@getidsbot` on Telegram to get your numeric ID (usually starts with `-100`, e.g. `-1001234567890`).
3. **Uploading music**:
   - Always upload tracks as **Files / Documents** (not compressed audio). Telegram will preserve exact bit-for-bit FLAC audio, embedded tags, and cover artwork!
   - Newly uploaded songs are **automatically indexed in real time** without needing to restart the server.

---

## Step 4: Run Locally

```bash
npm start
```

You should see:
```
Connecting to Telegram MTProto...
Connected to Telegram!
Using Telegram channel: My Music Channel
BitChord Addon server running on http://0.0.0.0:3000
Manifest URL: http://localhost:3000/manifest.json
Indexing Telegram channel...
Indexing complete! 25 track(s) ready in library.
```

Test in your browser:
- `http://localhost:3000/manifest.json` — Addon metadata
- `http://localhost:3000/search` — List of indexed tracks

---

## Step 5: Expose via HTTPS for Android / BitChord

> [!IMPORTANT]
> Android's ExoPlayer blocks plain `http://` streams by default. The addon URL must be **`https://`**.

You have two simple options:

### Option A: Cloud Deployment on Fly.io (Free, Always On)
1. Install Fly CLI: `https://fly.io/docs/hands-on/install-flyctl/`
2. Run in this directory:
   ```bash
   fly launch --name my-telegram-music --no-deploy
   ```
3. Set your secrets (from your `.env`):
   ```bash
   fly secrets set TELEGRAM_API_ID="your_api_id"
   fly secrets set TELEGRAM_API_HASH="your_api_hash"
   fly secrets set TELEGRAM_SESSION_STRING="your_session_string"
   fly secrets set TELEGRAM_CHANNEL="@your_channel_or_id"
   ```
4. Deploy:
   ```bash
   fly deploy
   ```
5. Your live HTTPS URL will be: `https://my-telegram-music.fly.dev`

### Option B: Quick Local Testing via Cloudflare Tunnel
If running on your PC without cloud deploy:
1. Download [cloudflared](https://github.com/cloudflare/cloudflared/releases).
2. Run:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copy the generated `https://xxxx.trycloudflare.com` URL.

---

## Step 6: Add to BitChord Android App

1. Open **BitChord** on your Android device.
2. Tap **Settings** (gear icon) → **Sources**.
3. Under Addons / Pluggable Sources, tap **Add Source** (or the `+` button).
4. Paste your addon URL:
   ```
   https://my-telegram-music.fly.dev
   ```
5. BitChord will automatically probe `/manifest.json`, verify the connection, and show a green checkmark!
6. Now, whenever you play a song, BitChord checks your Telegram lossless library first:
   - If available: Streams high-fidelity FLAC/ALAC directly from Telegram with the **Lossless / Hi-Res** badge!
   - If not in your channel: Falls back seamlessly to YouTube Music audio!
