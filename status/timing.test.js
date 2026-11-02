import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DateTime } from "luxon";
import { io as connect } from "socket.io-client";
import { createStatusServer, formatTime, readEvents, readStatus, relativeTime, summarize } from "./server.js";
import { diagnosticsMessage, keyedRows, runningProgress } from "./shared/format.js";

const container = (state, started, stopped) => ({
  Labels: { "sablier.enable": "true", "sablier.group": "example" },
  State: state, StartedAt: started, FinishedAt: stopped,
});

test("groups the most recent independent start and stop times", () => {
  const { groups: [group] } = summarize([
    container("running", "2026-11-02T10:00:00Z", "2026-11-02T09:00:00Z"),
    container("exited", "2026-11-01T10:00:00Z", "2026-11-02T11:00:00Z"),
  ]);
  assert.equal(group.status, "partially_running");
  assert.equal(group.last_started_at, "2026-11-02T10:00:00.000Z");
  assert.equal(group.last_stopped_at, "2026-11-02T11:00:00.000Z");
});

test("handles missing and Docker zero timestamps without inventing history", () => {
  for (const value of [undefined, null, "0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000000000Z"]) {
    const { groups: [group] } = summarize([container("created", value, value)]);
    assert.equal(group.last_started_at, null);
    assert.equal(group.last_stopped_at, null);
  }
  for (const value of ["invalid", "2026-02-30T00:00:00Z", 123]) {
    assert.throws(() => summarize([container("running", value, null)]), /Invalid Docker/);
  }
});

test("formats relative ages at boundaries and clamps future timestamps", () => {
  const now = "2026-11-02T12:00:00Z";
  assert.equal(relativeTime(null, now), "Not available");
  for (const [seconds, expected] of [[0, "0 seconds"], [0.5, "0 seconds"], [59, "59 seconds"], [59.999, "59 seconds"], [60, "1 minute"], [3600, "1 hour"], [86400, "1 day"], [86400 * 40, "40 days"]]) {
    assert.equal(relativeTime(DateTime.fromISO(now).minus({ seconds }).toISO(), now), `${expected} ago`);
  }
  assert.equal(relativeTime("2026-11-03T00:00:00Z", now), "0 seconds ago");
  assert.throws(() => relativeTime("invalid", now), /Invalid Docker/);
  assert.throws(() => relativeTime(now, "invalid"), /Invalid Docker/);
});

test("normalizes timestamp offsets and formats UTC with milliseconds", () => {
  const { groups: [group] } = summarize([
    container("running", "2026-11-02T12:30:45.123456789+02:00", null),
  ]);
  assert.equal(group.last_started_at, "2026-11-02T10:30:45.123Z");
  assert.equal(formatTime(group.last_started_at), "2026-11-02 10:30:45.123 UTC");
  assert.equal(formatTime("2026-11-02T12:00:00+02:00"), "2026-11-02 10:00:00.000 UTC");
  assert.throws(() => formatTime("invalid"), /Invalid Docker/);
});

test("reports running progress at zero, full capacity, and mixed container counts", () => {
  assert.deepEqual(runningProgress([]), { running: 0, total: 0, percentage: 0 });
  assert.deepEqual(runningProgress([{ states: { exited: 3, paused: 2 } }]),
    { running: 0, total: 5, percentage: 0 });
  assert.deepEqual(runningProgress([{ states: { running: 2 } }, { states: { running: 3 } }]),
    { running: 5, total: 5, percentage: 100 });
  assert.deepEqual(runningProgress([{ states: { running: 1 } }, { states: { exited: 3 } }]),
    { running: 1, total: 4, percentage: 25 });
  assert.deepEqual(runningProgress([{ states: { running: 2, paused: 1, restarting: 1 } }]),
    { running: 2, total: 4, percentage: 50 });
});

test("preserves fractional running percentages and does not report partial capacity as full", () => {
  const fractional = runningProgress([{ states: { running: 1, exited: 2 } }]);
  const nearlyFull = runningProgress([{ states: { running: 127, exited: 1 } }]);

  assert.equal(fractional.running, 1);
  assert.equal(fractional.total, 3);
  assert.ok(Math.abs(fractional.percentage - 100 / 3) < 1e-10);
  assert.equal(nearlyFull.percentage, 99.21875);
});

