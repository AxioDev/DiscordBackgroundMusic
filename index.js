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

if (!BOT_TOKEN || !JAMENDO_CLIENT_ID) {
  console.error('Définis BOT_TOKEN et JAMENDO_CLIENT_ID dans les variables d\'env.');
  process.exit(1);
}

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
let currentVolume = 0.05; // 5% par défaut
let lastTrackInfo = null;
let manualStopInProgress = false;
let autoPlaybackDesired = false;
let loadingTrackPromise = null;
let lastAnnounceChannel = null;
let playbackRequestToken = 0;
let skipInProgressCount = 0;

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

// Recherche une piste "ambient" sur Jamendo en privilégiant celles dont le téléchargement est autorisé
async function getJamendoAmbientTrackStream() {
  const searchParams = new URLSearchParams({
    client_id: JAMENDO_CLIENT_ID,
    format: 'json',
    limit: '20',
    order: 'popularity_total_desc',
    tags: 'ambient',
    audioformat: 'mp32'
  });
  const url = `https://api.jamendo.com/v3.0/tracks/?${searchParams.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jamendo API error ${res.status}`);
  const j = await res.json();
  if (!j.results || j.results.length === 0) throw new Error('Aucune piste trouvée sur Jamendo.');

  let lastStreamError = null;

  for (const track of j.results) {
    if (!track || !track.audio) continue;
    if (track.audiodownload_allowed === false) continue; // piste non téléchargeable => éviter les 404

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
          licenseUrl
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
        licenseUrl: null
      };
    } else {
      const jamendoData = await getJamendoAmbientTrackStream();
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
      effectiveAnnounceChannel.send(message.trim()).catch(() => {});
    } else if (trackInfo) {
      console.log(`${prefix} : ${trackInfo.name} — ${trackInfo.artist}`);
    }

    return trackInfo;
  })();

  const trackedPromise = loadTask
    .catch((err) => {
      if (effectiveAnnounceChannel && typeof effectiveAnnounceChannel.send === 'function') {
        effectiveAnnounceChannel.send(`❌ Impossible de démarrer la lecture (${err.message || err}).`).catch(() => {});
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

  const effectiveAnnounceChannel = announceChannel || lastAnnounceChannel || null;
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
    return msg.channel.send('❌ Tu n\'es pas autorisé à utiliser ce bot.');
  }

  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];

  try {
    if (cmd === '--join-vocal') {
      const member = msg.member;
      if (!member || !member.voice || !member.voice.channel) {
        return msg.channel.send('Rejoins un salon vocal puis relance la commande.');
      }
      const channel = member.voice.channel;
      try {
        await connectToVoiceChannel(channel, { autoStartPlayback: true, announceChannel: msg.channel });
      } catch (err) {
        console.error('Connexion vocale impossible:', err);
        return msg.channel.send(`❌ Impossible de rejoindre le salon vocal (${err.message || err}).`);
      }
      return msg.channel.send(`🔊 Rejoint le salon vocal **${channel.name}**. Lecture automatique en cours.`);
    }

    else if (cmd === '--start-music') {
      try {
        await ensureVoiceConnection({ msg, autoPlayOnJoin: false, announceChannel: msg.channel });
      } catch (err) {
        return msg.channel.send(`❌ ${err.message || 'Impossible de préparer la connexion vocale.'}`);
      }

      const source = arg || null;
      try {
        await loadAndPlayTrack({ customUrl: source, announceChannel: msg.channel, reason: 'manual' });
      } catch (err) {
        return msg.channel.send(`❌ Impossible de démarrer la lecture (${err.message || err}).`);
      }
      return;
    }

    else if (cmd === '--skip-music') {
      try {
        await ensureVoiceConnection({ msg, autoPlayOnJoin: false, announceChannel: msg.channel });
      } catch (err) {
        return msg.channel.send(`❌ ${err.message || 'Impossible de préparer la connexion vocale.'}`);
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

        msg.channel.send('⏭️ Passage à la piste suivante...').catch(() => {});

        await loadAndPlayTrack({ customUrl: null, announceChannel: msg.channel, reason: 'manual-skip' });
      } catch (err) {
        console.error('Saut de piste échoué:', err);
        try {
          await msg.channel.send(`❌ Impossible de passer à la piste suivante (${err.message || err}).`);
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
      return msg.channel.send('⏹ Musique arrêtée et déconnectée.');
    }

    else if (cmd === '--change-volume') {
      const pct = parseFloat(arg);
      if (isNaN(pct)) return msg.channel.send('Usage: --change-volume 80 (pour 80%)');
      let vol = Math.max(0, Math.min(200, pct)) / 100;
      currentVolume = vol;
      if (currentResource && currentResource.volume) currentResource.volume.setVolume(currentVolume);
      return msg.channel.send(`🔉 Volume réglé à ${(currentVolume*100).toFixed(0)}%`);
    }
  } catch (err) {
    console.error('Commande erreur:', err);
    try { msg.channel.send('Erreur: ' + (err.message || String(err))); } catch(e){}
  }
});

client.login(BOT_TOKEN).catch(err => {
  console.error('Impossible de se connecter:', err);
});
