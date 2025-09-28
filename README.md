# Discord Background Music Bot

This project runs a self-hosted Discord music helper that can automatically join a voice channel and stream "atmo" tracks from Jamendo.

## Requirements

- Node.js 20 or newer (a recent LTS works, even though `@discordjs/voice@0.19` currently warns about Node versions <22).
- FFmpeg available in your PATH (installed automatically in the Docker image).
- A Discord user token and a Jamendo API client ID exported as environment variables `BOT_TOKEN` and `JAMENDO_CLIENT_ID`.
- One Opus encoder implementation. The project now ships with the pure JavaScript `opusscript` fallback so that builds succeed without compiling native modules, but you can optionally add `@discordjs/opus` for better performance when your environment supports it.

## Installation

```bash
npm install
```

## Running locally

Set the required environment variables and start the bot:

```bash
export BOT_TOKEN="<your discord token>"
export JAMENDO_CLIENT_ID="<your jamendo client id>"
node index.js
```

Optional environment variables `GUILD_ID` and `VOICE_CHANNEL_ID` let the bot auto-join a voice channel on startup. You can also
set `JAMENDO_MUSIC_TAG` to choose the default Jamendo style (defaults to `atmo`). The music tag can be changed at runtime in
Discord with the `--change-music-tag <tag>` command. Playback starts at 1% volume by default; override this by exporting
`DEFAULT_VOLUME_PERCENT` (any value between 0 and 200).

Use `--start-music <url>` to stream a custom audio source. The bot understands direct audio links as well as YouTube URLs.
When streaming YouTube, the bot now sends a consent cookie by default so that regions requiring GDPR consent do not return HTTP
410 errors. Override the cookie value with `YOUTUBE_CONSENT_COOKIE` if you need a different one or want to provide a full `CONSENT`
string from your own browser session.

## Docker

A Dockerfile and docker-compose.yml are included. Build and run with:

```bash
docker compose up --build
```

Mount a persistent `music_cache` directory if you plan to cache downloaded audio.
