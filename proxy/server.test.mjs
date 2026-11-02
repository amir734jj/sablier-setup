import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProxy } from "./server.mjs";

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
    response.setHeader("X-Private", "hidden");
    response.end("[]");
  }, async url => {
    const response = await fetch(url + path, { headers: { Authorization: "private" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-private"), null);
    assert.equal(await response.text(), "[]");
  });
});

test("denies other methods and paths without contacting Docker", async t => {
  let calls = 0;
  await withProxy(t, (_request, response) => { calls++; response.end("[]"); }, async url => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      assert.equal((await fetch(`${url}/containers/json`, { method })).status, 403);
    }
    for (const path of ["/", "/info", "/containers/json/extra", "/containers/json/", "/v1.47/containers/json", "/containers/create", "/containers/%6ason"]) {
      assert.equal((await fetch(url + path)).status, 403);
    }
    assert.equal(calls, 0);
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
