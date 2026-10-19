// Registry of everything the bot knows how to watch. Adding a platform means
// writing one module that exports `fetchRecent(creator, count)` returning
// { id, url, title, author, publishedAt } objects, then listing it here.
import * as youtube from "./youtube.js";
import * as tiktok from "./tiktok.js";
import * as instagram from "./instagram.js";

const REGISTRY = { youtube, tiktok, instagram };

export function supported() {
  return Object.keys(REGISTRY);
}

export async function fetchRecent(creator, count) {
  const adapter = REGISTRY[creator.platform];
  if (!adapter) throw new Error(`unsupported platform: ${creator.platform}`);
  return adapter.fetchRecent(creator, count);
}
