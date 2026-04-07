// ─── NMS Course Service ───────────────────────────────────────────────────────
//
// Reads from backend/src/data/courses.json (synced by scripts/syncCourses.js).
// No live API call on every chat request — token-safe and fast.
//
// Auto-refresh: every Friday at 09:00 local server time.

import fs      from "fs";
import path    from "path";
import { execFile }     from "child_process";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH   = path.resolve(__dirname, "../data/courses.json");
const SYNC_SCRIPT = path.resolve(__dirname, "../../../scripts/syncCourses.js");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NMS_BASE    = process.env.NMS_API_URL || "https://newmindstart.com";

// ─── Load from file ───────────────────────────────────────────────────────────

function loadFromFile() {
  try {
    const raw  = fs.readFileSync(DATA_PATH, "utf8");
    const json = JSON.parse(raw);
    console.log(`[courseService] Loaded ${json.total} courses from file (synced ${json.syncedAt}).`);
    return json.courses ?? [];
  } catch {
    console.warn("[courseService] courses.json not found — run `npm run sync` to generate it.");
    return [];
  }
}

// In-memory catalogue — populated on first import
let courses = loadFromFile();

// ─── Friday 09:00 background refresh ─────────────────────────────────────────

function msUntilFriday9AM() {
  const now    = new Date();
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  // 0 = Sun … 5 = Fri … 6 = Sat
  let daysUntil = (5 - now.getDay() + 7) % 7;
  // Already past 09:00 on Friday → schedule next Friday
  if (daysUntil === 0 && now.getHours() >= 9) daysUntil = 7;
  target.setDate(now.getDate() + daysUntil);
  return target.getTime() - now.getTime();
}

function scheduleFridaySync() {
  const delay = msUntilFriday9AM();
  console.log(`[courseService] Next Friday sync in ~${Math.round(delay / 3_600_000)}h`);

  const t = setTimeout(function runSync() {
    console.log("[courseService] Friday sync starting…");
    execFile("node", [SYNC_SCRIPT], (err, stdout) => {
      if (err) {
        console.error("[courseService] Friday sync failed:", err.message);
      } else {
        console.log(stdout.trim());
        courses = loadFromFile();
      }
    });
    // Schedule the next Friday
    const next = setTimeout(runSync, ONE_WEEK_MS);
    next.unref();
  }, delay);
  t.unref();
}

scheduleFridaySync();

// ─── Analytics scores (plugged in later) ─────────────────────────────────────

let analyticsScores = {};
export function updateAnalyticsScores(scores) {
  analyticsScores = scores ?? {};
}

// ─── Audience guards ──────────────────────────────────────────────────────────
// Each regex is tested against the course TITLE (and excerpt for women/men).
// passesAudienceGuard() uses the caller-supplied userProfile to decide whether
// to include the course in the scored pool.

const CHILD_COURSE_RE = /\b(kids?|children|child|baby|babies|toddler|newborn|infant|pregnancy|pregnant|maternal|prenatal|postnatal|montessori|mama|mamas|postpartum|birth(?:ing)?)\b/i;
const CHILD_QUERY_RE  = /\b(kids?|children|child|baby|babies|toddler|newborn|infant|son|daughter|pregnancy|pregnant|mama|postpartum)\b/i;

// Women-specific: feminine energy, goddess archetypes, womb/yoni anatomy,
// shakti tradition, sensual-goddess branding, or explicit "women/woman" label.
const WOMEN_COURSE_RE = /\bfeminine\b|\bgoddess\b|\bshakti\b|\byoni\b|\bwomen\b|\bwoman\b/i;

// Men-specific: explicit "men's health/kegel", lingam massage (course for men),
// or erectile/testosterone topics.
const MEN_COURSE_RE = /\bmen'?s\s+(health|kegel)\b|\blingam\s+massage\s+course\b|\berectile\b|\btestosterone\b/i;

// Elderly/anti-aging: explicit 50+/45+ label, "aging", "longevity", "senior",
// "menopause", "reverse aging", or "after 40/45".
const ELDERLY_COURSE_RE = /\b(?:50|60|70|45)\+|\baging\b|anti[- ]aging|reverse\s+aging|\blongevity\b|\bsenior\b|\bmenopause\b|after\s+(?:40|45)\b/i;

/**
 * Returns false if the course targets an audience segment that doesn't
 * match the caller's known profile. Returns true when there is no conflict
 * (including when the relevant profile field is unknown/null).
 */
