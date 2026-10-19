// GET /api/cron
// Vercel's scheduler hits this on the schedule in vercel.json. It is the only
// moving part in production: read the handles channel, check every creator,
// post whatever is new.
//
// Vercel attaches `Authorization: Bearer $CRON_SECRET` to scheduled requests,
// so the same secret is what lets you trigger a run by hand:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/cron
//
// Add ?dryRun=1 to see what it *would* post without touching the channel.
import { runPoll } from "../lib/poll.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const startedAt = Date.now();
  try {
    const summary = await runPoll({ dryRun: req.query?.dryRun === "1" });
    return res.status(200).json({
      ok: true,
      tookMs: Date.now() - startedAt,
      ...summary,
    });
  } catch (e) {
    // A 500 here shows up in the Vercel cron log, which is where you'll look
    // when the channel goes quiet.
    return res.status(500).json({
      ok: false,
      tookMs: Date.now() - startedAt,
      error: String(e?.message || e),
    });
  }
}
