import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import assistantRoutes     from "./routes/assistantRoutes.js";
import notificationRoutes  from "./routes/notificationRoutes.js";

// ─── Load .env ────────────────────────────────────────────────────────────────
// Minimal .env parser — avoids adding a dotenv dependency.
// Only sets variables that are not already present in the environment.

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const envPath    = path.join(projectRoot, ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/assistant", assistantRoutes);
app.use("/api/assistant", notificationRoutes);
app.use(express.static(projectRoot));   // serves index.html and widget.css

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => console.log(`NMS Health Coach API → http://localhost:${PORT}`));
