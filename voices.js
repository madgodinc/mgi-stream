import { listVoices } from "./tts.js";

const prefix = process.argv[2] ?? "";
const voices = await listVoices(prefix);

if (!voices.length) {
  console.log(`No voices for locale "${prefix}". Run without arguments to list all of them.`);
  process.exit(0);
}

for (const v of voices) {
  console.log(`${v.ShortName.padEnd(28)} ${v.Gender.padEnd(7)} ${v.FriendlyName}`);
}
console.log(`\n${voices.length} voices. Put a ShortName into config.json as "voice".`);
