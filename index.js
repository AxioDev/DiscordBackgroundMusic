// index.js — Bot Discord + Jamendo (Auto-join via env vars possible)
// Déps recommandées : discord.js @discordjs/voice node-fetch@2
// Variables requises : BOT_TOKEN, JAMENDO_CLIENT_ID
// Optionnelles : GUILD_ID, VOICE_CHANNEL_ID (pour auto-join au démarrage)

// Certains environnements Node (ex: 18.x) n'exposent pas File en global, ce qui fait
// échouer undici utilisé par discord.js. On le mappe depuis node:buffer si absent.
const bufferModule = require('node:buffer');
if (typeof globalThis.File === 'undefined' && typeof bufferModule.File === 'function') {
  globalThis.File = bufferModule.File;
}

let opusImplementation = null;
try {
  require('@discordjs/opus');
  opusImplementation = '@discordjs/opus';
} catch (opusErr) {
  try {
    require('opusscript');
    opusImplementation = 'opusscript';
  } catch (opusscriptErr) {
    const detail = opusErr?.message || opusscriptErr?.message || 'unknown error';
    console.error(
      'Aucun encodeur Opus détecté. Installe @discordjs/opus (recommandé) ou opusscript pour pouvoir encoder l\'audio.\n' +
      `Détail: ${detail}`
    );
    process.exit(1);
  }
}

if (opusImplementation) {
  console.log(`Encodeur Opus chargé: ${opusImplementation}`);
}

// discord.js-selfbot-v13 attend String.prototype.toWellFormed() (Node >=16.9).
// Certains environnements (versions LTS plus anciennes) ne l'exposent pas : on ajoute
// un polyfill minimal convertissant toute paire suppléante isolée en U+FFFD.
if (typeof ''.toWellFormed !== 'function') {
  Object.defineProperty(String.prototype, 'toWellFormed', {
    value: function toWellFormed() {
      let output = '';
      for (const segment of this) {
        const codePoint = segment.codePointAt(0);
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          output += '\uFFFD';
        } else {
          output += segment;
        }
      }
      return output;
    },
    configurable: true,
    writable: true
  });
}

const { Client, GatewayIntentBits } = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const fetch = require('node-fetch'); // node 18+ peut utiliser global fetch
const youtubedl = require('youtube-dl-exec');
const BOT_TOKEN = process.env.BOT_TOKEN;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const AUTO_GUILD_ID = process.env.GUILD_ID || null;
const AUTO_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || null;

function parseDeleteDelay(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const normalized = Math.max(0, Math.floor(numeric));
  return normalized;
}

const MESSAGE_DELETE_DELAY_MS = parseDeleteDelay(process.env.MESSAGE_DELETE_DELAY_MS, 15_000);

function parseVolumePercent(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(200, numeric));
  return clamped;
}

const DEFAULT_VOLUME_PERCENT = parseVolumePercent(process.env.DEFAULT_VOLUME_PERCENT);
const MIN_AUTO_VOLUME_PERCENT = 1;
const MAX_AUTO_VOLUME_PERCENT = 10;
const AUTO_VOLUME_MAX_MEMBERS = 25;

const INITIAL_VOLUME_PERCENT = DEFAULT_VOLUME_PERCENT === null
  ? MAX_AUTO_VOLUME_PERCENT
  : clampAutoVolumePercent(DEFAULT_VOLUME_PERCENT);
const DEFAULT_VOLUME = INITIAL_VOLUME_PERCENT / 100;

function scheduleMessageDeletion(message, delayMs = MESSAGE_DELETE_DELAY_MS) {
  if (!message || typeof message.delete !== 'function') {
    return;
  }
  const effectiveDelay = Number.isFinite(delayMs) ? delayMs : MESSAGE_DELETE_DELAY_MS;
  if (!(effectiveDelay > 0)) {
    return;
  }
  setTimeout(() => {
    try {
      message.delete().catch(() => {});
    } catch (err) {}
  }, effectiveDelay);
}

function sendWithAutoDelete(target, content, options = {}) {
  if (!target || typeof target.send !== 'function') {
    return Promise.reject(new Error('Invalid target for sendWithAutoDelete'));
  }

  const {
    deleteDelayMs = MESSAGE_DELETE_DELAY_MS,
    suppressErrors = false
  } = options || {};

  return Promise.resolve(target.send(content))
    .then((message) => {
      scheduleMessageDeletion(message, deleteDelayMs);
      return message;
    })
    .catch((err) => {
      if (suppressErrors) {
        return null;
      }
      throw err;
    });
}

function clampAutoVolumePercent(percent) {
  if (!Number.isFinite(percent)) {
    return MAX_AUTO_VOLUME_PERCENT;
  }
  return Math.max(MIN_AUTO_VOLUME_PERCENT, Math.min(MAX_AUTO_VOLUME_PERCENT, percent));
}

function countRelevantVoiceMembers(channel) {
  if (!channel || !channel.members || typeof channel.members.values !== 'function') {
    return 0;
  }
  let count = 0;
  for (const member of channel.members.values()) {
    if (!member) continue;
    const user = member.user;
    if (user && user.bot && client?.user && member.id !== client.user.id) {
      continue;
    }
    count++;
  }
  return count;
}

