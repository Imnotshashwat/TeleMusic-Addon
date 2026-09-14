const { utils } = require('telegram');

// Anti-remix / junk penalties
const REMIX_KEYWORDS = [
  'remix', 'mix', 'dj', 'club', 'house', 'afro', 'lofi', 'flip',
  'slowed', 'reverb', 'sped up', 'instrumental', 'karaoke', 'cover', 'tribute'
];

/**
 * Searches Apple Music via the official, free iTunes Search API.
 * Uses country=IN by default for Indian releases, with fallback to US.
 */
async function searchAppleMusic(query, country = 'IN') {
  try {
    const cleanQuery = query.trim();
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=${country}&entity=song&limit=7`;
    let res = await fetch(url);
    let data = await res.json();

    if ((!data.results || data.results.length === 0) && country !== 'US') {
      url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=US&entity=song&limit=7`;
      res = await fetch(url);
      data = await res.json();
    }

    return (data.results || []).map((r, idx) => {
      const durationSec = Math.round((r.trackTimeMillis || 0) / 1000);
      const mins = Math.floor(durationSec / 60);
      const secs = (durationSec % 60).toString().padStart(2, '0');
      return {
        optionNum: idx + 1,
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        durationSec,
        durationStr: `${mins}:${secs}`,
        url: r.trackViewUrl,
        artwork: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null,
      };
    });
  } catch (err) {
    console.error('[AppleSearch] Error querying iTunes API:', err.message);
    return [];
  }
}

/**
 * Scores an Apple Music candidate to prioritize the authentic original movie/album version.
 */
function scoreAppleMusicCandidate(candidate, originalQuery) {
  let score = 100;
  const qLower = originalQuery.toLowerCase();
  const titleLower = (candidate.title || '').toLowerCase();
  const albumLower = (candidate.album || '').toLowerCase();

  // If the user did not specifically ask for remix/dj, penalize remix markers
  const userWantsRemix = REMIX_KEYWORDS.some(k => qLower.includes(k));
  if (!userWantsRemix) {
    for (const kw of REMIX_KEYWORDS) {
      if (titleLower.includes(kw) || albumLower.includes(kw)) {
        score -= 80;
        break;
      }
    }
  }

  // Boost original soundtrack or movie markers
  if (titleLower.includes('from "') || titleLower.includes('soundtrack') || albumLower.includes('original')) {
    score += 40;
  }

  // Bollywood/pop original songs are usually full length (>= 3:30)
  if (candidate.durationSec >= 210) {
    score += 20;
  } else if (candidate.durationSec < 150) {
    // Short edits / tik tok cuts
    score -= 30;
  }

  return score;
}

/**
 * Downloads ALAC Lossless (.m4a) from Apple Music via @applemusicdw_bot.
 */
async function downloadFromAppleMusic(client, appleMusicUrl, onProgress) {
  const botEntity = await client.getEntity('applemusicdw_bot');
  if (onProgress) onProgress('Sending Apple Music link to @applemusicdw_bot...');

  const sendMsg = await client.sendMessage(botEntity, { message: appleMusicUrl });
  const startId = sendMsg.id;

  const startTime = Date.now();
  const timeoutMs = 45000;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
    for (const m of recentMsgs) {
      if (m.id > startId && m.media?.document) {
        return m;
      }
    }
  }
  throw new Error('@applemusicdw_bot timed out waiting for audio file');
}

/**
 * Downloads FLAC from @MusicsHuntersbot (Deezer, Spotify, Qobuz, Tidal).
 */
async function downloadFromMusicsHunters(client, queryOrUrl, optionNum = 1, onProgress) {
  const botEntity = await client.getEntity('MusicsHuntersbot');
  const isDirectUrl = /^https?:\/\//i.test(queryOrUrl.trim());

  if (isDirectUrl) {
    if (onProgress) onProgress('Sending streaming link to @MusicsHuntersbot...');
    const sendMsg = await client.sendMessage(botEntity, { message: queryOrUrl.trim() });
    const startId = sendMsg.id;

    const startTime = Date.now();
    while (Date.now() - startTime < 45000) {
      await new Promise(r => setTimeout(r, 2000));
      const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
      for (const m of recentMsgs) {
        if (m.id > startId && m.media?.document) {
          return m;
        }
      }
    }
    throw new Error('@MusicsHuntersbot timed out waiting for audio from link');
  }

  // Keyword search with buttons
  if (onProgress) onProgress(`Searching "${queryOrUrl}" on @MusicsHuntersbot...`);
  const sendMsg = await client.sendMessage(botEntity, { message: queryOrUrl.trim() });
  const startId = sendMsg.id;

  // Await search results with buttons
  let searchMsg = null;
  const searchStartTime = Date.now();
  while (Date.now() - searchStartTime < 15000) {
    await new Promise(r => setTimeout(r, 1500));
    const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
    searchMsg = recentMsgs.find(m => m.id > startId && m.replyMarkup?.rows);
    if (searchMsg) break;
  }

  if (!searchMsg) {
    throw new Error('@MusicsHuntersbot did not return search result buttons');
  }

  const optText = String(optionNum);
  if (onProgress) onProgress(`Clicking option ${optText} on @MusicsHuntersbot...`);
  await searchMsg.click({ text: optText });

  // Await document
  const dlStartTime = Date.now();
  while (Date.now() - dlStartTime < 45000) {
    await new Promise(r => setTimeout(r, 2000));
    const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
    for (const m of recentMsgs) {
      if (m.id > searchMsg.id && m.media?.document) {
        return m;
      }
    }
  }
  throw new Error('@MusicsHuntersbot timed out waiting for audio file');
}

