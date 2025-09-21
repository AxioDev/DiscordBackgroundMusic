const { Client, GatewayIntentBits } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const fetch = require('node-fetch'); // ou global fetch sur Node18+
const BOT_TOKEN = process.env.BOT_TOKEN;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
if (!BOT_TOKEN || !JAMENDO_CLIENT_ID) {
  console.error('Définis BOT_TOKEN et JAMENDO_CLIENT_ID');
  process.exit(1);
}

const client = new Client({  });

let voiceConnection = null;
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let currentResource = null;
let currentVolume = 0.05; // 5% par défaut (très bas)

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

async function getJamendoAmbientTrackUrl() {
  // On cherche une piste taggée "ambient" populaire (adaptable)
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}&format=json&limit=1&order=popularity_total_desc&tags=ambient&audioformat=mp32`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j.results || j.results.length === 0) throw new Error('Aucune piste trouvée');
  const track = j.results[0];
  // track.audio contient l'URL de stream; audiodownload contient download si autorisé
  if (!track.audio) throw new Error('Track sans champ audio');
  return { audioUrl: track.audio, name: track.name, artist: track.artist_name, license: track.license };
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith('--')) return;
  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];

  try {
    if (cmd === '--join-vocal') {
      const member = msg.member;
      if (!member || !member.voice.channel) return msg.channel.send('Rejoins d’abord un salon vocal.');
      const channel = member.voice.channel;
      voiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });
      msg.channel.send(`🔊 Rejoint ${channel.name}`);
    }

    else if (cmd === '--start-music') {
      if (!voiceConnection) {
        // try join the author's voice
        const member = msg.member;
        if (!member || !member.voice.channel) return msg.channel.send('Pas dans un vocal — utilise --join-vocal ou rejoins un vocal.');
        const channel = member.voice.channel;
        voiceConnection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });
      }

      const { audioUrl, name, artist, license } = await getJamendoAmbientTrackUrl();
      // stream the remote mp3
      const remoteRes = await fetch(audioUrl);
      if (!remoteRes.ok) throw new Error('Erreur fetch audio');
      const stream = remoteRes.body; // ReadableStream Node
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(currentVolume);
      currentResource = resource;
      player.play(resource);
      voiceConnection.subscribe(player);
      msg.channel.send(`▶️ Lecture : **${name}** — ${artist} (license: ${license})`);
    }

    else if (cmd === '--stop-music') {
      player.stop();
      if (voiceConnection) { try { voiceConnection.destroy(); } catch(_){} voiceConnection = null; }
      currentResource = null;
      msg.channel.send('⏹ Musique stoppée.');
    }

    else if (cmd === '--change-volume') {
      const pct = parseFloat(arg);
      if (isNaN(pct)) return msg.channel.send('Usage: --change-volume 80 (pour 80%)');
      let vol = Math.max(0, Math.min(200, pct)) / 100;
      currentVolume = vol;
      if (currentResource && currentResource.volume) currentResource.volume.setVolume(currentVolume);
      msg.channel.send(`🔉 Volume réglé à ${(currentVolume*100).toFixed(0)}%`);
    }
  } catch (err) {
    console.error(err);
    try { msg.channel.send('Erreur: ' + (err.message || String(err))); } catch(e){}
  }
});

client.login(BOT_TOKEN);
