// Thin wrapper over Upstash Redis (the storage Vercel provisions via its
// Marketplace). Everything the bot needs to remember lives here:
//
//   seen:<platform>:<handle>   -> SET of video ids already posted
//   known:<platform>:<handle>  -> "1" once a creator has been initialised
//   yt:channel:<handle>        -> resolved YouTube channel id (permanent cache)
//   cursor:creators            -> rotating offset so each cron run picks up
//                                 where the last one stopped
//
// Upstash auto-serializes objects to/from JSON, so we store/read plain values.
// Swapping storage later (Postgres, Supabase, etc.) means only editing this file.
import { Redis } from "@upstash/redis";

// Vercel's Upstash Marketplace integration sets KV_REST_API_URL / KV_REST_API_TOKEN.
// Fall back to the native UPSTASH_* names in case a future integration uses those.
const client = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

// KEY_PREFIX lets several copies of this bot (one per Discord server) share a
// single Redis database without reading each other's seen-sets or cursor.
const PREFIX = process.env.KEY_PREFIX || "";
const KEYED = new Set(["get", "set", "sadd", "scard", "del"]);
const redis = new Proxy(client, {
  get(target, prop) {
    const fn = target[prop];
    if (!KEYED.has(prop) || !PREFIX) return typeof fn === "function" ? fn.bind(target) : fn;
    return (key, ...rest) => fn.call(target, PREFIX + key, ...rest);
  },
});

// A creator can be referenced two different ways in the handles channel — a
// YouTube @handle and that same channel's UC... id, for instance. The adapter
// resolves both to one canonical `dedupKey`, so the two entries share a single
// seen-set and the channel never gets the same video posted twice.
const identity = (c) => (c.dedupKey || c.handle).toLowerCase();
const seenKey = (c) => `seen:${c.platform}:${identity(c)}`;
const knownKey = (c) => `known:${c.platform}:${identity(c)}`;

// Returns true if this video id had NOT been recorded before. SADD is atomic,
// so two overlapping cron runs can never both claim the same video — whichever
// gets there first gets `1` back, the other gets `0` and stays quiet.
export async function markSeen(creator, videoId) {
  const added = await redis.sadd(seenKey(creator), String(videoId));
  return added === 1;
}

// Record ids without treating them as new. Used on a creator's first sighting
// so their whole backlog doesn't flood the target channel.
export async function markManySeen(creator, videoIds) {
  const ids = videoIds.map(String).filter(Boolean);
  if (!ids.length) return;
  await redis.sadd(seenKey(creator), ...ids);
}

// Keeps the seen-set from growing without bound. A creator posting daily for a
// year is ~365 ids; we trim to the most recent `keep` by rewriting the set from
// the ids we just fetched plus whatever is still relevant.
export async function trimSeen(creator, keepIds, keep = 200) {
  const size = await redis.scard(seenKey(creator));
  if (size <= keep) return;
  const ids = keepIds.map(String).filter(Boolean);
  if (!ids.length) return;
  await redis.del(seenKey(creator));
  await redis.sadd(seenKey(creator), ...ids);
}

export async function isKnownCreator(creator) {
  return (await redis.get(knownKey(creator))) !== null;
}
export async function markCreatorKnown(creator) {
  await redis.set(knownKey(creator), 1);
}

// YouTube @handles have to be resolved to a UC... channel id once. That never
// changes, so cache it forever and save a page fetch on every later run.
export async function getCachedChannelId(handle) {
  return (await redis.get(`yt:channel:${handle.toLowerCase()}`)) || null;
}
export async function setCachedChannelId(handle, channelId) {
  await redis.set(`yt:channel:${handle.toLowerCase()}`, channelId);
}

// One-shot latch. Returns true only for the first caller inside `ttlSeconds`,
// so a condition that is true on every run (like a low credit balance) still
// only announces itself once per window instead of every 15 minutes.
export async function claimAlert(name, ttlSeconds) {
  const res = await redis.set(`alert:${name}`, Date.now(), { nx: true, ex: ttlSeconds });
  return res === "OK";
}

// Backoff state for creators that have never produced a single video.
//
//   quiet:<platform>:<id>  -> consecutive checks that came back empty
//   next:<platform>:<id>   -> epoch ms before which we shouldn't bother again
//
// Both are cleared the moment a creator posts anything, so a new account that
// finally goes live returns to full-rate checking immediately.
export async function getBackoff(creator) {
  const [streak, nextAt] = await Promise.all([
    redis.get(`quiet:${creator.platform}:${identity(creator)}`),
    redis.get(`next:${creator.platform}:${identity(creator)}`),
  ]);
  return { streak: Number(streak) || 0, nextAt: Number(nextAt) || 0 };
}

export async function setBackoff(creator, streak, nextAt) {
  await Promise.all([
    redis.set(`quiet:${creator.platform}:${identity(creator)}`, streak),
    redis.set(`next:${creator.platform}:${identity(creator)}`, nextAt),
  ]);
}

export async function clearBackoff(creator) {
  await Promise.all([
    redis.del(`quiet:${creator.platform}:${identity(creator)}`),
    redis.del(`next:${creator.platform}:${identity(creator)}`),
  ]);
}

// Rotating cursor: with more creators than one run can check, each invocation
// takes the next slice and leaves the offset ready for the run after it.
export async function getCursor() {
  const v = await redis.get("cursor:creators");
  return Number(v) || 0;
}
export async function setCursor(n) {
  await redis.set("cursor:creators", n);
}

// Last good answer from SideShift about who is on the team. Reused when
// SideShift can't be reached, so an outage there never empties the watch list.
export async function getRosterCache() {
  const v = await redis.get("sideshift:roster");
  return Array.isArray(v?.accounts) && v.accounts.length ? v.accounts : null;
}
export async function setRosterCache(accounts) {
  await redis.set("sideshift:roster", { savedAt: Date.now(), accounts });
}

// Which SideShift contracts are clippers', remembered for a day so the bot
// doesn't re-read every contract on every 15-minute run.
export async function getContractKinds() {
  return (await redis.get("sideshift:contract-kinds")) || null;
}
export async function setContractKinds(kinds) {
  await redis.set("sideshift:contract-kinds", kinds);
}
