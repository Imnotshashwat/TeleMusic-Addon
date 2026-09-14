require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bigInt = require('big-integer');
const { TelegramClient, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { NewMessage } = require('telegram/events');
const mm = require('music-metadata');

const app = express();
app.set('trust proxy', true);
app.use(cors());

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING;
const CHANNEL = process.env.TELEGRAM_CHANNEL; // e.g. "@mychannel", numeric ID -100..., or channel title
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'tracks_cache.json');

if (!API_ID || !API_HASH || !SESSION_STRING || !CHANNEL) {
  console.error('----------------------------------------------------------------');
  console.error('ERROR: Missing required environment variable in .env:');
  if (!API_ID) console.error('  - TELEGRAM_API_ID is missing');
  if (!API_HASH) console.error('  - TELEGRAM_API_HASH is missing');
  if (!SESSION_STRING) console.error('  - TELEGRAM_SESSION_STRING is missing (run "npm run login" first)');
  if (!CHANNEL) console.error('  - TELEGRAM_CHANNEL is missing (set your channel @name or ID)');
  console.error('----------------------------------------------------------------');
  process.exit(1);
}

const AUDIO_EXTENSIONS = ['flac', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'alac'];
const EXT_TO_FORMAT = {
  flac: 'flac',
  mp3: 'mp3',
  m4a: 'm4a',
  aac: 'aac',
  wav: 'wav',
  ogg: 'ogg',
  opus: 'opus',
  alac: 'alac',
};

const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
  connectionRetries: 5,
});

let channelEntity = null;
let trackIndex = [];
let lastIndexed = 0;

// In-memory media cache: maps track ID string -> Telegram msg.media object
// Eliminates the redundant 1-2 second client.getMessages() round-trip on every seek
const mediaCache = new Map();

// Helper: load cached tracks from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf-8');
      trackIndex = JSON.parse(data);
      console.log(`Loaded ${trackIndex.length} track(s) from local cache (${CACHE_FILE}).`);
    }
  } catch (err) {
    console.warn(`Could not load cache: ${err.message}`);
  }
}

// Helper: save cached tracks to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(trackIndex, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`Could not save cache: ${err.message}`);
  }
}

// Retrieve the Telegram msg.media object from RAM cache, or fetch once if not yet cached
async function getMediaForTrack(trackId) {
  const key = String(trackId);
  if (mediaCache.has(key)) {
    return mediaCache.get(key);
  }
  try {
    const messages = await client.getMessages(channelEntity, { ids: [parseInt(trackId, 10)] });
    if (messages && messages[0] && messages[0].media) {
      mediaCache.set(key, messages[0].media);
      return messages[0].media;
    }
  } catch (err) {
    console.error(`Failed to fetch media for track ${trackId}:`, err.message);
  }
  return null;
}

