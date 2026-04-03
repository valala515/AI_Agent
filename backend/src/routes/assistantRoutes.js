import express from "express";
import { createChatResponse } from "../services/chatService.js";

const router = express.Router();

router.post("/chat", async (req, res) => {
  const { userId, message } = req.body ?? {};

  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message are required." });
  }

  try {
    const result = await createChatResponse(req.body);
    res.json(result);
  } catch (err) {
    console.error("[assistant] chat error:", err.message);
    res.status(500).json({ error: "Assistant request failed.", detail: err.message });
  }
});

export default router;
