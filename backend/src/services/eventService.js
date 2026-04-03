// ─── NMS Live Events Service ──────────────────────────────────────────────────
//
// Fetches upcoming community events from the NMS API, caches them,
// and exposes findRelevantEvents() for the AI response pipeline.
//
// NOTE: The events endpoint needs the same Cloudflare x-bot-key bypass
// rule as /api/courses. Until that's added, this service returns [].

const NMS_BASE  = process.env.NMS_API_URL || "https://newmindstart.com";
const CACHE_TTL = 30 * 60 * 1000; // 30 min — events change more frequently

let cache = { events: [], fetchedAt: 0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAuthorName(author_info) {
  try {
    const parsed = typeof author_info === "string" ? JSON.parse(author_info) : author_info;
    return parsed?.[0]?.name ?? null;
  } catch { return null; }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllEvents() {
  const nmsKey = process.env.NMS_BOT_KEY;
  if (!nmsKey) {
    console.warn("[eventService] NMS_BOT_KEY not set.");
    return [];
  }

  const all  = [];
  let   page = 1;

  while (true) {
    const url = `${NMS_BASE}/api/events/all-user?per-page=100&page=${page}&expand=thumb&sort=-id`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "x-bot-key": nmsKey },
    });

    if (!res.ok) {
      if (res.status === 403) {
        console.warn("[eventService] 403 — events endpoint not yet whitelisted in Cloudflare. Events disabled until bypass rule is added.");
      } else {
        console.error(`[eventService] API error ${res.status}: ${url}`);
      }
      break;
    }

    const json       = await res.json();
    const events     = json.data ?? [];
    const pagination = json.pagination ?? {};

    all.push(...events);
    if (page >= (pagination.pagination_page_count ?? 1)) break;
    page++;
  }

  console.log(`[eventService] Loaded ${all.length} events from NMS API.`);
  return all;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

export async function getEvents() {
  if (cache.events.length && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.events;
  }
  cache.events   = await fetchAllEvents();
  cache.fetchedAt = Date.now();
  return cache.events;
}

// ─── Match ────────────────────────────────────────────────────────────────────

export async function findRelevantEvents(userMessage, limit = 2) {
  const events = await getEvents();
  if (!events.length) return [];

  const words = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (!words.length) return [];

  const scored = events
    .map((event) => {
      const haystack = [
        event.title       ?? "",
        event.description ?? "",
        event.excerpt     ?? "",
      ].join(" ").toLowerCase();

      const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
      return { event, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ event }) => event);

  return scored;
}

// ─── Serialise for frontend ───────────────────────────────────────────────────

export function serializeEventForClient(event) {
  return {
    title:     event.title,
    host:      parseAuthorName(event.author_info) ?? event.host ?? null,
    thumb:     event.thumb ?? event.thumb_big ?? null,
    date:      event.starts_at ?? event.date ?? event.start_date ?? null,
    url:       event.url ?? `${NMS_BASE}/events/${event.slug ?? event.id}`,
  };
}
