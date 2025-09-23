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

const MESSAGE_DELETE_DELAY_MS = parseDeleteDelay(process.env.MESSAGE_DELETE_DELAY_MS, 1_000);

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

const ALLOWED_USER_ID = '216189520872210444';
const ALLOWED_ROLE_NAMES = ['Radio', 'Modo', 'Medium'];

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
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let currentResource = null;
let currentVolume = 0.01; // 1% par défaut
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

async function fetchAudioStream(url, label = 'source distante') {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'DiscordBackgroundMusicBot/1.0 (+https://github.com/DiscordBackgroundMusic/DiscordBackgroundMusic)',
      Accept: 'audio/*;q=0.9,*/*;q=0.5'
    }
  });
  if (!response.ok || !response.body) {
    const statusText = (response.statusText || '').trim();
    const statusInfo = statusText ? `${response.status} ${statusText}` : String(response.status);
    throw new Error(`Impossible de récupérer ${label} (${statusInfo})`);
  }
  return response.body;
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
  try {
    await waitForVoiceConnectionReady(connection);
    lastVoiceChannelId = channel.id;
  } catch (err) {
    voiceConnection = null;
    throw err;
  }

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

    if (customUrl) {
      remoteStream = await fetchAudioStream(customUrl, 'la source fournie');
      trackInfo = {
        name: 'Source fournie',
        artist: customUrl,
        audioUrl: customUrl,
        licenseUrl: null,
        tag: null
      };
    } else {
      const jamendoData = await getJamendoTrackStream();
      remoteStream = jamendoData.stream;
      trackInfo = jamendoData.info;
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

    const resource = createAudioResource(remoteStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
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
      if (!customUrl && trackInfo) {
        const licensePart = trackInfo.licenseUrl ? ` (licence: ${trackInfo.licenseUrl})` : '';
        message = `▶️ ${prefix} : **${trackInfo.name}** — ${trackInfo.artist}${licensePart} ${volumeInfo}`;
      } else if (customUrl) {
        message = `▶️ ${prefix} depuis la source fournie ${volumeInfo}`;
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
    if (cmd === '--join-vocal') {
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
      const pct = parseFloat(arg);
      if (isNaN(pct)) {
        return sendWithAutoDelete(msg.channel, 'Usage: --change-volume 80 (pour 80%)');
      }
      let vol = Math.max(0, Math.min(200, pct)) / 100;
      currentVolume = vol;
      if (currentResource && currentResource.volume) currentResource.volume.setVolume(currentVolume);
      return sendWithAutoDelete(
        msg.channel,
        `🔉 Volume réglé à ${(currentVolume*100).toFixed(0)}%`
      );
    }
  } catch (err) {
    console.error('Commande erreur:', err);
    sendWithAutoDelete(msg.channel, 'Erreur: ' + (err.message || String(err)), { suppressErrors: true });
  }
});

client.login(BOT_TOKEN).catch(err => {
  console.error('Impossible de se connecter:', err);
});
