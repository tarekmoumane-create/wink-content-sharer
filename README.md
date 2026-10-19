# Content Sharer

A Discord bot that reads creator accounts from one channel and posts their new
videos into another channel automatically.

You don't maintain a list anywhere. Whatever links live in your handles channel
*are* the list — paste a new creator in, and the next run starts watching them.

```
#creator-handles                          #new-videos
┌────────────────────────┐                ┌──────────────────────────────┐
│ tiktok.com/@someone    │   ──cron──▶    │ **someone** just posted on   │
│ youtube.com/@another   │   every 15m    │ tiktok                       │
│ instagram.com/third    │                │ https://tiktok.com/@...      │
└────────────────────────┘                └──────────────────────────────┘
```

## Why there's no `discord.js` here

A normal Discord bot holds a websocket open forever. Vercel is serverless —
nothing stays running — so that design can't deploy there. Instead this runs as
a **cron job** that talks to Discord's plain HTTP API: it reads the handles
channel, checks each creator, posts what's new, and exits. Same result, and it
fits the hosting you already use.

## Platform support

| Platform | Cost per check | What it needs |
|---|---|---|
| **YouTube** | Free | Nothing. Public RSS feed, falling back to the channel's upload grid. Covers Shorts and long-form. |
| **TikTok** | 1 scraper credit | `SCRAPER_PROVIDER=scrapecreators` + `SCRAPECREATORS_API_KEY`. |
| **Instagram** | 1 scraper credit | Same key. Only video/Reel posts are shared; photos are skipped. |

Providers are pluggable: `scrapecreators` (wired up and in use), `apify`, or
`rapidapi`. `none` disables TikTok/Instagram and leaves YouTube working.

TikTok and Instagram have no official API that lists a given creator's uploads,
so a third-party scraper is unavoidable. Both platforms go through one small
interface (`lib/platforms/scraper.js`), so switching vendors is an env var, not
a rewrite. Leave `SCRAPER_PROVIDER=none` and YouTube still works fine.

## Setup

### 1. Create the Discord bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. That's `DISCORD_BOT_TOKEN`.
3. On the same tab, turn **Message Content Intent** ON. Without it the bot
   reads your handles channel as a wall of blank messages.
4. **OAuth2 → URL Generator**: scope `bot`, permissions **View Channels**,
   **Read Message History**, **Send Messages**. Open the generated URL and add
   the bot to your server.
5. Make sure the bot can actually see both channels (check channel-level
   permission overrides, not just the server-wide role).

### 2. Get the channel IDs

Discord → Settings → Advanced → **Developer Mode** on. Then right-click each
channel → **Copy Channel ID**.

- `DISCORD_SOURCE_CHANNEL_ID` — where the handles live
- `DISCORD_TARGET_CHANNEL_ID` — where videos get posted

### 3. Deploy

```bash
npm install
vercel                      # first deploy, links the project
```

In the Vercel dashboard: **Storage → Upstash Redis → Connect**. That sets
`KV_REST_API_URL` and `KV_REST_API_TOKEN` for you (same setup as
`follow-up-backend`).

Then add the rest under **Settings → Environment Variables** — see
`.env.example` for the annotated list. At minimum:

```
DISCORD_BOT_TOKEN
DISCORD_SOURCE_CHANNEL_ID
DISCORD_TARGET_CHANNEL_ID
CRON_SECRET          # any long random string
```

Redeploy so the cron picks them up: `vercel --prod`.

### 4. Verify before waiting on a cron

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/health
```

This reports whether the token works, whether both channels are reachable, and
**exactly which creators it parsed** — the fastest way to confirm your handles
channel is being read the way you expect.

Then do a no-op trial run that posts nothing:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-app>.vercel.app/api/cron?dryRun=1"
```

## ⚠️ The scraper budget is the real constraint

TikTok and Instagram cost **one credit per creator per check**. YouTube is free
and is never counted against the budget.

```
credits/day = MAX_METERED_PER_RUN x runs-per-day
```

At the current setup — 23 TikTok/Instagram creators, cron every 15 minutes,
`MAX_METERED_PER_RUN=25` (so everyone every run):