function extFromName(name) {
  const match = (name || '').match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function getFileNameFromMessage(msg) {
  const attrs = msg.media?.document?.attributes || [];
  const fileNameAttr = attrs.find((a) => a instanceof Api.DocumentAttributeFilename || a.fileName);
  return fileNameAttr ? fileNameAttr.fileName : `file_${msg.id}`;
}

function getAudioAttr(msg) {
  const attrs = msg.media?.document?.attributes || [];
  return attrs.find((a) => a instanceof Api.DocumentAttributeAudio || (a.duration !== undefined && !a.w));
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// Fetch a small chunk (128KB) of audio file to parse deep metadata (sample rate, bit depth, tags)
// without downloading the entire 50MB+ FLAC file.
async function getHeaderChunk(media, maxBytes = 128 * 1024) {
  const chunks = [];
  let downloaded = 0;
  try {
    const iter = client.iterDownload({
      file: media,
      offset: bigInt(0),
      requestSize: 64 * 1024,
    });
    for await (const chunk of iter) {
      chunks.push(chunk);
      downloaded += chunk.length;
      if (downloaded >= maxBytes) {
        iter.left = 0;
        await iter.close();
        break;
      }
    }
    return Buffer.concat(chunks).slice(0, maxBytes);
  } catch (err) {
    return null;
  }
}

async function parseTrackMessage(msg) {
  if (!msg.media || !msg.media.document) return null;

  // Cache media object in memory
  mediaCache.set(String(msg.id), msg.media);

  const doc = msg.media.document;
  const fileName = getFileNameFromMessage(msg);
  const ext = extFromName(fileName);
  const audioAttr = getAudioAttr(msg);

  // If extension is known audio OR document has audio attribute
  const isAudio = AUDIO_EXTENSIONS.includes(ext) || Boolean(audioAttr);
  if (!isAudio) return null;

  const resolvedExt = ext || 'mp3';
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '');
  const sizeBytes = Number(doc.size) || 0;
  const hasArtwork = Boolean(doc.thumbs && doc.thumbs.length > 0);

  // Initial metadata from Telegram's instant attributes (zero network bytes!)
  let title = (audioAttr && audioAttr.title) ? audioAttr.title.trim() : fallbackTitle;
  let artist = (audioAttr && audioAttr.performer) ? audioAttr.performer.trim() : 'Unknown Artist';
  let duration = (audioAttr && audioAttr.duration) ? Math.round(audioAttr.duration) : undefined;
  let album = undefined;
  let sampleRate = undefined;
  let bitDepth = undefined;
  let isrc = undefined;

  // Try to inspect the first 128KB for lossless FLAC/ALAC tags or missing title/performer
  const shouldSniffTags = resolvedExt === 'flac' || resolvedExt === 'alac' || !audioAttr || !audioAttr.title;
  if (shouldSniffTags && sizeBytes > 0) {
    try {
      const headerBuf = await getHeaderChunk(msg.media, Math.min(128 * 1024, sizeBytes));
      if (headerBuf && headerBuf.length > 0) {
        const parsed = await mm.parseBuffer(headerBuf, undefined, {
          duration: false,
          size: sizeBytes,
        });
        if (parsed.common) {
          if (parsed.common.title) title = parsed.common.title;
          if (parsed.common.artists && parsed.common.artists.length > 0) {
            artist = parsed.common.artists.join(', ');
          } else if (parsed.common.artist) {
            artist = parsed.common.artist;
          }
          if (parsed.common.album) album = parsed.common.album;
          if (parsed.common.isrc && parsed.common.isrc.length > 0) isrc = parsed.common.isrc[0];
        }
        if (parsed.format) {
          if (parsed.format.sampleRate) sampleRate = parsed.format.sampleRate;
          if (parsed.format.bitsPerSample) bitDepth = parsed.format.bitsPerSample;
          if (!duration && parsed.format.duration) duration = Math.round(parsed.format.duration);
        }
      }
    } catch (e) {
      // Non-fatal, keep attributes extracted from Telegram
    }
  }

  // Quality badge text (e.g. "24-bit / 96000Hz lossless" or "FLAC lossless")
  const formatName = EXT_TO_FORMAT[resolvedExt] || resolvedExt;
  let qualityText = formatName.toUpperCase();
  if (bitDepth && sampleRate) {
    qualityText = `${bitDepth}-bit / ${sampleRate}Hz lossless`;
  } else if (['flac', 'wav', 'alac'].includes(formatName)) {
    qualityText = 'Lossless';
  }

  return {
    id: String(msg.id),
    title: title || fallbackTitle,
    artist: artist || 'Unknown Artist',
    album: album || undefined,
    duration: duration || undefined,
    format: formatName,
    sampleRate,
    bitDepth,
    quality: qualityText,
    isrc,
    hasArtwork,
    sizeBytes,
    mimeType: doc.mimeType || 'audio/mpeg',
  };
}

async function buildTrackIndex() {
  console.log('Indexing Telegram channel...');
  try {
    const messages = await client.getMessages(channelEntity, { limit: 500 });
    const newIndex = [];

    for (const msg of messages) {
      // Always cache media object for instant seeking
      if (msg.media) {
        mediaCache.set(String(msg.id), msg.media);
      }

      // Check if we already have this message ID cached with full details
      const existing = trackIndex.find((t) => t.id === String(msg.id));
      if (existing) {
        newIndex.push(existing);
        continue;
      }

      const parsed = await parseTrackMessage(msg);
      if (parsed) {
        newIndex.push(parsed);
      }
    }

    trackIndex = newIndex;
    lastIndexed = Date.now();
    saveCache();
    console.log(`Indexing complete! ${trackIndex.length} track(s) ready in library.`);
  } catch (err) {
    console.error('Error during track indexing:', err.message);
  }
}

function findTrack(id) {
  return trackIndex.find((t) => t.id === id);
}

// ── BitChord / Stremio Addon Endpoints ─────────────────────────────────────

// Manifest: BitChord queries this to verify addon id, name, and capabilities
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.personal.telegrammusic',
    name: 'Telegram Music',
    version: '1.2.0',
    description: 'Personal hi-res and lossless music library streamed directly from Telegram',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music',
  });
});

