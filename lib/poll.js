// The actual job: read the handles channel, check each creator for uploads we
// haven't posted yet, and drop the new ones into the target channel.
//
// Three rules shape this file:
//   1. A creator seen for the first time does NOT get their backlog posted.
//      Marking their current videos as seen is the difference between "the bot
//      is live" and "the bot dumped 400 links into the channel".
//   2. One broken creator must not kill the run. Every check is isolated and
//      failures are collected into the summary instead of thrown.
//   3. A run has hard caps — creators checked and messages posted — so a
//      serverless invocation always finishes inside its time budget.
//   4. Free and paid platforms are budgeted separately. YouTube costs nothing,
//      so every YouTube creator is checked every run. TikTok and Instagram burn
//      a scraper credit per creator per check, so those rotate through a small
//      per-run quota and the cursor remembers where the last run stopped.
import { loadCreators } from "./creators.js";
import { fetchRecent } from "./platforms/index.js";
import { postMessage } from "./discord.js";
import { takeCreditsReading } from "./platforms/scraper.js";
import {
  claimAlert,
  getBackoff,
  setBackoff,
  clearBackoff,
  markSeen,
  markManySeen,
  trimSeen,
  isKnownCreator,
  markCreatorKnown,
  getCursor,
  setCursor,
} from "./store.js";

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Platforms that cost money per check. YouTube is absent on purpose: its RSS
// feed is free and unmetered, so it never competes for the scraper budget.
const METERED = new Set(["tiktok", "instagram"]);

// Escalating wait, in minutes, after each consecutive empty check. A creator
// who has never posted is worth watching, just not every 15 minutes: the first
// miss costs nothing, and by the fifth we're down to a 4-hourly poke. Capped
// rather than unbounded so an account that eventually goes live is still found
// within a few hours.
const BACKOFF_MINUTES = [0, 30, 60, 120, 240];

function backoffDelayMs(streak) {
  const mins = BACKOFF_MINUTES[Math.min(streak, BACKOFF_MINUTES.length - 1)];
  return mins * 60 * 1000;
}

// Backoff only applies from BACKOFF_START_AT onward, so it can be shipped now
// and switch itself on later without anyone redeploying. Unset means active
// immediately; an unparseable date is treated as "not yet" rather than
// silently enabling something that was meant to be scheduled.
function backoffActive(now) {
  const raw = process.env.BACKOFF_START_AT;
  if (!raw) return true;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  return now >= t;
}

function render(template, video, creator) {
  return template
    .replace(/\{name\}/g, video.author || creator.name || creator.handle)
    .replace(/\{platform\}/g, creator.platform)
    .replace(/\{title\}/g, (video.title || "").slice(0, 200))
    .replace(/\{url\}/g, video.url || "");
}

// Oldest first, so a creator who dropped three videos between runs appears in
// the channel in the order they actually posted them. Adapters normalise
// publishedAt to ISO, but a missing or unparseable date must not reorder the
// rest — those sort to the end and keep their original relative order.
function chronological(videos) {
  return videos
    .map((v, i) => ({ v, i, t: Date.parse(v.publishedAt ?? "") }))
    .sort((a, b) => {
      const aBad = Number.isNaN(a.t);
      const bBad = Number.isNaN(b.t);
      if (aBad && bBad) return a.i - b.i;
      if (aBad) return 1;
      if (bBad) return -1;
      return a.t - b.t || a.i - b.i;
    })
    .map((x) => x.v);
}

