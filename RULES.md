# NMS Wellness Companion — Recommendation & Behaviour Rules

This file is the single source of truth for how the system decides what to recommend,
when to surface it, and how the AI should respond. Update this file whenever a rule
changes, and reference it when building new features on top of the recommendation engine.

---

## 1. AI Persona & Tone

| Rule | Value |
|---|---|
| Name | NMS Wellness Companion |
| Tone | Warm, supportive, non-judgmental |
| Topics | Sleep, stress, nutrition, fitness, mindfulness, habit-building |
| Forbidden | Diagnosing medical conditions, prescribing treatments or medications |
| Safety fallback | If a user describes symptoms that may need medical attention, encourage them to see a healthcare professional |

---

## 2. AI Response Format

These rules live in `chatService.js → buildSystemPrompt()` and **must not be softened**.
The AI ignores soft suggestions — use imperative language.

### Intent classification — first step every time

The AI classifies every incoming message into one of three modes before responding:

| Mode | Signals | Behaviour |
|---|---|---|
| **A — Course-seeking** | "what do you have for X", "anything for X", "what can I watch", "where should I start" | Recommend directly (1–3 courses). Ask at most one brief clarifying question. |
| **B — Problem-sharing** | User describes how they feel without asking for content: "my knees hurt", "I feel anxious" | Follow the 4-step sequence below. Do NOT jump to recommendations. |
| **C — Informational** | Educational question: "why do I wake up tired", "how does breathing help anxiety" | Answer briefly, then invite personalization. |

### Mode B — problem-sharing response sequence

```
Step 1: Acknowledge the issue briefly (1 sentence).
Step 2: Give 1–3 short practical ideas or reflections (skip if vague — see below).
Step 3: Ask ONE focused follow-up question with up to 6 chip options.
Step 4: After enough context — recommend platform content.
```

### Vague vs Specific messages

Before responding in Mode B, classify the message:

**VAGUE** — lacks a specific symptom, body area, situation, or goal → must clarify first.
Do NOT give tips or recommend courses yet. Acknowledge + ask ONE question with chips.

| Vague (ask first) | Specific (can recommend) |
|---|---|
| "my kids are behaving badly" | "my 4-year-old has daily tantrums" |
| "I don't feel well" | "my knee hurts climbing stairs" |
| "I need help" | "I wake up at 3am every night" |
| "things are hard lately" | "I feel anxious at work every day" |

**Rule:** Never use the bridge phrase or show course cards on the first reply to a vague message.

### Mode A — course recommendation format

```
1. Give 2–4 lines of practical, actionable advice the user can apply today.
2. Add one short bridge sentence (e.g. "To go deeper, NMS has something made for exactly this:").
3. Name 1–2 courses from the injected list using their EXACT full title — no URL needed.
4. If a specific lesson matches, mention it: "In [Course], the lesson '[Lesson Name]' covers exactly this."

Rules:
- ONLY reference courses from the injected list. Never invent or mention any other course.
- If none of the listed courses fit, skip the recommendation entirely.
- Keep the whole reply under 140 words. No long paragraphs.
```

### When no courses matched (any mode)

```
Keep your reply concise and practical — under 100 words. No long paragraphs.
```

### Events — never in AI replies

The AI must **never mention events, live sessions, or workshops** in its text reply.
Events are surfaced separately by the platform (see §7).

### Conversation history

- Last **10 turns** of the conversation are forwarded to the AI.
- Older turns are dropped to stay within context limits.

### Model & temperature

| Setting | Value |
|---|---|
| Default model | `gpt-4o-mini` (override via `OPENAI_MODEL` env var) |
| Temperature | `0.7` |

---

## 3. Course Catalogue

### Source

- File: `backend/src/data/courses.json`
- Synced from `https://newmindstart.com/api/courses` using header `x-bot-key`
- Run manually: `npm run sync`
- **Auto-refresh: every Friday at 09:00 local server time** (`courseService.js → scheduleFridaySync()`)

### Language filter

**English only — always.** Russian-language courses are excluded at sync time.
Filter logic: `!c.lang || c.lang === "en"`

### Normalised course shape

```json
{
  "id":         123,
  "title":      "...",
  "slug":       "course-slug",
  "author":     "Author Name",
  "rating":     4.8,
  "thumb":      "https://…",
  "excerpt":    "First 300 chars of plain-text description",
  "lang":       "en",
  "created_at": "2024-12-01T00:00:00Z"
}
```

### Sync API call

```
GET /api/courses?per-page=100&page={n}&expand=thumb_big&sort=-id
Header: x-bot-key: <NMS_BOT_KEY>
```

