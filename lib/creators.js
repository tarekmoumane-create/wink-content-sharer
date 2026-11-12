// Turns the raw contents of the handles channel into a clean creator list.
//
// The channel is the source of truth: whatever links people have posted there
// are the accounts the bot watches. Drop a new link in, and the next cron run
// picks it up — no commands, no redeploy. This file is only about parsing; it
// does no network calls.
import { fetchChannelMessages } from "./discord.js";
import { hasSideshift, fetchActiveAccounts, SIDESHIFT_PLATFORMS } from "./sideshift.js";
import { getRosterCache, setRosterCache, getContractKinds, setContractKinds } from "./store.js";

// Paths that look like a username but aren't one.
const IG_RESERVED = new Set([
  "p", "reel", "reels", "stories", "explore", "accounts", "direct",
  "tv", "about", "developer", "legal", "privacy", "terms",
]);
const YT_RESERVED = new Set([
  "watch", "shorts", "playlist", "results", "feed", "hashtag", "about", "embed",
]);

// A handle is valid if it's plausible for the platform. Keeps stray punctuation
// from Discord formatting (trailing `)`, `>`, `.`) out of the stored key.
function clean(handle) {
  return String(handle || "").replace(/[^\w.\-]/g, "").toLowerCase();
}

function add(map, platform, handle, sourceUrl) {
  const h = clean(handle);
  if (!h || h.length < 2) return;
  const key = `${platform}:${h}`;
  if (map.has(key)) return;
  map.set(key, { platform, handle: h, name: h, sourceUrl });
}

// Pulls every creator reference out of one chunk of text. A single message can
// legitimately hold several links (people paste a creator's whole set at once).
export function parseCreatorsFromText(text, map = new Map()) {
  if (!text) return map;

  // --- TikTok: tiktok.com/@handle (optionally followed by /video/123) -------
  for (const m of text.matchAll(/tiktok\.com\/@([\w.\-]+)/gi)) {
    add(map, "tiktok", m[1], `https://www.tiktok.com/@${clean(m[1])}`);
  }

  // --- YouTube: /@handle, /channel/UC..., /c/name, /user/name ---------------
  for (const m of text.matchAll(/youtube\.com\/@([\w.\-]+)/gi)) {
    if (YT_RESERVED.has(clean(m[1]))) continue;
    add(map, "youtube", m[1], `https://www.youtube.com/@${clean(m[1])}`);
  }
  for (const m of text.matchAll(/youtube\.com\/channel\/(UC[\w\-]{20,})/gi)) {
    // Channel ids are case-sensitive, so store them verbatim rather than cleaned.
    const id = m[1];
    const key = `youtube:${id.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        platform: "youtube",
        handle: id.toLowerCase(),
        name: id,
        channelId: id,
        sourceUrl: `https://www.youtube.com/channel/${id}`,
      });
    }
  }
  for (const m of text.matchAll(/youtube\.com\/(?:c|user)\/([\w.\-]+)/gi)) {
    if (YT_RESERVED.has(clean(m[1]))) continue;
    add(map, "youtube", m[1], `https://www.youtube.com/c/${clean(m[1])}`);
  }

  // --- Instagram: instagram.com/username -----------------------------------
  for (const m of text.matchAll(/instagram\.com\/([\w.\-]+)/gi)) {
    if (IG_RESERVED.has(clean(m[1]))) continue;
    add(map, "instagram", m[1], `https://www.instagram.com/${clean(m[1])}`);
  }

  // --- Explicit shorthand, for creators posted without a full URL ----------
  // e.g.  tiktok: @someone   |   yt @someone   |   ig: someone
  const shorthand = /\b(tiktok|tt|youtube|yt|instagram|ig)\s*[:=]?\s*@([\w.\-]+)/gi;
  for (const m of text.matchAll(shorthand)) {
    const p = m[1].toLowerCase();
    const platform =
      p === "tt" || p === "tiktok" ? "tiktok"
      : p === "yt" || p === "youtube" ? "youtube"
      : "instagram";
    add(map, platform, m[2], null);
  }

  return map;
}