// Search: BitChord calls /search?q=... to find tracks
app.get('/search', async (req, res) => {
  try {
    // Refresh index periodically (every 30 minutes)
    if (Date.now() - lastIndexed > 30 * 60 * 1000) {
      buildTrackIndex().catch((e) => console.error('Background index error:', e.message));
    }

    const q = (req.query.q || '').toLowerCase().trim();
    const base = getBaseUrl(req);

    let matches = trackIndex;
    if (q) {
      // Split query into terms (e.g. "blinding lights the weeknd" -> ["blinding", "lights", "the", "weeknd"])
      const terms = q.split(/\s+/).filter(Boolean);
      matches = trackIndex.filter((t) => {
        const fullText = `${t.title} ${t.artist} ${t.album || ''}`.toLowerCase();
        return terms.every((term) => fullText.includes(term));
      });
    }

    res.json({
      tracks: matches.slice(0, 60).map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album || '',
        duration: t.duration,
        format: t.format,
        audioQuality: t.quality || 'lossless',
        artworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
        albumArtworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
        streamURL: `${base}/audio/${t.id}`,
        isrc: t.isrc,
      })),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stream info: BitChord queries this for stream metadata and direct playback URL
app.get('/stream/:id', (req, res) => {
  const track = findTrack(req.params.id);
  const base = getBaseUrl(req);

  res.json({
    url: `${base}/audio/${req.params.id}`,
    format: track ? track.format : 'flac',
    codec: track ? track.format : 'flac',
    container: track ? track.format : 'flac',
    manifest: 'none',
    encrypted: false,
    sampleRate: track ? track.sampleRate : undefined,
    bitDepth: track ? track.bitDepth : undefined,
    quality: track ? track.quality : undefined,
    streamQuality: track ? track.quality : undefined,
  });
});

// Artwork thumbnail endpoint: serves album cover directly to BitChord
app.get('/artwork/:id', async (req, res) => {
  try {
    const track = findTrack(req.params.id);
    if (!track) return res.status(404).send('Track not found');

    const media = await getMediaForTrack(req.params.id);
    if (!media || !media.document) return res.status(404).send('Media not found');

    const doc = media.document;
    const thumbs = doc.thumbs || [];
    if (!thumbs.length) return res.status(404).send('No artwork thumbnail');

    // 1. Instant response if stripped photo is available (0ms network request)
    const stripped = thumbs.find((t) => t instanceof Api.PhotoStrippedSize);
    if (stripped) {
      const jpg = utils.strippedPhotoToJpg(stripped.bytes);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(jpg);
    }

    // 2. Download thumbnail via GramJS
    const thumbBuf = await client.downloadMedia(media, { thumb: 0 });
    if (!thumbBuf || thumbBuf.length === 0) {
      return res.status(404).send('No artwork thumbnail');
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(thumbBuf);
  } catch (err) {
    console.error('Artwork fetch error:', err.message);
    res.status(404).send('Artwork not available');
  }
});

// Audio streaming: BitChord streams audio bytes with HTTP 206 Range support,
// instant seeking via in-memory media caching, backpressure control, and immediate abort on client skip/seek.
app.get('/audio/:id', async (req, res) => {
  let isConnectionClosed = false;
  let iterator = null;

  req.on('close', () => {
    isConnectionClosed = true;
    if (iterator) {
      iterator.left = 0;
      if (typeof iterator.close === 'function') {
        iterator.close().catch(() => {});
      }
    }
  });

  try {
    const track = findTrack(req.params.id);
    if (!track) return res.status(404).send('Track not found');

    // 0ms lookup from in-memory media cache (avoids Telegram API network call!)
    const media = await getMediaForTrack(req.params.id);
    if (!media) return res.status(404).send('Media not found');

    if (isConnectionClosed) return;

    const totalSize = track.sizeBytes;
    let start = 0;
    let end = totalSize - 1;

    const range = req.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      }
    }

    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', track.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    if (range) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    }

    // Use 256KB chunks for faster initial response time and smooth streaming
    iterator = client.iterDownload({
      file: media,
      offset: bigInt(start),
      requestSize: 256 * 1024,
    });

    let bytesSent = 0;
    const bytesNeeded = end - start + 1;

    for await (const chunk of iterator) {
      if (isConnectionClosed || res.writableEnded || res.destroyed) {
        iterator.left = 0;
        await iterator.close();
        break;
      }

      let toSend = chunk;
      let shouldBreak = false;

      if (bytesSent + chunk.length > bytesNeeded) {
        toSend = chunk.slice(0, bytesNeeded - bytesSent);
        shouldBreak = true;
      }

      bytesSent += toSend.length;
      if (bytesSent >= bytesNeeded) {
        shouldBreak = true;
      }

      // Handle backpressure: pause pulling chunks if client network buffer is full
      const canContinue = res.write(toSend);
      if (!canContinue && !res.writableEnded && !res.destroyed && !isConnectionClosed) {
        await new Promise((resolve) => {
          const onDrain = () => {
            req.removeListener('close', onClose);
            resolve();
          };
          const onClose = () => {
            res.removeListener('drain', onDrain);
            resolve();
          };
          res.once('drain', onDrain);
          req.once('close', onClose);
        });
      }

      if (shouldBreak || isConnectionClosed) {
        iterator.left = 0;
        await iterator.close();
        break;
      }
    }

    if (!res.writableEnded && !isConnectionClosed) {
      res.end();
    }
  } catch (err) {
    if (!isConnectionClosed && !res.destroyed) {
      console.error(`Audio stream error for track ${req.params.id}:`, err.message);
      if (!res.headersSent) res.status(500).send(err.message);
      else res.end();
    }
  }
});

// Manual refresh endpoint
app.get('/refresh', async (req, res) => {
  try {
    await buildTrackIndex();
    res.json({ ok: true, count: trackIndex.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status / Health endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'BitChord Telegram Music Addon',
    tracksCount: trackIndex.length,
    manifest: `${getBaseUrl(req)}/manifest.json`,
  });
});

// ── Server & Telegram Initialization ──────────────────────────────────────

async function resolveChannel() {
  console.log(`Resolving channel "${CHANNEL}"...`);
  // Calling getDialogs populates Telegram entity cache with access hashes for private channels
  const dialogs = await client.getDialogs({ limit: 100 });
  const cleanInput = CHANNEL.trim();
  const stripped = cleanInput.replace(/^-100/, '').replace(/^@/, '').toLowerCase();

  for (const d of dialogs) {
    const entity = d.entity;
    if (!entity) continue;
    const entityId = entity.id ? entity.id.toString() : '';
    const username = (entity.username || '').toLowerCase();
    const title = (entity.title || '').toLowerCase();

    if (
      entityId === cleanInput ||
      `-100${entityId}` === cleanInput ||
      entityId === stripped ||
      (username && username === stripped) ||
      title === cleanInput.toLowerCase()
    ) {
      console.log(`Successfully matched channel dialog: "${entity.title || entity.username}" (ID: ${entityId})`);
      return entity;
    }
  }

  // Fallback to direct resolution
  return await client.getEntity(cleanInput);
}

(async () => {
  try {
    loadCache();
    console.log('Connecting to Telegram MTProto...');
    await client.connect();
    console.log('Connected to Telegram!');

    channelEntity = await resolveChannel();
    console.log(`Using Telegram channel: ${channelEntity.title || channelEntity.username || CHANNEL}`);

    // Set up real-time listener for new audio files uploaded to the channel
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.media || !message.media.document) return;

        // Verify the message belongs to our configured music channel
        if (channelEntity && message.peerId) {
          const peerId = utils.getPeerId(message.peerId).toString();
          const targetChanId = utils.getPeerId(channelEntity).toString();
          if (peerId !== targetChanId) return;
        }

        console.log(`Detected new upload in channel (msg ID: ${message.id}), auto-indexing...`);
        const track = await parseTrackMessage(message);
        if (track) {
          const existingIdx = trackIndex.findIndex((t) => t.id === track.id);
          if (existingIdx >= 0) {
            trackIndex[existingIdx] = track;
          } else {
            trackIndex.unshift(track);
          }
          saveCache();
          console.log(`Auto-indexed new track: "${track.title}" by "${track.artist}"`);
        }
      } catch (err) {
        console.warn('Real-time indexing error:', err.message);
      }
    }, new NewMessage({}));

    app.listen(PORT, '0.0.0.0', async () => {
      console.log(`BitChord Addon server running on http://0.0.0.0:${PORT}`);
      console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
      try {
        await buildTrackIndex();
      } catch (err) {
        console.error('Initial indexing error:', err.message);
      }
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
