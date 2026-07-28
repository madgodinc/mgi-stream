# mgi-stream

Reads your TikTok LIVE chat out loud, into OBS, from your own machine.

TikFinity does this as a hosted service you do not control. This does the same job in about 300 lines of Node: it connects to the live chat, filters out what should not be spoken, synthesizes each message with Microsoft Edge neural voices, and plays the audio from a page you add to OBS as a Browser Source.

No API key, no account, no cloud service in the middle.

## Quick start

```bash
npm install
cp config.example.json config.json   # then set "username" to your TikTok handle
npm start
```

Open `http://localhost:8099` and click once to allow sound. In OBS, add a **Browser Source** pointing at the same URL, 900x600, and the speech lands on its own audio track with its own volume slider.

To watch the pipeline work without going live:

```bash
npm run mock
```

## How it works

```
TikTok LIVE  ──▶  filter  ──▶  queue  ──▶  Edge neural TTS  ──▶  WebSocket  ──▶  browser source
  (webcast)      drop junk    cap depth      mp3 per phrase                      plays in order
```

The queue matters more than it looks. Chat arrives faster than speech plays back, so an unbounded queue puts the voice minutes behind the stream and it never recovers. `maxQueue` caps the depth and drops the oldest pending message, which keeps the audio close to what is happening on screen.

Synthesis runs one phrase at a time over a socket that is kept open, so a phrase takes roughly 300 to 600 ms after the first one. The browser holds its own playback queue and starts the next clip on `ended`, which is what keeps two messages from overlapping.

## Configuration

`config.json`, read once at startup.

| Key | Meaning |
| --- | --- |
| `username` | TikTok handle to listen to, with or without `@` |
| `voice` | Edge voice short name, for example `ru-RU-DmitryNeural` |
| `rate`, `pitch` | Prosody, for example `+8%` and `+0Hz` |
| `port` | HTTP and WebSocket port for the browser source |
| `sayNickname` | Read the author before the message |
| `nicknameTemplate` | Phrase around the nickname, `{nick}` is substituted |
| `maxChars` | Truncate longer messages |
| `minChars` | Skip shorter messages |
| `maxQueue` | Pending messages before the oldest gets dropped |
| `skipEmojiOnly` | Skip messages that are only emoji |
| `skipLinks` | Skip messages containing links |
| `ignoreUsers` | Nicknames never read out |
| `signApiKey` | Optional EulerStream key, needed only if signing gets rate limited |

To see the available voices:

```bash
npm run voices        # all of them
npm run voices ru     # one locale
```

Russian ships as `ru-RU-DmitryNeural` and `ru-RU-SvetlanaNeural`.

## Limits

TikTok has no official realtime chat API. This uses [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector), which speaks the internal Webcast protocol, so a TikTok-side change can break the connection until that library catches up.

Speech comes from the public endpoint behind Edge Read Aloud. It costs nothing and needs no key, but it is an internet round trip per phrase and Microsoft can change it. Swapping in a local engine such as Piper or Silero means replacing `tts.js` alone, since everything else works with mp3 buffers.

Chat only. Gifts, follows, likes, alerts, and overlays are out of scope here.

## License

MIT
