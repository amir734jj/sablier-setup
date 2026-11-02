import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { DateTime } from "luxon";
import { createApp, formatTime, readEvents, readStatus, relativeTime, summarize } from "./server.js";

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

test("renders lifecycle columns and keeps JSON health timing fields", async t => {
  const data = summarize([container("running", "2026-11-02T10:00:00Z", null)]);
  const server = createApp(async () => data).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url)).text();
  assert.match(html, /Last started/);
  assert.match(html, /Last stopped/);
  assert.match(html, /@media \(max-width: 767\.98px\)/);
  for (const label of ["Status", "Container states", "Last started", "Last stopped"]) {
    assert.match(html, new RegExp(`data-label="${label}"`));
  }
  assert.match(html, /Not available/);
  assert.match(html, /datetime="2026-11-02T10:00:00.000Z"/);
  assert.match(html, /title="2026-11-02 10:00:00.000 UTC"/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /2026-11-02 10:00:00.000 UTC/);
  assert.match(html, /window\.setTimeout\(\(\) => window\.location\.reload\(\), 30_000\)/);
  assert.match(html, /if \(event\.persisted\) window\.location\.reload\(\)/);
  assert.match(html, /href="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.8\/dist\/css\/bootstrap\.min\.css"/);
  assert.match(html, /Sablier events/);
  assert.match(html, /window\.setTimeout\(refreshEvents, 5_000\)/);
  assert.match(html, /fetch\("\/events", \{ cache: "no-store"/);
  assert.match(html, /cell\.textContent = value/);
  assert.match(html, /Any events below are stale/);
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), data);
});

test("disables caching for pages, health, and error responses", async t => {
  let calls = 0;
  const app = createApp(async () => { calls++; return summarize([]); });
  assert.equal(app.enabled("etag"), false);
  assert.equal(app.enabled("view cache"), false);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [path, status] of [["/", 200], ["/status", 200], ["/health", 200], ["/missing", 404], ["/health", 200]]) {
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
  assert.equal(calls, 4);
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
  const server = createApp(async () => summarize([]), async () => {
    if (fail) throw new Error("SECRET upstream detail");
    return data;
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/events`, { headers: { "If-None-Match": "*" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("etag"), null);
  assert.deepEqual(await response.json(), data);
  fail = true;
  const unavailable = await fetch(`${url}/events`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Sablier diagnostics are temporarily unavailable" });
  assert.equal(log.mock.callCount(), 1);
  for (const path of ["/", "/health"]) {
    const healthy = await fetch(url + path);
    assert.equal(healthy.status, 200);
    await healthy.text();
  }
  const denied = await fetch(`${url}/events`, { method: "POST" });
  assert.equal(denied.status, 405);
  assert.deepEqual(await denied.json(), { error: "Read-only endpoint" });
});
