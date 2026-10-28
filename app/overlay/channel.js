// Sound for the helper processes (see app/helper.js). The music window plays the
// track to the stream, the «Озвучка» window plays the chat voice to the stream,
// and the hidden headphone window plays both to the streamer's own device. Levels and devices come from the app over
// the same socket as everything else, as { kind: "audio" }.

const dataUrl = (b64) => `data:audio/${b64.startsWith("UklGR") ? "wav" : "mpeg"};base64,${b64}`;

/** Finds the output device by its name: ids differ between the app and this page. */
async function sinkFor(label) {
  if (!label) return "";
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return all.find((d) => d.kind === "audiooutput" && d.label === label)?.deviceId ?? "";
}

export function channel({ role }) {
  const monitor = role === "monitor";
  // «Озвучка»: the chat voice to the stream device at the stream level.
  const talker = role === "voice";
  const music = new Audio();
  const voice = new Audio();
  const voices = [];
  let levels = { voice: 100, voiceMonitor: 0, music: 70, musicMonitor: 0, duck: true, playInApp: true, streamDevice: "", monitorDevice: "" };
  let ducked = false;
  let current = null;
  let target = { position: 0, paused: false, at: 0 };

  function volume() {
    const m = (monitor ? levels.musicMonitor : levels.music) / 100;
    music.volume = Math.max(0, Math.min(1, ducked && levels.duck ? m * 0.3 : m));
    voice.volume = Math.max(0, Math.min(1, (talker ? levels.voice : levels.voiceMonitor) / 100));
  }

  async function route() {
    const id = await sinkFor(monitor ? levels.monitorDevice : levels.streamDevice);
    for (const el of [music, voice]) el.setSinkId?.(id).catch(() => el.setSinkId(""));
  }

  function speak() {
    if ((!monitor && !talker) || !voice.paused || !voices.length) return;
    const item = voices.shift();
    if (monitor && !levels.voiceMonitor) return speak();
    if (talker && (!levels.voice || !levels.playInApp)) return speak();
    voice.src = dataUrl(item.audio);
    voice.play().catch(() => speak());
  }
  voice.onended = voice.onerror = () => speak();

  // The app's window keeps the time; this one follows it, gently, since every
  // correction is a jump the listener hears.
  setInterval(() => {
    if (!current || !music.src) return;
    if (target.paused) return music.paused || music.pause();
    if (music.paused) music.play().catch(() => {});
    if (music.seeking || !music.duration) return;
    const want = target.position + (Date.now() - target.at) / 1000;
    if (Math.abs(music.currentTime - Math.min(want, music.duration - 0.1)) > 1) music.currentTime = Math.min(want, music.duration - 0.1);
  }, 500);

  return function onMessage(m) {
    if (m.kind === "audio") {
      levels = { ...levels, ...m };
      volume();
      route();
    } else if (m.kind === "duck") {
      ducked = m.on;
      volume();
    } else if (talker && m.kind.startsWith("music-")) {
      // the voice window carries the voice only
    } else if (m.kind === "music-play") {
      current = m.track;
      target = { position: m.track.start || 0, paused: false, at: Date.now() };
      music.src = m.src;
      music.currentTime = m.track.start || 0;
      volume();
      music.play().catch(() => {});
    } else if (m.kind === "music-stop") {
      current = null;
      music.pause();
      music.removeAttribute("src");
      music.load();
    } else if (m.kind === "music-sync") {
      if (current && m.uid === current.uid) target = m;
    } else if (m.kind === "speak" && (monitor || talker) && m.audio) {
      voices.push(m);
      speak();
    }
  };
}
