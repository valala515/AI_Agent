import { getUserContext } from "../data/mockData.js";
import { findRelevantCourses, formatCourseForPrompt, serializeCourseForClient } from "./courseService.js";
import { findRelevantEvents, serializeEventForClient } from "./eventService.js";
import { findRelevantLessons, formatLessonsForPrompt } from "./lessonService.js";
import { getUserHistory, appendTurns } from "./historyService.js";

const MODEL       = process.env.OPENAI_MODEL    || "gpt-4o-mini";
const OPENAI_URL  = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const EVENT_QUERY_RE = /\bevent|workshop|live\s*(session|class|call)\b/i;

// User is explicitly seeking a recommendation — show course cards even if AI went Mode B
const RECOMMENDATION_REQUEST_RE = /\b(what (do you have|can (i|you) (watch|try)|can help|('s| is) (good|best))|do you have (something|anything)|anything for|show me|where should (i|we) start|what (can|will) help|what (should|can) (calm|help|fix|treat|improve)|how (can|do) (i|you) (calm|help|fix|improve)|i need something for|recommend (me|something|a course)|suggest (something|a course)|is there (anything|something) (good |helpful )?(for|about)|can you recommend)\b/i;

function hasEnoughContext(payload) {
  const priorUserTurns = (payload.conversation ?? []).filter((m) => m?.role === "user").length;
  const interestsCount = payload.healthGoals?.length ?? 0;
  const hasFocus = Boolean(payload.currentFocus);
  return priorUserTurns >= 2 || (priorUserTurns >= 1 && hasFocus) || interestsCount >= 3;
}

// ─── User profile text ────────────────────────────────────────────────────────

function buildUserProfileText(userProfile = {}) {
  if (!userProfile) return null;
  const lines = [];
  if (userProfile.gender)          lines.push(`Gender: ${userProfile.gender}`);
  if (userProfile.ageGroup)        lines.push(`Age group: ${userProfile.ageGroup}`);
  if (userProfile.workStyle)       lines.push(`Work style: ${userProfile.workStyle}`);
  if (userProfile.physicalState)   lines.push(`Physical state: ${userProfile.physicalState}`);
  if (userProfile.concernType)     lines.push(`Main concern: ${userProfile.concernType}`);
  if (userProfile.hasKids != null) lines.push(`Has children: ${userProfile.hasKids}`);
  return lines.length ? lines.join("\n") : null;
}

// ─── Chips parser ─────────────────────────────────────────────────────────────
// Strips [CHIPS: label | label] marker from the end of AI responses.

function parseChips(raw) {
  const match = raw.match(/\[CHIPS:\s*([^\]]+)\]\s*$/);
  if (!match) return { text: raw, chips: null };
  const chips = match[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label) => ({ label }));
  const text = raw.slice(0, match.index).trim();
  return { text, chips: chips.length ? chips : null };
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx, courses = [], userProfile = {}, lessonContext = "") {
  const profileText = buildUserProfileText(userProfile);

  const courseData = courses.length
    ? `==================================================
AVAILABLE COURSES — only reference in MODE A or MODE B step 3:
==================================================
${courses.map(formatCourseForPrompt).join("\n")}
${lessonContext ? `\n${lessonContext}` : ""}

You have up to ${courses.length} courses above. Recommend only the 2–3 that are the strongest fit for the user's specific need. Skip any that are only loosely related.`
    : "";

  return `
You are an NMS Wellness Companion — a warm, calm, human guide on the NewMindStart platform.
Your topics: sleep, stress, nutrition, fitness, mindfulness, and habit-building.
Your tone: supportive, non-judgmental, conversational. Never robotic. Never "customer support."

==================================================
INTENT — classify before every response
==================================================

Do NOT assume every health-related message is a recommendation request.

MODE A — COURSE-SEEKING
User asks what the platform has, what to watch, what can help, or where to start.
Examples: "What do you have for X?" / "Anything for X?" / "What can I watch for X?" /
"Do you have something for X?" / "What can help with X?" / "Where should I start for X?"
→ Recommend directly. At most one brief clarifying question if genuinely needed.

MODE B — PROBLEM-SHARING
User describes how they feel or shares a discomfort, without asking for content.
Examples: "my knees hurt" / "I feel anxious" / "I've been waking up exhausted"
→ Do NOT mention courses yet. Follow the 3-step sequence below.

VAGUE vs SPECIFIC — decide before entering Mode B:

  VAGUE — must ask one clarifying question before recommending:
  The message lacks a specific symptom, body area, situation, or goal.
  Examples: "my kids are behaving badly" / "I don't feel well" / "things are hard" /
  "I need help" / "I'm struggling" / "I want to feel better"
  → Acknowledge + ask ONE focused question with chips. Do NOT recommend courses yet.

  SPECIFIC — can recommend after acknowledging:
  The message names a clear symptom, area, or situation.
  Examples: "my knee hurts climbing stairs" / "I wake up at 3am" /
  "I feel anxious at work" / "my 4-year-old has daily tantrums"
  → Follow Mode B steps 1–4 normally; recommend after one exchange (or immediately
     if context leaves no doubt about the right course type).

MODE C — GENERAL INFORMATIONAL
User asks an educational question.
Examples: "why do I wake up tired?" / "can stress affect sleep?"
→ Answer briefly and clearly. No course push unless the user then asks.

==================================================
HOW TO RESPOND
==================================================

── MODE A ──
Use this exact structure — no long paragraphs:

[1–2 sentence acknowledgment + key insight]

Quick tips:
• [tip 1]
• [tip 2]
• [tip 3]

NMS has something made for exactly this:
• **[Exact course title 1]** — [one sentence why it fits]
• **[Exact course title 2]** — [one sentence why it fits]
• **[Exact course title 3]** — [one sentence why it fits, if relevant]

[Optional: "The lesson '[Name]' in [Course] covers exactly this."]

Rules:
- Always recommend 2–3 courses. Never just 1.
- Copy course titles exactly as they appear in the list. Never paraphrase or invent.
- Keep the whole reply under 160 words.

── MODE B ──
1. Acknowledge briefly and naturally (1 sentence).
2. Give 1–3 short practical ideas (skip if the message is vague — no ideas yet, just ask).
3. Ask ONE focused follow-up question with chip options when the message is vague.
4. Once the user answers — OR the original message was already specific enough — switch
   to MODE A and recommend courses. Never ask more than one follow-up before recommending.

Vague message example flow:
  User: "my kids are behaving badly"
  → "That sounds exhausting — parenting challenges can really wear you down.
     What's the main thing you're dealing with?
     [CHIPS: Tantrums & meltdowns | Won't focus or sit still | Sleep issues | Anxiety or fears | Back-talk & defiance]"
  User picks chip → Mode A with relevant courses.

NEVER use the bridge phrase "NMS has something…" on a vague message.
NEVER recommend courses on the first reply to a vague message.

── MODE C ──
Answer briefly and clearly. No course push unless the user asks.

==================================================
EVENTS
==================================================
Never mention events in your text reply — they are surfaced separately by the platform.

==================================================
SAFETY
==================================================
- Do not diagnose conditions or prescribe treatments.
- If symptoms may need medical attention, encourage seeing a healthcare professional.

==================================================
USER CONTEXT
==================================================
Subscription: ${ctx.subscriptionState ?? "unknown"}
Health goals: ${ctx.healthGoals?.join(", ") ?? "not specified"}
Current focus: ${ctx.currentFocus ?? "general wellness"}
${profileText ? `\nKnown profile:\n${profileText}` : ""}

${courseData}
`.trim();
}

// ─── Message formatting ───────────────────────────────────────────────────────

function buildMessages({ history = [], message, ctx, courses, userProfile, lessonContext, isChip = false }) {
  const formattedHistory = history
    .filter((m) => m?.role && m?.content)
    .map((m) => ({
      role:    m.role === "assistant" ? "assistant" : "user",
      content: String(m.content),
    }));

  // When a chip was clicked, prepend a system note so the AI always uses Mode A.
  // Chips are topic-selection shortcuts — the user is asking for content, not sharing a problem.
  const chipNote = isChip
    ? "\n\n[SYSTEM NOTE: The user selected a quick-topic chip — this is an implicit Mode A request. Respond in MODE A format: give practical tips then recommend 2–3 courses from the list. Do NOT ask a follow-up question.]"
    : "";

  return [
    { role: "system", content: buildSystemPrompt(ctx, courses, userProfile, lessonContext) + chipNote },
    ...formattedHistory,
    { role: "user",   content: message },
  ];
}

// ─── OpenAI request ───────────────────────────────────────────────────────────

async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const response = await fetch(`${OPENAI_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.6 }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "No response generated.";
}

// ─── Course reference detection ───────────────────────────────────────────────
// Only surface cards for courses the AI actually referenced in its response.

function filterCoursesReferencedByAI(responseText, courses) {
  const lower = responseText.toLowerCase();
  return courses.filter((c) => {
    const keywords = c.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(with|your|that|this|from|have|what|when|also|just|like|very|some|been|want|need|into|their|there|these|those)$/.test(w))
      .slice(0, 5);
    if (!keywords.length) return false;
    // Use word-boundary match to avoid substring false positives
    const matched = keywords.filter((w) =>
      new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)
    ).length;
    return matched >= Math.min(2, keywords.length);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createChatResponse(payload) {
  const ctx         = { ...getUserContext(payload.userId), ...payload };
  const userProfile = payload.userProfile ?? {};
  const userId      = payload.userId;

  // Load persistent conversation history for this user
  const storedHistory = getUserHistory(userId);

  // Use the current message ONLY for course matching — never the conversation
  // history. Including prior turns pollutes the keyword set (e.g. old messages
  // about muscle soreness inflate the threshold and outrank sleep courses when
  // the user switches topics). The AI already has full history in its context
  // window and will recommend appropriately; the backend matcher is just a filter.
  const [courses, allEvents] = await Promise.all([
    findRelevantCourses(payload.message, 5, userProfile),
    findRelevantEvents(payload.message),
  ]);

  const courseNames = courses.map(c => c.title).filter(Boolean);
  const { topLessons, bonusHint } = findRelevantLessons(payload.message, courseNames, 2);
  const lessonContext = formatLessonsForPrompt(topLessons, bonusHint);

  const userAsksAboutEvents = EVENT_QUERY_RE.test(payload.message);
  const enoughContextForEvents = hasEnoughContext(ctx);
  const events = userAsksAboutEvents
    ? allEvents
    : enoughContextForEvents
      ? allEvents.filter((e) => {
          const d = e.starts_at ?? e.date ?? e.start_date;
          if (!d) return false;
          const hoursUntil = (new Date(d) - Date.now()) / 3_600_000;
          return hoursUntil >= 0 && hoursUntil <= 72;
        })
      : [];

  // isChip must be declared before buildMessages (used in the call below)
  const isChip = Boolean(payload.isChip);

  // Use persistent history for AI context (last 10 turns)
  const messages = buildMessages({
    history:      storedHistory.slice(-10),
    message:      payload.message,
    ctx,
    courses,
    userProfile,
    lessonContext,
    isChip,
  });

  const rawAnswer       = await callOpenAI(messages);
  const { text, chips } = parseChips(rawAnswer);

  // Determine which course cards to show:
  // 1. Prefer courses the AI explicitly named in its response (title keyword match)
  // 2. If none matched (AI used bridge phrase but paraphrased) → fall back to top 3 backend results
  // 3. If no bridge phrase and user didn't explicitly ask → no cards
  const aiUsedBridge          = /nms has (something|a course|these|this)/i.test(text);
  const userAskedForSomething = RECOMMENDATION_REQUEST_RE.test(payload.message);
  const shouldShowCourses     = aiUsedBridge || userAskedForSomething || isChip;

  const namedByAI = filterCoursesReferencedByAI(text, courses);
  const referencedCourses = namedByAI.length > 0
    ? namedByAI
    : shouldShowCourses && courses.length
      ? courses.slice(0, 3)   // fallback: top 3, never all 5
      : [];

  const referencedLessons = topLessons.filter((l) =>
    referencedCourses.some((c) => c.title === l.courseName)
  );

  // Persist this exchange so future sessions have full context
  appendTurns(userId, [
    { role: "user",      content: payload.message, ts: new Date().toISOString() },
    { role: "assistant", content: text,             ts: new Date().toISOString() },
  ]);

  return {
    reply:   { message: text },
    courses: referencedCourses.map(serializeCourseForClient),
    events:  events.map(serializeEventForClient),
    chips:   chips ?? null,
    lessons: referencedLessons,
    meta:    { model: MODEL, source: "openai" },
  };
}