function computeAutoVolumePercent(memberCount) {
  if (!Number.isFinite(memberCount) || memberCount <= 1) {
    return MAX_AUTO_VOLUME_PERCENT;
  }
  const clampedCount = Math.max(1, Math.min(AUTO_VOLUME_MAX_MEMBERS, memberCount));
  if (AUTO_VOLUME_MAX_MEMBERS <= 1) {
    return MAX_AUTO_VOLUME_PERCENT;
  }
  const ratio = (clampedCount - 1) / (AUTO_VOLUME_MAX_MEMBERS - 1);
  const percent = MAX_AUTO_VOLUME_PERCENT - ratio * (MAX_AUTO_VOLUME_PERCENT - MIN_AUTO_VOLUME_PERCENT);
  return clampAutoVolumePercent(percent);
}

function applyVolumePercent(percent, { cause = 'auto' } = {}) {
  const normalizedPercent = Number.isFinite(percent) ? Math.max(0, Math.min(200, percent)) : MAX_AUTO_VOLUME_PERCENT;
  const previousVolume = currentVolume;
  const normalizedVolume = normalizedPercent / 100;
  currentVolume = normalizedVolume;
  if (currentResource && currentResource.volume && typeof currentResource.volume.setVolume === 'function') {
    try {
      currentResource.volume.setVolume(currentVolume);
    } catch (err) {
      console.warn('Impossible de mettre à jour le volume de la ressource audio:', err?.message || err);
    }
  }
  if (!Number.isFinite(previousVolume) || Math.abs(previousVolume - currentVolume) >= 0.0001) {
    console.log(`Volume ${cause}: ${(currentVolume * 100).toFixed(2)}%`);
  }
  return normalizedPercent;
}

function updateAutomaticVolumeForChannel(channel, { cause = 'auto' } = {}) {
  if (!channel || !isVoiceChannel(channel)) {
    return null;
  }

  currentVoiceChannel = channel;
  const memberCount = countRelevantVoiceMembers(channel);
  const targetPercent = computeAutoVolumePercent(memberCount);
  const appliedPercent = applyVolumePercent(targetPercent, { cause: `${cause} (${memberCount} membres)` });
  return { memberCount, percent: appliedPercent };
}

function sanitizeMusicTag(rawTag) {
  if (typeof rawTag !== 'string') return null;
  const trimmed = rawTag.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().replace(/\s+/g, '-');
}

const DEFAULT_JAMENDO_TAG = sanitizeMusicTag(process.env.JAMENDO_MUSIC_TAG) || 'atmo';
let currentJamendoTag = DEFAULT_JAMENDO_TAG;

if (!BOT_TOKEN || !JAMENDO_CLIENT_ID) {
  console.error('Définis BOT_TOKEN et JAMENDO_CLIENT_ID dans les variables d\'env.');
  process.exit(1);
}

console.log(`Tag Jamendo initial: ${currentJamendoTag}`);
console.log(`Suppression automatique des messages après ${MESSAGE_DELETE_DELAY_MS} ms${MESSAGE_DELETE_DELAY_MS === 0 ? ' (désactivée)' : ''}.`);
console.log(
  `Volume automatique initial: ${INITIAL_VOLUME_PERCENT}% (ajustement entre ${MIN_AUTO_VOLUME_PERCENT}% et ${MAX_AUTO_VOLUME_PERCENT}% jusqu'à ${AUTO_VOLUME_MAX_MEMBERS} personnes).`
);

const ALLOWED_USER_ID = '216189520872210444';
const ALLOWED_ROLE_NAMES = ['Radio', 'Modo', 'Medium'];

function buildCommandsHelpMessage(definitions) {
  const header = '📖 **Commandes disponibles**';
  const lines = definitions.map((def) => `• ${def.name} : ${def.description}`);
  return [header, ...lines].join('\n');
}

function buildCommandsBioText(definitions) {
  const baseText = `Cmds: ${definitions.map((def) => def.name).join(', ')}`;
  if (baseText.length <= 190) {
    return baseText;
  }
  return `${baseText.slice(0, 187)}…`;
}

const COMMAND_DEFINITIONS = [
  { name: '--help', description: 'Affiche cette aide.' },
  { name: '--join-vocal', description: 'Fait rejoindre ton salon vocal et démarre la musique.' },
  { name: '--start-music', description: 'Lance la musique (ou une URL audio/YouTube fournie).' },
  { name: '--skip-music', description: 'Passe à la piste Jamendo suivante.' },
  { name: '--stop-music', description: 'Arrête la musique et quitte le vocal.' },
  { name: '--change-music-tag', description: 'Change le style Jamendo utilisé pour la lecture.' },
  { name: '--change-volume', description: 'Indique le volume actuel (ajustement automatique).' }
];

const COMMANDS_HELP_MESSAGE = buildCommandsHelpMessage(COMMAND_DEFINITIONS);
const COMMANDS_BIO_TEXT = buildCommandsBioText(COMMAND_DEFINITIONS);