Pages are iterated until `pagination.pagination_page_count` is reached.

---

## 4. Course Matching & Scoring

**File:** `backend/src/services/courseService.js → findRelevantCourses()`

### Audience guard — child & postpartum courses

The catalogue contains courses aimed at children, babies, pregnancy, or postpartum recovery.
These are **excluded unless the user's message explicitly mentions the relevant context**.

| Check | Triggers on title containing |
|---|---|
| Child-audience course | `kids`, `kid`, `child`, `children`, `baby`, `babies`, `toddler`, `newborn`, `infant`, `pregnancy`, `pregnant`, `maternal`, `prenatal`, `postnatal`, `montessori`, `mama`, `mamas`, `postpartum`, `birth` |
| User asks about a child | Message contains: `kids`, `kid`, `child`, `children`, `baby`, `toddler`, `newborn`, `infant`, `son`, `daughter`, `pregnancy`, `pregnant`, `mama`, `postpartum` |

> **Example:** "The Radiant Mama" (postpartum course) will never appear for a general voice, sleep, or stress query because "mama" is in the course title but not in the user's message.

### Keyword extraction (from user message)

1. Lowercase the message
2. Strip non-alphanumeric characters
3. Split on whitespace
4. **Discard words with ≤ 3 characters**
5. **Discard stop words** — high-frequency words that carry no topical signal (see list below)
6. **Stem each keyword** — strip common English suffixes so "sleeping" matches "sleep"

#### Stop words (discarded before matching)

```
that, this, with, have, from, they, will, what, when, more,
also, about, your, just, like, very, some, been, want, need,
feel, help, make, know, think, time, good, better, really,
does, into, their, there, these, those, then, than, them,
each, much, many, most, here, over, such, only, even, back,
both, well, long, able, find, give, live, move, work, take,
come, ways, made, used, life, body, mind, self, every, while
```

#### Stemmer — suffixes stripped (minimum root length: 4 characters)

`-ing`, `-tion`, `-ness`, `-ment`, `-ful`, `-ily`, `-ly`, `-er`, `-ed`, `-es`, `-s`

Examples: `sleeping → sleep`, `stressed → stress`, `breathing → breath`

> **Known limitation:** prefix-modified roots don't stem — "asleep" will not match "sleep".
> Resolved when keyword matching is replaced with semantic (embedding) search.

### Scoring formula

```
total = relevance × 1.0  +  freshness × 0.1  +  popularity × 0.0
```

| Component | How calculated | Weight |
|---|---|---|
| `relevance` | Count of keyword matches in `title + excerpt` | 1.0 |
| `freshness` | `course.id / max_id` — tiebreaker only, not a quality signal | **0.1** |
| `popularity` | `analyticsScores[course.id]` (injected externally) | **0.0 — not yet active** |

### Minimum relevance threshold

A course is only eligible if it matches **at least 40% of the query's keywords** (minimum 1).

```
minRelevance = Math.max(1, Math.ceil(wordCount × 0.4))
```

| Query keywords | Min matches required |
|---|---|
| 1–2 keywords | 1 |
| 3–4 keywords | 2 |
| 5–7 keywords | 2–3 |

> **Why:** A single-keyword hit on a generic word ("energy", "breathing") can match dozens of unrelated courses. The threshold ensures only genuinely relevant courses are shown.

### Selection

- Courses below `minRelevance` are excluded entirely.
- Top **3** courses by `total` score are passed to the AI prompt and returned to the frontend.

### Prompt format (one line per course)

```
• "Course Title"  by Author Name  ★ 4.8  — First 120 chars of excerpt…
```

---

## 5. Course Titles in AI Replies

The AI must use the **exact full title** as it appears in the system prompt.

| Correct | Wrong |
|---|---|
| "Voice Alchemy: Activate The Power Of Your Healing Voice" | "Voice Alchemy" |
| "Cortisol Detox: Calm Anxiety, Feel More Productive, and Sleep Better with Simple Neuro Hacks" | "Cortisol Detox" |

The system prompt instructs: *"Name 1–2 courses from the list above using their EXACT full title as written."*
It also explicitly forbids: *"Never mention any other course, program, or resource."*

This prevents the AI from hallucinating course names it may have seen in training data (e.g., recommending "Radiant Mama" for a voice query because it knows the NMS catalogue from pre-training).

---

## 6. Interest Tracking (Frontend)

**File:** `index.html → addInterests()`

User interests are extracted from every message the user sends (typed or chip) and
stored in `localStorage` as a deduplicated keyword array.

