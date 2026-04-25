"use strict";

// ─── Залежності ───────────────────────────────────────────────────────────────
const express   = require("express");
const http      = require("http");
const https     = require("https");
const WebSocket = require("ws");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const { z }     = require("zod");
const si        = require("systeminformation");
const Database  = require("better-sqlite3");
const crypto    = require("crypto");
const fs        = require("fs");
const path      = require("path");
require("dotenv").config();

// ─── Валідація env при старті ─────────────────────────────────────────────────
if (!process.env.API_KEY) {
  console.error("[FATAL] API_KEY відсутній у .env");
  process.exit(1);
}

const PORT           = parseInt(process.env.PORT || "3001", 10);
const API_KEY        = process.env.API_KEY;
const USE_TLS        = process.env.USE_TLS === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",").map(s => s.trim());

// ─── База даних SQLite (персистентна) ─────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "telemetry.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    level   TEXT NOT NULL CHECK(level IN ('info','warn','error')),
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    meta    TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    event   TEXT NOT NULL,
    ip      TEXT,
    details TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
`);

const stmtInsert = db.prepare(
  "INSERT INTO events (ts,level,service,message,meta) VALUES (?,?,?,?,?)"
);
const stmtAudit = db.prepare(
  "INSERT INTO audit_log (ts,event,ip,details) VALUES (?,?,?,?)"
);

function audit(event, ip, details = {}) {
  stmtAudit.run(Date.now(), event, ip ?? "unknown", JSON.stringify(details));
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();

// ШАР 1: Helmet — захисні HTTP-заголовки
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ШАР 1: CORS — тільки дозволені origin
app.use(cors({
  origin(origin, cb) {
    if (!origin && process.env.NODE_ENV !== "production") return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    audit("cors_blocked", null, { origin });
    cb(new Error("CORS: origin не дозволений"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-api-key"],
}));

// Обмеження розміру payload — захист від flood
app.use(express.json({ limit: "16kb" }));

// ШАР 3: Rate limiting
const globalLimiter = rateLimit({
  windowMs: 60_000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Забагато запитів — спробуй через хвилину" },
});
const ingestLimiter = rateLimit({
  windowMs: 1_000, max: 100,
  message: { error: "Ingest limit: max 100 req/s" },
});
app.use("/api", globalLimiter);

// ШАР 2: Автентифікація — timing-safe порівняння
function requireApiKey(req, res, next) {
  const provided = req.headers["x-api-key"] ?? "";
  let valid = false;
  try {
    const a = Buffer.from(provided.padEnd(64));
    const b = Buffer.from(API_KEY.padEnd(64));
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {}

  if (!valid) {
    audit("auth_failed", req.ip, { path: req.path });
    return res.status(401).json({ error: "Недійсний API ключ" });
  }
  next();
}

// ШАР 3: Zod валідація вхідних даних
const eventSchema = z.object({
  level:   z.enum(["info", "warn", "error"]),
  service: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  message: z.string().min(1).max(512),
  meta:    z.record(z.unknown()).optional().default({}),
});

// ─── Метрики системи (реальні — через systeminformation) ──────────────────────
let cachedMetrics = {};
let totalEvents = 0;
let errorCount  = 0;
let wss;

async function refreshMetrics() {
  try {
    const [cpu, mem, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
    ]);
    const eps = db.prepare(
      "SELECT COUNT(*) as c FROM events WHERE ts > ?"
    ).get(Date.now() - 1000).c;

    cachedMetrics = {
      eps,
      cpu:       parseFloat(cpu.currentLoad.toFixed(1)),
      memory:    Math.round(mem.used  / 1024 / 1024),
      memTotal:  Math.round(mem.total / 1024 / 1024),
      netInKB:   Math.round((net[0]?.rx_sec ?? 0) / 1024),
      netOutKB:  Math.round((net[0]?.tx_sec ?? 0) / 1024),
      errorRate: totalEvents > 0
        ? parseFloat(((errorCount / totalEvents) * 100).toFixed(2))
        : 0,
      wsClients: wss?.clients?.size ?? 0,
      uptime:    Math.round(process.uptime()),
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error("[metrics]", err.message);
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss?.clients?.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ─── REST endpoints ───────────────────────────────────────────────────────────

// POST /api/ingest — приймаємо реальні події від твоїх сервісів
app.post("/api/ingest", requireApiKey, ingestLimiter, (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Невалідні дані",
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const { level, service, message, meta } = parsed.data;
  const ts = Date.now();
  stmtInsert.run(ts, level, service, message, JSON.stringify(meta));
  totalEvents++;
  if (level === "error") errorCount++;
  broadcast({ type: "event", payload: { ts, level, service, message, meta } });
  res.json({ ok: true, total: totalEvents });
});

// GET /api/metrics
app.get("/api/metrics", requireApiKey, (_req, res) => res.json(cachedMetrics));

// GET /api/events
app.get("/api/events", requireApiKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const since = parseInt(req.query.since) || 0;
  const level = req.query.level;

  let sql = "SELECT * FROM events WHERE ts > ?";
  const params = [since];
  if (level && ["info","warn","error"].includes(level)) {
    sql += " AND level = ?"; params.push(level);
  }
  sql += " ORDER BY ts DESC LIMIT ?"; params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// GET /api/health — публічний, без auth
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()) });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("[error]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ─── HTTP / HTTPS сервер ──────────────────────────────────────────────────────
let server;
if (USE_TLS) {
  server = https.createServer({
    key:  fs.readFileSync(process.env.TLS_KEY  || "server.key"),
    cert: fs.readFileSync(process.env.TLS_CERT || "server.crt"),
  }, app);
} else {
  server = http.createServer(app);
}

// ─── WebSocket з автентифікацією ──────────────────────────────────────────────
wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  // WS авторизація через query: ws://host:3001?key=YOUR_API_KEY
  const url  = new URL(req.url, "http://localhost");
  const wsKey = url.searchParams.get("key") ?? "";
  let valid = false;
  try {
    const a = Buffer.from(wsKey.padEnd(64));
    const b = Buffer.from(API_KEY.padEnd(64));
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {}

  if (!valid) {
    audit("ws_auth_failed", req.socket.remoteAddress);
    ws.close(1008, "Unauthorized");
    return;
  }

  ws.send(JSON.stringify({ type: "snapshot", payload: cachedMetrics }));
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString().slice(0, 256));
      if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch (_) {}
  });
  ws.on("error", err => console.error("[ws]", err.message));
});

// Оновлення метрик кожну секунду
setInterval(async () => {
  await refreshMetrics();
  broadcast({ type: "metrics", payload: cachedMetrics });
}, 1000);

refreshMetrics();

server.listen(PORT, () => {
  console.log(`\n TelemetryOS ready`);
  console.log(` http${USE_TLS?"s":""}://localhost:${PORT}/api`);
  console.log(` ws${USE_TLS?"s":""}://localhost:${PORT}?key=<API_KEY>`);
  console.log(` DB: ${DB_PATH}\n`);
});

process.on("SIGTERM", () => {
  wss.clients.forEach(c => c.close());
  server.close(() => { db.close(); process.exit(0); });
});
process.on("SIGINT", () => process.emit("SIGTERM"));
