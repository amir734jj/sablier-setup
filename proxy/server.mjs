import Docker from "dockerode";
import { createServer } from "node:http";
import { parse } from "node:querystring";
import { addAbortSignal } from "node:stream";
import { pathToFileURL } from "node:url";

const statusCodes = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [index + 200, true]));

async function readDocker(path, docker, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await new Promise((resolve, reject) => {
    // Stream through Dockerode's transport so the size limit applies before buffering.
    docker.modem.dial({
      path: "/containers/json?",
      method: "GET",
      options: { _query: parse(path.split("?").slice(1).join("?")) },
      isStream: true,
      abortSignal: signal,
      statusCodes,
    }, (error, stream) => error ? reject(error) : resolve(stream));
  });
  addAbortSignal(signal, response);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Docker status response exceeds size limit");
    chunks.push(chunk);
  }
  return { status: response.statusCode, body: Buffer.concat(chunks) };
}

export function createProxy({ socketPath = "/var/run/docker.sock", timeoutMs = 3000 } = {}) {
  const docker = new Docker({ socketPath });
  let active = 0;
  const server = createServer({
    headersTimeout: 5000,
    requestTimeout: 5000,
    connectionsCheckingInterval: 1000,
  }, async (incoming, outgoing) => {
    outgoing.setHeader("Cache-Control", "no-store");
    outgoing.setHeader("Content-Type", "application/json");
    if (incoming.method !== "GET" || incoming.url.split("?")[0] !== "/containers/json") {
      outgoing.writeHead(403).end(JSON.stringify({ error: "Docker API request denied" }));
      return;
    }
    if (active >= 8) {
      outgoing.writeHead(503).end(JSON.stringify({ error: "Docker status proxy is busy" }));
      return;
    }
    active++;
    try {
      const { status, body } = await readDocker(incoming.url, docker, timeoutMs);
      outgoing.writeHead(status).end(body);
    } catch (error) {
      console.error("Unable to proxy Docker container status:", error.message);
      outgoing.writeHead(503).end(JSON.stringify({ error: "Docker status is temporarily unavailable" }));
    } finally {
      active--;
    }
  });
  server.maxConnections = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createProxy().listen(2375, "0.0.0.0");
}