### Stop words (always discarded)

```
that, this, with, have, from, they, will, what, when, more,
also, about, your, just, like, very, some, been, want, need,
feel, help, make, know, think, time, good, better, really
```

### Rules

- **Minimum word length:** > 3 characters (same as backend)
- **Storage cap:** 40 most-recent unique words (oldest trimmed automatically)
- **Persistence:** `localStorage` key `nms_interests` — survives page reload

### Triggers

| Action | Calls `addInterests`? |
|---|---|
| User types and sends a message | Yes |
| User clicks a quick-reply chip | Yes |

---

## 7. Events System

**File:** `backend/src/services/eventService.js`

### Surfacing rules — events are NOT part of the AI reply

Events appear in the chat **only in two situations**:

| Condition | How surfaced |
|---|---|
| User explicitly asks ("are there events?", "any workshops?") | Returned as event cards inside the chat bubble |
| An event starts within the next **72 hours** | Returned as event cards inside the chat bubble |
| All other cases | Events are **not shown in the chat at all** |

The AI is instructed never to mention events in its text. The filtering happens in `chatService.js → createChatResponse()`.

### Proactive event notifications

The separate notification system (`notificationService.js`) can surface upcoming events as a proactive bubble outside the chat — independent of the 72-hour chat rule.

### Cache & refresh

- Runtime cache TTL: **30 minutes** (events are time-sensitive)
- Eager cache refresh: **every Friday at 09:00** local server time (`eventService.js → scheduleFridayRefresh()`)

### API call (when Cloudflare bypass is active)

```
GET /api/events/all-user?per-page=100&page={n}&expand=thumb&sort=-id
Header: x-bot-key: <NMS_BOT_KEY>
```

**Status:** Currently returns 403. Backend team needs to extend the `x-bot-key` WAF rule to cover `/api/events/all-user`.

---

## 8. Proactive Notification System

**Backend:** `notificationService.js`
**Endpoint:** `GET /api/assistant/notifications?interests=sleep,stress&seen=1234,5678`
**Frontend:** `index.html → loadNotifications() + renderNotification()`

### Trigger

Notifications fire **once per browser session**, **6 seconds after the chat widget opens**.
Guard key: `sessionStorage` key `nms_notif_shown`.

### Notification types

#### Type 1 — `new_course`
Course released within the **last 7 days** that matches user interests.

| Rule | Value |
|---|---|
| Recency window | 7 days from `created_at` |
| Social proof label | "🔥 X people joining this course" |
| Social proof number | Random integer **200 – 1800**, re-generated on every render |
| Dedup | Course ID stored in `localStorage` key `nms_notified_ids` |

#### Type 2 — `popular_course`
Highly-rated unseen course matching user interests.

| Rule | Value |
|---|---|
| Minimum rating | ≥ 4.7 |
| Dedup | Same `nms_notified_ids` key — never the same course as `new_course` |

#### Type 3 — `event`
Upcoming community event. **Placeholder — skipped when `event: null`** until the events endpoint is unblocked.

---

## 9. Sync Schedule Summary

| What | When | How |
|---|---|---|
| Course catalogue (`courses.json`) | Every **Friday 09:00** | `courseService.js → scheduleFridaySync()` runs `scripts/syncCourses.js` |
| Event cache (in-memory) | Every **Friday 09:00** + every **30 min** TTL | `eventService.js → scheduleFridayRefresh()` |
| Manual trigger | Any time | `npm run sync` |

---

## 10. Analytics Hook (Future)

`courseService.js` exports `updateAnalyticsScores(scores)`.

Call it with `{ [courseId]: score }` where score is completion rate, engagement, or any custom signal.
The `popularity` weight is **0.0** until connected.

```js
import { updateAnalyticsScores } from "./courseService.js";
updateAnalyticsScores({ 101: 0.92, 204: 0.78 });
```

---

## 11. What to Build Next

- **Semantic matching** — replace keyword overlap with embedding similarity for better recall on paraphrased queries
- **Lesson-level recommendations** — index subtitle transcripts (`assets/_Subtitles_eng/`) to recommend specific lessons, not just courses
- **Completion-rate weighting** — wire real analytics into `updateAnalyticsScores()` and raise the `popularity` weight from 0.0
- **Per-user seen history on the backend** — currently only tracked client-side; a server-side record would survive browser clears
- **Personalised greeting** — use stored interests on first open to pre-populate a context-aware welcome message
- **A/B test social proof numbers** — replace random range with a data-backed figure once course enrollment metrics are available
