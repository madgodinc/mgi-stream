# mgi-stream

Reads your TikTok LIVE chat out loud, into OBS, from your own machine.

![mgi-stream reading a chat](docs/screenshot.png)

Interface in Russian and English, switch in the top right corner.

TikFinity does this as a hosted service you do not control. mgi-stream does the same job as a Windows app that runs on your PC: it joins the live chat, drops what should not be spoken, synthesizes each message with Microsoft Edge neural voices, and plays it through a page you add to OBS as a browser source.

## Install

**[Download the installer](https://github.com/madgodinc/mgi-stream/releases/latest/download/mgi-stream-setup.exe)** and run it. That is the entire installation.

Nothing else has to be on the machine. The app ships with its own runtime, all seventy of its packages included, so a PC that has never had Node or npm on it runs this fine. There is also a [portable build](https://github.com/madgodinc/mgi-stream/releases/latest/download/mgi-stream-portable.exe) that skips the installer too, and [older versions](../../releases) if you need one.

The build is not code-signed, so SmartScreen shows a warning the first time: **More info → Run anyway**.

Cloning this repository is for changing the app, not for running it. That path does need Node, and it is described at the bottom.

## Use it

1. Type the channel name. `@yourname`, `yourname`, or a pasted `tiktok.com/@yourname/live` link all work. This is the account whose live chat gets read.
2. Pick a voice, set speed and pitch, hit **test voice**. Four presets cover the common cases (Russian and English, male and female); the dropdown below them holds every voice Edge offers.
3. Press **go on air**. Speech comes out of the app window right away, so you can hear it working before OBS is involved.
4. For the stream itself, in OBS add **Source → Browser**, paste the URL from the bottom bar (`http://localhost:8099`), size it 900x600.

Speech then arrives on its own OBS audio track with its own volume slider. Nothing else on your desktop goes into it. If you only want it in the stream and not in your own ears, turn off **play sound in this window too**.

**Demo chat** replays sample messages so you can set the voice up before you ever go live.

### Press it before you go live

The room does not have to exist yet. If the channel is not streaming, the app sits in **waiting** and connects by itself the moment the stream starts. The same applies while it is running: a dropped socket or an ended room puts it back into waiting rather than stopping it, which matters because TikTok drops mobile streams often. Only a channel name that does not exist stops the run outright.

### No TikTok login

You never sign in. The app joins the public chat of a live room the same way a viewer's browser does, so all it needs is the channel name. Nothing is posted, nothing is read from your account, and no password or session cookie is stored anywhere.

One thing follows from that: you can point the app at somebody else's stream just as easily as your own.

## What gets read

Chat moves faster than anyone can talk, so the useful part of this app is what it refuses to say.

**Audience.** Everyone, followers only, subscribers only, moderators only, or nobody except the names you list. The tier comes from the viewer flags TikTok attaches to each message, not from a guess.

**A prefix.** Turn it on and only messages that start with `!` get read. Any character works. The prefix itself is not spoken.

**Lists.** *Always read* passes a name through no matter which audience tier is set. *Never read* silences a name entirely.

**Noise.** Emoji-only messages, links, and anything shorter than two characters are dropped by default. Long messages are cut instead of read to the end.

Every filtered message still shows up in the app, greyed out with the reason next to the nickname, so nothing disappears silently.

All of this can be changed mid-stream. Tightening the audience or switching the voice takes effect on the next message, without going off air. The channel name and the overlay port are the two that still need a restart.

## Why the queue has a limit

Chat produces messages faster than speech plays them back. An unbounded queue puts the voice minutes behind the picture, and it never catches up. The queue caps at a depth you choose and drops the oldest pending message when it overflows, which keeps the audio close to what is happening on screen. The footer shows the current depth and how many were dropped.

## How it works

```
TikTok LIVE ──▶ filter ──▶ queue ──▶ Edge neural TTS ──▶ WebSocket ──▶ OBS browser source
  (webcast)     who/what    capped      mp3 per phrase                   plays in order
```

Everything runs in one Electron process on your machine. The local HTTP server exists only to feed the OBS overlay; it listens on localhost and serves one page.

Synthesis holds its socket open, so a phrase takes roughly 300 to 600 ms after the first one. The overlay keeps its own playback queue and starts the next clip on `ended`, which is what stops two messages from talking over each other.

## Limits

TikTok has no official realtime chat API. This uses [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector), which speaks the internal Webcast protocol, so a TikTok-side change can break the connection until that library catches up.

Joining a room is signed through EulerStream, whose free tier is rate limited per address. If connecting starts failing with a signature limit, put a free key in the **EulerStream key** field in settings. Most people never need to.

Speech comes from the public endpoint behind Edge Read Aloud. It costs nothing and needs no key, but it is an internet round trip per phrase and Microsoft can change it. Russian ships two voices, `ru-RU-DmitryNeural` and `ru-RU-SvetlanaNeural`; other languages have more. Moving to a local engine such as Piper or Silero means replacing `app/core/tts.js` alone, since the rest of the app only handles mp3 buffers.

Chat only. Gifts, follows, likes, alerts, and overlays are out of scope.

## Build from source

Only for working on the app. To simply use it, take the installer above instead.

```bash
npm install        # needs Node 22
npm start          # run the app
npm test           # filter rules
npm run dist       # dist/*.exe, installer and portable
```

`npm run dist` bundles Node, Chromium and every dependency into the two `.exe`
files, which is why the finished app needs nothing installed alongside it.

Settings live in `%APPDATA%/mgi-stream/config.json`.

## License

MIT
