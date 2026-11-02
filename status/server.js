import express from "express";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "socket.io";
import { createReaders, readEvents, readStatus, sendError } from "./utils.js";

export { formatTime, relativeTime } from "./shared/format.js";
export { readEvents, readStatus, summarize } from "./utils.js";

const MAX_LIVE_CONNECTIONS = 8;
const STATUS_INTERVAL_MS = 30_000;
const EVENTS_INTERVAL_MS = 5_000;

function createApp(readers, webRoot) {
  const app = express();
  const fileOptions = { etag: false, lastModified: false, cacheControl: false };

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("json spaces", 2);

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

  const sendEvents = async (request, response) => {
    response.json(await readers.events());
  };

  const sendStatus = async (request, response) => {
    response.json(await readers.status());
  };

  const renewSession = (request, response) => response.sendStatus(204);
  const api = express.Router();

  api.get("/status", sendStatus);
  api.get("/events", sendEvents);
  api.get("/session", renewSession);
  api.all(["/status", "/events", "/session"], (request, response) => {
    sendError(request, response, 405, "Read-only endpoint");
  });
  api.use((request, response) => sendError(request, response, 404, "Not found"));

  app.use("/api", api);

  app.get("/health", sendStatus);
  app.get("/events", sendEvents);
  app.get("/session", renewSession);

  app.use(express.static(webRoot, {
    ...fileOptions,
    index: false,
    redirect: false,
  }));

  app.get(["/", "/status"], (request, response) => {
    response.sendFile(join(webRoot, "index.html"), fileOptions);
  });

  const paths = ["/", "/status", "/session", "/events", "/health"];

  app.all(paths, (request, response) => sendError(request, response, 405, "Read-only endpoint"));
  app.use((request, response) => sendError(request, response, 404, "Not found"));

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    if (["/api/events", "/events"].includes(request.path)) {
      console.error("Unable to read Sablier diagnostics:", error.message);
      return sendError(request, response, 503, "Sablier diagnostics are temporarily unavailable");
    }

    if (["/api/status", "/health"].includes(request.path)) {
      console.error("Unable to read Docker container status:", error.message);
      return sendError(request, response, 503, "Container status is temporarily unavailable");
    }

    console.error("Unable to serve dashboard assets:", error.message);
    sendError(request, response, 503, "Dashboard assets are temporarily unavailable");
  });

  return app;
}

function attachLiveUpdates(io, readers) {
  const connections = new Set();

  io.use((socket, next) => {
    if (connections.size >= MAX_LIVE_CONNECTIONS) {
      return next(new Error("Live updates are busy"));
    }

    connections.add(socket.id);

    const release = () => connections.delete(socket.id);

    socket.once("disconnect", release);
    socket.conn.once("close", release);
    next();
  });

  io.on("connection", socket => {
    let timer;
    let nextStatus = 0;

    socket.once("disconnect", () => clearTimeout(timer));

    async function update(event, load, message) {
      let data;

      try {
        data = await load();
      } catch (error) {
        console.error(`Unable to publish ${event}:`, error.message);

        if (socket.connected) {
          socket.emit(`${event}:error`, { message });
        }

        return;
      }

      if (socket.connected) {
        socket.emit(event, data);
      }
    }

    async function poll() {
      if (!socket.connected) return;

      if (Date.now() >= nextStatus) {
        nextStatus = Date.now() + STATUS_INTERVAL_MS;

        await update("status", readers.status,
          "Container status is temporarily unavailable. Any status below is stale; retrying in 30 seconds.");
      }

      if (!socket.connected) return;

      await update("events", readers.events,
        "Sablier diagnostics are temporarily unavailable. Any events below are stale; container status is independent. Retrying in 5 seconds.");

      if (socket.connected) {
        timer = setTimeout(poll, EVENTS_INTERVAL_MS);
      }
    }

    void poll();
  });
}

export function createStatusServer(
  loadStatus = readStatus,
  loadEvents = readEvents,
  { webRoot = fileURLToPath(new URL("./dist/", import.meta.url)) } = {},
) {
  const readers = createReaders(loadStatus, loadEvents);
  const app = createApp(readers, webRoot);
  const server = createServer({
    headersTimeout: 5000,
    requestTimeout: 5000,
    connectionsCheckingInterval: 1000,
  }, app);
  const io = new Server(server, {
    serveClient: false,
    maxHttpBufferSize: 1024,
    perMessageDeflate: false,
  });

  io.engine.on("headers", headers => {
    headers["Cache-Control"] = "no-store, no-cache, max-age=0, must-revalidate";
    headers["X-Content-Type-Options"] = "nosniff";
  });

  attachLiveUpdates(io, readers);
  server.maxConnections = 32;

  return { app, server, io };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createStatusServer();

  server.listen(8080, "0.0.0.0");
}
