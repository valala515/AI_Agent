// ─── NMS Live Events Service ──────────────────────────────────────────────────
//
// Fetches upcoming community events from the NMS API, caches them,
// and exposes findRelevantEvents() for the AI response pipeline.
//
// Cache TTL: 30 minutes (events are time-sensitive).
// Eager refresh: every Friday at 09:00 local server time.
//
// NOTE: The events endpoint needs the same Cloudflare x-bot-key bypass
// rule as /api/courses. Until that's added, this service returns [].

const NMS_BASE    = process.env.NMS_API_URL || "https://newmindstart.com";
const CACHE_TTL   = 30 * 60 * 1000; // 30 min
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let cache = { events: [], fetchedAt: 0 };

// ─── Friday 09:00 eager refresh ───────────────────────────────────────────────

function msUntilFriday9AM() {
  const now    = new Date();
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  let daysUntil = (5 - now.getDay() + 7) % 7;
  if (daysUntil === 0 && now.getHours() >= 9) daysUntil = 7;
  target.setDate(now.getDate() + daysUntil);
  return target.getTime() - now.getTime();
}

(function scheduleFridayRefresh() {
  const delay = msUntilFriday9AM();
  console.log(`[eventService] Next Friday refresh in ~${Math.round(delay / 3_600_000)}h`);
  const t = setTimeout(function runRefresh() {
    console.log("[eventService] Friday morning event refresh…");
    fetchAllEvents().then((events) => {
      cache.events    = events;
      cache.fetchedAt = Date.now();
    });
    const next = setTimeout(runRefresh, ONE_WEEK_MS);
    next.unref();
  }, delay);
  t.unref();
}());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAuthorName(author_info) {
  try {
    const parsed = typeof author_info === "string" ? JSON.parse(author_info) : author_info;
    return parsed?.[0]?.name ?? null;
  } catch { return null; }
}

function toAbsoluteUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${NMS_BASE}${value}`;
  return `${NMS_BASE}/${value.replace(/^\.?\//, "")}`;
}

function pickThumbCandidate(source) {
  if (!source) return null;

  if (typeof source === "string") {
    return toAbsoluteUrl(source);
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = pickThumbCandidate(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof source === "object") {
    const candidates = [
      source.url,
      source.path,
      source.src,
      source.source_url,
      source.file,
      source.file_path,
      source.image,
      source.image_url,
      source.thumb,
      source.thumb_big,
      source.thumbnail,
      source.thumbnail_url,
      source.preview,
      source.preview_url,
      source.original,
      source.original_url,
      source.full,
      source.full_url,
      source.formats?.thumbnail?.url,
      source.formats?.small?.url,
      source.formats?.medium?.url,
      source.formats?.large?.url,
      source.attributes?.url,
      source.attributes?.path,
      source.data?.attributes?.url,
      source.data?.attributes?.path,
    ];

    for (const candidate of candidates) {
      const found = pickThumbCandidate(candidate);
      if (found) return found;
    }
  }

  return null;
}

function resolveEventThumb(event) {
  return (
    pickThumbCandidate(event.thumb) ||
    pickThumbCandidate(event.thumb_big) ||
    pickThumbCandidate(event.image) ||
    pickThumbCandidate(event.image_url) ||
    pickThumbCandidate(event.cover) ||
    pickThumbCandidate(event.cover_image) ||
    pickThumbCandidate(event.banner) ||
    pickThumbCandidate(event.media) ||
    null
  );
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
    thumb:     resolveEventThumb(event),
    date:      event.starts_at ?? event.date ?? event.start_date ?? null,
    url:       event.event_link ?? event.url ?? `${NMS_BASE}/events/${event.slug ?? event.id}`,
  };
}
