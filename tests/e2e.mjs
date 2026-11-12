import { startFakeRedis, startFakeDiscord } from "./fakes.mjs";

const SOURCE = "111111111111111111";
const TARGET = "222222222222222222";

// The handles channel as real people would fill it in: links, prose around
// them, a duplicate, and the same YouTube channel referenced two ways.
const messages = {
  [SOURCE]: [
    { id: "9", content: "welcome! drop your links below", embeds: [] },
    { id: "8", content: "https://www.youtube.com/@veritasium", embeds: [] },
    { id: "7", content: "mine is https://www.youtube.com/@MrBeast 🔥", embeds: [] },
    { id: "6", content: "same guy by id https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA", embeds: [] },
    { id: "5", content: "https://www.tiktok.com/@khaby.lame", embeds: [] },
    { id: "4", content: "check this post https://www.instagram.com/p/Cabc123/", embeds: [] },
    { id: "3", content: "", embeds: [{ url: "https://www.youtube.com/@mkbhd", title: "MKBHD" }] },
  ],
  [TARGET]: [],
};

const redis = await startFakeRedis();
const discord = await startFakeDiscord(messages);

process.env.KV_REST_API_URL = redis.url;
process.env.KV_REST_API_TOKEN = "test";
process.env.DISCORD_API_BASE = discord.url;
process.env.DISCORD_BOT_TOKEN = "test-token";
// These suites exercise YouTube too; the bot itself ships with it switched off.
process.env.WATCH_PLATFORMS = "youtube,tiktok,instagram";
process.env.DISCORD_SOURCE_CHANNEL_ID = SOURCE;
process.env.DISCORD_TARGET_CHANNEL_ID = TARGET;
process.env.SCRAPER_PROVIDER = "none";
process.env.VIDEOS_PER_CHECK = "4";

