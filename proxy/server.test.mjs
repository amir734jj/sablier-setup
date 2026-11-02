import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProxy } from "./server.mjs";
import { sanitizeEvents } from "./events.mjs";

function logFrame(text, stream = 2) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const eventNow = Date.parse("2026-11-02T16:00:00Z");
const eventContainers = [{
  Id: "b".repeat(64), Names: ["/private-container-name"],
  Labels: { "sablier.enable": "true", "sablier.group": "public-group" },
}];

test("publishes only allowlisted event fields, never raw messages or container names", () => {
  const body = logFrame([
    '2026-11-02T15:40:00.123456789Z 3:40PM INF sablier/autostop.go:54 stopped unregistered instance instance=private-container-name reason="SECRET=private"',
    '2026-11-02T15:41:00Z 3:41PM ERR sablier/instance_request.go:190 async instance start failed instance=private-container-name error="password=private"',
    '2026-11-02T15:42:00Z 3:42PM INF sablier/instance_request.go:195 instance is ready instance=private-container-name',
    '2026-11-02T15:43:00Z 3:43PM ERR sablier/instance_request.go:190 async instance start failed instance=unmanaged error="SECRET"',
    '2026-11-02T15:44:00Z 3:44PM INF sablier/unknown.go:1 arbitrary private message token=SECRET',
    '2026-11-02T15:45:00Z 3:45PM INF sablier/sablier.go:158 set groups new="map[private-name:[private-id]]"',
    "",
  ].join("\n"));
  const data = sanitizeEvents(body, eventContainers, eventNow);
  assert.deepEqual(data.events.map(event => [event.type, event.group]), [
    ["groups_refreshed", null], ["ready", "public-group"],
    ["start_failed", "public-group"], ["unregistered", "public-group"],
  ]);
  assert.equal(data.events[3].timestamp, "2026-11-02T15:40:00.123Z");
  assert.equal(data.ignored_records, 2);
  assert.equal(data.diagnostics.length, 2);
  assert.deepEqual(Object.keys(data.events[0]), ["timestamp", "group", "type", "severity", "explanation"]);
  assert.doesNotMatch(JSON.stringify(data), /private-container-name|private-name|private-id|SECRET|password|token|instance=|\.go:/);
});

test("enforces the one-hour and 100-event limits and aggregates diagnostic counts", () => {
  const records = Array.from({ length: 110 }, (_, index) =>
    `2026-11-02T15:${String(index % 60).padStart(2, "0")}:00Z 3:00PM INF sablier/autostop.go:54 stopped unregistered instance instance=private-container-name\n`);
  records.push(
    "2026-11-02T14:59:59Z 2:59PM INF sablier/instance_request.go:195 instance is ready instance=private-container-name\n",
    "2026-11-02T16:00:01Z 4:00PM INF sablier/instance_request.go:195 instance is ready instance=private-container-name\n",
  );
  const data = sanitizeEvents(logFrame(records.join("")), eventContainers, eventNow);
  assert.equal(data.events.length, 100);
  assert.equal(data.limited, true);
  assert.equal(data.diagnostics[0].count, 100);
  assert.ok(data.events.every(event => event.type === "unregistered"));
  assert.ok(data.events.every((event, index) => !index || event.timestamp <= data.events[index - 1].timestamp));
});

test("handles split Docker frames, stream separation, empty logs, and invalid formats safely", () => {
  const line = "2026-11-02T15:40:00Z 3:40PM INF sablier/instance_request.go:195 instance is ready instance=private-container-name\n";
  const body = Buffer.concat([logFrame(line.slice(0, 20)), logFrame("unrelated stdout\n", 1), logFrame(line.slice(20))]);
  const data = sanitizeEvents(body, eventContainers, eventNow);
  assert.equal(data.events.length, 1);
  assert.equal(data.ignored_records, 1);
  assert.deepEqual(sanitizeEvents(Buffer.alloc(0), eventContainers, eventNow).events, []);
  assert.equal(sanitizeEvents(logFrame("unsupported SECRET format\n"), eventContainers, eventNow).ignored_records, 1);
  for (const invalid of [Buffer.from("raw tty logs"), logFrame(line).subarray(0, 15), Buffer.alloc(7)]) {
    assert.throws(() => sanitizeEvents(invalid, eventContainers, eventNow), /Docker log/);
  }
});

