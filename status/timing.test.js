import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp, relativeTime, summarize } from "./server.js";

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
  for (const value of [undefined, null, "0001-01-01T00:00:00Z"]) {
    const { groups: [group] } = summarize([container("created", value, value)]);
    assert.equal(group.last_started_at, null);
    assert.equal(group.last_stopped_at, null);
  }
  for (const value of ["invalid", 123]) {
    assert.throws(() => summarize([container("running", value, null)]), /Invalid Docker/);
  }
});

test("formats relative ages at boundaries and clamps future timestamps", () => {
  const now = "2026-11-02T12:00:00Z";
  assert.equal(relativeTime(null, now), "Not available");
  for (const [seconds, expected] of [[0, "0 seconds"], [59, "59 seconds"], [60, "1 minute"], [3600, "1 hour"], [86400, "1 day"]]) {
    assert.equal(relativeTime(new Date(Date.parse(now) - seconds * 1000).toISOString(), now), `${expected} ago`);
  }
  assert.equal(relativeTime("2026-11-03T00:00:00Z", now), "0 seconds ago");
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
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), data);
});