// Creators to skip even though they appear in the handles channel. Set
// IGNORE_CREATORS to a comma-separated list of "platform:handle" entries.
//
// The reason this exists: another bot may already be announcing some of these
// creators in the same channel. Ignoring them here is better than deleting
// people's messages out of the handles channel, and on metered platforms it
// saves a scraper credit per skipped creator per run.
export function ignoredSet() {
  return new Set(
    (process.env.IGNORE_CREATORS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Reads the handles channel and returns a de-duplicated creator list.
// Embeds count too: when someone pastes a link Discord often strips it from the
// visible content and keeps the URL in an embed, so we scan both.
// Each entry remembers who posted it (authorId), which is how a YouTube link is
// tied to a person when SideShift decides who is on the team.
async function readChannel(channelId, limit = 500) {
  const messages = await fetchChannelMessages(channelId, limit);
  const map = new Map();

  for (const msg of messages) {
    const found = new Map();
    parseCreatorsFromText(msg.content, found);
    for (const e of msg.embeds || []) {
      parseCreatorsFromText([e.url, e.title, e.description, e.author?.url].filter(Boolean).join(" "), found);
    }
    for (const [key, creator] of found) {
      if (!map.has(key)) map.set(key, { ...creator, authorId: msg.author?.id || null });
    }
  }
  return [...map.values()];
}

// The platforms this bot shares. Wink does not do YouTube, so out of the box
// only TikTok and Instagram accounts are watched, whatever links are sitting in
// the handles channel. WATCH_PLATFORMS (comma-separated) is the only way to
// widen that, e.g. "tiktok,instagram,youtube".
export function watchedPlatforms() {
  return new Set(
    (process.env.WATCH_PLATFORMS || "tiktok,instagram")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const withoutIgnored = (creators) => {
  const ignored = ignoredSet();
  const watched = watchedPlatforms();
  return creators
    .filter((c) => watched.has(c.platform))
    .filter((c) => !ignored.has(`${c.platform}:${c.handle.toLowerCase()}`))
    .map(({ authorId, person, ...c }) => c);
};

export async function loadCreators(channelId, limit = 500) {
  return withoutIgnored(await readChannel(channelId, limit));
}

// The list the bot actually watches, and where it came from.
//
// Without SIDESHIFT_API_KEY this is the handles channel, as before. With it:
//   - TikTok and Instagram accounts are exactly those of creators with an
//     active SideShift contract. A creator who leaves stops being watched; a
//     new one is watched from the next run, whether or not they posted links.
//   - YouTube is not watched at all (see watchedPlatforms). If it is ever
//     switched back on, YouTube links come from the channel, but only those
//     posted by someone still on the team, meaning they also posted a TikTok
//     or Instagram account that SideShift lists as active.
//   - If SideShift has no working account for a team member on TikTok or
//     Instagram, the link they posted in the channel for it is used instead.
//   - If SideShift can't be read, the last good answer is reused, so an outage
//     there changes nothing here. With no saved answer either, the channel is
//     used as before.
export async function loadRoster(channelId) {
  if (!hasSideshift()) {
    return { creators: await loadCreators(channelId), source: "channel" };
  }

  let accounts = null;
  let source = "sideshift";
  let error;
  try {
    accounts = await fetchActiveAccounts({ get: getContractKinds, set: setContractKinds });
    if (!accounts.length) throw new Error("SideShift listed no active accounts");
    await setRosterCache(accounts);
  } catch (e) {
    error = String(e?.message || e);
    accounts = await getRosterCache().catch(() => null);
    source = accounts ? "sideshift (saved copy)" : "channel";
  }

  // The channel is only a helper once SideShift is in charge, so failing to
  // read it must not stop the run.
  let fromChannel = [];
  try {
    fromChannel = await readChannel(channelId);
  } catch (e) {
    if (!accounts) throw e;
  }
  if (!accounts) return { creators: withoutIgnored(fromChannel), source, error };

  // Who posted what in the channel tells us which Discord user is which
  // SideShift person: posting an account SideShift lists as active makes you
  // that account's owner.
  const owner = new Map(accounts.map((a) => [`${a.platform}:${a.handle}`, a.person || a.handle]));
  const peopleOf = new Map(); // Discord author id -> the SideShift people they are
  for (const c of fromChannel) {
    const person = owner.get(`${c.platform}:${c.handle.toLowerCase()}`);
    if (!person || !c.authorId) continue;
    if (!peopleOf.has(c.authorId)) peopleOf.set(c.authorId, new Set());
    peopleOf.get(c.authorId).add(person);
  }
  const covered = new Set(accounts.map((a) => `${a.person || a.handle}|${a.platform}`));

  const creators = accounts.map(({ platform, handle }) => ({
    platform,
    handle,
    name: handle,
    sourceUrl:
      platform === "tiktok"
        ? `https://www.tiktok.com/@${handle}`
        : `https://www.instagram.com/${handle}`,
  }));
  for (const c of fromChannel) {
    if (owner.has(`${c.platform}:${c.handle.toLowerCase()}`)) continue; // already listed
    const people = peopleOf.get(c.authorId);
    if (!people) continue; // posted by someone who is not on the team (any more)
    if (SIDESHIFT_PLATFORMS.includes(c.platform)) {
      // A TikTok/Instagram link SideShift doesn't list. Keep it only when
      // SideShift has no working account on that platform for this person
      // (their account there went stale, say), so they don't go unwatched.
      if ([...people].some((p) => covered.has(`${p}|${c.platform}`))) continue;
    }
    creators.push(c);
  }
  return { creators: withoutIgnored(creators), source, error };
}