| MAX_METERED_PER_RUN | credits/day | credits/month | each creator checked every |
|---|---|---|---|
| 25 (all) | 2,208 | 66,240 | 15 min |
| **2 (current)** | **192** | **5,760** | **~2.9 h — matches MEE6** |
| 12 | 1,152 | 34,560 | ~30 min |
| 6 | 576 | 17,280 | ~1 hour |
| 3 | 288 | 8,640 | ~2 hours |

Dialling it down never drops a creator — the rotating cursor just gets to them
on a later run. Change it with one command, no code redeploy:

```bash
printf '6' | vercel env add MAX_METERED_PER_RUN production --force
vercel deploy --prod
```

When credits run out, TikTok/Instagram checks fail individually and are listed
in the cron summary's `errors`. YouTube keeps working and nothing crashes —
which is exactly why it's easy to miss, so the bot posts a warning into the
target channel when the balance drops below `LOW_CREDIT_WARNING` (default 500),
at most once every 12 hours.

**Note:** Vercel Hobby cron only fires once per day; every-15-minutes needs Pro.

## YouTube: why there are two code paths

The RSS feed is the cheap path and gives exact publish dates, so it is tried
first. But it is unreliable for this roster: it returns **404 for channels that
demonstrably have uploads** — reproducibly, not as a blip — and intermittently
500s. Shorts-only channels are the worst affected, and most creators here post
Shorts exclusively.

So when the feed fails or comes back empty, the bot reads the channel's own
upload grid instead. Still free, still no API key. The tradeoff is that the
grid has no exact timestamps, only "3 days ago" text, so those videos carry a
null date and rely on grid order (newest first, reversed before posting).

**The one thing not to break here:** only `richItemRenderer` entries — the
channel's own uploads — may be read. A YouTube channel page mentions plenty of
*other* channels' video ids in recommendations and sidebars, and scooping those
up would post strangers' videos under your creator's name.
`tests/youtube.mjs` seeds the fixture with decoy ids specifically to catch that.

## Backing off creators who have never posted

A creator with no videos at all still costs a credit every time they are
checked. Those creators are re-checked on an escalating delay — 30 min, 1 h,
2 h, 4 h, then capped — instead of every run, and a deferred creator releases
its credit slot to someone active rather than just being skipped.

The delay resets to zero the instant they post anything, so a debut is never
missed by more than the current wait. Only TikTok and Instagram are affected;
YouTube is free, so throttling it would cost freshness and save nothing.

`BACKOFF_START_AT` schedules activation. The cron summary reports
`backoff: "active"` or `"scheduled for <date>"`, plus a `deferred` list of who
is currently being skipped.

## Behaviour worth knowing

- **Adding a creator never floods the channel.** The first time a creator is
  seen, their existing videos are marked as already-posted and nothing is sent.
  Set `BACKFILL_ON_ADD=latest` if you'd rather announce their newest video.
- **No double-posting.** Claiming a video is a single atomic Redis operation, so
  two overlapping runs can't both post it. The same YouTube channel listed as
  both `@handle` and `/channel/UC...` collapses onto one identity.
- **One broken creator doesn't stop the run.** Failures are collected and
  returned in the cron response; everyone else still gets checked.
- **Caps keep runs bounded.** `MAX_CREATORS_PER_RUN` rotates through a large
  roster across runs; `MAX_POSTS_PER_RUN` stops a burst from spamming the
  channel. Anything skipped is picked up next run, never dropped.
- **Nothing the bot posts can ping anyone** — mentions are stripped.

## Layout

```
api/
  cron.js          the scheduled job (this is the whole product)
  health.js        setup check: token, channels, parsed creator list
lib/
  poll.js          core logic: what's new, what to post
  creators.js      parses the handles channel into creators
  discord.js       minimal Discord REST client
  store.js         Upstash Redis: seen videos, caches, cursor
  platforms/
    index.js       registry
    youtube.js     RSS, no key needed
    tiktok.js      via scraper
    instagram.js   via scraper
    scraper.js     ScrapeCreators / Apify / RapidAPI provider layer
```

### Adding a platform

Write a module exporting `fetchRecent(creator, count)` that returns
`{ id, url, title, author, publishedAt }` objects, add it to the registry in
`lib/platforms/index.js`, and teach `lib/creators.js` to recognise its URLs.
Nothing else changes.

## Tuning

All optional, all in `.env.example` with comments:

