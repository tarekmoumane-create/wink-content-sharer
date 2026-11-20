import http from "node:http";

// --- Minimal in-memory Upstash-REST-compatible server ----------------------
// The @upstash/redis client POSTs a JSON command array like ["SADD","k","v"]
// and expects {"result": ...}. Implementing the handful of commands the bot
// uses lets the real store.js run untouched.
export function startFakeRedis() {
  const strings = new Map();
  const sets = new Map();
  const set = (k) => sets.get(k) ?? (sets.set(k, new Set()), sets.get(k));

  let commands = 0;
  const exec = ([cmd, ...args]) => {
    commands++;
    switch (String(cmd).toLowerCase()) {
      case "get": return strings.has(args[0]) ? strings.get(args[0]) : null;
      case "set": {
        // Supports the NX flag the alert latch relies on; EX is accepted and
        // ignored since tests don't need real expiry.
        const flags = args.slice(2).map((f) => String(f).toUpperCase());
        if (flags.includes("NX") && strings.has(args[0])) return null;
        strings.set(args[0], args[1]);
        return "OK";
      }
      case "sadd": { const s = set(args[0]); let n = 0;
        for (const v of args.slice(1)) if (!s.has(String(v))) { s.add(String(v)); n++; } return n; }
      case "sismember": return set(args[0]).has(String(args[1])) ? 1 : 0;
      case "smismember": return args.slice(1).flat().map((v) => (set(args[0]).has(String(v)) ? 1 : 0));
      case "mget": return args.flat().map((k) => (strings.has(k) ? strings.get(k) : null));
      case "scard": return set(args[0]).size;
      case "smembers": return [...set(args[0])];
      case "del": { let n = 0; for (const k of args) { if (strings.delete(k)) n++; if (sets.delete(k)) n++; } return n; }
      default: throw new Error(`fake redis: unsupported ${cmd}`);
    }
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "[]");
        const result = Array.isArray(parsed[0])
          ? parsed.map((c) => ({ result: exec(c) }))   // pipeline
          : { result: exec(parsed) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message) }));
      }
    });
  });

  return new Promise((r) => server.listen(0, () =>
    r({ url: `http://127.0.0.1:${server.address().port}`, server,
        commands: () => commands,
        dump: () => ({ strings: [...strings], sets: [...sets].map(([k,v])=>[k,[...v]]) }) })));
}

// --- Minimal Discord API stand-in ------------------------------------------
export function startFakeDiscord(channelMessages) {
  const posted = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const msgMatch = url.pathname.match(/^\/channels\/(\d+)\/messages$/);
    const chanMatch = url.pathname.match(/^\/channels\/(\d+)$/);

    if (msgMatch && req.method === "GET") {
      const before = url.searchParams.get("before");
      let all = channelMessages[msgMatch[1]] ?? [];
      if (before) all = all.slice(all.findIndex((m) => m.id === before) + 1);
      const page = all.slice(0, Number(url.searchParams.get("limit") || 50));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(page));
    }

    if (msgMatch && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        posted.push({ channel: msgMatch[1], ...JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: String(Date.now()) }));
      });
    }

    if (chanMatch) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: chanMatch[1], name: `chan-${chanMatch[1]}` }));
    }

    res.writeHead(404); res.end("{}");
  });

  return new Promise((r) => server.listen(0, () =>
    r({ url: `http://127.0.0.1:${server.address().port}`, server, posted })));
}
