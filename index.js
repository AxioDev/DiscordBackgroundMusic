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

const http = require('node:http');
const { URL } = require('node:url');
const { Client, GatewayIntentBits } = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior
} = require('@discordjs/voice');
const fetch = require('node-fetch'); // node 18+ peut utiliser global fetch
const BOT_TOKEN = process.env.BOT_TOKEN;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const AUTO_GUILD_ID = process.env.GUILD_ID || null;
const AUTO_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || null;
const VOICE_API_PORT = Number.parseInt(
  process.env.VOICE_API_PORT || process.env.API_PORT || process.env.PORT || '3000',
  10
);
const VOICE_API_HOST = process.env.VOICE_API_HOST || '0.0.0.0';

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

const trackedVoiceUsers = new Map();
const trackedVoiceContext = {
  guildId: AUTO_GUILD_ID,
  channelId: AUTO_VOICE_CHANNEL_ID,
  guildName: null,
  channelName: null,
  hydrated: false,
  lastSyncedAt: null
};
let voiceApiServer = null;

function isVoiceLikeChannel(channel) {
  if (!channel) return false;
  const voiceTypes = new Set([
    2,
    13,
    15,
    'GUILD_VOICE',
    'GUILD_STAGE_VOICE',
    'VOICE',
    'STAGE_VOICE'
  ]);
  return voiceTypes.has(channel.type);
}

function voiceStateToPayload(voiceState) {
  if (!voiceState) return null;
  const member = voiceState.member || null;
  const user = member?.user || client.users.cache.get(voiceState.id) || null;
  return {
    id: voiceState.id,
    username: user?.username || null,
    discriminator: user?.discriminator || null,
    globalName: user?.globalName || null,
    displayName: member?.displayName || user?.username || null,
    nick: member?.nickname || null,
    deaf: Boolean(voiceState.deaf || voiceState.serverDeaf),
    mute: Boolean(voiceState.mute || voiceState.serverMute),
    selfDeaf: Boolean(voiceState.selfDeaf),
    selfMute: Boolean(voiceState.selfMute),
    streaming: Boolean(voiceState.streaming),
    video: Boolean(voiceState.selfVideo),
    suppressed: Boolean(voiceState.suppress)
  };
}

function fallbackMemberSnapshot(member) {
  if (!member) return null;
  const user = member.user || client.users.cache.get(member.id) || null;
  const voice = member.voice || null;
  return {
    id: member.id,
    username: user?.username || null,
    discriminator: user?.discriminator || null,
    globalName: user?.globalName || null,
    displayName: member.displayName || user?.username || null,
    nick: member.nickname || null,
    deaf: Boolean(voice?.deaf || voice?.serverDeaf),
    mute: Boolean(voice?.mute || voice?.serverMute),
    selfDeaf: Boolean(voice?.selfDeaf),
    selfMute: Boolean(voice?.selfMute),
    streaming: Boolean(voice?.streaming),
    video: Boolean(voice?.selfVideo),
    suppressed: Boolean(voice?.suppress)
  };
}

async function syncTrackedVoiceUsers(guildId, channelId, { force = false } = {}) {
  if (!client.isReady()) {
    throw new Error('Client Discord pas prêt.');
  }
  if (!guildId || !channelId) {
    trackedVoiceUsers.clear();
    trackedVoiceContext.guildId = guildId || null;
    trackedVoiceContext.channelId = channelId || null;
    trackedVoiceContext.hydrated = false;
    trackedVoiceContext.guildName = null;
    trackedVoiceContext.channelName = null;
    trackedVoiceContext.lastSyncedAt = null;
    return null;
  }

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    trackedVoiceUsers.clear();
    trackedVoiceContext.guildId = guildId;
    trackedVoiceContext.channelId = channelId;
    trackedVoiceContext.hydrated = false;
    trackedVoiceContext.guildName = null;
    trackedVoiceContext.channelName = null;
    trackedVoiceContext.lastSyncedAt = null;
    throw new Error(`Guilde introuvable (${err?.message || err}).`);
  }

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (err) {
    trackedVoiceUsers.clear();
    trackedVoiceContext.guildId = guild.id;
    trackedVoiceContext.channelId = channelId;
    trackedVoiceContext.hydrated = false;
    trackedVoiceContext.guildName = guild.name || null;
    trackedVoiceContext.channelName = null;
    trackedVoiceContext.lastSyncedAt = null;
    throw new Error(`Salon introuvable (${err?.message || err}).`);
  }

  if (!isVoiceLikeChannel(channel)) {
    throw new Error('Le salon ciblé n\'est pas un salon vocal.');
  }

  if (force) {
    try {
      await guild.members.fetch({ withPresences: false });
    } catch (err) {
      console.warn('Impossible de rafraîchir tous les membres de la guilde:', err?.message || err);
    }
  }

  trackedVoiceUsers.clear();
  trackedVoiceContext.guildId = guild.id;
  trackedVoiceContext.channelId = channel.id;
  trackedVoiceContext.guildName = guild.name || null;
  trackedVoiceContext.channelName = channel.name || null;
  trackedVoiceContext.hydrated = true;
  trackedVoiceContext.lastSyncedAt = Date.now();

  const voiceStates = guild.voiceStates.cache;
  for (const state of voiceStates.values()) {
    if (state.channelId === channel.id) {
      const payload = voiceStateToPayload(state);
      if (payload) {
        trackedVoiceUsers.set(payload.id, payload);
      }
    }
  }

  if (channel.members?.size) {
    for (const member of channel.members.values()) {
      if (!member) continue;
      if (member.voice?.channelId !== channel.id) continue;
      if (!trackedVoiceUsers.has(member.id)) {
        let payload = null;
        try {
          const fetchedState = await guild.voiceStates.fetch(member.id, { force: true });
          payload = voiceStateToPayload(fetchedState);
        } catch (err) {
          payload = fallbackMemberSnapshot(member);
        }
        if (payload) {
          trackedVoiceUsers.set(member.id, payload);
        }
      }
    }
  }

  return { guild, channel };
}

