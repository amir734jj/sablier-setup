import Docker from "dockerode";
import { createServer } from "node:http";
import { parse } from "node:querystring";
import { addAbortSignal } from "node:stream";
import { pathToFileURL } from "node:url";

const statusCodes = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [index + 200, true]));

async function readDocker(path, docker, signal) {
  const response = await new Promise((resolve, reject) => {
    // Stream through Dockerode's transport so the size limit applies before buffering.
    docker.modem.dial({
      path: path.split("?")[0] + "?",
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
      const signal = AbortSignal.timeout(timeoutMs);
      const { status, body } = await readDocker(incoming.url, docker, signal);
      if (status !== 200) {
        outgoing.writeHead(status).end(body);
        return;
      }
      const containers = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(containers)) throw new Error("Docker did not return a container list");
      const enabled = containers.filter(container => container.Labels?.["sablier.enable"] === "true");
      if (enabled.length > 128) throw new Error("Container timing inspection limit exceeded");
      for (const container of enabled) {
        if (!/^[a-f0-9]{64}$/.test(container.Id)) throw new Error("Invalid Docker container identifier");
        const detail = await readDocker(`/containers/${container.Id}/json`, docker, signal);
        if (detail.status !== 200) throw new Error(`Docker inspection returned HTTP ${detail.status}`);
        const { State: state } = JSON.parse(detail.body.toString("utf8"));
        if (!state || typeof state.StartedAt !== "string" || typeof state.FinishedAt !== "string") {
          throw new Error("Invalid Docker lifecycle timestamps");
        }
        container.StartedAt = state.StartedAt;
        container.FinishedAt = state.FinishedAt;
      }
      const result = enabled.length ? Buffer.from(JSON.stringify(containers)) : body;
      if (result.length > 2_000_000) throw new Error("Docker status response exceeds size limit");
      outgoing.writeHead(status).end(result);
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
