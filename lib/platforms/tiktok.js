// TikTok has no official API that will list an arbitrary creator's uploads, so
// this goes through whichever scraper SCRAPER_PROVIDER names. Every provider is
// normalised to the same { id, url, title, author, publishedAt } shape the rest
// of the bot expects.
import {
  provider,
  ScraperDisabled,
  runApifyActor,
  callRapidApi,
  callScrapeCreators,
  noteCredits,
  toIso,
  firstOf,
  asArray,
} from "./scraper.js";

function normalise(raw, handle) {
  const id = firstOf(raw, "aweme_id", "id", "video_id", "videoId");
  if (!id) return null;

  const author =
    firstOf(raw, "author.unique_id", "authorMeta.name", "author.uniqueId", "authorUniqueId") ||
    handle;

  return {
    id: String(id),
    // `url` is the clean canonical link. `share_url` carries tracking params
    // (_r, u_code, share_item_id…) that make the Discord post ugly, so it is
    // only a fallback.
    url:
      firstOf(raw, "url", "webVideoUrl", "share_url") ||
      `https://www.tiktok.com/@${author}/video/${id}`,
    title: firstOf(raw, "desc", "text", "title", "description") || "",
    author,
    publishedAt: toIso(
      firstOf(raw, "create_time_utc", "createTimeISO", "create_time", "createTime", "createtime"),
    ),
  };
}

export async function fetchRecent(creator, count = 5) {
  const p = provider();

  if (p === "scrapecreators") {
    const json = await callScrapeCreators("/v3/tiktok/profile/videos", {
      handle: creator.handle,
    });
    noteCredits(json);
    const items = asArray(json, "aweme_list", "items");
    return items.map((i) => normalise(i, creator.handle)).filter(Boolean).slice(0, count);
  }

  if (p === "apify") {
    const items = await runApifyActor(
      process.env.APIFY_TIKTOK_ACTOR || "clockworks~tiktok-scraper",
      {
        profiles: [creator.handle],
        resultsPerPage: count,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      },
    );
    return items.map((i) => normalise(i, creator.handle)).filter(Boolean).slice(0, count);
  }

  if (p === "rapidapi") {
    const json = await callRapidApi(
      process.env.RAPIDAPI_TIKTOK_HOST || "tiktok-scraper7.p.rapidapi.com",
      "/user/posts",
      { unique_id: `@${creator.handle}`, count: String(count), cursor: "0" },
    );
    const items = asArray(json, "data.videos", "data.itemList", "data", "videos");
    return items.map((i) => normalise(i, creator.handle)).filter(Boolean).slice(0, count);
  }

  throw new ScraperDisabled("TikTok");
}