async function startServer(t, loadStatus = async () => summarize([]), loadEvents = async () => diagnosticData()) {
  const webRoot = await mkdtemp(join(tmpdir(), "sablier-status-test-"));

  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"),
    '<!doctype html><main id="app"></main><script type="module" src="/assets/dashboard.js"></script>');
  await writeFile(join(webRoot, "assets", "dashboard.js"), 'console.info("Frontend build fixture");');
  await writeFile(join(webRoot, "assets", "dashboard.css"), "body { color: inherit; }");

  const instance = createStatusServer(loadStatus, loadEvents, { webRoot });
  const { server, io } = instance;

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  t.after(async () => {
    await new Promise(resolve => {
      io.close(resolve);
      server.closeAllConnections();
    });

    await rm(webRoot, { recursive: true, force: true });
  });

  return { ...instance, webRoot, url: `http://127.0.0.1:${server.address().port}` };
}

function createClient(t, url, options = {}) {
  const socket = connect(url, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    ...options,
  });

  t.after(() => socket.disconnect());

  return socket;
}

async function connectFor(socket, ...events) {
  const messages = events.map(event => once(socket, event));

  socket.connect();

  return Promise.all(messages);
}

async function disconnectClient(socket, io) {
  const disconnected = once(io.of("/").sockets.get(socket.id), "disconnect");

  socket.disconnect();
  await disconnected;
}

test("serves the configured frontend build and JSON health timing fields", async t => {
  const data = summarize([container("running", "2026-11-02T10:00:00Z", null)]);
  const { url } = await startServer(t, async () => data);
  const html = await (await fetch(url)).text();

  assert.match(html, /type="module" src="\/assets\/dashboard\.js"/);
  assert.doesNotMatch(html, /htmx|idiomorph|sse-connect|location\.reload/i);

  for (const path of ["/assets/dashboard.js", "/assets/dashboard.css"]) {
    const response = await fetch(url + path);

    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
  }

  assert.deepEqual(await (await fetch(`${url}/health`)).json(), data);
  assert.deepEqual(await (await fetch(`${url}/api/status`)).json(), data);
});