/**
 * Handles `/song ...` channel command.
 */
async function handleSongCommand(client, channelEntity, commandText, originalMsgId = null, onTrackForwarded = null) {
  const text = commandText.trim();
  const match = text.match(/^\/song(?:\s+(.+))?$/i);
  if (!match || !match[1]) {
    const helpMsg = await client.sendMessage(channelEntity, {
      message: 'ℹ️ **Usage:**\n• `/song <song name>` (e.g. `/song Kesariya`)\n• `/song <song name> <option#>` (e.g. `/song Kesariya 2`)\n• `/song <Apple Music / Spotify URL>`'
    });
    setTimeout(() => {
      client.deleteMessages(channelEntity, [helpMsg.id, originalMsgId].filter(Boolean), { revoke: true }).catch(() => {});
    }, 10000);
    return;
  }

  const queryArg = match[1].trim();
  let statusMsg = await client.sendMessage(channelEntity, {
    message: `🔍 **Searching:** \`${queryArg}\`...`
  });

  const updateStatus = async (msg) => {
    try {
      await client.editMessage(channelEntity, { message: statusMsg.id, text: msg });
    } catch (_) {}
  };

  try {
    let audioDocMsg = null;
    let chosenTrackInfo = null;

    // CASE 1: Direct Apple Music URL
    if (/music\.apple\.com/i.test(queryArg)) {
      await updateStatus(`📥 **Downloading Studio ALAC Lossless** via @applemusicdw_bot...`);
      audioDocMsg = await downloadFromAppleMusic(client, queryArg, updateStatus);
    }
    // CASE 2: Direct Spotify / Deezer / Qobuz / Tidal URL
    else if (/^(https?:\/\/)?(open\.spotify\.com|deezer\.com|deezer\.page\.link|qobuz\.com|tidal\.com)/i.test(queryArg)) {
      await updateStatus(`📥 **Downloading FLAC** via @MusicsHuntersbot...`);
      audioDocMsg = await downloadFromMusicsHunters(client, queryArg, 1, updateStatus);
    }
    // CASE 3: Keyword search with optional explicit option number
    else {
      let query = queryArg;
      let requestedOption = null;
      const numMatch = queryArg.match(/^(.+?)\s+(\d+)$/);
      if (numMatch) {
        query = numMatch[1].trim();
        requestedOption = parseInt(numMatch[2], 10);
      }

      await updateStatus(`🔍 Searching Apple Music catalog for **"${query}"**...`);
      const candidates = await searchAppleMusic(query);

      if (candidates.length > 0) {
        let selectedCandidate = null;
        if (requestedOption && requestedOption >= 1 && requestedOption <= candidates.length) {
          selectedCandidate = candidates[requestedOption - 1];
        } else {
          // Score candidates to pick the best original track
          const scored = candidates.map(c => ({
            candidate: c,
            score: scoreAppleMusicCandidate(c, query)
          }));
          scored.sort((a, b) => b.score - a.score);
          selectedCandidate = scored[0].candidate;
        }

        chosenTrackInfo = selectedCandidate;
        await updateStatus(`📥 Found **${selectedCandidate.artist} - ${selectedCandidate.title}** (${selectedCandidate.durationStr})\n⏳ Downloading Studio ALAC Lossless...`);

        try {
          audioDocMsg = await downloadFromAppleMusic(client, selectedCandidate.url, updateStatus);
        } catch (appleErr) {
          console.warn('[Downloader] Apple Music bot failed/timed out, trying @MusicsHuntersbot fallback:', appleErr.message);
          await updateStatus(`⚠️ Apple Music busy, falling back to @MusicsHuntersbot FLAC...`);
          audioDocMsg = await downloadFromMusicsHunters(client, query, requestedOption || 1, updateStatus);
        }
      } else {
        // Fallback directly to @MusicsHuntersbot if Apple returned 0 results
        await updateStatus(`🔍 Not found on Apple Music, querying @MusicsHuntersbot FLAC...`);
        audioDocMsg = await downloadFromMusicsHunters(client, query, requestedOption || 1, updateStatus);
      }
    }

    if (!audioDocMsg || !audioDocMsg.media?.document) {
      throw new Error('Failed to retrieve audio file from bot');
    }

    // Forward the audio document to the music library channel
    await updateStatus(`🚀 Uploading track to Music Library...`);
    const botPeer = audioDocMsg.peerId;
    const forwarded = await client.forwardMessages(channelEntity, {
      messages: [audioDocMsg.id],
      fromPeer: botPeer,
    });

    if (onTrackForwarded && forwarded && forwarded[0]) {
      try {
        await onTrackForwarded(forwarded[0]);
      } catch (idxErr) {
        console.warn('[Downloader] Post-forward indexing error:', idxErr.message);
      }
    }

    await updateStatus(`✅ **Added to Music Library!**`);

    // Clean up status message and original command after 8 seconds
    setTimeout(async () => {
      try {
        const msgsToDelete = [statusMsg.id];
        if (originalMsgId) msgsToDelete.push(originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete, { revoke: true });
      } catch (_) {}
    }, 8000);

  } catch (err) {
    console.error('[Downloader] Song command failed:', err.message);
    await updateStatus(`❌ **Download Failed:** ${err.message}`);
    setTimeout(async () => {
      try {
        const msgsToDelete = [statusMsg.id];
        if (originalMsgId) msgsToDelete.push(originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete, { revoke: true });
      } catch (_) {}
    }, 12000);
  }
}

module.exports = {
  searchAppleMusic,
  scoreAppleMusicCandidate,
  downloadFromAppleMusic,
  downloadFromMusicsHunters,
  handleSongCommand,
};
