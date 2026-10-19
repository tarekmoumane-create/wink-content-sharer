// GET /api/health
// Setup check. Confirms the bot token works, both channels are reachable, and
// shows exactly which creators the bot parsed out of the handles channel —
// so you can verify the list is right before waiting on a cron run.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/health
import { getChannel } from "../lib/discord.js";
import { loadCreators, ignoredSet } from "../lib/creators.js";
import { provider } from "../lib/platforms/scraper.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const report = {
    env: {
      DISCORD_BOT_TOKEN: Boolean(process.env.DISCORD_BOT_TOKEN),
      DISCORD_SOURCE_CHANNEL_ID: Boolean(process.env.DISCORD_SOURCE_CHANNEL_ID),
      DISCORD_TARGET_CHANNEL_ID: Boolean(process.env.DISCORD_TARGET_CHANNEL_ID),
      redis: Boolean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
      scraperProvider: provider(),
    },
    ignored: [...ignoredSet()],
    channels: {},
    creators: [],
  };

  try {
    const src = await getChannel(process.env.DISCORD_SOURCE_CHANNEL_ID);
    report.channels.source = { id: src.id, name: src.name, ok: true };
  } catch (e) {
    report.channels.source = { ok: false, error: String(e?.message || e) };
  }

  try {
    const dst = await getChannel(process.env.DISCORD_TARGET_CHANNEL_ID);
    report.channels.target = { id: dst.id, name: dst.name, ok: true };
  } catch (e) {
    report.channels.target = { ok: false, error: String(e?.message || e) };
  }

  try {
    const creators = await loadCreators(process.env.DISCORD_SOURCE_CHANNEL_ID);
    report.creatorCount = creators.length;
    report.byPlatform = creators.reduce((acc, c) => {
      acc[c.platform] = (acc[c.platform] || 0) + 1;
      return acc;
    }, {});
    report.creators = creators.map((c) => `${c.platform}:${c.handle}`);
  } catch (e) {
    report.creatorsError = String(e?.message || e);
  }

  return res.status(200).json(report);
}
