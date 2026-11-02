import _ from "lodash";
import { DateTime } from "luxon";
import { parseTime } from "./shared/format.js";

const MAX_CONCURRENT_READS = 8;

function lifecycleTime(value) {
  if (value === undefined || value === null) return null;

  const timestamp = parseTime(value);

  return timestamp.equals(DateTime.utc(1, 1, 1)) ? null : timestamp.toISO();
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

export function sendError(request, response, code, message) {
  response.status(code).json({ error: message });
}

export function createReaders(loadStatus, loadEvents) {
  let active = 0;

  async function read(load) {
    if (active >= MAX_CONCURRENT_READS) {
      throw new Error("Read concurrency limit reached");
    }

    active++;

    try {
      return await load();
    } finally {
      active--;
    }
  }

  return {
    status: () => read(loadStatus),
    events: () => read(loadEvents),
  };
}
