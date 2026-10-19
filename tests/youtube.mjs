// Covers the channel-page fallback used when YouTube's RSS feed 404s, which it
// does routinely for Shorts-only channels.
//
// The critical property under test is scoping: a YouTube channel page mentions
// many OTHER channels' video ids (recommendations, sidebars). Only the
// channel's own upload grid may be read. Getting this wrong posts strangers'
// videos under your creator's name — the same class of bug that once made the
// channel-id lookup resolve to a recommended video's channel.
const OWN = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
const FOREIGN = ["zzzzzzzzzzz", "yyyyyyyyyyy"];

const page = (items) => `<html><script>var ytInitialData = ${JSON.stringify({
  // Decoys first, in the shapes YouTube really uses elsewhere on the page.
  sidebar: { items: FOREIGN.map((id) => ({ compactVideoRenderer: { videoId: id } })) },
  contents: { grid: items },
  footer: { promo: { videoId: FOREIGN[0] } },
})};</script></html>`;

const shortItem = (id, title) => ({
  richItemRenderer: { content: { shortsLockupViewModel: {
    entityId: `shorts-shelf-item-${id}`,
    overlayMetadata: { primaryText: { content: title } },
  } } },
});
const videoItem = (id, title) => ({
  richItemRenderer: { content: { videoRenderer: {
    videoId: id, title: { runs: [{ text: title }] },
  } } },
});

let failures = [];
const check = (n, c, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); if (!c) failures.push(n); };
const line = (s) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);

// Feed always fails, forcing the fallback; /shorts serves the fixture.
function stub(html) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("feeds/videos.xml")) return { ok: false, status: 404, text: async () => "" };
    if (u.includes("/shorts")) return { ok: true, status: 200, text: async () => html };
    return { ok: true, status: 200, text: async () => page([]) };
  };
}

const { fetchRecent } = await import("../lib/platforms/youtube.js");
const creator = { platform: "youtube", handle: "someone", channelId: "UCtesttesttesttesttest" };

line("Shorts-only channel: ids come from entityId, newest last");
stub(page([shortItem(OWN[2], "newest"), shortItem(OWN[1], "middle"), shortItem(OWN[0], "oldest")]));
let vids = await fetchRecent(creator, 5);
console.log(`  got: ${vids.map((v) => `${v.id}(${v.title})`).join(", ")}`);
check("all three extracted", vids.length === 3);
check("oldest first, ready to post in order", vids[0].title === "oldest" && vids[2].title === "newest");
check("urls are watch links", vids.every((v) => v.url === `https://www.youtube.com/watch?v=${v.id}`));
check("titles carried across", vids[1].title === "middle");

line("Foreign video ids elsewhere on the page are NEVER picked up");
check("no recommendation leaked in", !vids.some((v) => FOREIGN.includes(v.id)),
  vids.map((v) => v.id).join(","));

line("Regular (non-Shorts) uploads also work");
stub(page([videoItem(OWN[1], "second"), videoItem(OWN[0], "first")]));
vids = await fetchRecent(creator, 5);
check("videoRenderer entries extracted", vids.length === 2);
check("still oldest-first", vids[0].title === "first");
check("no foreign ids", !vids.some((v) => FOREIGN.includes(v.id)));

line("Mixed grid, duplicates collapsed, count respected");
stub(page([shortItem(OWN[2], "c"), videoItem(OWN[1], "b"), shortItem(OWN[2], "c-dupe"), videoItem(OWN[0], "a")]));
vids = await fetchRecent(creator, 2);
check("duplicate id collapsed", new Set(vids.map((v) => v.id)).size === vids.length);
check("count respected", vids.length === 2, `got ${vids.length}`);

line("A genuinely empty channel returns nothing rather than throwing");
stub(page([]));
vids = await fetchRecent(creator, 5);
check("empty array, no throw", Array.isArray(vids) && vids.length === 0);

// --------------------------------------------------------------------------
// Regression: "couldn't read the page" must NOT look like "account is empty".
// Conflating them marks a creator caught up when they are not, and the next
// successful run posts their entire back catalogue in one burst.
// --------------------------------------------------------------------------
line("Unreadable page THROWS instead of reporting an empty account");
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("feeds/videos.xml")) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => "<html>no ytInitialData here</html>" };
};
let threw = false;
try { await fetchRecent(creator, 5); } catch { threw = true; }
check("throws when nothing could be parsed", threw);

line("Every request failing also THROWS");
globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
threw = false;
try { await fetchRecent(creator, 5); } catch { threw = true; }
check("throws when all fetches fail", threw);

line("Unparseable /shorts but valid /videos still succeeds");
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("feeds/videos.xml")) return { ok: false, status: 404, text: async () => "" };
  if (u.includes("/shorts")) return { ok: true, status: 200, text: async () => "<html>garbage</html>" };
  return { ok: true, status: 200, text: async () => page([videoItem(OWN[0], "only one")]) };
};
vids = await fetchRecent(creator, 5);
check("falls through to /videos", vids.length === 1 && vids[0].title === "only one");

line(failures.length ? `FAILURES: ${failures.join(", ")}` : "ALL YOUTUBE FALLBACK CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
