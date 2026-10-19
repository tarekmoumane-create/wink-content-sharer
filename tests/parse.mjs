import { parseCreatorsFromText } from "../lib/creators.js";

const sample = `
Here's the roster for this month:
https://www.tiktok.com/@mrbeast
https://tiktok.com/@charlidamelio?lang=en
check out https://www.youtube.com/@MrBeast and https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA
https://www.instagram.com/cristiano/
legacy one: https://www.youtube.com/c/PewDiePie
someone posted a video not a channel: https://www.tiktok.com/@zachking/video/7234567890123456789
ignore these: https://www.instagram.com/p/Cabc123/ and https://www.instagram.com/reel/Cxyz/
and https://www.youtube.com/watch?v=dQw4w9WgXcQ
shorthand: tiktok: @khaby.lame | yt @veritasium | ig: @natgeo
duplicate on purpose: https://www.tiktok.com/@mrbeast
`;

const creators = [...parseCreatorsFromText(sample).values()];
console.log(`parsed ${creators.length} unique creators:\n`);
for (const c of creators) console.log(`  ${c.platform.padEnd(10)} ${c.handle}`);

// Assertions on the things that would silently break the bot.
const keys = creators.map((c) => `${c.platform}:${c.handle}`);
const must = [
  "tiktok:mrbeast", "tiktok:charlidamelio", "tiktok:zachking", "tiktok:khaby.lame",
  "youtube:mrbeast", "youtube:pewdiepie", "youtube:veritasium",
  "instagram:cristiano", "instagram:natgeo",
];
const mustNot = ["instagram:p", "instagram:reel", "youtube:watch"];

const missing = must.filter((k) => !keys.includes(k));
const leaked = mustNot.filter((k) => keys.includes(k));
const dupes = keys.length !== new Set(keys).size;

console.log("\nmissing:", missing.length ? missing : "none");
console.log("reserved-path leaks:", leaked.length ? leaked : "none");
console.log("duplicates:", dupes ? "YES (bug)" : "none");
console.log(missing.length || leaked.length || dupes ? "\nFAIL" : "\nPASS");
