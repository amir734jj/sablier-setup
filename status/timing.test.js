import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { DateTime } from "luxon";
import { createApp, formatTime, readStatus, relativeTime, summarize } from "./server.js";

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
  assert.match(html, /Not available/);
  assert.match(html, /datetime="2026-11-02T10:00:00.000Z"/);
  assert.match(html, /title="2026-11-02 10:00:00.000 UTC"/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /2026-11-02 10:00:00.000 UTC/);
  assert.match(html, /window\.setTimeout\(\(\) => window\.location\.reload\(\), 30_000\)/);
  assert.match(html, /if \(event\.persisted\) window\.location\.reload\(\)/);
  assert.match(html, /href="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.8\/dist\/css\/bootstrap\.min\.css"/);
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