function passesAudienceGuard(course, userProfile = {}, userAsksAboutChild = false) {
  const title = course.title ?? "";
  const hay   = `${title} ${course.excerpt ?? ""} ${course.body ?? ""}`;

  // ── Kids / parenting ──────────────────────────────────────────────────────
  if (CHILD_COURSE_RE.test(title)) {
    return userAsksAboutChild || userProfile.hasKids === true;
  }

  // ── Men's courses ─────────────────────────────────────────────────────────
  // Guard tested on title+excerpt only — not full body — to avoid false
  // positives where "testosterone" or "erectile" appears in a general
  // hormone-health course that isn't actually targeted at men.
  const titleExcerpt = `${title} ${course.excerpt ?? ""}`;
  if (MEN_COURSE_RE.test(titleExcerpt)) {
    const g = userProfile.gender;
    if (g === "female" || g === "non-binary" || g === "prefer_not") return false;
    return true; // male or unknown → show
  }

  // ── Women's courses ───────────────────────────────────────────────────────
  if (WOMEN_COURSE_RE.test(titleExcerpt)) {
    const g = userProfile.gender;
    if (g === "male" || g === "prefer_not") return false;
    return true; // female, non-binary, or unknown → show
  }

  // ── Elderly / 50+ courses ─────────────────────────────────────────────────
  if (ELDERLY_COURSE_RE.test(hay)) {
    const ag = userProfile.ageGroup;
    if (!ag) return true; // age unknown → show
    if (ag === "under30" || ag === "30s") return false;
    return true; // 40s or 50plus → show
  }

  return true;
}

// ─── Stop words ───────────────────────────────────────────────────────────────
// High-frequency words that appear in almost every course description and carry
// no topical signal — discarding them prevents false-positive matches.
// IMPORTANT: generic action verbs ("start", "learn", "begin") belong here too —
// they appear in virtually every excerpt and add zero topical signal.

const STOP_WORDS = new Set([
  "that","this","with","have","from","they","will","what","when","more",
  "also","about","your","just","like","very","some","been","want","need",
  "feel","help","make","know","think","time","good","better","really",
  "does","into","their","there","these","those","then","than","them",
  "each","much","many","most","here","over","such","only","even","back",
  "both","well","long","able","find","give","live","move","work","take",
  "come","ways","made","used","life","body","mind","self","every","while",
  // Generic action verbs — appear in nearly every course description
  "start","begin","learn","become","improve","practice","discover","explore",
  "build","join","stop","keep","show","goes","lets","gets","puts","gets",
  // Intensifiers / qualifiers — add zero topical signal
  "level","levels","completely","totally","fully","highly","really",
  // Filler words with no topical signal — common in conversational messages
  // and chip labels ("Help me sleep better", "Sometimes I feel...")
  "little","sometimes","would","often","quite","still","always","never",
  "maybe","really","things","other","thing","could","should","today",
  "right","please","thank","something","anything","everything","nothing",
]);

// ─── Synonym map ──────────────────────────────────────────────────────────────
// Maps a user's word (or its stem) → additional search terms to try.
// This bridges the gap between how users describe their goal and how courses
// are titled — e.g. a user says "singing", courses say "voice" / "vocal".

