// SideShift as the source of truth for who the bot watches. Discord, Redis and
// SideShift are all local stand-ins; the real creators.js / sideshift.js /
// store.js code runs untouched.
import http from "node:http";
import { startFakeRedis, startFakeDiscord } from "./fakes.mjs";

const SOURCE = "111111111111111111";
const msg = (id, authorId, content) => ({ id, author: { id: authorId }, content, embeds: [] });

// The handles channel after a month of churn: Anna is still on the team, Kayla
// left (her links are still sitting there), and nobody told Nova to post hers.
const messages = {
  [SOURCE]: [
    msg("9", "anna", "https://www.tiktok.com/@annasfinds https://www.instagram.com/annasfinds"),
    msg("8", "anna", "and my shorts https://www.youtube.com/@annashorts"),
    msg("7", "kayla", "https://www.tiktok.com/@kaylaleft"),
    msg("6", "kayla", "https://www.youtube.com/@kaylatube"),
    msg("5", "anna", "old account, not on my contract: https://www.tiktok.com/@anna.old"),
    msg("4", "ghostgirl", "https://www.instagram.com/ghostpage and my tiktok https://www.tiktok.com/@ghost.tiktok"),
  ],
};

// --- Minimal SideShift Platform API stand-in -------------------------------
const contract = (id, name, profiles, extra = {}) => ({
  id, contractorId: `user-${id}`, contractorName: name, programId: "prog1", status: "active",
  socialProfiles: profiles.map(([platform, handle]) => ({ platform, handle })), ...extra,
});
const sideshift = { mode: "ok", calls: [], keys: new Set() };
const CONTRACTS = [
  contract("c1", "Anna", [["tiktok", "@AnnasFinds"], ["instagram", "annasfinds"], ["facebook", "6159"]], {
    socialProfiles: [
      { platform: "tiktok", handle: "@AnnasFinds", connectionStatus: "active" },
      { platform: "instagram", handle: "annasfinds", connectionStatus: "active" },
      { platform: "facebook", handle: "6159", connectionStatus: "active" },
      { platform: "instagram", handle: "anna.deadaccount", connectionStatus: "inactive" },
      { platform: "tiktok", handle: "anna.retired", connectionStatus: "active", scrapeErrorCode: "PROFILE_NOT_FOUND", retiredAt: "2026-11-12T22:07:15Z" },
      { platform: "instagram", handle: "anna.vanished", connectionStatus: "active", scrapeErrorCode: "PROFILE_DOESNT_EXIST" },
    ],
  }),
  contract("c2", "Nova", [["tiktok", "novathrifts"]]),
  contract("c3", "Kayla", [["tiktok", "kaylaleft"]], { status: "cancelled" }),
  contract("c4", "Elsewhere", [["tiktok", "othercampaign"]], { programId: "prog2" }),
  contract("c5", "Ghost", [], { platform: "instagram", handle: "ghostpage" }),
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  sideshift.calls.push(url.pathname + url.search);
  sideshift.keys.add(req.headers["x-api-key"]);
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (sideshift.mode === "down") return send(503, { error: "unavailable" });
  if (sideshift.mode === "empty") return send(200, { data: [], hasMore: false });
  if (url.pathname === "/contracts") {
    // Two pages, to prove the cursor is followed.
    return url.searchParams.get("cursor")
      ? send(200, { data: CONTRACTS.slice(2), hasMore: false, nextCursor: null })
      : send(200, { data: CONTRACTS.slice(0, 2), hasMore: true, nextCursor: "page2" });
  }
  const one = url.pathname.match(/^\/contracts\/(\w+)$/);
  if (one) {
    // Nova is a clipper: views-only pay on her own contract.
    return send(200, { data: one[1] === "c2" ? { paymentStructure: { type: "performance", paymentStructureMode: "per-creator" } } : {} });
  }
  if (url.pathname === "/creators") {
    return send(200, { data: [
      { id: "user-c2", name: "Nova", campaigns: [{ contractId: "c2", handles: [{ platform: "instagram", handle: "nova.ig" }] }] },
      { id: "user-c1", name: "Anna", campaigns: [{ contractId: "c1", handles: [{ platform: "instagram", handle: "anna.deadaccount" }] }] },
    ], hasMore: false });
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, r));

const redis = await startFakeRedis();
const discord = await startFakeDiscord(messages);
process.env.KV_REST_API_URL = redis.url;
process.env.KV_REST_API_TOKEN = "test";
process.env.DISCORD_API_BASE = discord.url;
process.env.DISCORD_BOT_TOKEN = "test-token";
process.env.SIDESHIFT_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.SIDESHIFT_PROGRAM_ID = "prog1";

const { loadRoster } = await import("../lib/creators.js");

let failures = [];
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};
const keys = (r) => r.creators.map((c) => `${c.platform}:${c.handle}`).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nNo key: the handles channel is the list, exactly as before");
delete process.env.SIDESHIFT_API_KEY;
const r0 = await loadRoster(SOURCE);
check("source is the channel", r0.source === "channel");
check("every TikTok and Instagram link in the channel is watched, YouTube is not", same(keys(r0), ["instagram:annasfinds", "instagram:ghostpage", "tiktok:anna.old", "tiktok:annasfinds", "tiktok:ghost.tiktok", "tiktok:kaylaleft"]), keys(r0).join(", "));
check("SideShift was not called", sideshift.calls.length === 0);

