import { getUserContext } from "../data/mockData.js";
import { findRelevantCourses, formatCourseForPrompt, serializeCourseForClient } from "./courseService.js";
import { findRelevantEvents, serializeEventForClient } from "./eventService.js";

const MODEL       = process.env.OPENAI_MODEL    || "gpt-4o-mini";
const OPENAI_URL  = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx, courses = []) {
  const courseBlock = courses.length
    ? `
RELEVANT NMS COURSES (you MUST reference these):
${courses.map(formatCourseForPrompt).join("\n")}

RESPONSE FORMAT — follow this every time:
1. Give 2–4 lines of concise, practical advice on the user's question.
2. Then add a short bridge sentence (e.g. "To go deeper on this, we have something just for you on NMS:").
3. Then name 1–2 of the courses above — title only, no URL needed (the widget shows the card).
Keep the whole reply under 120 words. Do not write long paragraphs.`
    : "\nKeep your reply concise — under 100 words. No long paragraphs.";

  return `
You are an NMS Wellness Companion — a warm, knowledgeable personal wellness assistant on the NewMindStart platform.

Your role:
- Help users build healthy habits around sleep, stress, nutrition, fitness, and mindfulness
- Give practical, evidence-informed advice they can act on today
- Keep a supportive, non-judgmental tone — meet users where they are
- Celebrate small wins and help users stay consistent over time

How to respond:
- Be concise and easy to scan; use bullet points or short numbered lists when listing steps
- Offer 1–3 concrete next actions when a user seems unsure where to start
- Ask a brief follow-up question when it would help you give better guidance
- Personalise answers using the user context below when relevant
${courseBlock}
Safety rules:
- Do not diagnose medical conditions or prescribe treatments or medications
- If a user describes symptoms that may need medical attention, encourage them to see a healthcare professional
- Stay within wellness, lifestyle, and habit-building topics only

User context:
- Subscription: ${ctx.subscriptionState ?? "unknown"}
- Health goals: ${ctx.healthGoals?.join(", ") ?? "not specified"}
- Current focus: ${ctx.currentFocus ?? "general wellness"}
`.trim();
}

// ─── Message formatting ───────────────────────────────────────────────────────

/**
 * Converts our internal conversation history + new message into the shape
 * the OpenAI Chat Completions API expects.
 * We keep the last 10 turns to stay well within context limits.
 */
function buildMessages({ conversation = [], message, ctx, courses }) {
  const history = conversation
    .slice(-10)
    .filter((m) => m?.role && m?.content)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content),
    }));

  return [
    { role: "system",    content: buildSystemPrompt(ctx, courses) },
    ...history,
    { role: "user",      content: message },
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
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.7 }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "No response generated.";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Accepts the raw request payload, enriches it with user context,
 * calls the AI, and returns a standardised response object.
 */
export async function createChatResponse(payload) {
  const ctx = { ...getUserContext(payload.userId), ...payload };

  const [courses, events] = await Promise.all([
    findRelevantCourses(payload.message),
    findRelevantEvents(payload.message),
  ]);

  const messages = buildMessages({
    conversation: payload.conversation,
    message: payload.message,
    ctx,
    courses,
  });

  const answer = await callOpenAI(messages);

  return {
    reply:   { message: answer },
    courses: courses.map(serializeCourseForClient),
    events:  events.map(serializeEventForClient),
    meta:    { model: MODEL, source: "openai" },
  };
}