| Variable | Default | Does |
|---|---|---|
| `MAX_METERED_PER_RUN` | 10 | TikTok/IG creators per run = the run's credit bill. YouTube is exempt and always fully checked |
| `VIDEOS_PER_CHECK` | 5 | How far back to look per creator |
| `MAX_POSTS_PER_RUN` | 15 | Ceiling on messages per run |
| `BACKFILL_ON_ADD` | `none` | `none` or `latest` |
| `IGNORE_CREATORS` | empty | `platform:handle` list to skip (another bot covers them) |
| `LOW_CREDIT_WARNING` | 500 | Warn in-channel below this balance; 0 disables |
| `BACKOFF_START_AT` | empty | Date to activate never-posted backoff; empty = on now |
| `POST_TEMPLATE` | see below | `{name}` `{url}` `{platform}` `{title}` |

```
**{name}** just posted on {platform}
{url}
```

Posting the bare URL on its own line is deliberate — Discord unfurls it into a
playable embed. Wrapping it in markdown breaks that.


## Live deployment

Deployed to Vercel as **content-sharer** under `tarekmoumane-3300's projects`
(Pro, so the 15-minute cron is valid).

- Source: `#hype-creator-handles` (`1470807434443620393`)
- Target: `#content` (`1466107031650959416`)
- Server: Hype UGC — bot is `Content Sharer#7242`
- Storage: Upstash `upstash-kv-gray-basket`, auto-connected

Currently watching **30 creators**: 12 Instagram, 11 TikTok, 7 YouTube.

### MEE6 shares this channel — measured, not guessed

MEE6 posts Instagram content into `#content` for 11 creators. Display names in
its messages are not handles, so each was resolved by looking up the owner of a
post it linked:

| MEE6 name | Instagram handle | Last posted | In handles channel? |
|---|---|---|---|
| julian | `trades.byju` | active | **yes — overlap** |
| Sophie | `sophierosesdiary` | active | **yes — overlap** |
| aly | `alyybuildswealth` | Jun | no |
| Keishun | `mintz.trades` | Jul | no |
| Bobby | `jack.tradesmemes` | Mar | no |
| fran | `fran.hype_` | Mar | no |
| Tom | `tradewithtom01` | Feb | no |
| Braedon, elliott, Seth, karthik | unresolved (posts deleted) | Feb–Mar | unknown |

Only **two** genuinely overlap, and both are ignored:

```
IGNORE_CREATORS=instagram:trades.byju,instagram:sophierosesdiary
```

Everything else in the handles channel is this bot's. The five MEE6-only
handles are deliberately *not* added here — MEE6 already covers them.

Note that only julian and Sophie are still posting; MEE6's other nine have been
quiet for months. If MEE6 is ever switched off, only those five handles above
need adding here.

### How often MEE6 fires

Measured from 20 posts by its two active creators, comparing the Instagram
timestamp to the Discord message:

| | julian | Sophie |
|---|---|---|
| fastest | 35 min | 12 min |
| **median** | **204 min** | **327 min** |
| slowest | 338 min | 2364 min (39 h) |

**MEE6's median lag is about 4 hours**, occasionally over a day.

This bot is tuned to match that on the paid platforms: `MAX_METERED_PER_RUN=2`
puts each TikTok/Instagram creator on a ~2.9 hour rotation, comfortably inside
MEE6's 4.1 hour median, for **192 credits/day instead of 2,208** — an 11x
saving for cadence the server has lived with for months.

The cron itself stays at **15 minutes**, not 4 hours. YouTube costs nothing, so
slowing it down would sacrifice freshness for no saving. Only the metered
platforms are rate-limited, and they are limited by the per-run quota rather
than the schedule.

Once backoff activates, the ~13 creators who have never posted stop consuming
those two slots, so the active creators roughly double in frequency again.

The practical consequence of the ignore list: the two ignored creators arrive
on MEE6's slow schedule. If freshness on them matters more than avoiding a
duplicate, remove them from `IGNORE_CREATORS` and accept two copies.

`/api/health` reports the active `ignored` list, so a deliberately-skipped
creator is never mistaken for a bug.

### Checking on it

```bash
# what it parsed, whether channels and token still work
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/health

# force a run; add ?dryRun=1 to post nothing (still spends credits)
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/cron
```

The cron response is the health report: `posted`, `initialised`, `empty`
(known creators whose feed returned nothing — a mistyped or dead handle shows
up here), `errors`, and `creditsRemaining`.
