import express from "express";
import { generateNotifications } from "../services/notificationService.js";

const router = express.Router();

// GET /api/assistant/notifications?interests=sleep,stress&seen=1234,5678
router.get("/notifications", (req, res) => {
  const interests = (req.query.interests ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const seenIds = (req.query.seen ?? "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));

  try {
    const notifications = generateNotifications({ interests, seenIds });
    res.json({ notifications });
  } catch (err) {
    console.error("[notifications] error:", err.message);
    res.status(500).json({ notifications: [] });
  }
});

export default router;