function isAuthorizedUser(message) {
  if (message.author.id === ALLOWED_USER_ID) {
    return true;
  }

  const memberRoles = message.member?.roles?.cache;
  if (!memberRoles || typeof memberRoles.some !== 'function') {
    return false;
  }

  return memberRoles.some((role) => ALLOWED_ROLE_NAMES.includes(role.name));
}

const client = new Client({

});

let voiceConnection = null;
let currentVoiceChannel = null;
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let currentResource = null;
let currentVolume = DEFAULT_VOLUME; // Valeur initiale, ajustée automatiquement ensuite
let lastTrackInfo = null;
let manualStopInProgress = false;
let autoPlaybackDesired = false;
let loadingTrackPromise = null;
let lastAnnounceChannel = null;
let playbackRequestToken = 0;
let skipInProgressCount = 0;
let lastVoiceChannelId = null;

const jamendoRecentTrackIdsByTag = new Map();
const JAMENDO_RECENT_TRACK_HISTORY = 5;

async function updateBotCommandBio() {
  const user = client?.user;
  if (!user || typeof user.setAboutMe !== 'function') {
    return;
  }

  const currentBio = typeof user.bio === 'string' ? user.bio : '';
  const desiredBio = COMMANDS_BIO_TEXT;

  if (currentBio === desiredBio) {
    return;
  }

  try {
    await user.setAboutMe(desiredBio);
    console.log('Description mise à jour avec la liste des commandes.');
  } catch (err) {
    console.error('Impossible de mettre à jour la description:', err?.message || err);
  }
}

function getJamendoHistoryBucket(tag) {
  const key = tag || '';
  let bucket = jamendoRecentTrackIdsByTag.get(key);
  if (!bucket) {
    bucket = [];
    jamendoRecentTrackIdsByTag.set(key, bucket);
  }
  return bucket;
}

function getRecentJamendoTrackIds(tag) {
  const key = tag || '';
  const bucket = jamendoRecentTrackIdsByTag.get(key);
  return bucket ? bucket.slice() : [];
}

function rememberJamendoTrack(tag, trackId) {
  if (!trackId) return;
  const normalized = getNormalizedJamendoId(trackId);
  if (!normalized) return;
  const bucket = getJamendoHistoryBucket(tag);
  const existingIndex = bucket.indexOf(normalized);
  if (existingIndex !== -1) {
    bucket.splice(existingIndex, 1);
  }
  bucket.push(normalized);
  while (bucket.length > JAMENDO_RECENT_TRACK_HISTORY) {
    bucket.shift();
  }
}

function getNormalizedJamendoId(rawId) {
  if (rawId === undefined || rawId === null) {
    return null;
  }
  try {
    return String(rawId);
  } catch (err) {
    return null;
  }
}

function shuffledCopy(items) {
  const array = items.slice();
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);

  await updateBotCommandBio();

  // Si GUILD_ID + VOICE_CHANNEL_ID fournis -> tenter auto-join
  if (AUTO_GUILD_ID && AUTO_VOICE_CHANNEL_ID) {
    try {
      const guild = await client.guilds.fetch(AUTO_GUILD_ID);
      const channel = await guild.channels.fetch(AUTO_VOICE_CHANNEL_ID);
      if (!isVoiceChannel(channel)) {
        console.warn('Le channel spécifié n\'est pas un salon vocal ou est introuvable.');
        return;
      }

      await connectToVoiceChannel(channel, { autoStartPlayback: true });
      console.log(`Auto-join : salon vocal ${channel.name} (${channel.id}) sur la guilde ${guild.name} (${guild.id})`);
    } catch (err) {
      console.error('Auto-join failed:', err?.message || err);
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    const trackedChannelId = currentVoiceChannel?.id || voiceConnection?.joinConfig?.channelId || lastVoiceChannelId;
    if (!trackedChannelId) {
      return;
    }

    const oldChannelId = oldState?.channelId || null;
    const newChannelId = newState?.channelId || null;

    if (oldChannelId !== trackedChannelId && newChannelId !== trackedChannelId) {
      return;
    }

    const candidateChannel =
      (newChannelId === trackedChannelId ? newState?.channel : null) ||
      (oldChannelId === trackedChannelId ? oldState?.channel : null) ||
      currentVoiceChannel;

    if (candidateChannel && isVoiceChannel(candidateChannel)) {
      updateAutomaticVolumeForChannel(candidateChannel, { cause: 'mise à jour vocale' });
      return;
    }

    const guild = newState?.guild || oldState?.guild;
    if (!guild || typeof guild.channels?.fetch !== 'function') {
      return;
    }

    guild.channels
      .fetch(trackedChannelId)
      .then((channel) => {
        if (isVoiceChannel(channel)) {
          updateAutomaticVolumeForChannel(channel, { cause: 'mise à jour vocale (fetch)' });
        }
      })
      .catch(() => {});
  } catch (err) {
    console.warn('Mise à jour automatique du volume impossible:', err?.message || err);
  }
});

