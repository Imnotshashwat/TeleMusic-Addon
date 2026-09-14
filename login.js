// Interactive login helper for Telegram MTProto
// Generates your TELEGRAM_SESSION_STRING and optionally saves it directly into .env

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const envPath = path.join(__dirname, '.env');

function readEnvMap() {
  const map = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        map[key] = val;
      }
    }
  }
  return map;
}

function saveEnvKey(key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const safeVal = value.includes(' ') || value.includes('"') ? `"${value.replace(/"/g, '\\"')}"` : value;
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${safeVal}`);
  } else {
    content += `\n${key}=${safeVal}\n`;
  }
  fs.writeFileSync(envPath, content.trim() + '\n', 'utf-8');
}

(async () => {
  console.log('=================================================================');
  console.log('       BitChord Telegram Music Addon — Login Setup               ');
  console.log('=================================================================\n');

  let apiIdStr = process.env.TELEGRAM_API_ID;
  let apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiIdStr || !apiHash) {
    console.log('You need Telegram API credentials to connect.');
    console.log('If you do not have them yet:');
    console.log('  1. Go to https://my.telegram.org');
    console.log('  2. Log in with your phone number');
    console.log('  3. Click "API development tools" and create an app to get API ID & Hash.\n');

    if (!apiIdStr) {
      apiIdStr = await input.text('Enter your TELEGRAM_API_ID (numbers only): ');
    }
    if (!apiHash) {
      apiHash = await input.text('Enter your TELEGRAM_API_HASH: ');
    }
  }

  const apiId = parseInt(apiIdStr.trim(), 10);
  apiHash = apiHash.trim();

  if (!apiId || !apiHash) {
    console.error('Invalid API_ID or API_HASH provided.');
    process.exit(1);
  }

  console.log('\nConnecting to Telegram to authorize your session...');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Your phone number (with international code, e.g. +1... or +91...): '),
    password: async () => await input.text('Your 2FA password (leave blank and press Enter if none): '),
    phoneCode: async () => await input.text('Verification code Telegram just sent to your app: '),
    onError: (err) => console.error('Telegram Auth Error:', err),
  });

  const sessionString = client.session.save();

  console.log('\n=================================================================');
  console.log('                  LOGIN SUCCESSFUL!                             ');
  console.log('=================================================================\n');

  console.log('Saving TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING to .env...');
  saveEnvKey('TELEGRAM_API_ID', apiId.toString());
  saveEnvKey('TELEGRAM_API_HASH', apiHash);
  saveEnvKey('TELEGRAM_SESSION_STRING', sessionString);

  let channel = process.env.TELEGRAM_CHANNEL;
  if (!channel) {
    console.log('\nNow configure your Telegram Music Channel.');
    console.log('You can provide either:');
    console.log('  - The public username (e.g. @my_music_channel)');
    console.log('  - Or the numeric channel ID (e.g. -1001234567890)');
    console.log('  - Or the exact channel name/title');
    channel = await input.text('Your Telegram Channel handle or ID: ');
    if (channel && channel.trim()) {
      saveEnvKey('TELEGRAM_CHANNEL', channel.trim());
    }
  }

  if (!process.env.PORT) {
    saveEnvKey('PORT', '3000');
  }

  console.log('\n[✔] Configuration successfully saved to .env!');
  console.log('\nYour Session String (keep this secret):');
  console.log(sessionString);
  console.log('\nYou can now start the server with:');
  console.log('  npm start\n');

  await client.disconnect();
  process.exit(0);
})();