test("covers recognized Sablier transitions without claiming expiration confirms a stop", () => {
  const messages = [
    ["instance added to group", "enabled"],
    ["instance removed from group", "removed"],
    ["request to start instance dispatched", "starting"],
    ["instance expired", "expired"],
    ["instance expired could not be stopped from provider", "stop_failed"],
    ["instance expired could not be inspected before stop", "inspection_failed"],
    ["instance expired but is not managed by sablier, skipping stop", "stop_skipped"],
  ];
  const data = sanitizeEvents(logFrame(messages.map(([message]) =>
    `2026-11-02T15:40:00Z 3:40PM INF sablier/instance_request.go:1 ${message} instance=private-container-name group=SECRET error=SECRET\n`).join("")), eventContainers, eventNow);
  assert.deepEqual(data.events.map(event => event.type), messages.map(([, type]) => type));
  assert.match(data.events.find(event => event.type === "expired").explanation, /does not confirm/);
  assert.doesNotMatch(JSON.stringify(data), /SECRET/);
});

test("reads only the designated daemon logs and denies arbitrary log access", async t => {
  const daemon = "a".repeat(64);
  const paths = [];
  await withProxy(t, (incoming, response) => {
    const url = new URL(incoming.url, "http://docker");
    paths.push(url.pathname);
    if (url.pathname === "/containers/json") {
      assert.equal(url.searchParams.get("all"), "true");
      response.end(JSON.stringify([
        { Id: daemon, Labels: { "sablier.diagnostics": "true" } },
        ...eventContainers,
      ]));
    } else {
      assert.equal(url.pathname, `/containers/${daemon}/logs`);
      assert.equal(url.searchParams.get("tail"), "1000");
      assert.equal(url.searchParams.get("timestamps"), "true");
      assert.equal(url.searchParams.get("stdout"), "true");
      assert.equal(url.searchParams.get("stderr"), "true");
      assert.ok(Math.abs(Number(url.searchParams.get("since")) * 1000 - (Date.now() - 3_600_000)) < 5000);
      assert.equal(url.searchParams.has("follow"), false);
      response.end(logFrame(`${new Date(Date.now() - 1000).toISOString()} 3:40PM INF sablier/instance_request.go:195 instance is ready instance=private-container-name error=SECRET\n`));
    }
  }, async url => {
    const response = await fetch(`${url}/events`, { headers: { Authorization: "SECRET" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const data = await response.json();
    assert.equal(data.events[0].group, "public-group");
    assert.doesNotMatch(JSON.stringify(data), /SECRET|private-container-name/);
    for (const path of [`/containers/${daemon}/logs`, "/events?tail=all", "/events/", "/events?container=private"]) {
      assert.equal((await fetch(url + path)).status, 403);
    }
    assert.equal((await fetch(`${url}/events`, { method: "POST" })).status, 403);
    assert.deepEqual(paths, ["/containers/json", `/containers/${daemon}/logs`]);
  });
});

test("fails explicitly for missing or ambiguous daemon sources and Docker log errors", async t => {
  const log = t.mock.method(console, "error", () => {});
  for (const mode of ["missing", "ambiguous", "invalid-id", "log-error", "bad-frame"]) {
    await withProxy(t, (incoming, response) => {
      if (new URL(incoming.url, "http://docker").pathname === "/containers/json") {
        const daemon = { Id: mode === "invalid-id" ? "../private" : "a".repeat(64), Labels: { "sablier.diagnostics": "true" } };
        response.end(JSON.stringify(mode === "missing" ? [] : mode === "ambiguous" ? [daemon, daemon] : [daemon]));
      } else if (mode === "log-error") response.writeHead(500).end('{"error":"SECRET"}');
      else response.end("raw tty SECRET");
    }, async url => {
      const response = await fetch(`${url}/events`);
      assert.equal(response.status, 503, mode);
      assert.deepEqual(await response.json(), { error: "Sablier diagnostics are temporarily unavailable" });
    });
  }
  assert.equal(log.mock.callCount(), 5);
});

async function withProxy(t, handler, run, options = {}) {
  const id = `sablier-${randomUUID()}`;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
  const docker = createServer(handler);
  docker.listen(socketPath);
  await once(docker, "listening");
  t.after(() => new Promise((resolve, reject) => {
    docker.close(error => error ? reject(error) : resolve());
    docker.closeAllConnections();
  }));
  const proxy = createProxy({ socketPath, ...options });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve, reject) => {
    proxy.close(error => error ? reject(error) : resolve());
    proxy.closeAllConnections();
  }));
  await run(`http://127.0.0.1:${proxy.address().port}`, docker);
}