setInterval(() => {
  try {
    if (!currentVoiceChannel || !isVoiceChannel(currentVoiceChannel)) {
      return;
    }
    updateAutomaticVolumeForChannel(currentVoiceChannel, { cause: 'rafraîchissement périodique' });
  } catch (err) {
    console.warn('Rafraîchissement automatique du volume impossible:', err?.message || err);
  }
}, 15_000);

// Recherche une piste sur Jamendo en fonction du tag actuel en privilégiant celles dont le téléchargement est autorisé
async function getJamendoTrackStream(tag = currentJamendoTag) {
  const effectiveTag = sanitizeMusicTag(tag) || DEFAULT_JAMENDO_TAG;
  const searchParams = new URLSearchParams({
    client_id: JAMENDO_CLIENT_ID,
    format: 'json',
    limit: '20',
    order: 'popularity_total_desc',
    tags: effectiveTag,
    audioformat: 'mp32'
  });
  const url = `https://api.jamendo.com/v3.0/tracks/?${searchParams.toString()}`;
  console.log(`url Jamendo (${effectiveTag}):`, url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jamendo API error ${res.status}`);
  const j = await res.json();
  if (!j.results || j.results.length === 0) throw new Error('Aucune piste trouvée sur Jamendo.');

  const playableTracks = [];
  for (const track of j.results) {
    if (!track || !track.audio) continue;
    if (track.audiodownload_allowed === false) continue; // piste non téléchargeable => éviter les 404
    playableTracks.push({
      track,
      jamendoId: getNormalizedJamendoId(track.id)
    });
  }

  if (playableTracks.length === 0) {
    throw new Error('Aucune piste Jamendo lisible trouvée.');
  }

  const previousJamendoId = lastTrackInfo?.tag === effectiveTag ? getNormalizedJamendoId(lastTrackInfo?.jamendoId) : null;
  const recentIds = new Set(getRecentJamendoTrackIds(effectiveTag));
  const preferred = [];
  const fallback = [];

  for (const item of playableTracks) {
    const { jamendoId } = item;
    if (jamendoId && (jamendoId === previousJamendoId || recentIds.has(jamendoId))) {
      fallback.push(item);
    } else {
      preferred.push(item);
    }
  }

  const selectionOrder = [...shuffledCopy(preferred), ...shuffledCopy(fallback)];
  let lastStreamError = null;

  for (const { track, jamendoId } of selectionOrder) {
    let audioUrl = track.audio;
    try {
      const parsed = new URL(audioUrl);
      if (!parsed.searchParams.has('from')) {
        parsed.searchParams.set('from', `app-${JAMENDO_CLIENT_ID}`);
        audioUrl = parsed.toString();
      }
    } catch (err) {
      // on ne modifie pas si l'URL n'est pas parseable
    }

    try {
      const stream = await fetchAudioStream(audioUrl, `l'audio Jamendo pour ${track.name || 'une piste'}`);
      const licenseUrl = track.license_ccurl || track.license || null;
      return {
        stream,
        inputType: StreamType.Arbitrary,
        info: {
          audioUrl,
          name: track.name || 'Piste Jamendo',
          artist: track.artist_name || 'Artiste Jamendo',
          licenseUrl,
          jamendoId,
          tag: effectiveTag
        }
      };
    } catch (err) {
      lastStreamError = err;
    }
  }

  if (lastStreamError) {
    throw new Error(`Aucune piste Jamendo lisible (${lastStreamError.message || lastStreamError})`);
  }
  throw new Error('Aucune piste Jamendo lisible trouvée.');
}

async function fetchAudioStream(url, label = 'source distante', options = {}) {
  const { headers: extraHeaders = {} } = options || {};
  const headers = {
    'User-Agent': 'DiscordBackgroundMusicBot/1.0 (+https://github.com/DiscordBackgroundMusic/DiscordBackgroundMusic)',
    Accept: 'audio/*;q=0.9,*/*;q=0.5'
  };

  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === undefined || value === null) {
        continue;
      }
      headers[key] = String(value);
    }
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers
  });
  if (!response.ok || !response.body) {
    const statusText = (response.statusText || '').trim();
    const statusInfo = statusText ? `${response.status} ${statusText}` : String(response.status);
    throw new Error(`Impossible de récupérer ${label} (${statusInfo})`);
  }
  return response.body;
}

const YOUTUBE_HOST_SUFFIXES = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

