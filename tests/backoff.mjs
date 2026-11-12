// Verifies the never-posted backoff: that it stays dormant until its start
// date, escalates while a creator stays empty, frees the credit slot while
// deferred, and resets the instant the creator finally posts something.
import { startFakeRedis, startFakeDiscord } from "./fakes.mjs";

const SOURCE = "111111111111111111";
const TARGET = "222222222222222222";

const messages = {
  [SOURCE]: [
    { id: "2", content: "https://www.tiktok.com/@activeone", embeds: [] },
    { id: "1", content: "https://www.tiktok.com/@emptyone", embeds: [] },
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
process.env.SCRAPER_PROVIDER = "scrapecreators";
process.env.SCRAPECREATORS_API_KEY = "test";
process.env.LOW_CREDIT_WARNING = "0";

// @activeone always has a video; @emptyone never does. Everything else
// (Discord, Redis) still goes to the local fakes.
const realFetch = globalThis.fetch;
let scrapeCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes("api.scrapecreators.com")) return realFetch(url, opts);
  const handle = new URL(u).searchParams.get("handle");
  scrapeCalls.push(handle);
  const list = handle === "activeone"
    ? [{ aweme_id: "v1", url: "https://www.tiktok.com/@activeone/video/v1",
         desc: "hi", create_time_utc: "2026-09-20T00:00:00.000Z",
         author: { unique_id: "activeone" } }]
    : [];
  return { ok: true, status: 200, json: async () => ({ success: true, credits_remaining: 9999, aweme_list: list }), text: async () => "" };
};

const { runPoll } = await import("../lib/poll.js");
const line = (s) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);
let failures = [];
const check = (n, c, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); if (!c) failures.push(n); };
const nextAt = async (h) => Number((await (await realFetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(["GET", `next:tiktok:${h}`]) })).json()).result) || 0;

// ------------------------------------------------------------------ gate ---
line("Backoff stays OFF before its start date");
process.env.BACKOFF_START_AT = new Date(Date.now() + 864e5).toISOString();
let r = await runPoll();
check("reports itself as scheduled, not active", String(r.backoff).startsWith("scheduled"), r.backoff);
check("both creators still checked", r.meteredChecked === 2, `checked=${r.meteredChecked}`);
check("nothing deferred", r.deferred.length === 0);
check("no backoff recorded while dormant", (await nextAt("emptyone")) === 0);

// ---------------------------------------------------------------- active ---
line("Backoff ON: empty creator starts deferring, active one never does");
process.env.BACKOFF_START_AT = new Date(Date.now() - 864e5).toISOString();
scrapeCalls = [];
r = await runPoll();
check("now active", r.backoff === "active", r.backoff);
check("empty creator has a future next-check", (await nextAt("emptyone")) > Date.now());
check("active creator has none", (await nextAt("activeone")) === 0);

line("A deferred creator is skipped and frees its credit slot");
scrapeCalls = [];
r = await runPoll();
check("emptyone deferred", r.deferred.some((d) => d.includes("emptyone")), JSON.stringify(r.deferred));
check("only 1 credit spent, not 2", scrapeCalls.length === 1, `calls=${JSON.stringify(scrapeCalls)}`);
check("activeone still checked every run", scrapeCalls.includes("activeone"));
check("meteredTotal still reports the full roster", r.meteredTotal === 2, `${r.meteredTotal}`);

// ------------------------------------------------------------- escalation ---
line("Delay escalates 30m -> 60m -> 120m -> 240m and caps");
const seen = [];
for (let i = 0; i < 5; i++) {
  await realFetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(["SET", "next:tiktok:emptyone", 0]) });
  const before = Date.now();
  await runPoll();
  seen.push(Math.round(((await nextAt("emptyone")) - before) / 60000));
}
console.log(`  delays observed (minutes): ${seen.join(" -> ")}`);
check("escalates then caps at 240", seen[seen.length - 1] === 240 && seen[0] < seen[seen.length - 1], seen.join(","));
check("never exceeds the cap", Math.max(...seen) === 240);

// ------------------------------------------------------------------ reset ---
line("Creator finally posts -> backoff cleared immediately");
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes("api.scrapecreators.com")) return realFetch(url, opts);
  const handle = new URL(u).searchParams.get("handle");
  // Only @emptyone changes: it finally posts. @activeone keeps its existing
  // video, which is already marked seen, so it must stay silent.
  const list = handle === "emptyone"
    ? [{ aweme_id: "debut", url: "https://www.tiktok.com/@emptyone/video/debut",
         desc: "first!", create_time_utc: "2026-09-22T00:00:00.000Z", author: { unique_id: "emptyone" } }]
    : [{ aweme_id: "v1", url: "https://www.tiktok.com/@activeone/video/v1",
         desc: "hi", create_time_utc: "2026-09-20T00:00:00.000Z", author: { unique_id: "activeone" } }];
  return { ok: true, status: 200, json: async () => ({ success: true, credits_remaining: 9999, aweme_list: list }), text: async () => "" };
};
await realFetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(["SET", "next:tiktok:emptyone", 0]) });
const postsBefore = discord.posted.length;
r = await runPoll();
check("backoff cleared once they post", (await nextAt("emptyone")) === 0);
const newPosts = discord.posted.slice(postsBefore);
check("their debut video IS posted", newPosts.some((p) => p.content.includes("/video/debut")));
check("exactly one post, no duplicate", newPosts.length === 1,
  newPosts.map((p) => p.content.replace(/\n/g, " ")).join(" | "));

line(failures.length ? `FAILURES: ${failures.join(", ")}` : "ALL BACKOFF CHECKS PASSED");
redis.server.close(); discord.server.close();
process.exit(failures.length ? 1 : 0);
