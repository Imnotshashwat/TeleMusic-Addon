# TeleMusic Addon

A BitChord music provider that streams lossless audio stored in a private Telegram channel.

BitChord searches this server whenever a track is requested. If the track is present in your Telegram channel, BitChord streams the original FLAC/ALAC file directly to ExoPlayer. If not, it falls back to YouTube Music.

## Features

- **Direct FLAC streaming**: Streams audio over HTTP 206 range requests without re-encoding.
- **In-memory indexing**: Maintains track metadata in memory to keep search latency under 5ms.
- **Title and artist matching**: Normalizes song titles and splits multi-artist tags to match queries from YouTube Music.
- **Quality deduplication**: Keeps track of bit depth, sample rate, and container formats, retaining higher-quality copies when duplicates are added.
- **Automated bot downloads**: Includes a `/song` command to fetch tracks via Apple Music and music downloader bots directly into your channel.

## How it works

1. You upload audio files (FLAC, ALAC, WAV, MP3, M4A) to a Telegram channel.
2. The server authenticates with Telegram via MTProto (GramJS) using a user session, bypassing standard bot file size limits.
3. The server extracts audio metadata (title, artist, album, bit depth, sample rate) and builds a local index.
4. BitChord queries `/manifest.json`, `/search?q=...`, and `/stream/:id` using its pluggable source protocol.
5. BitChord's ExoPlayer streams audio directly through the `/audio/:id` endpoint.

## Quick start

### 1. Prerequisites

- Node.js 18+
- Telegram account with `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org)
- A dedicated Telegram channel (public or private) for storing audio files

### 2. Setup and authentication

Clone the repository and install dependencies:

```bash
git clone https://github.com/Imnotshashwat/TeleMusic-Addon.git
cd TeleMusic-Addon
npm install
```

Generate your session string and `.env` file:

```bash
npm run login
```

The interactive prompt will request your API ID, API hash, phone number, login code, and channel handle or numeric ID.

### 3. Start the server

```bash
npm start
```

Default local port is `3000`. Test the manifest in a browser:

```
http://localhost:3000/manifest.json
```

### 4. Deploy to the cloud

Because Android ExoPlayer blocks non-HTTPS streams by default, deploy the server to a host with an HTTPS URL (such as Render, Fly.io, or through a Cloudflare tunnel).

Set the following environment variables in your deployment dashboard:

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Numeric Telegram API ID |
| `TELEGRAM_API_HASH` | Telegram API hash string |
| `TELEGRAM_SESSION_STRING` | Generated MTProto session string from `npm run login` |
| `TELEGRAM_CHANNEL` | Channel username (e.g. `@my_vault`) or numeric ID (e.g. `-1001234567890`) |
| `PORT` | Web server port (defaults to `3000` or assigned by host) |

### 5. Add to BitChord

1. Open BitChord on your Android device.
2. Navigate to **Settings** > **Sources**.
3. Tap **Add Source** and paste your deployment URL (e.g. `https://your-app.onrender.com`).
4. BitChord validates the manifest. When you play tracks, BitChord will check your Telegram channel first.

## API Endpoints

- `GET /manifest.json`: Addon metadata and supported capabilities.
- `GET /search?q=:query`: Sub-5ms in-memory search across indexed tracks.
- `GET /stream/:id`: Stream metadata and direct audio playback URL.
- `GET /audio/:id`: HTTP 206 range-enabled audio streaming.
- `GET /artwork/:id`: Embedded album artwork images.
- `GET /debug/requests`: Live log buffer of the last 50 incoming requests.
- `GET /ping`: Uptime monitor heartbeat.

## License

MIT