test("forwards allowed queries over the Docker socket without client headers", async t => {
  const path = "/containers/json?all=true&filters=%7B%22label%22%3A%5B%22sablier.enable%3Dtrue%22%5D%7D";
  await withProxy(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, path);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["cache-control"], "no-cache");
    assert.equal(request.headers.pragma, "no-cache");
    response.setHeader("X-Private", "hidden");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("ETag", '"docker-cached"');
    response.end("[]");
  }, async url => {
    const response = await fetch(url + path, { headers: { Authorization: "private" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store, no-cache, max-age=0, must-revalidate");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("expires"), "0");
    assert.equal(response.headers.get("surrogate-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("x-private"), null);
    assert.equal(await response.text(), "[]");
  });
});

test("parses repeated query parameters and question marks with URL", async t => {
  await withProxy(t, (incoming, response) => {
    const url = new URL(incoming.url, "http://docker");
    assert.equal(url.pathname, "/containers/json");
    assert.deepEqual(url.searchParams.getAll("label"), ["first", "second"]);
    assert.equal(url.searchParams.get("value"), "one?two");
    assert.equal(url.searchParams.get("encoded"), "?");
    assert.equal(url.searchParams.get("empty"), "");
    response.end("[]");
  }, async url => {
    const response = await fetch(`${url}/containers/json?label=first&label=second&value=one?two&encoded=%3F&empty=`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});

test("denies raw path aliases before URL normalization", async t => {
  let calls = 0;
  await withProxy(t, (_incoming, response) => { calls++; response.end("[]"); }, async url => {
    const paths = [
      "/ignored/../containers/json",
      "/ignored/%2e%2e/containers/json",
      "//docker/containers/json",
      "/containers\\json",
      "/containers/json#fragment",
    ];
    const statuses = await Promise.all(paths.map(path => new Promise((resolve, reject) => {
      const incoming = request(url, { path }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      incoming.on("error", reject);
      incoming.end();
    })));
    assert.deepEqual(statuses, paths.map(() => 403));
    assert.equal(calls, 0);
  });
});

test("inspects containers sequentially and preserves list order", async t => {
  const ids = ["a", "b", "c"].map(character => character.repeat(64));
  const inspected = [];
  let active = 0;
  let peak = 0;
  await withProxy(t, (incoming, response) => {
    const { pathname } = new URL(incoming.url, "http://docker");
    if (pathname === "/containers/json") {
      response.end(JSON.stringify(ids.map(Id => ({ Id, Labels: { "sablier.enable": "true" } }))));
      return;
    }
    inspected.push(pathname);
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      response.end(JSON.stringify({
        State: { StartedAt: "2026-11-02T10:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" },
      }));
    }, 10);
  }, async url => {
    const response = await fetch(`${url}/containers/json`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(container => container.Id), ids);
    assert.deepEqual(inspected, ids.map(id => `/containers/${id}/json`));
    assert.equal(peak, 1);
  });
});

test("reads Docker again on every request and ignores conditional client headers", async t => {
  let calls = 0;
  await withProxy(t, (request, response) => {
    assert.equal(request.headers["if-none-match"], undefined);
    assert.equal(request.headers["if-modified-since"], undefined);
    response.end(JSON.stringify([{ State: ++calls === 1 ? "running" : "exited" }]));
  }, async url => {
    for (const state of ["running", "exited"]) {
      const response = await fetch(`${url}/containers/json`, {
        headers: { "If-None-Match": '"cached"', "If-Modified-Since": "Mon, 02 Nov 2026 12:00:00 GMT" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store, no-cache, max-age=0, must-revalidate");
      assert.deepEqual(await response.json(), [{ State: state }]);
    }
    assert.equal(calls, 2);
  });
});

test("denies other methods and paths without contacting Docker", async t => {
  let calls = 0;
  await withProxy(t, (_request, response) => { calls++; response.end("[]"); }, async url => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      assert.equal((await fetch(`${url}/containers/json`, { method })).status, 403);
    }
    for (const path of ["/", "/info", "/containers/json/extra", "/containers/json/", "/v1.47/containers/json", "/containers/create", "/containers/%6ason", `/containers/${"a".repeat(64)}/json`]) {
      assert.equal((await fetch(url + path)).status, 403);
    }
    assert.equal(calls, 0);
  });
});

  test("adds only lifecycle timestamps for enabled containers", async t => {
    const id = "a".repeat(64);
    const paths = [];
    await withProxy(t, (request, response) => {
      paths.push(request.url);
      if (new URL(request.url, "http://docker").pathname === "/containers/json") {
        response.end(JSON.stringify([
          { Id: id, Labels: { "sablier.enable": "true" } },
          { Id: "b".repeat(64), Labels: {} },
        ]));
      } else {
        assert.equal(new URL(request.url, "http://docker").pathname, `/containers/${id}/json`);
        response.end(JSON.stringify({
          State: { StartedAt: "2026-11-02T10:00:00Z", FinishedAt: "2026-11-02T09:00:00Z" },
          Config: { Env: ["SECRET=private"] },
        }));
      }
    }, async url => {
      const response = await fetch(`${url}/containers/json`);
      assert.equal(response.status, 200);
      const containers = await response.json();
      assert.deepEqual(containers[0], {
        Id: id, Labels: { "sablier.enable": "true" },
        StartedAt: "2026-11-02T10:00:00Z", FinishedAt: "2026-11-02T09:00:00Z",
      });
      assert.deepEqual(containers[1], { Id: "b".repeat(64), Labels: {} });
      assert.equal(paths.length, 2);
    });
  });

  test("logs inspection failures rather than returning incomplete timing data", async t => {
    const log = t.mock.method(console, "error", () => {});
    await withProxy(t, (request, response) => {
      if (new URL(request.url, "http://docker").pathname === "/containers/json") {
        response.end(JSON.stringify([{ Id: "a".repeat(64), Labels: { "sablier.enable": "true" } }]));
      } else response.writeHead(404).end("{}");
    }, async url => {
      assert.equal((await fetch(`${url}/containers/json`)).status, 503);
      assert.equal(log.mock.callCount(), 1);
    });
  });

  test("caps timing inspections before inspecting any container", async t => {
    t.mock.method(console, "error", () => {});
    let calls = 0;
    await withProxy(t, (_request, response) => {
      calls++;
      response.end(JSON.stringify(Array.from({ length: 129 }, () => ({
        Id: "a".repeat(64), Labels: { "sablier.enable": "true" },
      }))));
    }, async url => {
      assert.equal((await fetch(`${url}/containers/json`)).status, 503);
      assert.equal(calls, 1);
    });
  });

test("preserves Docker error statuses", async t => {
  await withProxy(t, (_request, response) => {
    response.writeHead(500).end('{"message":"Docker failed"}');
  }, async url => {
    const response = await fetch(`${url}/containers/json`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: "Docker failed" });
  });
});

test("logs socket failures and returns 503", async t => {
  const log = t.mock.method(console, "error", () => {});
  await withProxy(t, request => request.socket.destroy(), async url => {
    const response = await fetch(`${url}/containers/json`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Docker status is temporarily unavailable" });
    assert.equal(log.mock.callCount(), 1);
  });
});

test("times out stalled Docker responses, including stalled bodies", async t => {
  const log = t.mock.method(console, "error", () => {});
  await withProxy(t, (request, response) => {
    if (request.url.includes("body")) {
      response.writeHead(200);
      response.write("[");
    }
  }, async url => {
    for (const query of ["headers", "body"]) {
      const response = await fetch(`${url}/containers/json?${query}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 503);
      await response.text();
    }
    assert.equal(log.mock.callCount(), 2);
  }, { timeoutMs: 50 });
});

test("accepts the response size limit and rejects one byte over it", async t => {
  const log = t.mock.method(console, "error", () => {});
  await withProxy(t, (request, response) => {
    response.end("[]" + " ".repeat(request.url.includes("over") ? 1_999_999 : 1_999_998));
  }, async url => {
    const accepted = await fetch(`${url}/containers/json`);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.arrayBuffer()).byteLength, 2_000_000);
    const rejected = await fetch(`${url}/containers/json?over`);
    assert.equal(rejected.status, 503);
    await rejected.text();
    assert.equal(log.mock.callCount(), 1);
  });
});

test("rejects the ninth active read and restores capacity after completion", async t => {
  const pending = [];
  let ready;
  const admitted = new Promise(resolve => { ready = resolve; });
  await withProxy(t, (_request, response) => {
    pending.push(response);
    if (pending.length === 8) ready();
    if (pending.length > 8) response.end("[]");
  }, async url => {
    const reads = Array.from({ length: 8 }, () => fetch(`${url}/containers/json`));
    try {
      await admitted;
      const busy = await fetch(`${url}/containers/json`);
      assert.equal(busy.status, 503);
      await busy.text();
      assert.equal(pending.length, 8);
    } finally {
      for (const response of pending) response.end("[]");
      for (const response of await Promise.all(reads)) {
        assert.equal(response.status, 200);
        await response.text();
      }
    }
    const resumed = await fetch(`${url}/containers/json`);
    assert.equal(resumed.status, 200);
    await resumed.text();
  });
});