console.log("\nWith a key (and clippers explicitly included): SideShift's active contracts decide");
process.env.SIDESHIFT_API_KEY = "sspk_test_fake";
process.env.SIDESHIFT_CLIPPERS = "include";
const r1 = await loadRoster(SOURCE);
const expected = ["instagram:annasfinds", "instagram:ghostpage", "instagram:nova.ig", "tiktok:annasfinds", "tiktok:ghost.tiktok", "tiktok:novathrifts"];
check("source is sideshift", r1.source === "sideshift" && !r1.error, r1.error);
check("active creators' accounts are watched, new creator included", same(keys(r1), expected), keys(r1).join(", "));
check("creator who left is gone", !keys(r1).some((k) => k.includes("kayla")));
check("an account that is not on the contract is not watched", !keys(r1).includes("tiktok:anna.old"));
check("other campaigns and other platforms are ignored", !keys(r1).some((k) => k.includes("othercampaign") || k.includes("6159")));
check("no YouTube at all, even for someone still on the team", !keys(r1).some((k) => k.startsWith("youtube")));
check("the key is sent, both pages are read", sideshift.keys.has("sspk_test_fake") && sideshift.calls.some((c) => c.includes("cursor=page2")));
check("asks only for active contracts in the campaign", sideshift.calls.some((c) => c.startsWith("/contracts?status=active&programId=prog1")));
check("a team member's channel link fills in a platform SideShift has nothing for", keys(r1).includes("tiktok:ghost.tiktok"));
check("an account SideShift marks inactive is not watched", !keys(r1).includes("instagram:anna.deadaccount"));
check("a handle retired through Edit handles (still says active) is not watched", !keys(r1).includes("tiktok:anna.retired"));
check("a handle SideShift cannot find is not watched", !keys(r1).includes("instagram:anna.vanished"));
check("no contract was opened one by one when clippers are included", !sideshift.calls.some((c) => /^\/contracts\/\w+/.test(c)));
check("entries carry what the poller needs", r1.creators.every((c) => c.name && !("authorId" in c)) && r1.creators.find((c) => c.handle === "novathrifts")?.sourceUrl === "https://www.tiktok.com/@novathrifts");

console.log("\nSideShift down: the last good answer is reused");
sideshift.mode = "down";
const r2 = await loadRoster(SOURCE);
check("same list as before the outage", same(keys(r2), expected), keys(r2).join(", "));
check("says it used the saved copy, with the reason", r2.source === "sideshift (saved copy)" && /503/.test(r2.error || ""), `${r2.source} / ${r2.error}`);

console.log("\nSideShift answers with nobody: treated as a failure, not as 'everyone left'");
sideshift.mode = "empty";
const r3 = await loadRoster(SOURCE);
check("list unchanged", same(keys(r3), expected));

console.log("\nIGNORE_CREATORS still applies");
sideshift.mode = "ok";
process.env.IGNORE_CREATORS = "tiktok:novathrifts";
const r4 = await loadRoster(SOURCE);
check("ignored account is skipped", !keys(r4).includes("tiktok:novathrifts") && keys(r4).includes("instagram:nova.ig"));
process.env.IGNORE_CREATORS = "";

console.log("\nOut of the box (no SIDESHIFT_CLIPPERS): clippers' accounts are left out");
delete process.env.SIDESHIFT_CLIPPERS;
sideshift.calls.length = 0;
const r6 = await loadRoster(SOURCE);
check("clipper's accounts are gone, everyone else stays", same(keys(r6), ["instagram:annasfinds", "instagram:ghostpage", "tiktok:annasfinds", "tiktok:ghost.tiktok"]), keys(r6).join(", "));
const detailReads = () => sideshift.calls.filter((c) => /^\/contracts\/\w+/.test(c)).length;
check("each active contract in the campaign was read once", detailReads() === 3, `reads=${detailReads()}`);
await loadRoster(SOURCE);
check("the answer is remembered, so the next run reads none", detailReads() === 3, `reads=${detailReads()}`);
process.env.SIDESHIFT_CLIPPERS = "include";

console.log("\nWATCH_PLATFORMS can switch YouTube back on, for team members only");
process.env.WATCH_PLATFORMS = "tiktok,instagram,youtube";
const r7 = await loadRoster(SOURCE);
check("YouTube link of someone on the team is watched", keys(r7).includes("youtube:annashorts"));
check("YouTube link of someone who left is not", !keys(r7).includes("youtube:kaylatube"));
delete process.env.WATCH_PLATFORMS;

console.log("\nSideShift down and nothing saved yet: fall back to the channel");
await fetch(redis.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(["DEL", "sideshift:roster"]) });
sideshift.mode = "down";
const r5 = await loadRoster(SOURCE);
check("channel list is used", r5.source === "channel" && same(keys(r5), keys(r0)), `${r5.source}: ${keys(r5).join(", ")}`);

console.log(failures.length ? `\nFAILURES: ${failures.join(", ")}` : "\nALL CHECKS PASSED");
redis.server.close(); discord.server.close(); server.close();
process.exit(failures.length ? 1 : 0);