test("serves static files from the build root without allowing API paths to fall through", async t => {
  const { url, webRoot } = await startServer(t);

  await writeFile(join(webRoot, "robots.txt"), "User-agent: *\nDisallow:\n");
  await mkdir(join(webRoot, "api"));
  await writeFile(join(webRoot, "api", "private.json"), '{"unexpected":true}');

  const staticFile = await fetch(`${url}/robots.txt`);

  assert.equal(staticFile.status, 200);
  assert.equal(await staticFile.text(), "User-agent: *\nDisallow:\n");

  for (const path of ["/api", "/api/missing", "/api/private.json", "/api/containers/json"]) {
    const response = await fetch(url + path);

    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("keeps the API read-only and preserves legacy JSON endpoints", async t => {
  const status = summarize([]);
  const events = diagnosticData();
  const { url } = await startServer(t, async () => status, async () => events);

  for (const path of ["/api/status", "/health"]) {
    assert.deepEqual(await (await fetch(url + path)).json(), status);
  }

  for (const path of ["/api/events", "/events"]) {
    assert.deepEqual(await (await fetch(url + path)).json(), events);
  }

  for (const path of ["/api/session", "/session"]) {
    assert.equal((await fetch(url + path)).status, 204);
  }

  for (const path of ["/api/status", "/api/events", "/api/session"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(url + path, { method });

      assert.equal(response.status, 405, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "Read-only endpoint" });
    }
  }
});

test("uses a Vite JSX entry point without browser import maps or vendor routes", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

  assert.match(html, /type="module" src="\/src\/main\.jsx"/);
  assert.match(html, /JavaScript is required/);
  assert.match(html, /href="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.8\/dist\/css\/bootstrap\.min\.css"/);
  assert.doesNotMatch(html, /importmap|\/vendor\//);
});

test("reports missing frontend builds without misreporting Docker health", async t => {
  t.mock.method(console, "error", () => {});

  const { url, webRoot } = await startServer(t);

  await unlink(join(webRoot, "index.html"));

  const missing = await fetch(url);

  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: "Dashboard assets are temporarily unavailable" });
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("keeps duplicate event keys unique and existing keys stable when new events arrive", () => {
  const event = diagnosticData().events[0];
  const fields = ["timestamp", "group", "type", "severity", "explanation"];
  const original = keyedRows([event, { ...event }], fields);
  const updated = keyedRows([{ ...event, timestamp: "2026-11-02T16:00:00Z" }, event, { ...event }], fields);

  assert.notEqual(original[0].key, original[1].key);
  assert.deepEqual(updated.slice(1).map(row => row.key), original.map(row => row.key));
});

test("includes bounded-history notices in diagnostic summaries", () => {
  const data = { ...diagnosticData(), events: [], limited: true };
  const message = diagnosticsMessage(data, "2026-11-02T16:00:12.000Z");

  assert.match(message, /No recognized events/);
  assert.match(message, /checked 12 seconds ago/);
  assert.match(message, /History limit reached/);
  assert.match(message, /2 unrecognized or unrelated records omitted/);
});

test("updates diagnostic check ages relative to the current time without visible UTC timestamps", () => {
  const data = diagnosticData();

  for (const [now, age] of [
    ["2026-11-02T16:00:12.000Z", "12 seconds ago"],
    ["2026-11-02T16:00:13.000Z", "13 seconds ago"],
    ["2026-11-02T16:01:05.000Z", "1 minute ago"],
  ]) {
    const message = diagnosticsMessage(data, now);

    assert.ok(message.startsWith(`Events checked ${age}.`));
    assert.doesNotMatch(message, /2026-|UTC/);
  }
});

test("publishes JSON snapshots over WebSocket and supports the polling transport", { timeout: 15_000 }, async t => {
  const status = summarize([container("running", "2026-11-02T10:00:00Z", null)]);
  const data = diagnosticData();
  const { url } = await startServer(t, async () => status, async () => data);

  for (const transport of ["websocket", "polling"]) {
    const socket = createClient(t, url, { transports: [transport] });
    const [[receivedStatus], [receivedEvents]] = await connectFor(socket, "status", "events");

    assert.deepEqual(receivedStatus, status);
    assert.deepEqual(receivedEvents, data);
    assert.equal(socket.io.engine.transport.name, transport);
  }
});

test("publishes independent failures and fresh snapshots after reconnecting", { timeout: 15_000 }, async t => {
  const log = t.mock.method(console, "error", () => {});
  let statusFail = true;
  let eventsFail = false;
  const { url, io } = await startServer(t, async () => {
    if (statusFail) throw new Error("SECRET status detail");

    return summarize([]);
  }, async () => {
    if (eventsFail) throw new Error("SECRET log detail");

    return diagnosticData();
  });
  const socket = createClient(t, url);
  const [[statusError], [events]] = await connectFor(socket, "status:error", "events");

  assert.match(statusError.message, /status below is stale/);
  assert.doesNotMatch(statusError.message, /SECRET/);
  assert.deepEqual(events, diagnosticData());

  await disconnectClient(socket, io);
  statusFail = false;
  eventsFail = true;

  const [[status], [eventsError]] = await connectFor(socket, "status", "events:error");

  assert.deepEqual(status.groups, []);
  assert.match(eventsError.message, /Any events below are stale/);
  assert.doesNotMatch(eventsError.message, /SECRET/);

  await disconnectClient(socket, io);
  eventsFail = false;

  const [[recoveredStatus], [recoveredEvents]] = await connectFor(socket, "status", "events");

  assert.deepEqual(recoveredStatus.groups, []);
  assert.deepEqual(recoveredEvents, diagnosticData());
  assert.equal(log.mock.callCount(), 2);
});

test("bounds live connections and releases slots when clients disconnect", { timeout: 15_000 }, async t => {
  const { url, io } = await startServer(t);
  const clients = [];

  for (let index = 0; index < 8; index++) {
    const socket = createClient(t, url);

    await connectFor(socket, "status", "events");
    clients.push(socket);
  }

  const rejected = createClient(t, url);
  const [[error]] = await connectFor(rejected, "connect_error");

  assert.equal(error.message, "Live updates are busy");
  assert.equal((await fetch(`${url}/health`)).status, 200);

  await disconnectClient(clients[0], io);
  await connectFor(rejected, "status", "events");

  assert.equal(rejected.connected, true);
});

test("disables caching for pages, health, and error responses", async t => {
  let calls = 0;
  const { app, url } = await startServer(t, async () => {
    calls++;

    return summarize([]);
  });

  assert.equal(app.enabled("etag"), false);

  for (const [path, status] of [
    ["/", 200], ["/status", 200], ["/api/session", 204], ["/api/status", 200],
    ["/api/events", 200], ["/api/missing", 404], ["/missing", 404], ["/health", 200],
  ]) {
    const response = await fetch(url + path, {
      headers: { "If-None-Match": "*", "If-Modified-Since": "Mon, 02 Nov 2026 12:00:00 GMT" },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store, no-cache, max-age=0, must-revalidate");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("expires"), "0");
    assert.equal(response.headers.get("surrogate-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("last-modified"), null);
    await response.arrayBuffer();
  }
  assert.equal(calls, 2);

  const polling = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);

  assert.equal(polling.status, 200);
  assert.match(polling.headers.get("cache-control"), /no-store/);
  await polling.text();

  const denied = await fetch(`${url}/api/session`, { method: "POST" });

  assert.equal(denied.status, 405);
  assert.deepEqual(await denied.json(), { error: "Read-only endpoint" });
});

test("requests uncached Docker status on every read", async () => {
  let calls = 0;
  const fetchDocker = async (_url, options) => {
    calls++;
    assert.equal(options.cache, "no-store");
    return new Response("[]");
  };
  await readStatus(fetchDocker);
  await readStatus(fetchDocker);
  assert.equal(calls, 2);
});

const diagnosticData = () => ({
  checked_at: "2026-11-02T16:00:00.000Z",
  events: [{
    timestamp: "2026-11-02T15:40:00.000Z", group: "example",
    type: "unregistered", severity: "warning",
    explanation: "Sablier stopped an enabled container that had no Sablier-managed session.",
  }],
  diagnostics: [{
    group: "example", type: "unregistered", severity: "warning",
    explanation: "Sablier stopped an enabled container that had no Sablier-managed session.", count: 1,
  }],
  ignored_records: 2, limited: false,
});

test("reads bounded diagnostics without caching and rejects invalid responses", async () => {
  const data = diagnosticData();
  assert.deepEqual(await readEvents(async (url, options) => {
    assert.equal(url, "http://docker-status-proxy:2375/events");
    assert.equal(options.cache, "no-store");
    return Response.json(data);
  }), data);
  const invalid = [
    null, {}, { ...data, events: Array(101).fill(data.events[0]) },
    { ...data, checked_at: "invalid" }, { ...data, limited: null },
    { ...data, ignored_records: -1 }, { ...data, events: [{ ...data.events[0], timestamp: "invalid" }] },
    { ...data, events: [{ ...data.events[0], severity: "unexpected" }] },
    { ...data, diagnostics: [{ ...data.diagnostics[0], count: 0 }] },
  ];
  for (const value of invalid) {
    await assert.rejects(readEvents(async () => Response.json(value)), /Invalid/);
  }
  await assert.rejects(readEvents(async () => new Response("SECRET", { status: 503 })), /HTTP 503/);
  await assert.rejects(readEvents(async () => new Response("SECRET")), /invalid JSON/);
  await assert.rejects(readEvents(async () => new Response(" ".repeat(2_000_001))), /size limit/);
});

test("serves diagnostics independently and preserves healthy container status on log failure", async t => {
  const log = t.mock.method(console, "error", () => {});
  let fail = false;
  const data = diagnosticData();
  const { url } = await startServer(t, async () => summarize([]), async () => {
    if (fail) throw new Error("SECRET upstream detail");
    return data;
  });
  const response = await fetch(`${url}/api/events`, { headers: { "If-None-Match": "*" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("etag"), null);
  assert.deepEqual(await response.json(), data);
  fail = true;
  const unavailable = await fetch(`${url}/api/events`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Sablier diagnostics are temporarily unavailable" });
  assert.equal(log.mock.callCount(), 1);
  for (const path of ["/", "/health"]) {
    const healthy = await fetch(url + path);
    assert.equal(healthy.status, 200);
    await healthy.text();
  }
  const denied = await fetch(`${url}/api/events`, { method: "POST" });
  assert.equal(denied.status, 405);
  assert.deepEqual(await denied.json(), { error: "Read-only endpoint" });
});
