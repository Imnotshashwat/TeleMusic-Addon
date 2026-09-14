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
const { handleSongCommand } = require('./downloader');

const app = express();
app.set('trust proxy', true);
app.use(cors());

function cleanEnv(val) {
  if (!val) return '';
  let s = String(val).trim();
  // Strip any wrapping quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const API_ID = parseInt(cleanEnv(process.env.TELEGRAM_API_ID), 10);
const API_HASH = cleanEnv(process.env.TELEGRAM_API_HASH);
let SESSION_STRING = cleanEnv(process.env.TELEGRAM_SESSION_STRING);
const CHANNEL = cleanEnv(process.env.TELEGRAM_CHANNEL);
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'tracks_cache.json');

// GramJS StringSession requires the session string to begin with the version character "1"
if (SESSION_STRING && SESSION_STRING[0] !== '1') {
  const oneIdx = SESSION_STRING.indexOf('1');
  if (oneIdx !== -1) {
    SESSION_STRING = SESSION_STRING.slice(oneIdx);
  }
}

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

// Fast-Start buffer cache: maps track ID -> first 512KB of audio bytes (served from RAM for instant ExoPlayer start)
// 15 tracks × 512KB ≈ 7.6MB RAM – well within Render's 512MB free tier limit.
const fastStartCache = new Map();
const FAST_START_BYTES = 512 * 1024; // 512 KB – covers ~3-4 seconds of lossless FLAC audio

// In-memory request log ring buffer (keeps last 50 requests for production debugging)
const recentRequests = [];
function recordRequest(entry) {
  recentRequests.unshift(entry);
  if (recentRequests.length > 50) recentRequests.pop();
}

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

// Pre-warm the fast-start buffer for a single track:
// Downloads the first FAST_START_BYTES of audio from Telegram and stores it in RAM.
// This lets ExoPlayer start playing within 0.3s (served from RAM) while the rest
// of the FLAC streams live from Telegram in the background.
async function prewarmFastStart(trackId, media) {
  if (fastStartCache.has(trackId)) return; // Already cached
  const chunks = [];
  let downloaded = 0;
  try {
    const iter = client.iterDownload({
      file: media,
      offset: bigInt(0),
      requestSize: 512 * 1024,
    });
    for await (const chunk of iter) {
      chunks.push(chunk);
      downloaded += chunk.length;
      if (downloaded >= FAST_START_BYTES) {
        iter.left = 0;
        await iter.close();
        break;
      }
    }
    const buf = Buffer.concat(chunks).slice(0, FAST_START_BYTES);
    if (buf.length > 0) {
      fastStartCache.set(trackId, buf);
      console.log(`[FastStart] Pre-warmed ${buf.length} bytes for track ${trackId}`);
    }
  } catch (err) {
    // Non-fatal: if pre-warm fails, streaming falls back to live MTProto normally
    console.warn(`[FastStart] Pre-warm failed for track ${trackId}: ${err.message}`);
  }
}

