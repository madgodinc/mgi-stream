// One program, three processes. The app itself speaks the chat; two helpers
// started with --mgi-helper play the music window and the headphone copy. Each
// is its own process tree, so TikTok LIVE Studio captures them as separate
// application sounds and the headphone copy stays out of the stream.
const helper = process.argv.some((a) => a.startsWith("--mgi-helper="));
import(helper ? "./helper.js" : "./main.js");
