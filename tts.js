import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

/**
 * Wraps the Edge Read Aloud API. The socket stays open between phrases so the
 * second and later requests skip the handshake, but it drops on its own after
 * idle periods, so a failed synthesis rebuilds the client and retries once.
 */
export class Speaker {
  constructor({ voice, rate, pitch }) {
    this.voice = voice;
    this.prosody = { rate, pitch };
    this.tts = null;
  }

  async #client() {
    if (this.tts) return this.tts;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    this.tts = tts;
    return tts;
  }

  async #attempt(text) {
    const tts = await this.#client();
    const { audioStream } = tts.toStream(text, this.prosody);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const mp3 = Buffer.concat(chunks);
    if (!mp3.length) throw new Error("empty audio response");
    return mp3;
  }

  async synth(text) {
    try {
      return await this.#attempt(text);
    } catch {
      this.tts = null;
      return await this.#attempt(text);
    }
  }
}

export async function listVoices(localePrefix = "") {
  const voices = await new MsEdgeTTS().getVoices();
  return voices.filter((v) => v.Locale.startsWith(localePrefix));
}
