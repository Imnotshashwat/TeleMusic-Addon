# BitChord Addon: Telegram Music Server

Stream lossless and hi-res audio from a private Telegram channel into the BitChord Android app, falling back to YouTube Music when a track is not in your library.

---

## Architecture

```
┌─────────────────────────────────┐
│     Telegram Private Channel    │ (Storage for FLAC audio files)
└────────────────┬────────────────┘
                 │ MTProto
┌────────────────▼────────────────┐
│   TeleMusic Addon Server        │ (Node.js, GramJS, Express)
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

## Security

- This server logs in using a Telegram user session rather than a Bot API token. A user session avoids the standard 20MB bot download limit, which FLAC files usually exceed.
- Keep your session string private. It provides account access; do not commit `.env` or session strings to public repositories.
- You can use a secondary Telegram account for the channel library or terminate the session anytime under Telegram Settings > Devices.

---

## 1. Get Telegram API credentials

1. Log in to [my.telegram.org](https://my.telegram.org) with your phone number.
2. Open **API development tools**.
3. Create an application (the title and short name can be anything).
4. Note your `api_id` and `api_hash`.

---

## 2. Authenticate and create session string

Run the login script:

```bash
npm run login
```

Follow the prompts to enter:
1. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (if not set in `.env`)
2. Phone number in international format (such as `+1234567890` or `+919876543210`)
3. Telegram confirmation code
4. Two-step verification password, if enabled
5. Telegram channel handle or ID

The script writes the resulting credentials to `.env`.

---

## 3. Set up the Telegram channel

1. Create a channel in Telegram (private or public).
2. Find the channel identifier:
   - Public channel: Use the username (such as `@my_lossless_vault`).
   - Private channel: Forward a message from the channel to `@userinfobot` or `@getidsbot` to get the numeric ID (prefixed with `-100`).
3. Upload audio files:
   - Upload audio as **Files / Documents** rather than compressed audio to preserve tags and uncompressed audio.
   - The server indexes newly uploaded files as they arrive.

---

## 4. Run locally

```bash
npm start
```

Expected startup output:
```
Connecting to Telegram MTProto...
Connected to Telegram!
Using Telegram channel: My Music Channel
BitChord Addon server running on http://0.0.0.0:3000
Manifest URL: http://localhost:3000/manifest.json
Indexing Telegram channel...
Indexing complete! 25 track(s) ready in library.
```

Endpoints to verify in a browser:
- `http://localhost:3000/manifest.json`: Addon manifest metadata
- `http://localhost:3000/search`: Indexed tracks

---

## 5. Expose over HTTPS

Android ExoPlayer requires HTTPS streams.

### Option A: Render / Fly.io

Deploy to a hosting service that provides HTTPS termination, such as Render or Fly.io.

For Fly.io:
1. Install the flyctl CLI.
2. Launch the app configuration:
   ```bash
   fly launch --name my-telegram-music --no-deploy
   ```
3. Set environment secrets:
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

### Option B: Cloudflare Tunnel for local testing

1. Install `cloudflared`.
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copy the assigned `https://...trycloudflare.com` URL.

---

## 6. Connect BitChord

1. Open **BitChord** on Android.
2. Go to **Settings** > **Sources**.
3. Select **Add Source** under pluggable sources.
4. Enter your addon base URL:
   ```
   https://my-telegram-music.fly.dev
   ```
5. BitChord validates `/manifest.json`.
6. When playing a song, BitChord queries your Telegram library first. If a match is found, it plays the Telegram audio stream; otherwise, it falls back to YouTube Music.
