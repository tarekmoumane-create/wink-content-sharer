// SideShift (the creator-campaign platform) is where creators get signed and
// removed, so it knows who is on the team right now and which accounts they
// post from. When SIDESHIFT_API_KEY is set, the bot watches exactly the TikTok
// and Instagram accounts of creators with an ACTIVE contract there, instead of
// trusting whatever links are still sitting in the handles channel.
//
// Read-only: one scoped Platform API key (Settings → API & MCP → API Keys in
// the SideShift company), sent as x-api-key. Nothing here writes to SideShift.
const base = () => process.env.SIDESHIFT_API_BASE || "https://app.sideshift.app/api/oauth/v1";
const key = () => (process.env.SIDESHIFT_API_KEY || "").trim();
const programId = () => (process.env.SIDESHIFT_PROGRAM_ID || "").trim();
// Clippers (the $2 CPM reposting contracts) are NOT watched: this bot shares the
// UGC creators on the retainer contract. Only the exact value
// SIDESHIFT_CLIPPERS=include lets clippers' accounts in.
const excludeClippers = () => (process.env.SIDESHIFT_CLIPPERS || "exclude").trim().toLowerCase() !== "include";

// The platforms SideShift decides. Anything else (YouTube) still comes from the
// handles channel.
export const SIDESHIFT_PLATFORMS = ["tiktok", "instagram"];

export const hasSideshift = () => Boolean(key());

const clean = (h) => String(h || "").trim().replace(/^@/, "").replace(/[^\w.\-]/g, "").toLowerCase();

async function getPage(path, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const res = await fetch(`${base()}${path}${q ? `?${q}` : ""}`, {
    headers: { "x-api-key": key(), accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SideShift ${path} answered ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Every row of a cursor-paginated list. Throws rather than return half a list:
// a partial roster would look like half the team had left.
async function listAll(path, params = {}) {
  const out = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 50; page++) {
    const body = await getPage(path, { ...params, limit: 100, cursor });
    if (!Array.isArray(body?.data)) throw new Error(`SideShift ${path} sent no data list`);
    out.push(...body.data);
    const more = body.hasMore ?? Boolean(body.nextCursor);
    if (!more || !body.nextCursor || !body.data.length) return out;
    if (seen.has(body.nextCursor)) throw new Error(`SideShift ${path} repeated a page`);
    seen.add(body.nextCursor);
    cursor = body.nextCursor;
  }
  throw new Error(`SideShift ${path} has more than 50 pages`);
}

// Pure: is this contract (in detail) a clipper's? Clippers repost existing
// videos and are paid on views only, through terms set on their own contract.
// Everyone else is on the campaign's terms or a custom per-post rate.
export function isClipperContract(detail) {
  const ps = detail?.paymentStructure;
  return Boolean(ps && ps.paymentStructureMode === "per-creator" && ps.type === "performance");
}

// Pure: an account SideShift no longer tracks for this contract: marked
// inactive, retired (replaced through "Edit handles"; SideShift keeps the row
// with a retiredAt), or one SideShift found doesn't exist. Retired rows still
// say connectionStatus "active", so that field alone is not enough.
const GONE = new Set(["PROFILE_NOT_FOUND", "PROFILE_DOESNT_EXIST"]);
export function isDeadProfile(s) {
  if (!s) return false;
  if (String(s.connectionStatus || "").toLowerCase() === "inactive") return true;
  if (s.retiredAt) return true;
  return GONE.has(String(s.scrapeErrorCode || "").toUpperCase());
}

// Pure: contract rows (plus roster rows, when readable) → the unique accounts
// of everyone with an active contract, as [{ platform, handle, person }]
// (person = whose account it is). Accounts
// SideShift marks "inactive" (it can no longer reach them) are left out, and so
// is every contract whose id is in `skipIds`.
export function accountsFromContracts(contracts, creatorRows = [], program = "", skipIds = new Set()) {
  const extra = new Map();
  for (const cr of creatorRows || []) {
    for (const camp of cr.campaigns || []) {
      if (camp?.contractId) extra.set(String(camp.contractId), camp.handles || []);
    }
  }
  const out = new Map();
  for (const k of contracts || []) {
    if (String(k?.status || "").toLowerCase() !== "active") continue;
    if (program && k.programId !== program) continue;
    if (skipIds.has(String(k.id))) continue;
    const person = String(k.contractorId || k.id);
    const own = Array.isArray(k.socialProfiles) ? k.socialProfiles : [];
    const dead = new Set(own.filter(isDeadProfile).map((s) => `${String(s.platform).toLowerCase()}:${clean(s.handle)}`));
    for (const s of [...own, ...(extra.get(String(k.id)) || []), { platform: k.platform, handle: k.handle }]) {
      const platform = String(s?.platform || "").toLowerCase();
      const handle = clean(s?.handle);
      if (!SIDESHIFT_PLATFORMS.includes(platform) || handle.length < 2) continue;
      if (dead.has(`${platform}:${handle}`)) continue;
      if (!out.has(`${platform}:${handle}`)) out.set(`${platform}:${handle}`, { platform, handle, person });
    }
  }
  return [...out.values()];
}

// Pure: has the brand paused this contract ("Pause new posts" in SideShift)?
// Paused people are not watched until unpaused.
export function isPausedContract(detail) {
  return Boolean(detail?.pauseNewPosts);
}

// What each active contract is: a clipper's, paused, or neither. Telling takes
// one detail read per contract, and this bot runs every 15 minutes, so each
// answer is remembered for a day. Throws if a contract can't be read: guessing
// would either drop a creator or let a clipper in.
const KIND_TTL_MS = 24 * 60 * 60 * 1000;
async function readContractKinds(contracts, cache) {
  const known = (await cache.get().catch(() => null)) || {};
  const now = Date.now();
  const fresh = {};
  for (const k of contracts) {
    const id = String(k.id);
    let entry = known[id];
    if (!entry || now - entry.at > KIND_TTL_MS || !("paused" in entry)) {
      const body = await getPage(`/contracts/${encodeURIComponent(id)}`, {});
      const detail = body?.data || body;
      entry = { clipper: isClipperContract(detail), paused: isPausedContract(detail), at: now };
    }
    fresh[id] = entry;
  }
  await cache.set(fresh).catch(() => {});
  return fresh;
}

// The accounts of everyone with an active, unpaused contract right now.
// `kindCache` is { get, set } for remembering what each contract is.
export async function fetchActiveAccounts(kindCache) {
  const program = programId();
  const contracts = await listAll("/contracts", { status: "active", programId: program });
  // The roster list repeats the handles per contract. A second source for the
  // same fact, so a key without the creators scope still works.
  let creatorRows = [];
  try {
    creatorRows = await listAll("/creators", { programId: program });
  } catch {
    creatorRows = [];
  }
  const active = contracts.filter(
    (k) => String(k?.status || "").toLowerCase() === "active" && (!program || k.programId === program),
  );
  const kinds = await readContractKinds(active, kindCache || { get: async () => null, set: async () => {} });
  const skip = new Set();
  for (const [id, v] of Object.entries(kinds)) {
    if (v.paused || (v.clipper && excludeClippers())) skip.add(id);
  }
  return accountsFromContracts(contracts, creatorRows, program, skip);
}
