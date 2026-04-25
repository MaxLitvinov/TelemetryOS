[README (1).md](https://github.com/user-attachments/files/27091299/README.1.md)
# TelemetryOS — Real-time Telemetry Dashboard
---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                              │
│         React Dashboard     │    curl / Postman / SDK       │
└──────────────┬──────────────┴──────────────┬────────────────┘
               │ WebSocket (ws://)            │ HTTP REST
               ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node.js Backend (Express + ws)            │
│                                                             │
│   POST /api/ingest   →  circular buffer  →  WS broadcast   │
│   GET  /api/metrics  →  snapshot                           │
│   GET  /api/events   →  filtered log query                 │
│   GET  /api/health   →  uptime                             │
└─────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# Backend
cd backend
npm install
npm run dev        # → http://localhost:3001

# Frontend
cd frontend
npm install
npm run dev        # → http://localhost:5173
```

## Send telemetry events

```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"level":"info","service":"ingestion","message":"batch complete","meta":{"count":4096}}'
```

## Tech stack

| Layer     | Tech                            |
|-----------|---------------------------------|
| Backend   | Node.js, Express, ws (WebSocket)|
| Frontend  | React, Vite                     |
| Protocol  | REST + WebSocket                |
| Data      | In-memory circular buffer       |

## Features

- Real-time event streaming via WebSocket
- REST API: ingest, query, health check
- Circular buffer with configurable window
- Auto-reconnect WebSocket client
- Live metrics: EPS, CPU, memory, error rate
- Log feed with level filtering

## Extending to C++

For max throughput, replace the Node.js backend with:
- **uWebSockets.js** (C++ bindings for Node) — 10-100x faster WS
- Or a full **C++ server** using `uSockets` / `Boost.Beast`

The REST API contract (`/api/ingest`, `/api/metrics`) stays identical.