export async function runPoll({ dryRun = false } = {}) {
  const sourceChannel = process.env.DISCORD_SOURCE_CHANNEL_ID;
  const targetChannel = process.env.DISCORD_TARGET_CHANNEL_ID;
  if (!sourceChannel) throw new Error("DISCORD_SOURCE_CHANNEL_ID is not set");
  if (!targetChannel) throw new Error("DISCORD_TARGET_CHANNEL_ID is not set");

  // Credit budget per run: how many TikTok/Instagram creators to check. Each
  // one costs exactly one scraper credit, so this number IS the run's bill.
  const meteredPerRun = num(process.env.MAX_METERED_PER_RUN, 10);
  const perCheck = num(process.env.VIDEOS_PER_CHECK, 5);
  const maxPosts = num(process.env.MAX_POSTS_PER_RUN, 15);
  const backfill = (process.env.BACKFILL_ON_ADD || "none").toLowerCase();
  const template =
    process.env.POST_TEMPLATE || "**{name}** just posted on {platform}\n{url}";

  const allCreators = await loadCreators(sourceChannel);

  const free = allCreators.filter((c) => !METERED.has(c.platform));
  const allMetered = allCreators.filter((c) => METERED.has(c.platform));

  // Drop creators still inside their backoff window before the budget is
  // sliced, so a dormant account can't occupy a credit slot that an active
  // creator needs.
  const now = Date.now();
  const useBackoff = backoffActive(now);
  let deferred = [];
  let metered = allMetered;

  if (useBackoff) {
    const states = await Promise.all(allMetered.map((c) => getBackoff(c)));
    metered = allMetered.filter((c, i) => states[i].nextAt <= now);
    deferred = allMetered
      .filter((c, i) => states[i].nextAt > now)
      .map((c) => `${c.platform}:${c.handle}`);
  }

  // Free creators are all checked every run. Metered ones rotate through a
  // quota so a run's credit spend is predictable: at most `meteredPerRun`.
  const cursor = metered.length ? (await getCursor()) % metered.length : 0;
  const meteredSlice =
    metered.length <= meteredPerRun
      ? metered
      : [...metered, ...metered].slice(cursor, cursor + meteredPerRun);

  const slice = [...free, ...meteredSlice];

  const summary = {
    creatorsFound: allCreators.length,
    creatorsChecked: slice.length,
    freeChecked: free.length,
    meteredChecked: meteredSlice.length,
    meteredTotal: allMetered.length,
    backoff: useBackoff ? "active" : `scheduled for ${process.env.BACKOFF_START_AT}`,
    deferred,
    posted: [],
    initialised: [],
    errors: [],
    skipped: [],
    empty: [],
  };

  let postsLeft = maxPosts;

  // Only metered creators carry backoff state: a free YouTube check costs
  // nothing, so slowing it down would buy nothing and cost freshness.
  const shouldTrack = (c) => useBackoff && METERED.has(c.platform);

  for (const creator of slice) {
    try {
      const videos = await fetchRecent(creator, perCheck);
      const known = await isKnownCreator(creator);

      // Anything at all on the feed means this is a live account: reset any
      // accumulated backoff so it goes straight back to full-rate checking.
      if (videos.length && shouldTrack(creator)) {
        await clearBackoff(creator);
      }

      // First sighting: absorb the backlog quietly.
      //
      // This runs even when the creator currently has NO videos. An empty
      // account has no backlog to suppress, so marking it known now means its
      // very first upload is treated as new and gets posted. Skipping the mark
      // would swallow that first video as if it were history.
      if (!known) {
        const ids = videos.map((v) => v.id);
        const newest = backfill === "latest" ? chronological(videos).at(-1) : null;
        if (newest) {
          await markManySeen(creator, ids.filter((id) => id !== newest.id));
          if (postsLeft > 0) {
            if (!dryRun) await postMessage(targetChannel, render(template, newest, creator));
            postsLeft--;
            summary.posted.push({ creator: creator.handle, url: newest.url });
          }
          await markSeen(creator, newest.id);
        } else {
          await markManySeen(creator, ids);
        }
        await markCreatorKnown(creator);
        // A creator who arrives with nothing starts accruing backoff straight
        // away rather than waiting for a second empty run to notice.
        if (!ids.length && shouldTrack(creator)) {
          await setBackoff(creator, 1, Date.now() + backoffDelayMs(1));
        }
        summary.initialised.push(
          `${creator.platform}:${creator.handle}${ids.length ? "" : " (no videos yet)"}`,
        );
        continue;
      }

      // Known creator with nothing to show: the account went quiet, or the
      // handle no longer resolves. Surfaced so dead handles are visible.
      if (!videos.length) {
        if (shouldTrack(creator)) {
          const { streak } = await getBackoff(creator);
          const next = streak + 1;
          const delay = backoffDelayMs(next);
          await setBackoff(creator, next, Date.now() + delay);
          summary.empty.push(
            `${creator.platform}:${creator.handle} (next check in ${delay / 60000}m)`,
          );
        } else {
          summary.empty.push(`${creator.platform}:${creator.handle}`);
        }
        continue;
      }

      for (const video of chronological(videos)) {
        if (!video.url) continue;
        if (postsLeft <= 0) {
          // Leave it unseen so the next run picks it up rather than losing it.
          summary.skipped.push({ creator: creator.handle, url: video.url });
          break;
        }

        // markSeen is atomic: it returns false if another run already claimed
        // this video, which is what stops double-posting.
        const isNew = await markSeen(creator, video.id);
        if (!isNew) continue;

        if (!dryRun) {
          await postMessage(targetChannel, render(template, video, creator));
        }
        postsLeft--;
        summary.posted.push({ creator: creator.handle, url: video.url });
      }

      await trimSeen(creator, videos.map((v) => v.id));
    } catch (err) {
      summary.errors.push({
        creator: `${creator.platform}:${creator.handle}`,
        error: String(err?.message || err),
        disabled: Boolean(err?.disabled),
      });
    }
  }

  if (metered.length) {
    await setCursor((cursor + meteredSlice.length) % metered.length);
  }

  // Lowest scraper credit balance seen this run, so the cron log doubles as a
  // budget warning. null when the provider doesn't report credits.
  summary.creditsRemaining = takeCreditsReading();

  // Running out of credits makes TikTok and Instagram fail quietly while
  // YouTube carries on, which is easy to miss until someone notices the
  // channel has gone thin. Say so in the channel instead, at most once every
  // 12 hours so it can't become its own spam.
  const threshold = num(process.env.LOW_CREDIT_WARNING, 500);
  if (
    threshold > 0 &&
    Number.isFinite(summary.creditsRemaining) &&
    summary.creditsRemaining < threshold
  ) {
    const perRun = summary.meteredChecked || 1;
    const runsLeft = Math.floor(summary.creditsRemaining / perRun);
    if (await claimAlert("low-credits", 12 * 60 * 60)) {
      summary.warned = true;
      if (!dryRun) {
        await postMessage(
          targetChannel,
          `⚠️ Scraper credits low: **${summary.creditsRemaining}** left ` +
            `(~${runsLeft} more checks at ${perRun}/run). ` +
            `TikTok and Instagram stop when these run out — YouTube keeps working.`,
        );
      }
    }
  }

  return summary;
}
