import { useEffect, useRef, useState, useCallback } from "react";
import MetricCard  from "./components/MetricCard";
import LogFeed     from "./components/LogFeed";
import ThroughputChart from "./components/ThroughputChart";
import ServiceBars from "./components/ServiceBars";
import "./index.css";

const WS_URL = `ws://${import.meta.env.VITE_API_HOST || "localhost:3001"}?key=${import.meta.env.VITE_API_KEY}`;

// ─── WebSocket hook з auto-reconnect ─────────────────────────────────────────
function useWebSocket(url) {
  const [metrics, setMetrics] = useState(null);
  const [events,  setEvents]  = useState([]);
  const [status,  setStatus]  = useState("connecting"); // connecting | live | reconnecting
  const wsRef   = useRef(null);
  const retryRef = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("live");
      clearTimeout(retryRef.current);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "metrics" || msg.type === "snapshot") {
          setMetrics(msg.payload);
        }
        if (msg.type === "event") {
          setEvents((prev) => [msg.payload, ...prev].slice(0, 200));
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setStatus("reconnecting");
      retryRef.current = setTimeout(connect, 2500);
    };

    ws.onerror = () => ws.close();
  }, [url]);

  useEffect(() => {
    connect();
    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 5000);
    return () => {
      clearInterval(ping);
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { metrics, events, status };
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const { metrics, events, status } = useWebSocket(WS_URL);

  const statusColor = {
    live:         "var(--green)",
    reconnecting: "var(--amber)",
    connecting:   "var(--muted)",
  }[status];

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-title">
          <span className="accent">TELEMETRY</span>OS
        </div>
        <div className="header-right">
          <div className="pill" style={{ borderColor: statusColor, color: statusColor }}>
            <span className="dot" style={{ background: statusColor }} />
            {status.toUpperCase()}
          </div>
          <span className="clock">{new Date().toLocaleTimeString()}</span>
        </div>
      </header>

      {/* Metric cards */}
      <div className="grid-4">
        <MetricCard label="Events / sec"  value={metrics?.eps}                              color="var(--green)" sub="rolling 1s" />
        <MetricCard label="CPU"           value={metrics?.cpu != null ? metrics.cpu + "%" : null} color="var(--amber)" sub={`${metrics?.memTotal ?? "—"} MB total`} />
        <MetricCard label="Memory"        value={metrics?.memory != null ? metrics.memory + " MB" : null} color="var(--blue)"  sub="used" />
        <MetricCard label="Error rate"    value={metrics?.errorRate != null ? metrics.errorRate + "%" : null} color={metrics?.errorRate > 2 ? "var(--red)" : "var(--green)"} sub={`${metrics?.wsClients ?? 0} WS clients`} />
      </div>

      {/* Main row */}
      <div className="grid-main">
        <ThroughputChart events={events} />
        <LogFeed events={events} />
      </div>

      {/* Bottom row */}
      <div className="grid-bot">
        <ServiceBars events={events} />
        <div className="card net-card">
          <div className="card-label">Network I/O</div>
          <div className="net-row">
            <span className="net-dir">↑ OUT</span>
            <span className="net-val" style={{ color: "var(--blue)" }}>
              {metrics?.netOutKB ?? 0} KB/s
            </span>
          </div>
          <div className="net-row">
            <span className="net-dir">↓ IN</span>
            <span className="net-val" style={{ color: "var(--green)" }}>
              {metrics?.netInKB ?? 0} KB/s
            </span>
          </div>
          <div className="net-row" style={{ marginTop: 12 }}>
            <span className="net-dir">Uptime</span>
            <span className="net-val">{formatUptime(metrics?.uptime)}</span>
          </div>
        </div>
        <div className="card stat-card">
          <div className="card-label">Event breakdown</div>
          {["info", "warn", "error"].map((lvl) => {
            const count = events.filter((e) => e.level === lvl).length;
            const pct   = events.length ? Math.round((count / events.length) * 100) : 0;
            const color = lvl === "info" ? "var(--green)" : lvl === "warn" ? "var(--amber)" : "var(--red)";
            return (
              <div key={lvl} className="breakdown-row">
                <span className="breakdown-lvl" style={{ color }}>{lvl}</span>
                <div className="breakdown-track">
                  <div className="breakdown-fill" style={{ width: pct + "%", background: color }} />
                </div>
                <span className="breakdown-count">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="footer">
        TelemetryOS v1.0 · uptime {formatUptime(metrics?.uptime)} · {metrics?.wsClients ?? 0} connected
      </footer>
    </div>
  );
}

function formatUptime(s) {
  if (!s) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
