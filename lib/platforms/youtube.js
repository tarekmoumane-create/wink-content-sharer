// YouTube needs no API key and no scraper: every channel publishes an Atom feed
// at /feeds/videos.xml?channel_id=UC..., updated within minutes of a new upload
// and covering both long-form videos and Shorts.
//
// The only wrinkle is that people share @handle URLs, and the feed wants the
// UC... channel id. We resolve a handle once by reading the channel page and
// pulling the id out of its metadata, then cache it forever.
import { getCachedChannelId, setCachedChannelId } from "../store.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Extracting the channel id is the one genuinely delicate part of this file.
// A channel page mentions 6-12 DIFFERENT channel ids — every recommended video
// carries its own "channelId" — so a naive match on that field silently binds a
// creator to a stranger's uploads. These four patterns all identify the page
// owner specifically, and were verified to agree with each other on live pages.
const ID_PATTERNS = [
  /feeds\/videos\.xml\?channel_id=(UC[\w\-]{20,})/,                                   // the page's own RSS link tag
  /"externalId":"(UC[\w\-]{20,})"/,                                                    // channel metadata blob
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w\-]{20,})"/, // canonical URL
  /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w\-]{20,})"/,
];

function extractChannelId(html) {
  for (const re of ID_PATTERNS) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

async function resolveChannelId(creator) {
  if (creator.channelId) return creator.channelId;

  // A cache miss is recoverable; a cache *outage* shouldn't stop us resolving.
  let cached = null;
  try {
    cached = await getCachedChannelId(creator.handle);
  } catch {
    // fall through to a live lookup
  }
  if (cached) return cached;

  // Try the modern @handle URL first, then the legacy /c/ and /user/ forms.
  const candidates = [
    `https://www.youtube.com/@${creator.handle}`,
    `https://www.youtube.com/c/${creator.handle}`,
    `https://www.youtube.com/user/${creator.handle}`,
  ];

  for (const url of candidates) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;

    const id = extractChannelId(await res.text());
    if (id) {
      try {
        await setCachedChannelId(creator.handle, id);
      } catch {
        // caching is an optimisation, not a requirement
      }
      return id;
    }
  }

  throw new Error(`could not resolve YouTube channel id for @${creator.handle}`);
}

// The feed is small, well-formed XML. A full parser would be overkill here, so
// we pull the handful of fields we need with scoped regexes over each <entry>.
function parseFeed(xml) {
  const videos = [];

  for (const entry of xml.split("<entry>").slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!id) continue;

    videos.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""),
      author: decodeEntities(entry.match(/<name>([\s\S]*?)<\/name>/)?.[1] || ""),
      publishedAt: entry.match(/<published>([^<]+)<\/published>/)?.[1] || null,
    });
  }

  return videos;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// ---------------------------------------------------------------------------
// Fallback: read the channel's own uploads grid.
//
// The RSS feed is the cheap path, but it is unreliable for these creators —
// it returns 404 for channels that demonstrably have uploads, especially
// Shorts-only ones, and intermittently 500s. When that happens we read the
// channel page instead. Still free, no API key.
//
// Only `richItemRenderer` entries are considered, which is the channel's own
// upload grid. That scoping matters: a channel page also mentions plenty of
// OTHER channels' video ids, and picking those up would post strangers'
// videos under your creator's name.
// ---------------------------------------------------------------------------
function collect(node, key, out) {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
  }
}

// Returns null when the page could not be understood at all, versus [] for a
// page that was read fine and simply has no uploads. Callers MUST keep these
// apart: treating "couldn't read" as "empty account" marks a creator caught up
// when they aren't, and their whole back catalogue posts as new on the next
// run that succeeds.
function parseChannelPage(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const items = [];
  collect(data, "richItemRenderer", items);

  const out = [];
  const seen = new Set();

  for (const item of items) {
    const content = item?.content ?? {};
    let id = null;
    let title = "";

    const short = content.shortsLockupViewModel;
    const video = content.videoRenderer;

    if (short) {
      // entityId looks like "shorts-shelf-item-McnCTxiezME".
      id = String(short.entityId || "").match(/([\w-]{11})$/)?.[1] ?? null;
      title = short.overlayMetadata?.primaryText?.content ?? "";
    } else if (video?.videoId) {
      id = video.videoId;
      title = video.title?.runs?.[0]?.text ?? video.title?.simpleText ?? "";
    }

    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title,
      author: "",
      // The grid gives no exact timestamps, only "3 days ago" style text.
      // Rather than guess a date, leave it null and rely on grid order.
      publishedAt: null,
    });
  }

  return out;
}

async function fetchFromChannelPage(creator, channelId, count) {
  const base = creator.handle && !/^uc[\w-]{20,}$/i.test(creator.handle)
    ? `https://www.youtube.com/@${creator.handle}`
    : `https://www.youtube.com/channel/${channelId}`;

  // /shorts first for these creators, then /videos: whichever has content wins.
  let readSomething = false;

  for (const path of ["/shorts", "/videos"]) {
    const res = await fetch(base + path, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;

    const videos = parseChannelPage(await res.text());
    if (videos === null) continue;

    readSomething = true;
    if (videos.length) {
      // The grid is newest-first; the caller wants to post oldest-first, and
      // with no dates to sort on this order is the only signal available.
      return videos.slice(0, count).reverse();
    }
  }

  // Nothing could be read. Throwing keeps this creator un-initialised so the
  // run reports an error instead of quietly recording them as "caught up".
  if (!readSomething) {
    throw new Error(`could not read uploads for ${creator.handle || channelId}`);
  }

  // Read successfully, genuinely no uploads.
  return [];
}

export async function fetchRecent(creator, count = 5) {
  const channelId = await resolveChannelId(creator);

  // Canonical identity for de-duplication. Whether this creator was listed as
  // @handle or as a /channel/UC... link, both collapse onto the same key.
  creator.dedupKey = channelId.toLowerCase();

  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers: { "User-Agent": UA } },
  );

  if (res.ok) {
    const videos = parseFeed(await res.text());
    if (videos.length) return videos.slice(0, count);
  }

  // Feed unavailable or empty — fall back to reading the channel's grid. An
  // empty result here is a legitimate answer (a creator with no uploads yet),
  // so it is returned rather than thrown.
  return fetchFromChannelPage(creator, channelId, count);
}
