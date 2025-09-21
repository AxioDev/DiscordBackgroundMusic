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

let opusEncoderAvailable = false;
try {
  require('@discordjs/opus');
  opusEncoderAvailable = true;
} catch (opusErr) {
  try {
    require('opusscript');
    opusEncoderAvailable = true;
  } catch (opusscriptErr) {
    const detail = opusErr?.message || opusscriptErr?.message || 'unknown error';
    console.error(
      'Aucun encodeur Opus détecté. Installe @discordjs/opus (recommandé) ou opusscript pour pouvoir encoder l\'audio.\n' +
      `Détail: ${detail}`
    );
    process.exit(1);
  }
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
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const fetch = require('node-fetch'); // node 18+ peut utiliser global fetch
const BOT_TOKEN = process.env.BOT_TOKEN;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const AUTO_GUILD_ID = process.env.GUILD_ID || null;
const AUTO_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || null;

if (!BOT_TOKEN || !JAMENDO_CLIENT_ID) {
  console.error('Définis BOT_TOKEN et JAMENDO_CLIENT_ID dans les variables d\'env.');
  process.exit(1);
}

const client = new Client({
    
});

let voiceConnection = null;
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let currentResource = null;
let currentVolume = 0.05; // 5% par défaut

client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);

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
