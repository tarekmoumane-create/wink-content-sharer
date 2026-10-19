// Instagram, same story as TikTok: no official API covers listing an arbitrary
// public account's Reels, so this runs through the configured scraper.
//
// Only video posts are shared. Photo posts and carousels of stills are filtered
// out, since the point of this bot is circulating videos.
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

function isVideo(raw) {
  // Instagram's own numeric enum: 1 = photo, 2 = video, 8 = carousel.
  const mediaType = firstOf(raw, "media_type");
  if (mediaType === 2 || mediaType === "2") return true;
  if (mediaType === 1 || mediaType === "1") return false;

  const type = String(firstOf(raw, "product_type", "type", "productType", "__typename") || "");
  if (/video|reel|clips/i.test(type)) return true;

  return firstOf(raw, "video_url", "videoUrl", "video_versions") != null;
}

function normalise(raw, handle) {
  const code = firstOf(raw, "code", "shortCode", "shortcode");
  const id = firstOf(raw, "pk", "id") || code;
  if (!id) return null;

  const author = firstOf(raw, "user.username", "ownerUsername", "username") || handle;

  return {
    // `pk` is stable per post; `code` is the public shortcode. Either works as
    // an identity key, but prefer pk so a URL format change can't resurface an
    // already-posted video as new.
    id: String(id),
    url:
      firstOf(raw, "url", "permalink") ||
      (code ? `https://www.instagram.com/reel/${code}/` : null),
    title: firstOf(raw, "caption.text", "caption", "text", "title") || "",
    author,
    publishedAt: toIso(
      firstOf(raw, "created_at", "taken_at", "timestamp", "taken_at_timestamp"),
    ),
  };
}

export async function fetchRecent(creator, count = 5) {
  const p = provider();
  let items = [];

  if (p === "scrapecreators") {
    const json = await callScrapeCreators("/v2/instagram/user/posts", {
      handle: creator.handle,
    });
    noteCredits(json);
    items = asArray(json, "items", "data.items");
  } else if (p === "apify") {
    items = await runApifyActor(
      process.env.APIFY_INSTAGRAM_ACTOR || "apify~instagram-scraper",
      {
        directUrls: [`https://www.instagram.com/${creator.handle}/`],
        resultsType: "posts",
        // Over-fetch: photos get filtered out below, and we still want `count`
        // videos back when a creator mixes stills into their grid.
        resultsLimit: Math.max(count * 3, 12),
      },
    );
  } else if (p === "rapidapi") {
    const json = await callRapidApi(
      process.env.RAPIDAPI_INSTAGRAM_HOST || "instagram-scraper-api2.p.rapidapi.com",
      "/v1/posts",
      { username_or_id_or_url: creator.handle },
    );
    items = asArray(json, "data.items", "items", "data");
  } else {
    throw new ScraperDisabled("Instagram");
  }

  return items
    .filter(isVideo)
    .map((i) => normalise(i, creator.handle))
    .filter((v) => v && v.url)
    .slice(0, count);
}