const SYNONYMS = {
  // Voice / music
  "sing":       ["voice", "vocal", "song", "music"],
  "singing":    ["voice", "vocal", "song", "music", "sing"],
  "singer":     ["voice", "vocal", "sing"],
  "voice":      ["vocal", "sing", "throat", "sound"],
  "vocal":      ["voice", "sing", "throat"],
  "song":       ["sing", "voice", "music"],
  "music":      ["sound", "sing", "musical"],
  "throat":     ["voice", "vocal"],
  "chant":      ["sing", "voice", "vocal", "sound"],
  "hum":        ["sing", "voice", "sound"],

  // Sleep
  // "rest" deliberately excluded — \brest\b still matches "restore","restful" etc.
  // Use specific sleep-signal words only.
  "sleep":      ["insomnia", "nidra", "sleepy", "sleepless", "bedtime", "melatonin"],
  "sleeping":   ["sleep", "insomnia", "nidra"],
  "insomnia":   ["sleep", "nidra", "sleepless"],
  "nidra":      ["sleep", "insomnia", "yoga", "relax"],
  "bedtime":    ["sleep", "insomnia", "nidra"],
  "melatonin":  ["sleep", "insomnia"],

  // Stress / anxiety / nervous system
  "stress":     ["anxiety", "cortisol", "nervous", "tension"],
  "anxiety":    ["stress", "anxious", "nervous", "cortisol"],
  "anxious":    ["anxiety", "stress", "nervous"],
  "worry":      ["anxiety", "stress"],
  "panic":      ["anxiety", "stress", "nervous"],
  "nervous":    ["anxiety", "stress", "cortisol"],
  "cortisol":   ["stress", "anxiety", "nervous"],
  "overwhelm":  ["stress", "anxiety", "burnout"],
  "burnout":    ["stress", "anxiety", "overwhelm", "exhaust"],

  // Breathing
  "breathe":    ["breath", "pranayama", "lung", "oxygen"],
  "breathing":  ["breath", "pranayama", "lung"],
  "breath":     ["breathing", "pranayama", "lung"],
  "pranayama":  ["breath", "yoga", "meditation"],
  "oxygen":     ["breath", "breathing"],

  // Meditation / mindfulness
  "meditate":   ["meditation", "mindful", "calm", "nidra"],
  "meditating": ["meditation", "mindful", "calm"],
  "meditation": ["mindful", "calm", "nidra", "mindfulness"],
  "mindful":    ["meditation", "calm", "awareness", "mindfulness"],
  "mindfulness":["meditation", "mindful", "calm"],
  "calm":       ["meditation", "relax", "peace", "stress"],
  "relax":      ["calm", "meditation", "nidra", "sleep"],

  // Yoga / movement
  "yoga":       ["stretch", "asana", "flexibility", "pose"],
  "stretch":    ["yoga", "flexibility", "mobility"],
  "posture":    ["spine", "alignment", "back"],
  "flexibility":["stretch", "yoga", "mobility"],
  "mobility":   ["flexibility", "stretch", "joint"],

  // Gut / digestion
  "gut":        ["digest", "belly", "intestine", "bowel"],
  "digest":     ["gut", "belly", "stomach"],
  "belly":      ["gut", "digest", "abdomen"],
  "stomach":    ["gut", "digest", "belly"],
  "bloat":      ["gut", "digest", "belly"],

  // Physical pain — deliberately NOT including "tension" here because
  // "tension" appears in emotional/somatic course descriptions and creates
  // false positives for physical-pain queries (e.g. E-motion Detox).
  "pain":       ["ache", "sore", "hurt", "relief", "chronic"],
  "ache":       ["pain", "sore", "hurt", "relief"],
  "sore":       ["pain", "ache", "tight", "stiff"],
  "hurt":       ["pain", "ache", "injury"],
  // Knee-specific — do NOT expand to generic "joint" (too many false positives)
  "knee":       ["knees", "kneecap"],
  "knees":      ["knee", "kneecap"],
  "stiff":      ["tight", "mobility", "stretch", "joint"],
  "tight":      ["stiff", "stretch", "mobility"],
  // Emotional tension is separate — only triggered by stress/emotion keywords
  "tension":    ["stress", "anxiety", "relief", "nervous"],

  // Energy / fatigue
  "energy":     ["vitality", "fatigue"],
  "tired":      ["fatigue", "energy", "exhaust"],
  "fatigue":    ["tired", "energy", "exhaust"],
  "exhaust":    ["fatigue", "tired", "burnout"],
  "vitality":   ["energy", "fatigue"],

  // Weight / nutrition
  "weight":     ["slim", "nutrition", "diet", "loss"],
  "lose":       ["loss", "slim", "fat", "weight"],
  "loss":       ["lose", "slim", "fat", "weight"],
  "diet":       ["nutrition", "weight", "food"],
  "nutrition":  ["diet", "food", "weight"],
  "slim":       ["weight", "diet"],

  // Focus / brain
  "focus":      ["attention", "concentration", "brain"],
  "attention":  ["focus", "concentration", "brain"],
  "adhd":       ["focus", "attention", "concentration"],

  // Emotional / trauma
  "emotion":    ["feeling", "emotional", "trauma"],
  "trauma":     ["emotional", "therapy", "healing", "release"],
  "heal":       ["healing", "therapy", "recovery"],
  "healing":    ["therapy", "recover", "release"],
  "release":    ["healing", "trauma", "emotion"],

  // Sound healing
  "bowl":       ["singing", "sound", "healing"],
  "sound":      ["music", "singing", "bowl", "vibration"],

  // Jaw / face
  "jaw":        ["tmj", "myofunctional", "facial", "bite"],
  "face":       ["jaw", "facial", "skin"],

  // Hormones / women
  "hormone":    ["cortisol", "estrogen", "menopause", "thyroid"],
  "menopause":  ["hormone", "women", "aging"],
};

// ─── Simple suffix stemmer ────────────────────────────────────────────────────