// Pre-warm all currently indexed tracks in the background (one at a time to avoid flooding MTProto)
async function prewarmAllTracks() {
  console.log(`[FastStart] Starting pre-warm for ${trackIndex.length} track(s)...`);
  for (const track of trackIndex) {
    if (fastStartCache.has(track.id)) continue;
    const media = mediaCache.get(track.id);
    if (!media) continue;
    await prewarmFastStart(track.id, media);
    // Small gap between downloads to avoid rate-limiting Telegram MTProto
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[FastStart] Pre-warm complete! ${fastStartCache.size}/${trackIndex.length} track(s) cached in RAM.`);
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

  // Try to inspect the first 128KB for lossless FLAC/ALAC/WAV tags or missing title/performer
  const shouldSniffTags = resolvedExt === 'flac' || resolvedExt === 'alac' || resolvedExt === 'wav' || resolvedExt === 'm4a' || !audioAttr || !audioAttr.title;
  let parsedCodec = null;
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
          parsedCodec = parsed.format.codec;
          if (parsed.format.sampleRate) sampleRate = parsed.format.sampleRate;
          if (parsed.format.bitsPerSample) bitDepth = parsed.format.bitsPerSample;
          if (!duration && parsed.format.duration) duration = Math.round(parsed.format.duration);
        }
      }
    } catch (e) {
      // Non-fatal, keep attributes extracted from Telegram
    }
  }

  // Quality badge text & format resolution
  let formatName = EXT_TO_FORMAT[resolvedExt] || resolvedExt;
  let rawKbps = 0;
  if (sizeBytes && duration) {
    rawKbps = Math.round((sizeBytes * 8) / (duration * 1000));
  }

  // Detect ALAC in .m4a containers (Apple Music delivers ALAC in .m4a)
  if (formatName === 'm4a' && (parsedCodec === 'ALAC' || rawKbps > 500)) {
    formatName = 'alac';
    if (!bitDepth) bitDepth = rawKbps > 2000 ? 24 : 16;
    if (!sampleRate) sampleRate = 48000;
  }

  let qualityText = formatName.toUpperCase();
  if (bitDepth && sampleRate) {
    qualityText = `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(1)}kHz ${formatName.toUpperCase()}`;
  } else if (['flac', 'wav', 'alac'].includes(formatName)) {
    qualityText = `16-bit / 44.1kHz ${formatName.toUpperCase()} Lossless`;
  } else {
    qualityText = `${formatName.toUpperCase()} (${Math.min(rawKbps || 320, 320)}kbps)`;
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

// ── Smart Audio Quality Deduplication & Channel Notifications ──────────────

function getQualityScore(track) {
  const fmt = (track.format || '').toLowerCase();
  const isLossless = ['flac', 'wav', 'alac'].includes(fmt);
  if (isLossless) {
    const bits = track.bitDepth || 16;
    const rate = track.sampleRate || 44100;
    // Lossless base score is 1,000,000 + (bitDepth * sampleRate)
    // 24-bit / 192kHz = 5,608,000
    // 24-bit / 96kHz  = 3,304,000
    // 24-bit / 48kHz  = 2,152,000
    // 24-bit / 44.1kHz = 2,058,400
    // 16-bit / 44.1kHz = 1,705,600
    return 1000000 + (bits * rate);
  }

  // Lossy formats (opus, aac, m4a, mp3, ogg)
  let rawKbps = 320;
  if (track.sizeBytes && track.duration) {
    rawKbps = Math.round((track.sizeBytes * 8) / (track.duration * 1000));
  }

  // Codec efficiency multiplier for fair quality comparison:
  // Opus is modern and outperforms MP3 at lower bitrates (160kbps Opus ~ 320kbps MP3)
  // AAC / M4A has higher coding efficiency than MP3 (256kbps AAC ~ 320kbps MP3)
  let multiplier = 1.0;
  if (fmt === 'opus') multiplier = 1.5;
  else if (fmt === 'aac' || fmt === 'm4a') multiplier = 1.25;

  return Math.round(rawKbps * multiplier);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function describeTrackQuality(track) {
  const fmt = (track.format || 'mp3').toUpperCase();
  if (track.bitDepth && track.sampleRate) {
    return `${track.bitDepth}-bit / ${(track.sampleRate / 1000).toFixed(1)}kHz ${fmt}`;
  }
  if (['FLAC', 'WAV', 'ALAC'].includes(fmt)) {
    return `16-bit / 44.1kHz ${fmt} (Lossless)`;
  }
  let kbps = 320;
  if (track.sizeBytes && track.duration) {
    kbps = Math.round((track.sizeBytes * 8) / (track.duration * 1000));
  }
  return `${fmt} (~${kbps}kbps)`;
}

function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/\((?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?).*?\)/gi, '')
    .replace(/\[(?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?).*?\]/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArtist(a) {
  if (!a || a.toLowerCase() === 'unknown artist') return '';
  return a
    .toLowerCase()
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate(a, b) {
  if (a.id === b.id) return false;

  // Duration safeguard: if both tracks have known duration, they must match within 5 seconds
  if (a.duration && b.duration && Math.abs(a.duration - b.duration) > 5) {
    return false;
  }

  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  if (!titleA || !titleB) return false;

  if (titleA === titleB) {
    const artistA = normalizeArtist(a.artist);
    const artistB = normalizeArtist(b.artist);
    if (artistA && artistB) {
      const wordsA = artistA.split(' ').filter((w) => w.length > 2);
      const wordsB = artistB.split(' ').filter((w) => w.length > 2);
      const hasCommonArtist = wordsA.some((w) => artistB.includes(w)) || wordsB.some((w) => artistA.includes(w));
      return hasCommonArtist;
    }
    return true;
  }

  return false;
}

async function sendChannelNotification(text) {
  try {
    if (channelEntity) {
      await client.sendMessage(channelEntity, { message: text });
      console.log('[Channel Notification Sent]');
    }
  } catch (err) {
    console.warn('[Channel Notification Error]:', err.message);
  }
}

async function deleteTelegramMessage(messageId) {
  try {
    const id = parseInt(messageId, 10);
    if (channelEntity && id) {
      await client.deleteMessages(channelEntity, [id], { revoke: true });
      console.log(`[Deleted Telegram Message] ID: ${id}`);
      return true;
    }
  } catch (err) {
    console.warn(`[Delete Message Error] ID ${messageId}:`, err.message);
  }
  return false;
}

async function processTrackUpload(newTrack) {
  const existingDup = trackIndex.find((t) => isDuplicate(t, newTrack));
  if (!existingDup) {
    trackIndex.unshift(newTrack);
    saveCache();
    console.log(`Auto-indexed new track: "${newTrack.title}" by "${newTrack.artist}" (${describeTrackQuality(newTrack)})`);
    return newTrack;
  }

  const scoreNew = getQualityScore(newTrack);
  const scoreOld = getQualityScore(existingDup);

  console.log(`Duplicate detected for "${newTrack.title}"! Incoming score: ${scoreNew}, Existing score: ${scoreOld}`);

  if (scoreNew > scoreOld) {
    // Incoming track is HIGHER quality (e.g. 24/192 replacing 16/44.1, or FLAC replacing MP3)
    console.log(`Upgrading "${newTrack.title}" from ${describeTrackQuality(existingDup)} to ${describeTrackQuality(newTrack)}`);

    await deleteTelegramMessage(existingDup.id);

    const oldIdx = trackIndex.findIndex((t) => t.id === existingDup.id);
    if (oldIdx >= 0) {
      trackIndex.splice(oldIdx, 1);
    }
    trackIndex.unshift(newTrack);
    saveCache();

    const notif =
      `🗑️ Duplicate Removed (Quality Upgrade)\n\n` +
      `🎵 Track: ${newTrack.title} — ${newTrack.artist}\n` +
      `✅ Kept (New): ${describeTrackQuality(newTrack)} [${formatBytes(newTrack.sizeBytes)}]\n` +
      `❌ Deleted (Old): ${describeTrackQuality(existingDup)} [${formatBytes(existingDup.sizeBytes)}]\n` +
      `💡 Reason: Higher resolution audio detected. Automatically upgraded your library!`;
    await sendChannelNotification(notif);

    return newTrack;
  } else {
    // Incoming track is LOWER or EQUAL quality: delete incoming upload!
    console.log(`Discarding incoming duplicate of "${newTrack.title}". Keeping existing ${describeTrackQuality(existingDup)}.`);

    await deleteTelegramMessage(newTrack.id);

    const isLower = scoreNew < scoreOld;
    const notif =
      `🗑️ Duplicate Removed\n\n` +
      `🎵 Track: ${newTrack.title} — ${newTrack.artist}\n` +
      `✅ Kept (Library): ${describeTrackQuality(existingDup)} [${formatBytes(existingDup.sizeBytes)}]\n` +
      `❌ Deleted (Upload): ${describeTrackQuality(newTrack)} [${formatBytes(newTrack.sizeBytes)}]\n` +
      `💡 Reason: ${isLower ? 'Channel already contains a higher quality version.' : 'Exact duplicate already present in library.'}`;
    await sendChannelNotification(notif);

    return null;
  }
}

async function deduplicateEntireLibrary() {
  console.log('Scanning library for duplicates...');
  const removed = [];
  const sorted = [...trackIndex].sort((a, b) => getQualityScore(b) - getQualityScore(a));
  const kept = [];

  for (const track of sorted) {
    const dup = kept.find((k) => isDuplicate(k, track));
    if (!dup) {
      kept.push(track);
    } else {
      console.log(`Removing duplicate: "${track.title}" (ID: ${track.id}) in favor of (ID: ${dup.id})`);
      await deleteTelegramMessage(track.id);
      removed.push({ deleted: track, kept: dup });

      const notif =
        `🗑️ Duplicate Cleaned\n\n` +
        `🎵 Track: ${dup.title} — ${dup.artist}\n` +
        `✅ Kept: ${describeTrackQuality(dup)} [${formatBytes(dup.sizeBytes)}]\n` +
        `❌ Deleted: ${describeTrackQuality(track)} [${formatBytes(track.sizeBytes)}]\n` +
        `💡 Reason: Library cleanup: lower/duplicate quality removed.`;
      await sendChannelNotification(notif);
    }
  }

  if (removed.length > 0) {
    trackIndex = kept;
    saveCache();
    console.log(`Deduplication complete! Removed ${removed.length} duplicate(s).`);
  } else {
    console.log('Deduplication check: Library is 100% clean, no duplicates found.');
  }

  return { checked: sorted.length, duplicatesRemoved: removed.length, removed };
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
        if (!existing.sizeBytes && msg.media?.document?.size) {
          existing.sizeBytes = Number(msg.media.document.size);
        }
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
    await deduplicateEntireLibrary();
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
    name: 'Telegram Music Addon',
    version: `1.9.1 (${trackIndex.length} songs)`,
    description: 'Personal hi-res, lossless, and high-quality music library streamed directly from Telegram',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music',
  });
});

// Deduplication trigger endpoint: triggers on-demand library scan and cleaning
app.get('/deduplicate', async (req, res) => {
  try {
    const result = await deduplicateEntireLibrary();
    res.json({
      status: 'ok',
      checkedTracks: result.checked,
      duplicatesRemoved: result.duplicatesRemoved,
      details: result.removed.map((r) => ({
        track: r.kept.title,
        artist: r.kept.artist,
        kept: describeTrackQuality(r.kept),
        deleted: describeTrackQuality(r.deleted),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ARTIST_SEPARATORS_REGEX = /\s*(?:[,&/;·|]|\band\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i;
const BRACKETED_REGEX = /[([][^()[\]]*[)\]]/g;
const NOISE_WORDS_REGEX = /\b(?:official|video|audio|lyrics|lyric|lyrical|song|songs|full|hd|hq|4k|mp3|flac|ost|soundtrack|remaster|remastered)\b/gi;

function extractCoreTitle(title) {
  if (!title) return '';
  let clean = title.toLowerCase();
  clean = clean.replace(BRACKETED_REGEX, ' ');
  clean = clean.replace(NOISE_WORDS_REGEX, ' ');
  clean = clean.replace(/[^a-z0-9\s]/g, ' ');
  return clean.replace(/\s+/g, ' ').trim();
}

function parseArtistTokens(artistStr) {
  if (!artistStr) return [];
  const parts = artistStr.toLowerCase().split(ARTIST_SEPARATORS_REGEX);
  const result = [];
  for (const p of parts) {
    const words = p.replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (words.length > 0) {
      result.push(words);
    }
  }
  return result;
}

function runOf(outer, inner) {
  if (!inner.length || inner.length > outer.length) return false;
  for (let i = 0; i <= outer.length - inner.length; i++) {
    let match = true;
    for (let j = 0; j < inner.length; j++) {
      if (outer[i + j] !== inner[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function sameArtist(aWords, bWords) {
  return runOf(aWords, bWords) || runOf(bWords, aWords);
}

function sharesArtist(queryArtistStr, trackArtistStr) {
  const queryArtists = parseArtistTokens(queryArtistStr);
  const trackArtists = parseArtistTokens(trackArtistStr);
  if (queryArtists.length === 0 || trackArtists.length === 0) return false;

  return queryArtists.some((q) => trackArtists.some((t) => sameArtist(q, t)));
}

function scoreTrackMatch(track, query) {
  if (!query) return 100;
  const qClean = query.toLowerCase().trim();
  const trackTitleCore = extractCoreTitle(track.title);
  const trackArtist = (track.artist || '').toLowerCase();
  const trackAlbum = (track.album || '').toLowerCase();

  // Fast direct match
  const fullText = `${track.title} ${track.artist} ${track.album || ''}`.toLowerCase();
  if (fullText.includes(qClean)) return 180;

  const queryCore = extractCoreTitle(qClean);

  // 1. Exact Core Title Match
  if (queryCore === trackTitleCore) {
    return 100;
  }

  // 2. Query begins with Track Core Title (e.g. "party on my mind pritam")
  if (queryCore.startsWith(trackTitleCore) || trackTitleCore.startsWith(queryCore)) {
    const extraWords = queryCore.replace(trackTitleCore, '').trim();
    if (!extraWords) {
      return 100;
    }
    // Check if extra words match any artist using BitChord's sameArtist/runOf
    if (sharesArtist(extraWords, track.artist)) {
      return 150; // Exact title + verified shared artist = Top Match!
    }
    // Check if extra words match album
    if (trackAlbum && trackAlbum.includes(extraWords)) {
      return 120;
    }
    // Title matched, but extra words are present (e.g. composer, record label, video tags).
    // Return 85 so BitChord receives the candidate and its client-side TrackMatcher validates duration/artist.
    return 85;
  }

  // 3. Token-based fallback matching
  const queryTokens = qClean.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const titleTokens = trackTitleCore.split(/\s+/).filter(Boolean);
  const allTrackTokens = new Set([
    ...titleTokens,
    ...trackArtist.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
    ...trackAlbum.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  ]);

  const allTitleMatched = titleTokens.length > 0 && titleTokens.every((tw) => queryTokens.includes(tw));
  if (allTitleMatched) {
    const hasArtistToken = queryTokens.some((qw) => !titleTokens.includes(qw) && allTrackTokens.has(qw));
    return hasArtistToken ? 140 : 90;
  }

  const matchCount = queryTokens.filter((t) => allTrackTokens.has(t)).length;
  const ratio = matchCount / queryTokens.length;
  if (ratio >= 0.6) {
    return Math.round(ratio * 80);
  }

  return 0;
}

async function onTrackForwarded(msg) {
  try {
    const track = await parseTrackMessage(msg);
    if (track) {
      await processTrackUpload(track);
      console.log(`[AutoIndex] Successfully indexed newly uploaded track: "${track.title}" (ID: ${track.id})`);
    }
  } catch (err) {
    console.warn('[AutoIndex] Error indexing forwarded track:', err.message);
  }
}

// Search: BitChord calls /search?q=... to find tracks (100% in-memory for instant < 5ms response!)
app.get('/search', async (req, res) => {
  const startTime = Date.now();
  try {
    // Refresh index periodically in background (every 30 minutes)
    if (Date.now() - lastIndexed > 30 * 60 * 1000) {
      buildTrackIndex().catch((e) => console.error('Background index error:', e.message));
    }

    const q = (req.query.q || '').toLowerCase().trim();
    const base = getBaseUrl(req);

    let matches = trackIndex;
    if (q) {
      matches = trackIndex
        .map((t) => ({ track: t, score: scoreTrackMatch(t, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.track);
    }

    const elapsed = Date.now() - startTime;
    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'search',
      query: req.query.q || '',
      tier: req.query.quality || 'NONE',
      resultsCount: matches.length,
      topResult: matches[0] ? `${matches[0].title} - ${matches[0].artist} (${matches[0].duration}s)` : null,
      elapsedMs: elapsed,
    });

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

  recordRequest({
    timestamp: new Date().toISOString(),
    type: 'stream',
    id: req.params.id,
    track: track ? `${track.title} - ${track.artist}` : 'NOT_FOUND',
    quality: track ? track.quality : 'UNKNOWN',
    tier: req.query.quality || 'NONE',
  });

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
  const reqStart = Date.now();
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

    // Bulletproof totalSize: fallback to media.document.size, never allow NaN
    const totalSize = Number(track.sizeBytes) || Number(media.document?.size) || 0;
    if (!totalSize || isNaN(totalSize)) {
      console.error(`Invalid totalSize for track ${req.params.id}`);
      return res.status(500).send('Unable to determine audio file size');
    }
    if (!track.sizeBytes) {
      track.sizeBytes = totalSize;
    }

    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    const range = req.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        if (match[1] === '' && match[2] !== '') {
          // Suffix range: bytes=-500 (request last 500 bytes)
          const suffix = parseInt(match[2], 10);
          start = Math.max(0, totalSize - suffix);
          end = totalSize - 1;
          isRange = true;
        } else if (match[1] !== '') {
          start = parseInt(match[1], 10);
          end = match[2] !== '' ? parseInt(match[2], 10) : totalSize - 1;
          isRange = true;
        }
      }
    }

    if (isRange && (start >= totalSize || start > end)) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }

    // Strictly clamp boundaries to valid byte positions
    start = Math.max(0, Math.min(start, totalSize - 1));
    end = Math.max(start, Math.min(end, totalSize - 1));
    const bytesNeeded = end - start + 1;

    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'audio',
      id: req.params.id,
      range: range || 'none',
      bytes: `${start}-${end}/${totalSize}`,
      bytesNeeded,
      track: `${track.title} - ${track.artist}`,
    });

    res.status(isRange ? 206 : 200);
    res.setHeader('Content-Type', track.mimeType || (track.format === 'flac' ? 'audio/flac' : 'application/octet-stream'));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=100');
    res.setHeader('Content-Length', bytesNeeded);
    if (isRange) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    }

    // Dynamic MTProto block size:
    // For small probes (<= 128KB), use 64KB/128KB to respond in sub-100ms without socket congestion.
    // For normal/large streaming, use 512KB for maximum line-rate throughput.
    // Must be a multiple of 4096 (MIN_CHUNK_SIZE) between 64KB and 512KB.
    const dynamicBlockSize = Math.min(
      512 * 1024,
      Math.max(64 * 1024, Math.ceil(bytesNeeded / 4096) * 4096)
    );

    // Stream directly from Telegram MTProto from the requested byte offset.
    let bytesSent = 0;

    iterator = client.iterDownload({
      file: media,
      offset: bigInt(start),
      requestSize: dynamicBlockSize,
    });

    for await (const chunk of iterator) {
      if (isConnectionClosed || res.writableEnded || res.destroyed) {
        iterator.left = 0;
        await iterator.close().catch(() => {});
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
        await iterator.close().catch(() => {});
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

// Lightweight ping for uptime monitors / keep-alive pingers
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Live debug endpoint: returns the last 50 incoming requests and their responses
app.get('/debug/requests', (req, res) => {
  res.json({
    status: 'ok',
    totalTrackCount: trackIndex.length,
    recordedRequestsCount: recentRequests.length,
    requests: recentRequests,
  });
});

// Fast-Start cache inspection endpoint
app.get('/debug/faststart', (req, res) => {
  const entries = trackIndex.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    cached: fastStartCache.has(t.id),
    cachedBytes: fastStartCache.has(t.id) ? fastStartCache.get(t.id).length : 0,
  }));
  res.json({
    fastStartCacheSize: fastStartCache.size,
    totalTracks: trackIndex.length,
    cachedBytes: FAST_START_BYTES,
    tracks: entries,
  });
});

// Status / Health endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '1.9.1',
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

    // Set up real-time listener for /song commands and new audio uploads
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const isMusicChannel = channelEntity && message.peerId && (utils.getPeerId(message.peerId).toString() === utils.getPeerId(channelEntity).toString());
        const isSelfChat = message.isPrivate; // e.g. Saved Messages

        // Check for /song command
        if (message.text && message.text.trim().startsWith('/song')) {
          if (isMusicChannel || isSelfChat) {
            console.log(`[Song Command] Detected: "${message.text.trim()}" (msg ID: ${message.id})`);
            handleSongCommand(client, channelEntity, message.text.trim(), message.id, onTrackForwarded).catch((err) => {
              console.error('[Song Command Error]:', err.message);
            });
            return;
          }
        }

        // Check for incoming audio file upload
        if (message.media && message.media.document) {
          if (!isMusicChannel) return;

          console.log(`Detected new upload in channel (msg ID: ${message.id}), processing track...`);
          const track = await parseTrackMessage(message);
          if (track) {
            await processTrackUpload(track);
          }
        }
      } catch (err) {
        console.warn('Real-time event error:', err.message);
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