function isYoutubeUrl(input) {
  if (typeof input !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch (err) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return YOUTUBE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function normalizeYoutubeConsentCookie(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

const YOUTUBE_CONSENT_COOKIE = normalizeYoutubeConsentCookie(process.env.YOUTUBE_CONSENT_COOKIE);

function normalizeYoutubeDlHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object') {
    return null;
  }
  const normalized = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key] = String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function extractYoutubeAudio(details) {
  if (!details || typeof details !== 'object') {
    return null;
  }

  const fallbackHeaders = normalizeYoutubeDlHeaders(details.http_headers);

  const tryFormat = (format) => {
    if (!format || typeof format !== 'object') {
      return null;
    }
    const acodec = format.acodec;
    if (!acodec || acodec === 'none') {
      return null;
    }
    const headers = normalizeYoutubeDlHeaders(format.http_headers) || fallbackHeaders;
    if (typeof format.url === 'string' && format.url) {
      return {
        url: format.url,
        headers
      };
    }
    if (typeof format.manifest_url === 'string' && format.manifest_url) {
      return {
        url: format.manifest_url,
        headers
      };
    }
    return null;
  };

  if (typeof details.url === 'string' && details.url) {
    return {
      url: details.url,
      headers: fallbackHeaders
    };
  }

  const collections = [];
  if (Array.isArray(details.requested_formats)) {
    collections.push(details.requested_formats);
  }
  if (Array.isArray(details.formats)) {
    collections.push(details.formats);
  }

  for (const group of collections) {
    for (const format of group) {
      const candidate = tryFormat(format);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function parseYoutubeDlOutput(output) {
  if (output && typeof output === 'object' && !Buffer.isBuffer(output)) {
    return output;
  }

  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Réponse inattendue renvoyée par yt-dlp.');
  }
}

async function getYoutubeAudioStream(url) {
  const addHeader = [];
  if (YOUTUBE_CONSENT_COOKIE) {
    addHeader.push(`Cookie: ${YOUTUBE_CONSENT_COOKIE}`);
  }

  const ytDlpOptions = {
    dumpSingleJson: true,
    skipDownload: true,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    format: 'bestaudio/best',
    noPlaylist: true
  };

  if (addHeader.length > 0) {
    ytDlpOptions.addHeader = addHeader;
  }

  let rawInfo;
  try {
    rawInfo = await youtubedl(url, ytDlpOptions);
  } catch (err) {
    const detail = err?.message || err;
    throw new Error(`Impossible de récupérer les informations YouTube (${detail})`);
  }

  let info;
  try {
    info = parseYoutubeDlOutput(rawInfo);
  } catch (err) {
    throw new Error(err.message || 'Réponse YouTube invalide.');
  }

  const streamDetails = extractYoutubeAudio(info);
  if (!streamDetails || !streamDetails.url) {
    throw new Error('Impossible de déterminer l\'URL audio YouTube.');
  }

  const headers = streamDetails.headers ? { ...streamDetails.headers } : {};
  if (YOUTUBE_CONSENT_COOKIE && !headers?.Cookie) {
    headers.Cookie = YOUTUBE_CONSENT_COOKIE;
  }

  const stream = await fetchAudioStream(
    streamDetails.url,
    `l'audio YouTube pour ${info?.title || 'une vidéo'}`,
    { headers }
  );

  const licenseUrl =
    (typeof info?.channel_url === 'string' && info.channel_url) ||
    (typeof info?.uploader_url === 'string' && info.uploader_url) ||
    null;
  const artistName =
    (typeof info?.uploader === 'string' && info.uploader) ||
    (typeof info?.channel === 'string' && info.channel) ||
    (typeof info?.artist === 'string' && info.artist) ||
    'YouTube';

  return {
    stream,
    inputType: StreamType.Arbitrary,
    info: {
      name: info?.title || 'Vidéo YouTube',
      artist: artistName,
      audioUrl: url,
      licenseUrl,
      tag: null
    }
  };
}

async function getCustomAudioStream(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    throw new Error('URL fournie invalide.');
  }

  if (isYoutubeUrl(trimmed)) {
    return getYoutubeAudioStream(trimmed);
  }

  const stream = await fetchAudioStream(trimmed, 'la source fournie');
  return {
    stream,
    inputType: StreamType.Arbitrary,
    info: {
      name: 'Source fournie',
      artist: trimmed,
      audioUrl: trimmed,
      licenseUrl: null,
      tag: null
    }
  };
}

function isVoiceChannel(channel) {
  if (!channel) return false;
  return channel.type === 2 || channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE';
}

function isVoiceConnectionUsable(connection) {
  return Boolean(connection && connection.state && connection.state.status !== VoiceConnectionStatus.Destroyed);
}

async function waitForVoiceConnectionReady(connection) {
  if (!connection) {
    throw new Error('Aucune connexion vocale active.');
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    try { connection.destroy(); } catch (destroyErr) { console.error('Destruction connexion vocale échouée:', destroyErr); }
    throw err;
  }
  return connection;
}

async function connectToVoiceChannel(channel, { autoStartPlayback: shouldAutoStart = true, announceChannel = null } = {}) {
  if (!isVoiceChannel(channel)) {
    throw new Error('Le salon spécifié n\'est pas un salon vocal.');
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  voiceConnection = connection;
  currentVoiceChannel = channel;
  try {
    await waitForVoiceConnectionReady(connection);
    lastVoiceChannelId = channel.id;
  } catch (err) {
    voiceConnection = null;
    currentVoiceChannel = null;
    throw err;
  }

  updateAutomaticVolumeForChannel(channel, { cause: 'connexion vocale' });

  autoPlaybackDesired = shouldAutoStart;
  if (shouldAutoStart) {
    setImmediate(() => {
      autoStartPlayback({ announceChannel, reason: 'auto-join' }).catch((error) => {
        console.error('Lecture automatique après connexion échouée:', error?.message || error);
      });
    });
  }

  return connection;
}

async function ensureVoiceConnection({ msg = null, autoPlayOnJoin = true, announceChannel = null } = {}) {
  if (isVoiceConnectionUsable(voiceConnection)) {
    try {
      await waitForVoiceConnectionReady(voiceConnection);
      return voiceConnection;
    } catch (err) {
      console.warn('Connexion vocale invalide, tentative de reconnexion:', err?.message || err);
      try { voiceConnection.destroy(); } catch (destroyErr) { console.error('Destruction connexion vocale échouée:', destroyErr); }
      voiceConnection = null;
      currentVoiceChannel = null;
    }
  }

  if (!msg && lastVoiceChannelId) {
    try {
      if (client?.channels?.fetch) {
        const channel = await client.channels.fetch(lastVoiceChannelId);
        if (isVoiceChannel(channel)) {
          await connectToVoiceChannel(channel, { autoStartPlayback: autoPlayOnJoin, announceChannel });
          return voiceConnection;
        }
      }
    } catch (err) {
      console.warn('Reconnexion au dernier salon vocal impossible:', err?.message || err);
    }
  }

  if (AUTO_GUILD_ID && AUTO_VOICE_CHANNEL_ID) {
    try {
      const guild = await client.guilds.fetch(AUTO_GUILD_ID);
      const channel = await guild.channels.fetch(AUTO_VOICE_CHANNEL_ID);
      if (isVoiceChannel(channel)) {
        await connectToVoiceChannel(channel, { autoStartPlayback: autoPlayOnJoin, announceChannel });
        return voiceConnection;
      }
      console.warn('Le channel spécifié n\'est pas un salon vocal ou est introuvable.');
    } catch (err) {
      console.error('Connexion automatique via variables d\'env impossible:', err?.message || err);
    }
  }

  if (msg) {
    const member = msg.member;
    if (!member || !member.voice || !member.voice.channel) {
      throw new Error('Rejoins un salon vocal puis relance la commande.');
    }
    await connectToVoiceChannel(member.voice.channel, { autoStartPlayback: autoPlayOnJoin, announceChannel });
    return voiceConnection;
  }

  throw new Error('Pas de connexion vocale disponible.');
}

async function loadAndPlayTrack({ customUrl = null, announceChannel = null, reason = 'manual' } = {}) {
  if (!isVoiceConnectionUsable(voiceConnection)) {
    throw new Error('Pas de connexion vocale active.');
  }

  const effectiveAnnounceChannel = announceChannel || lastAnnounceChannel || null;
  if (announceChannel) {
    lastAnnounceChannel = announceChannel;
  }

  const connection = voiceConnection;
  const requestToken = ++playbackRequestToken;

  const loadTask = (async () => {
    await waitForVoiceConnectionReady(connection);
    if (voiceConnection !== connection) {
      throw new Error('Connexion vocale modifiée pendant le chargement.');
    }
    if (requestToken !== playbackRequestToken) {
      return null;
    }
    autoPlaybackDesired = true;
    manualStopInProgress = false;

    let remoteStream;
    let trackInfo = null;
    let resourceInputType = StreamType.Arbitrary;

    if (customUrl) {
      const custom = await getCustomAudioStream(customUrl);
      remoteStream = custom.stream;
      trackInfo = custom.info;
      if (custom.inputType) {
        resourceInputType = custom.inputType;
      }
    } else {
      const jamendoData = await getJamendoTrackStream();
      remoteStream = jamendoData.stream;
      trackInfo = jamendoData.info;
      if (jamendoData.inputType) {
        resourceInputType = jamendoData.inputType;
      }
    }

    if (requestToken !== playbackRequestToken) {
      if (remoteStream) {
        try {
          if (typeof remoteStream.destroy === 'function') {
            remoteStream.destroy();
          } else if (typeof remoteStream.cancel === 'function') {
            remoteStream.cancel();
          }
        } catch (cleanupErr) {
          console.warn('Nettoyage du flux audio après annulation impossible:', cleanupErr?.message || cleanupErr);
        }
      }
      return null;
    }

    const resource = createAudioResource(remoteStream, {
      inputType: resourceInputType || StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(currentVolume);
    if (requestToken !== playbackRequestToken) {
      try {
        if (resource.playStream && typeof resource.playStream.destroy === 'function') {
          resource.playStream.destroy();
        }
      } catch (cleanupErr) {
        console.warn('Nettoyage de la ressource audio après annulation impossible:', cleanupErr?.message || cleanupErr);
      }
      return null;
    }
    currentResource = resource;
    lastTrackInfo = trackInfo;
    if (trackInfo && trackInfo.jamendoId) {
      rememberJamendoTrack(trackInfo.tag, trackInfo.jamendoId);
    }
    player.play(resource);
    connection.subscribe(player);

    let prefix = 'Lecture automatique';
    if (reason === 'manual') {
      prefix = 'Lecture démarrée';
    } else if (reason === 'manual-skip') {
      prefix = 'Piste suivante';
    }
    const volumeInfo = `(volume ${(currentVolume * 100).toFixed(0)}%)`;
    if (effectiveAnnounceChannel && typeof effectiveAnnounceChannel.send === 'function') {
      let message;
      if (trackInfo) {
        const namePart = trackInfo.name ? `**${trackInfo.name}**` : 'Une source audio';
        const artistPart = trackInfo.artist ? ` — ${trackInfo.artist}` : '';
        const licensePart = trackInfo.licenseUrl ? ` (licence: ${trackInfo.licenseUrl})` : '';
        message = `▶️ ${prefix} : ${namePart}${artistPart}${licensePart} ${volumeInfo}`;
      } else {
        message = `▶️ ${prefix} ${volumeInfo}`;
      }
      sendWithAutoDelete(effectiveAnnounceChannel, message.trim(), { suppressErrors: true });
    } else if (trackInfo) {
      console.log(`${prefix} : ${trackInfo.name} — ${trackInfo.artist}`);
    }

    return trackInfo;
  })();

  const trackedPromise = loadTask
    .catch((err) => {
      if (effectiveAnnounceChannel && typeof effectiveAnnounceChannel.send === 'function') {
        sendWithAutoDelete(
          effectiveAnnounceChannel,
          `❌ Impossible de démarrer la lecture (${err.message || err}).`,
          { suppressErrors: true }
        );
      }
      throw err;
    })
    .finally(() => {
      if (loadingTrackPromise === trackedPromise) {
        loadingTrackPromise = null;
      }
    });

  loadingTrackPromise = trackedPromise;

  return trackedPromise;
}

async function autoStartPlayback({ announceChannel = null, reason = 'auto' } = {}) {
  const effectiveAnnounceChannel = announceChannel || lastAnnounceChannel || null;

  if (!isVoiceConnectionUsable(voiceConnection)) {
    try {
      await ensureVoiceConnection({ autoPlayOnJoin: false, announceChannel: effectiveAnnounceChannel });
    } catch (err) {
      console.error('Reconnexion vocale nécessaire impossible:', err?.message || err);
      return;
    }
  }

  if (!isVoiceConnectionUsable(voiceConnection)) {
    return;
  }
  if (player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Buffering) {
    return;
  }
  if (loadingTrackPromise) {
    return loadingTrackPromise.catch(() => {});
  }

  try {
    await waitForVoiceConnectionReady(voiceConnection);
  } catch (err) {
    console.error('Connexion vocale indisponible pour la lecture automatique:', err?.message || err);
    return;
  }

  try {
    await loadAndPlayTrack({ customUrl: null, announceChannel: effectiveAnnounceChannel, reason });
  } catch (err) {
    console.error('Lecture automatique échouée:', err?.message || err);
  }
}

player.on(AudioPlayerStatus.Idle, () => {
  currentResource = null;
  if (skipInProgressCount > 0) {
    return;
  }
  if (manualStopInProgress) {
    manualStopInProgress = false;
    return;
  }
  if (!autoPlaybackDesired) {
    return;
  }
  autoStartPlayback({ reason: 'auto-next' }).catch((err) => {
    console.error('Echec du démarrage automatique après la fin de piste:', err?.message || err);
    if (autoPlaybackDesired) {
      setTimeout(() => {
        autoStartPlayback({ reason: 'auto-retry' }).catch((retryErr) => {
          console.error('Nouvelle tentative de lecture automatique échouée:', retryErr?.message || retryErr);
        });
      }, 5_000);
    }
  });
});

player.on('error', (err) => {
  console.error('Erreur du lecteur audio:', err);
  currentResource = null;
  if (!autoPlaybackDesired) {
    return;
  }
  setTimeout(() => {
    autoStartPlayback({ reason: 'player-error' }).catch((error) => {
      console.error('Redémarrage automatique après erreur échoué:', error?.message || error);
    });
  }, 1500);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith('--')) return;

  if (!isAuthorizedUser(msg)) {
    return sendWithAutoDelete(msg.channel, '❌ Tu n\'es pas autorisé à utiliser ce bot.');
  }

  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];

  try {
    if (cmd === '--help') {
      return msg.channel.send(COMMANDS_HELP_MESSAGE);
    }

    else if (cmd === '--join-vocal') {
      const member = msg.member;
      if (!member || !member.voice || !member.voice.channel) {
        return sendWithAutoDelete(msg.channel, 'Rejoins un salon vocal puis relance la commande.');
      }
      const channel = member.voice.channel;
      try {
        await connectToVoiceChannel(channel, { autoStartPlayback: true, announceChannel: msg.channel });
      } catch (err) {
        console.error('Connexion vocale impossible:', err);
        return sendWithAutoDelete(
          msg.channel,
          `❌ Impossible de rejoindre le salon vocal (${err.message || err}).`
        );
      }
      return sendWithAutoDelete(
        msg.channel,
        `🔊 Rejoint le salon vocal **${channel.name}**. Lecture automatique en cours.`
      );
    }

    else if (cmd === '--start-music') {
      try {
        await ensureVoiceConnection({ msg, autoPlayOnJoin: false, announceChannel: msg.channel });
      } catch (err) {
        return sendWithAutoDelete(
          msg.channel,
          `❌ ${err.message || 'Impossible de préparer la connexion vocale.'}`
        );
      }

      const source = arg || null;
      try {
        await loadAndPlayTrack({ customUrl: source, announceChannel: msg.channel, reason: 'manual' });
      } catch (err) {
        return sendWithAutoDelete(
          msg.channel,
          `❌ Impossible de démarrer la lecture (${err.message || err}).`
        );
      }
      return;
    }

    else if (cmd === '--skip-music') {
      try {
        await ensureVoiceConnection({ msg, autoPlayOnJoin: false, announceChannel: msg.channel });
      } catch (err) {
        return sendWithAutoDelete(
          msg.channel,
          `❌ ${err.message || 'Impossible de préparer la connexion vocale.'}`
        );
      }

      autoPlaybackDesired = true;
      manualStopInProgress = false;
      playbackRequestToken++;

      if (loadingTrackPromise) {
        loadingTrackPromise.catch(() => {});
        loadingTrackPromise = null;
      }

      skipInProgressCount++;
      try {
        const status = player?.state?.status;
        if (
          status === AudioPlayerStatus.Playing ||
          status === AudioPlayerStatus.Buffering ||
          status === AudioPlayerStatus.Paused
        ) {
          try {
            player.stop(true);
          } catch (stopErr) {
            console.warn('Arrêt du lecteur avant le skip impossible:', stopErr?.message || stopErr);
          }
        }

        sendWithAutoDelete(msg.channel, '⏭️ Passage à la piste suivante...', { suppressErrors: true });

        await loadAndPlayTrack({ customUrl: null, announceChannel: msg.channel, reason: 'manual-skip' });
      } catch (err) {
        console.error('Saut de piste échoué:', err);
        try {
          await sendWithAutoDelete(
            msg.channel,
            `❌ Impossible de passer à la piste suivante (${err.message || err}).`,
            { suppressErrors: true }
          );
        } catch (sendErr) {}
        return;
      } finally {
        skipInProgressCount = Math.max(0, skipInProgressCount - 1);
      }

      return;
    }

    else if (cmd === '--stop-music') {
      autoPlaybackDesired = false;
      manualStopInProgress = true;
      if (loadingTrackPromise) {
        loadingTrackPromise.catch(() => {});
        loadingTrackPromise = null;
      }
      player.stop();
      if (voiceConnection) {
        try { voiceConnection.destroy(); } catch(e){}
        voiceConnection = null;
        currentVoiceChannel = null;
      }
      currentResource = null;
      lastTrackInfo = null;
      return sendWithAutoDelete(msg.channel, '⏹ Musique arrêtée et déconnectée.');
    }

    else if (cmd === '--change-music-tag') {
      const requestedTagRaw = parts.slice(1).join(' ');
      if (!requestedTagRaw) {
        return sendWithAutoDelete(
          msg.channel,
          `🎶 Tag Jamendo actuel : **${currentJamendoTag}**. Usage: --change-music-tag <tag>`
        );
      }
      const sanitizedTag = sanitizeMusicTag(requestedTagRaw);
      if (!sanitizedTag) {
        return sendWithAutoDelete(msg.channel, '❌ Tag invalide. Exemple: --change-music-tag jazz');
      }
      if (sanitizedTag === currentJamendoTag) {
        return sendWithAutoDelete(
          msg.channel,
          `ℹ️ Le style est déjà défini sur **${currentJamendoTag}**.`
        );
      }
      currentJamendoTag = sanitizedTag;
      lastTrackInfo = null;
      return sendWithAutoDelete(
        msg.channel,
        `🎼 Style Jamendo défini sur **${currentJamendoTag}**. Utilise --skip-music pour passer directement sur ce style.`
      );
    }

    else if (cmd === '--change-volume') {
      const extraArgs = parts.slice(1);
      const voiceChannel = currentVoiceChannel;
      const memberCount = voiceChannel ? countRelevantVoiceMembers(voiceChannel) : null;
      let participantsText = '';
      if (memberCount !== null) {
        if (memberCount === 0) {
          participantsText = ', basé sur aucune personne connectée';
        } else {
          const plural = memberCount > 1 ? 's' : '';
          participantsText = `, basé sur ${memberCount} personne${plural} connectée${plural}`;
        }
      }
      const lines = [];
      if (extraArgs.length > 0) {
        lines.push('⚠️ Le volume est désormais géré automatiquement ; la valeur fournie est ignorée.');
      }
      lines.push(
        `🔉 Volume automatique actuel: ${(currentVolume * 100).toFixed(1)}%${participantsText}.`
      );
      lines.push(
        `ℹ️ Le volume s'ajuste entre ${MIN_AUTO_VOLUME_PERCENT}% et ${MAX_AUTO_VOLUME_PERCENT}% (jusqu'à ${AUTO_VOLUME_MAX_MEMBERS} personnes).`
      );
      return sendWithAutoDelete(msg.channel, lines.join('\n'));
    }
  } catch (err) {
    console.error('Commande erreur:', err);
    sendWithAutoDelete(msg.channel, 'Erreur: ' + (err.message || String(err)), { suppressErrors: true });
  }
});

client.login(BOT_TOKEN).catch(err => {
  console.error('Impossible de se connecter:', err);
});