function stems(word) {
  const variants = new Set([word]);
  const suffixes = ["ing", "tion", "ness", "ment", "ful", "ily", "ly", "er", "ed", "es", "s"];
  for (const sfx of suffixes) {
    if (word.endsWith(sfx) && word.length - sfx.length >= 4) {
      variants.add(word.slice(0, -sfx.length));
    }
  }
  return [...variants];
}

// ─── Word expansion ───────────────────────────────────────────────────────────
// Combines stemming + synonym lookup. Each raw keyword becomes a set of search
// terms that covers both surface forms and conceptually related words.

function expandWord(word) {
  const base = stems(word);
  const all  = new Set(base);
  // Look up synonyms for the raw word and each stem
  for (const v of base) {
    (SYNONYMS[v] ?? []).forEach((s) => all.add(s));
  }
  return [...all];
}

// ─── Word-boundary matcher ────────────────────────────────────────────────────
// Uses \bword\b (exact boundaries on BOTH sides).
//
// Why not prefix-only (\bword)?
//   Prefix-only caused "rest" to match "restore", "restoration", "restful" —
//   every wellness course body contains "restore" so sleep queries matched yoga
//   courses with a score of 0.4, outranking genuinely relevant sleep courses.
//
// Why exact boundaries are safe for stems:
//   stems("sleeping") = ["sleeping", "sleep"] — both variants are in the set,
//   so \bsleeping\b and \bsleep\b are searched independently.  Inflected forms
//   in course text are matched by the inflected stem variant, not by prefix bleed.

function matchesHaystack(haystack, variants) {
  return variants.some((v) => {
    try {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${esc}\\b`, "i").test(haystack);
    } catch {
      return haystack.toLowerCase().includes(v);
    }
  });
}

// ─── Match ────────────────────────────────────────────────────────────────────

export async function findRelevantCourses(userMessage, limit = 3, userProfile = {}) {
  if (!courses.length) return [];

  // Deduplicate: repeated words (can happen if caller joins messages together)
  // inflate minRelevance and double-count scores — use each unique word once.
  const rawWords = [...new Set(
    userMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
  )];

  if (!rawWords.length) return [];

  const wordVariants = rawWords.map(expandWord);

  // Require at least 40 % of keywords to match (minimum 1).
  const minRelevance = Math.max(1, Math.ceil(wordVariants.length * 0.4));

  const userAsksAboutChild = CHILD_QUERY_RE.test(userMessage);
  const maxId = courses.reduce((m, c) => Math.max(m, c.id ?? 0), 0);

  return courses
    .filter((course) => passesAudienceGuard(course, userProfile, userAsksAboutChild))
    .map((course) => {
      const title   = (course.title   ?? "").toLowerCase();
      const excerpt = (course.excerpt ?? "").toLowerCase();
      const body    = (course.body    ?? "").toLowerCase();

      // Tiered scoring — WHERE the keyword matches matters as much as WHETHER it matches.
      // Title match = 3 pts, excerpt match = 1 pt, body-only match = 0.4 pts.
      // This ensures "Fix Your Knees" ranks above a generic course that
      // merely mentions joints somewhere in a 2000-word body.
      let matchCount = 0;
      let score = 0;
      for (const variants of wordVariants) {
        if (matchesHaystack(title, variants)) {
          matchCount++;
          score += 3.0;
        } else if (matchesHaystack(excerpt, variants)) {
          matchCount++;
          score += 1.0;
        } else if (matchesHaystack(body, variants)) {
          matchCount++;
          score += 0.4;
        }
      }

      if (matchCount < minRelevance) return null;

      const freshness  = maxId > 0 ? (course.id ?? 0) / maxId : 0;
      const popularity = analyticsScores[course.id] ?? 0;
      const total      = score + freshness * 0.1 + popularity * 0.0;

      return { course, total };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ course }) => course);
}

// ─── Format for system prompt ─────────────────────────────────────────────────

export function formatCourseForPrompt(course) {
  return [
    `• "${course.title}"`,
    course.author  ? `by ${course.author}`                : null,
    course.rating  ? `★ ${course.rating}`                 : null,
    course.excerpt ? `— ${course.excerpt.slice(0, 220)}…` : null,
  ].filter(Boolean).join("  ");
}

// ─── Serialise for frontend ───────────────────────────────────────────────────

export function serializeCourseForClient(course) {
  return {
    title:  course.title,
    author: course.author,
    rating: course.rating,
    thumb:  course.thumb,
    url:    `${NMS_BASE}/courses/${course.slug}`,
  };
}
