import express from "express";
import { trackEvent, buildDashboardData } from "../services/analyticsService.js";

const router = express.Router();

// POST /api/assistant/analytics/track
// Called fire-and-forget from the chat widget.
router.post("/analytics/track", (req, res) => {
  const { event, sessionId, userId, ...rest } = req.body ?? {};
  if (!event || !sessionId) {
    return res.status(400).json({ error: "event and sessionId are required" });
  }
  // userId is optional (guests may not have one) but always stored when present
  trackEvent({ event, sessionId, userId: userId ?? null, ...rest });
  res.json({ ok: true });
});

// GET /api/assistant/analytics/data?token=...
// Returns aggregated dashboard data. Token-gated — team only.
router.get("/analytics/data", (req, res) => {
  const expected = process.env.ANALYTICS_TOKEN || "nms-chat-analytics-2025";
  if (req.query.token !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(buildDashboardData());
});

export default router;