function handleVoiceStateUpdate(oldState, newState) {
  if (!trackedVoiceContext.guildId || !trackedVoiceContext.channelId) {
    return;
  }

  const relevantGuild = trackedVoiceContext.guildId;
  const relevantChannel = trackedVoiceContext.channelId;

  if (oldState && oldState.guild?.id === relevantGuild && oldState.channelId === relevantChannel) {
    if (!newState || newState.channelId !== relevantChannel || newState.guild?.id !== relevantGuild) {
      trackedVoiceUsers.delete(oldState.id);
      trackedVoiceContext.lastSyncedAt = Date.now();
    }
  }

  if (newState && newState.guild?.id === relevantGuild && newState.channelId === relevantChannel) {
    const payload = voiceStateToPayload(newState);
    if (payload) {
      trackedVoiceUsers.set(payload.id, payload);
      trackedVoiceContext.lastSyncedAt = Date.now();
    }
  }
}

client.on('voiceStateUpdate', handleVoiceStateUpdate);

function buildVoiceUsersResponse({ refreshed }) {
  return {
    guildId: trackedVoiceContext.guildId,
    guildName: trackedVoiceContext.guildName,
    channelId: trackedVoiceContext.channelId,
    channelName: trackedVoiceContext.channelName,
    count: trackedVoiceUsers.size,
    users: Array.from(trackedVoiceUsers.values()),
    lastSyncedAt: trackedVoiceContext.lastSyncedAt
      ? new Date(trackedVoiceContext.lastSyncedAt).toISOString()
      : null,
    refreshed: Boolean(refreshed)
  };
}

async function voiceUsersRequestHandler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Requête invalide.' }));
    return;
  }

  if (method !== 'GET' || requestUrl.pathname !== '/api/voice/users') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const guildIdParam = requestUrl.searchParams.get('guildId');
  const channelIdParam = requestUrl.searchParams.get('channelId');
  const refreshParam = requestUrl.searchParams.get('refresh');

  const guildId = guildIdParam || trackedVoiceContext.guildId || AUTO_GUILD_ID || null;
  let channelId = channelIdParam || trackedVoiceContext.channelId || AUTO_VOICE_CHANNEL_ID || null;
  if (!channelId && voiceConnection?.joinConfig?.channelId) {
    channelId = voiceConnection.joinConfig.channelId;
  }

  if (!guildId || !channelId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'guildId et channelId sont requis.' }));
    return;
  }

  const needRefresh =
    refreshParam === '1' ||
    refreshParam === 'true' ||
    trackedVoiceContext.guildId !== guildId ||
    trackedVoiceContext.channelId !== channelId ||
    !trackedVoiceContext.hydrated;

  try {
    if (needRefresh) {
      await syncTrackedVoiceUsers(guildId, channelId, { force: true });
    }
    const body = JSON.stringify(buildVoiceUsersResponse({ refreshed: needRefresh }));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err?.message || String(err) }));
  }
}

function ensureVoiceApiServer() {
  if (voiceApiServer || Number.isNaN(VOICE_API_PORT)) {
    return;
  }
  voiceApiServer = http.createServer((req, res) => {
    voiceUsersRequestHandler(req, res).catch((err) => {
      console.error('Erreur API voix:', err);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Erreur interne du serveur.' }));
      } catch (writeErr) {
        console.error('Impossible de répondre à la requête API voix:', writeErr);
      }
    });
  });

  voiceApiServer.on('error', (err) => {
    console.error('Serveur API voix erreur:', err?.message || err);
  });

  voiceApiServer.listen(VOICE_API_PORT, VOICE_API_HOST, () => {
    console.log(`Serveur API voix démarré sur http://${VOICE_API_HOST}:${VOICE_API_PORT}/api/voice/users`);
  });
}

