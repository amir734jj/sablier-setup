import express from "express";
import _ from "lodash";
import { DateTime } from "luxon";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseTime(value) {
  if (typeof value !== "string") throw new Error("Invalid Docker lifecycle timestamp");
  const timestamp = DateTime.fromISO(value, { zone: "utc" });
  if (!timestamp.isValid) throw new Error("Invalid Docker lifecycle timestamp");
  return timestamp;
}

function lifecycleTime(value) {
  if (value === undefined || value === null) return null;
  const timestamp = parseTime(value);
  return timestamp.equals(DateTime.utc(1, 1, 1)) ? null : timestamp.toISO();
}

export function formatTime(value) {
  return parseTime(value).toFormat("yyyy-MM-dd HH:mm:ss.SSS 'UTC'");
}

export function relativeTime(value, checkedAt) {
  if (!value) return "Not available";
  const timestamp = parseTime(value);
  const base = parseTime(checkedAt);
  if (timestamp >= base) return "0 seconds ago";
  return timestamp.toRelative({
    base,
    unit: ["days", "hours", "minutes", "seconds"],
    locale: "en",
    numeric: "always",
    round: true,
  });
}

export function summarize(containers) {
  if (!Array.isArray(containers)) {
    throw new Error("Docker status API did not return a list");
  }
  const enabled = containers.filter(({ Labels: labels, State: state }) => {
    if (!labels || typeof labels !== "object" || typeof state !== "string") {
      throw new Error("Invalid Docker container status");
    }
    return labels["sablier.enable"] === "true";
  }).map(({ Labels: labels, State: state, StartedAt, FinishedAt }) => {
    const group = labels["sablier.group"] || "(ungrouped)";
    if (typeof group !== "string") throw new Error("Invalid Sablier group");
    return {
      group,
      state,
      last_started_at: lifecycleTime(StartedAt),
      last_stopped_at: lifecycleTime(FinishedAt),
    };
  });
  const groups = _.groupBy(enabled, "group");
  return {
    checked_at: DateTime.utc().toISO(),
    groups: Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([group, members]) => {
      const counts = _.countBy(members, "state");
      const states = Object.keys(counts);
      const status = states.every(state => state === "running") ? "running"
        : states.every(state => state === "exited") ? "stopped"
        : states.every(state => ["running", "exited"].includes(state)) ? "partially_running"
        : "attention";
      return {
        group,
        status,
        states: Object.fromEntries(Object.entries(counts).sort()),
        last_started_at: _.maxBy(members, "last_started_at")?.last_started_at ?? null,
        last_stopped_at: _.maxBy(members, "last_stopped_at")?.last_stopped_at ?? null,
      };
    }),
    note: "Stopped does not distinguish idle sleep from manual stops or failures.",
  };
}

export async function readStatus(fetchDocker = fetch) {
  const query = new URLSearchParams({
    all: "true",
    filters: JSON.stringify({ label: ["sablier.enable=true"] }),
  });
  return summarize(await readProxy(`/containers/json?${query}`, fetchDocker));
}

async function readProxy(path, fetchDocker) {
  const response = await fetchDocker(`http://docker-status-proxy:2375${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Docker status API returned HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Docker status response exceeds size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Docker status API returned invalid JSON");
  }
}

export async function readEvents(fetchDocker = fetch) {
  const data = await readProxy("/events", fetchDocker);
  if (!data || !Array.isArray(data.events) || data.events.length > 100 ||
      !Array.isArray(data.diagnostics) || data.diagnostics.length > 100 ||
      typeof data.limited !== "boolean" || !Number.isSafeInteger(data.ignored_records) || data.ignored_records < 0) {
    throw new Error("Invalid Sablier diagnostics response");
  }
  parseTime(data.checked_at);
  for (const event of [...data.events, ...data.diagnostics]) {
    if (!event || !(event.group === null || typeof event.group === "string") ||
        typeof event.type !== "string" || !["info", "warning", "error"].includes(event.severity) ||
        typeof event.explanation !== "string") throw new Error("Invalid Sablier diagnostic event");
  }
  for (const event of data.events) parseTime(event.timestamp);
  for (const item of data.diagnostics) {
    if (!Number.isSafeInteger(item.count) || item.count < 1) throw new Error("Invalid Sablier diagnostic count");
  }
  return data;
}

function sendError(request, response, code, message) {
  response.status(code);
  if (["/health", "/events"].includes(request.path)) return response.json({ error: message });
  return response.render("status", { status: null, message });
}

export function createApp(loadStatus = readStatus, loadEvents = readEvents) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.disable("view cache");
  app.set("json spaces", 2);
  app.set("view engine", "pug");
  app.set("views", fileURLToPath(new URL("./views/", import.meta.url)));
  app.locals.relativeTime = relativeTime;
  app.locals.formatTime = formatTime;
  app.use((request, response, next) => {
    delete request.headers["if-none-match"];
    delete request.headers["if-modified-since"];
    response.set({
      "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  let active = 0;
  app.get("/events", async (request, response) => {
    if (active >= 8) return sendError(request, response, 503, "Sablier diagnostics are busy");
    active++;
    try {
      response.json(await loadEvents());
    } finally {
      active--;
    }
  });
  app.all("/events", (request, response) => sendError(request, response, 405, "Read-only endpoint"));
  const paths = ["/", "/status", "/health"];
  app.get(paths, async (request, response) => {
    if (active >= 8) return sendError(request, response, 503, "Container status is busy");
    active++;
    try {
      const status = await loadStatus();
      if (request.path === "/health") response.json(status);
      else response.render("status", { status, message: null });
    } finally {
      active--;
    }
  });
  app.all(paths, (request, response) => sendError(request, response, 405, "Read-only endpoint"));
  app.use((request, response) => sendError(request, response, 404, "Not found"));
  app.use((error, request, response, _next) => {
    const eventsRequest = request.path === "/events";
    console.error(eventsRequest ? "Unable to read Sablier diagnostics:" : "Unable to read Docker container status:", error.message);
    sendError(request, response, 503, eventsRequest ? "Sablier diagnostics are temporarily unavailable" : "Container status is temporarily unavailable");
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer({
    headersTimeout: 5000,
    requestTimeout: 5000,
    connectionsCheckingInterval: 1000,
  }, createApp());
  server.maxConnections = 32;
  server.listen(8080, "0.0.0.0");
}
