<p align="center">
  <img width="250" height="250" src="https://raw.githubusercontent.com/museofficial/muse/master/.github/logo.png">
</p>

> [!IMPORTANT]
> Muse is now community-maintained under the [`museofficial`](https://github.com/museofficial) organization. For Docker, use `ghcr.io/museofficial/muse` as the canonical image source. Docker Hub tags may be published as compatibility mirrors, but GHCR is the supported target for new deployments.

------

Muse is a **highly-opinionated midwestern self-hosted** Discord music bot **that doesn't suck**. It's made for small to medium-sized Discord servers/guilds (think about a group the size of you, your friends, and your friend's friends).

![Hero graphic](.github/hero.png)

## Features

- 🎥 Livestreams
- ☁️ SoundCloud tracks, share links, and playlists
- ⏩ Seeking within a song/video
- 💾 Local caching for better performance
- 📋 No vote-to-skip - this is anarchy, not a democracy
- ↔️ Autoconverts playlists / artists / albums / songs from Spotify
- ⭐ Users can save favorite queries for reuse
- 1️⃣ Muse instance supports multiple guilds
- 🔊 Configurable volume controls, including optional ducking when people speak
- ✍️ Written in TypeScript, easily extendable
- ❤️ Loyal Packers fan

## Running

Muse is written in TypeScript. You can either run Muse with Docker (recommended) or directly with Node.js. Both methods require the Discord and YouTube API keys below. Spotify keys are optional and enable Spotify URL conversion:

- `DISCORD_TOKEN` can be acquired [here](https://discordapp.com/developers/applications) by creating a 'New Application', then going to 'Bot'.
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` can be acquired [here](https://developer.spotify.com/dashboard/applications) with 'Create a Client ID'.
- `YOUTUBE_API_KEY` can be acquired by [creating a new project](https://console.developers.google.com) in Google's Developer Console, enabling the YouTube API, and creating an API key under credentials.

Muse will log a URL when run. Open this URL in a browser to invite Muse to your server. Muse will DM the server owner after it's added with setup instructions.

A 64-bit OS is required to run Muse.

### Versioning

The `master` branch acts as the developing / bleeding edge branch and is not guaranteed to be stable.

When running a production instance, I recommend that you use the [latest release](https://github.com/museofficial/muse/releases/).


### 🐳 Docker

There are a variety of image tags available:
- `:2`: versions >= 2.0.0
- `:2.1`: versions >= 2.1.0 and < 2.2.0
- `:2.1.1`: an exact version specifier
- `:latest`: whatever the latest version is
- `:yt-dlp-latest`: the latest release rebuilt with the newest available `yt-dlp`

(Replace empty config strings with correct values.)

```bash
docker run -it -v "$(pwd)/data":/data -e DISCORD_TOKEN='' -e SPOTIFY_CLIENT_ID='' -e SPOTIFY_CLIENT_SECRET='' -e YOUTUBE_API_KEY='' ghcr.io/museofficial/muse:latest
```

This starts Muse and creates a data directory in your current directory.

You can also store your tokens in an environment file and make it available to your container. By default, the container will look for a `/config` environment file. You can customize this path with the `ENV_FILE` environment variable to use with, for example, [docker secrets](https://docs.docker.com/engine/swarm/secrets/). 

**Docker Compose**:

```yaml
services:
  muse:
    image: ghcr.io/museofficial/muse:latest
    restart: always
    volumes:
      - ./muse:/data
      # Optional: mount YouTube-only cookies for age-restricted videos.
      # - ./youtube-cookies.txt:/run/secrets/youtube-cookies.txt:ro
    environment:
      - DISCORD_TOKEN=
      - YOUTUBE_API_KEY=
      - SPOTIFY_CLIENT_ID=
      - SPOTIFY_CLIENT_SECRET=
      # - YT_DLP_COOKIES_PATH=/run/secrets/youtube-cookies.txt
```

#### Voice Commands In Docker

This checkout's Docker image always includes the Python wake-word and Whisper sidecar dependencies so you can turn voice commands on without maintaining a separate image variant.

The default build now uses a CUDA 12.4 torch wheel for Whisper:

```bash
docker build -t muse:voice .
```

That build also preloads the default `openWakeWord` assets and the configured Whisper model into the image, so the sidecar does not need a first-boot model download when you stick with the Docker defaults.

When you run the container, give it GPU access:

```bash
docker run --gpus all -it -v "$(pwd)/data":/data -e DISCORD_TOKEN='' -e SPOTIFY_CLIENT_ID='' -e SPOTIFY_CLIENT_SECRET='' -e YOUTUBE_API_KEY='' muse:voice
```

If your Docker host cannot expose an NVIDIA GPU to the container, override the torch install back to CPU:

```bash
docker build -t muse:voice-cpu \
  --build-arg VOICE_COMMANDS_TORCH_INSTALL="torch --index-url https://download.pytorch.org/whl/cpu" \
  .
```

If you want to bake a different Whisper checkpoint into the image, override `VOICE_COMMANDS_WHISPER_MODEL` at build time too:

```bash
docker build -t muse:voice-small \
  --build-arg VOICE_COMMANDS_WHISPER_MODEL=small.en \
  .
```

Then enable the feature with environment variables such as:

- `VOICE_COMMANDS_ENABLED=true`
- `VOICE_COMMANDS_AUTOSTART_SIDECAR=true`
- `VOICE_COMMANDS_WAKE_WORD=hey_jarvis`
- `VOICE_COMMANDS_WHISPER_MODEL=base.en`

If you want to keep Muse itself lighter, the cleaner Docker setup is to run the sidecar in a separate CUDA-enabled container and point Muse at it by setting:

- `VOICE_COMMANDS_AUTOSTART_SIDECAR=false`
- `VOICE_COMMANDS_SIDECAR_HOST=<sidecar-host>`
- `VOICE_COMMANDS_SIDECAR_PORT=<sidecar-port>`

The Dockerfile still accepts a `VOICE_COMMANDS_TORCH_INSTALL` build arg if you want to pin a different CUDA wheel. For example:

```bash
docker build -t muse:voice-gpu \
  --build-arg VOICE_COMMANDS_TORCH_INSTALL="torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124" \
  .
```

### Node.js

**Prerequisites**:
* Node.js 22.12.0 or newer
* ffmpeg (4.1 or later)
* `yt-dlp` on your `PATH` (or set `YT_DLP_PATH` to its full path)

1. `git clone https://github.com/museofficial/muse.git && cd muse`
2. Copy `.env.example` to `.env` and populate with values
3. I recommend checking out a tagged release with `git checkout v[latest release]`
4. `yarn install` (or `npm i`)
5. `yarn start` (or `npm run start`)

**Note**: if you're on Windows, you may need to manually set the ffmpeg path. See [#345](https://github.com/museofficial/muse/issues/345) for details.

### Local validation

Run the behavior suite locally with:

```bash
npm test
```

## ⚙️ Additional configuration (advanced)

### Cache

By default, Muse limits the total cache size to around 2 GB. If you want to change this, set the environment variable `CACHE_LIMIT`. For example, `CACHE_LIMIT=512MB` or `CACHE_LIMIT=10GB`.

### yt-dlp

Muse now uses `yt-dlp` to resolve playable YouTube media URLs. In Docker, the image already includes it. For direct Node.js installs, either put `yt-dlp` on your `PATH` or set `YT_DLP_PATH` in your environment file.

Muse logs `YT_DLP_VERSION` on startup. Set `YT_DLP_AUTO_UPDATE=true` to make Muse try to update the configured `yt-dlp` installation before connecting to Discord. This works best with the Docker image's bundled virtualenv, or when `YT_DLP_PATH` points at a virtualenv or standalone `yt-dlp` executable that Muse can update.

Age-restricted videos require cookies from an age-verified YouTube account. Export a YouTube-only Netscape cookie file using the [official yt-dlp guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies), mount it outside `/data`, and set `YT_DLP_COOKIES_PATH` to its container path. Treat this file like a password. Muse copies it to a private per-extraction temporary file because yt-dlp updates the cookie jar while it runs, so the mounted source may remain read-only and concurrent guilds do not share a writable cookie file.

Current YouTube extraction also requires a supported JavaScript runtime. The Docker image includes the matching `yt-dlp-ejs` package and uses its bundled Node.js runtime. Direct installs should install `yt-dlp[default]` and provide Node.js 22 or newer.

The `ghcr.io/museofficial/muse:yt-dlp-latest` image is rebuilt on a schedule from the latest Muse release with the newest `yt-dlp` published to PyPI. Versioned refresh tags are also published as `:<muse-version>-yt-dlp-<yt-dlp-version>`.

### SponsorBlock

Muse can skip non-music segments at the beginning or end of a Youtube music video (Using [SponsorBlock](https://sponsor.ajay.app/)). It is disabled by default. If you want to enable it, set the environment variable `ENABLE_SPONSORBLOCK=true` or uncomment it in your .env.
Being a community project, the server may be down or overloaded. When it happen, Muse will skip requests to SponsorBlock for a few minutes. You can change the skip duration by setting the value of `SPONSORBLOCK_TIMEOUT`.

### Custom Bot Status

In the default state, Muse has the status "Online" and the text "Listening to Music". You can change the status through environment variables:

- `BOT_STATUS`:
  - `online` (Online)
  - `idle` (Away)
  - `dnd` (Do not Disturb)

- `BOT_ACTIVITY_TYPE`:
  - `PLAYING` (Playing XYZ)
  - `LISTENING` (Listening to XYZ)
  - `WATCHING` (Watching XYZ)
  - `STREAMING` (Streaming XYZ)

- `BOT_ACTIVITY`: the text that follows the activity type

- `BOT_ACTIVITY_URL` If you use `STREAMING` you MUST set this variable, otherwise it will not work! Here you write a regular YouTube or Twitch Stream URL.

#### Examples

**Muse is watching a movie and is DND**:
- `BOT_STATUS=dnd`
- `BOT_ACTIVITY_TYPE=WATCHING`
- `BOT_ACTIVITY=a movie`

**Muse is streaming Monstercat**:
- `BOT_STATUS=online`
- `BOT_ACTIVITY_TYPE=STREAMING`
- `BOT_ACTIVITY_URL=https://www.twitch.tv/monstercat`
- `BOT_ACTIVITY=Monstercat`

### Bot-wide commands

If you have Muse running in a lot of guilds (10+) you may want to switch to registering commands bot-wide rather than for each guild. (The downside to this is that command updates can take up to an hour to propagate.) To do this, set the environment variable `REGISTER_COMMANDS_ON_BOT` to `true`.

### Automatically turn down volume when people speak

You can configure the bot to automatically turn down the volume when people are speaking in the channel using the following commands:

- `/config set-reduce-vol-when-voice true` - Enable automatic volume reduction
- `/config set-reduce-vol-when-voice false` - Disable automatic volume reduction
- `/config set-reduce-vol-when-voice-target <volume>` - Set the target volume percentage when people speak (0-100, default is 70)

### Voice Commands

Muse can now stream Discord receive audio to a small local Python sidecar over WebSockets for wake-word detection and Whisper transcription. The current implementation is designed around short commands such as `Jarvis, play darude sandstorm`, `Jarvis pause`, `Jarvis next`, `Jarvis resume`, `Jarvis clear`, and `Jarvis stop`.

Set the following environment variables to enable it:

- `VOICE_COMMANDS_ENABLED=true`
- `VOICE_COMMANDS_AUTOSTART_SIDECAR=true`
- `VOICE_COMMANDS_PYTHON_EXECUTABLE=python`
- `VOICE_COMMANDS_SIDECAR_HOST=127.0.0.1`
- `VOICE_COMMANDS_SIDECAR_PORT=8765`
- `VOICE_COMMANDS_WAKE_WORD=hey_jarvis`
- `VOICE_COMMANDS_WAKE_WORD_THRESHOLD=0.5`
- `VOICE_COMMANDS_WHISPER_MODEL=base.en`

Install the sidecar dependencies with:

```bash
python -m pip install -r voice-command-sidecar-requirements.txt
```

The Python sidecar lives at `src/scripts/voice-command-sidecar.py`. Muse owns the Discord receive connection, decodes and downsamples each speaker to 16 kHz mono, and streams frames to the sidecar. The sidecar only performs wake-word detection and Whisper transcription before sending the transcript back to Muse for command routing.