client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);

  ensureVoiceApiServer();

  if (AUTO_GUILD_ID && AUTO_VOICE_CHANNEL_ID) {
    try {
      await syncTrackedVoiceUsers(AUTO_GUILD_ID, AUTO_VOICE_CHANNEL_ID, { force: true });
    } catch (err) {
      console.warn('Impossible de synchroniser la liste vocale au démarrage:', err?.message || err);
    }
  }

  // Si GUILD_ID + VOICE_CHANNEL_ID fournis -> tenter auto-join
  if (AUTO_GUILD_ID && AUTO_VOICE_CHANNEL_ID) {
    try {
      // s'assurer que la guild est disponible
      const guild = await client.guilds.fetch(AUTO_GUILD_ID);
      const channel = await guild.channels.fetch(AUTO_VOICE_CHANNEL_ID);

      if (!channel || channel.type !== 2 && channel.type !== 'GUILD_VOICE' && channel.type !== 'GUILD_STAGE_VOICE') {
        console.warn('Le channel spécifié n\'est pas un salon vocal ou est introuvable.');
        return;
      }

      voiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator || channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      console.log(`Auto-join : salon vocal ${channel.name} (${channel.id}) sur la guilde ${guild.name} (${guild.id})`);

      try {
        await syncTrackedVoiceUsers(guild.id, channel.id, { force: false });
      } catch (syncErr) {
        console.warn('Impossible de synchroniser la liste vocale après auto-join:', syncErr?.message || syncErr);
      }
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
      // rejoint le salon vocal de l'auteur du message
      const member = msg.member;
      if (!member || !member.voice || !member.voice.channel) return msg.channel.send('Rejoins un salon vocal puis relance la commande.');
      const channel = member.voice.channel;
      voiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });
      try {
        await syncTrackedVoiceUsers(channel.guild.id, channel.id, { force: true });
      } catch (err) {
        console.warn('Impossible de synchroniser la liste vocale après --join-vocal:', err?.message || err);
      }
      return msg.channel.send(`🔊 Rejoint le salon vocal **${channel.name}**.`);
    }

    else if (cmd === '--start-music') {
      // Si pas connecté, tente d'utiliser la connexion auto (env) sinon tente de joindre l'auteur
      if (!voiceConnection) {
        if (AUTO_GUILD_ID && AUTO_VOICE_CHANNEL_ID) {
          // si env présentes mais pas connectées (peut-être join échoué au démarrage), tenter à nouveau
          try {
            const guild = await client.guilds.fetch(AUTO_GUILD_ID);
            const channel = await guild.channels.fetch(AUTO_VOICE_CHANNEL_ID);
            voiceConnection = joinVoiceChannel({
              channelId: channel.id,
              guildId: guild.id,
              adapterCreator: channel.guild.voiceAdapterCreator,
              selfDeaf: false,
              selfMute: false
            });
          } catch (err) {
            // ignore, on essayera de joindre l'auteur ensuite
          }
        }

        if (!voiceConnection) {
          const member = msg.member;
          if (!member || !member.voice || !member.voice.channel) {
            return msg.channel.send('Pas de connexion vocale : utilise --join-vocal ou définis GUILD_ID + VOICE_CHANNEL_ID en env.');
          }
          const channel = member.voice.channel;
          voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
          });
        }
      }

      if (voiceConnection?.joinConfig?.guildId && voiceConnection.joinConfig.channelId) {
        try {
          await syncTrackedVoiceUsers(
            voiceConnection.joinConfig.guildId,
            voiceConnection.joinConfig.channelId,
            { force: false }
          );
        } catch (err) {
          console.warn('Impossible de synchroniser la liste vocale après --start-music:', err?.message || err);
        }
      }

      // support : --start-music <url> ou fallback sur Jamendo
      const source = arg;
      let resource;
      if (source) {
        // si c'est un URL, stream direct via fetch/ytdl selon type (ici on traite comme URL mp3)
        try {
          const remoteStream = await fetchAudioStream(source, 'la source fournie');
          resource = createAudioResource(remoteStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        } catch (err) {
          return msg.channel.send(`Impossible de récupérer la source fournie (${err.message}).`);
        }
      } else {
        // récupérer une piste Jamendo
        const { stream: remoteStream, info: trackInfo } = await getJamendoAmbientTrackStream();
        resource = createAudioResource(remoteStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        // on peut informer l'utilisateur
        const licensePart = trackInfo.licenseUrl ? ` (license: ${trackInfo.licenseUrl})` : '';
        msg.channel.send(`▶️ Lecture préparée : **${trackInfo.name}** — ${trackInfo.artist}${licensePart}`).catch(()=>{});
      }

      if (resource.volume) resource.volume.setVolume(currentVolume);
      currentResource = resource;
      player.play(resource);
      voiceConnection.subscribe(player);
      return msg.channel.send(`▶️ Lecture démarrée (volume ${(currentVolume*100).toFixed(0)}%).`);
    }

    else if (cmd === '--stop-music') {
      player.stop();
      if (voiceConnection) {
        try { voiceConnection.destroy(); } catch(e){}
        voiceConnection = null;
      }
      currentResource = null;
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
