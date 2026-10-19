// Minimal Discord REST client. Deliberately no discord.js: that library opens a
// persistent gateway websocket, which a serverless function on Vercel cannot
// hold open. Everything this bot does — read a channel's history, post a
// message — is a plain HTTP call, so plain fetch is all we need.
// Overridable so the integration test can point the client at a local stand-in
// and exercise the real request/retry code without touching Discord.
const API = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";

function authHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "ContentSharer (https://vercel.com, 0.1.0)",
  };
}

// Discord replies 429 with a `retry_after` in seconds when we go too fast.
// Honour it rather than hammering, and give up after a few tries so a single
// stuck channel can't burn the whole function timeout.
async function call(path, options = {}, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });

  if (res.status === 429 && attempt < 3) {
    const body = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 100;
    await new Promise((r) => setTimeout(r, waitMs));
    return call(path, options, attempt + 1);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Discord ${options.method || "GET"} ${path} -> ${res.status} ${detail.slice(0, 300)}`);
  }

  return res.status === 204 ? null : res.json();
}

// Pulls a channel's history newest-first, paging backwards until we have `limit`
// messages or the channel runs out. The handles channel is usually small, but
// paging means a server with hundreds of creators still works.
export async function fetchChannelMessages(channelId, limit = 500) {
  const out = [];
  let before = null;

  while (out.length < limit) {
    const batch = Math.min(100, limit - out.length);
    const q = new URLSearchParams({ limit: String(batch) });
    if (before) q.set("before", before);

    const page = await call(`/channels/${channelId}/messages?${q}`);
    if (!Array.isArray(page) || page.length === 0) break;

    out.push(...page);
    before = page[page.length - 1].id;
    if (page.length < batch) break;
  }

  return out;
}

export async function postMessage(channelId, content) {
  return call(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      // Nothing this bot posts should ever ping anyone — it's a firehose of
      // links, and @everyone in a creator's video title would be miserable.
      allowed_mentions: { parse: [] },
    }),
  });
}

// Used by /api/health to prove the token works and the channels are reachable
// before you wait 15 minutes for a cron run to tell you otherwise.
export async function getChannel(channelId) {
  return call(`/channels/${channelId}`);
}