// YouTube is stubbed rather than called for real. This suite asserts exact
// post counts, and a live feed that 404s or changes between runs turns those
// assertions into coin flips. Discord and Redis still go to the local fakes.
const CHANNELS = {
  mrbeast:    "UCX6OQ3DkcsbYNE6H8uQQuVA",
  veritasium: "UCveritasiumAAAAAAAAAAAA",
  mkbhd:      "UCmkbhdBBBBBBBBBBBBBBBBB",
};
const FEEDS = {
  [CHANNELS.mrbeast]:    [["mb1", "Beast One"], ["mb2", "Beast Two"], ["mb3", "Beast Three"], ["mb4", "Beast Four"], ["mb5", "Beast Five"]],
  [CHANNELS.veritasium]: [["vt1", "Veri One"], ["vt2", "Veri Two"]],
  [CHANNELS.mkbhd]:      [["mk1", "MKB One"], ["mk2", "MKB Two"], ["mk3", "MKB Three"]],
};
const rss = (entries) => `<?xml version="1.0"?><feed>${entries.map(([id, t], i) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${t}</title><author><name>${t.split(" ")[0]}</name></author>` +
  `<published>2026-09-${String(10 + i).padStart(2, "0")}T00:00:00+00:00</published></entry>`).join("")}</feed>`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes("youtube.com")) return realFetch(url, opts);

  const feedId = u.match(/channel_id=(UC[\w-]+)/)?.[1];
  if (feedId) {
    const entries = FEEDS[feedId];
    return entries
      ? { ok: true, status: 200, text: async () => rss(entries) }
      : { ok: false, status: 404, text: async () => "" };
  }

  // Channel page: serve the RSS link tag the resolver reads the id from.
  const handle = u.match(/youtube\.com\/(?:@|c\/|user\/)([\w.\-]+)/)?.[1]?.toLowerCase();
  const id = handle && CHANNELS[handle];
  return id
    ? { ok: true, status: 200, text: async () => `<link href="https://www.youtube.com/feeds/videos.xml?channel_id=${id}">` }
    : { ok: false, status: 404, text: async () => "" };
};

const { runPoll } = await import("../lib/poll.js");

const line = (s) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);
let failures = [];
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

// ---------------------------------------------------------------- run 1 ----
line("RUN 1 — first ever run (should absorb backlog, post nothing)");
const r1 = await runPoll();
console.log(`  creators found: ${r1.creatorsFound}, checked: ${r1.creatorsChecked}`);
console.log(`  initialised: ${r1.initialised.join(", ")}`);
console.log(`  errors: ${r1.errors.map(e=>`${e.creator}${e.disabled?" (scraper off)":""}`).join(", ") || "none"}`);
check("no messages posted on first run", discord.posted.length === 0, `posted=${discord.posted.length}`);
check("YouTube creators initialised", r1.initialised.filter(s=>s.startsWith("youtube")).length === 3);
check("MrBeast's two entries collapsed to one key",
  new Set(r1.initialised.filter(s=>s.startsWith("youtube"))).size === 3);
check("TikTok fails gracefully (scraper disabled)", r1.errors.some(e => e.disabled));
check("instagram /p/ link not treated as a creator",
  !r1.initialised.some(s => s.includes("instagram")) && !r1.errors.some(e => e.creator.includes(":p")));

// ---------------------------------------------------------------- run 2 ----
line("RUN 2 — nothing new upstream (should stay silent)");
const r2 = await runPoll();
check("still no messages posted", discord.posted.length === 0, `posted=${discord.posted.length}`);
check("no creators re-initialised", r2.initialised.length === 0);

// ---------------------------------------------------------------- run 3 ----
line("RUN 3 — simulate a fresh upload by forgetting one video");
const before = redis.dump().sets.find(([k]) => k.toLowerCase().startsWith("seen:youtube:ucx6"));
const [seenKey, ids] = before;
console.log(`  ${seenKey} currently holds ${ids.length} ids`);
// Drop the newest id, exactly as if MrBeast had just posted it.
await fetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(["DEL", seenKey]) });
await fetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(["SADD", seenKey, ...ids.slice(1)]) });

const r3 = await runPoll();
console.log(`  posted: ${r3.posted.length}`);
for (const p of discord.posted) console.log(`    -> ${JSON.stringify(p.content)}`);
check("exactly one message posted", discord.posted.length === 1, `posted=${discord.posted.length}`);
check("posted to the TARGET channel", discord.posted[0]?.channel === TARGET);
check("message carries a youtube URL", /youtube\.com\/watch\?v=/.test(discord.posted[0]?.content ?? ""));
check("mentions are suppressed",
  JSON.stringify(discord.posted[0]?.allowed_mentions) === '{"parse":[]}');

// ---------------------------------------------------------------- run 4 ----
line("RUN 4 — same video must never post twice");
const r4 = await runPoll();
check("no duplicate post", discord.posted.length === 1, `posted=${discord.posted.length}`);

// ---------------------------------------------------------------- run 5 ----
line("RUN 5 — IGNORE_CREATORS excludes a creator another bot already covers");
process.env.IGNORE_CREATORS = "youtube:veritasium, youtube:mkbhd";
const { loadCreators } = await import("../lib/creators.js");
const visible = (await loadCreators(SOURCE)).map((c) => `${c.platform}:${c.handle}`);
console.log(`  visible now: ${visible.join(", ")}`);
check("ignored creators are gone", !visible.some((k) => k === "youtube:veritasium" || k === "youtube:mkbhd"));
check("everyone else survives", visible.includes("youtube:mrbeast") && visible.includes("tiktok:khaby.lame"));
check("whitespace around entries is tolerated", !visible.includes("youtube:mkbhd"));
process.env.IGNORE_CREATORS = "";

// ---------------------------------------------------------------- run 6 ----
line("RUN 6 — low-credit alert fires once, not every run");
const { claimAlert } = await import("../lib/store.js");
const first  = await claimAlert("low-credits", 3600);
const second = await claimAlert("low-credits", 3600);
const third  = await claimAlert("low-credits", 3600);
console.log(`  claims: ${first}, ${second}, ${third}`);
check("first call claims the alert", first === true);
check("repeat calls stay silent", second === false && third === false);
check("a different alert is unaffected", (await claimAlert("other", 3600)) === true);

line(failures.length ? `FAILURES: ${failures.join(", ")}` : "ALL CHECKS PASSED");
redis.server.close(); discord.server.close();
process.exit(failures.length ? 1 : 0);
