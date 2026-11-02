const rules = new Map([
  ["stopped unregistered instance", ["unregistered", "warning", "Sablier stopped an enabled container that had no Sablier-managed session."]],
  ["externally started instance detected, stopping", ["unregistered", "warning", "Sablier detected an enabled container started outside its session management and requested a stop."]],
  ["request to start instance dispatched", ["starting", "info", "Sablier requested a container start."]],
  ["instance is ready", ["ready", "info", "Sablier confirmed the container is ready."]],
  ["instance expired", ["expired", "info", "The idle session expired; Sablier requested a stop. This does not confirm the stop succeeded."]],
  ["instance added to group", ["enabled", "info", "Sablier discovered an enabled container in a group."]],
  ["instance removed from group", ["removed", "info", "Sablier removed a container from a group."]],
  ["async instance start failed", ["start_failed", "error", "A container start failed. Check readiness and the private Sablier logs."]],
  ["request to start instance failed", ["start_failed", "error", "A start request failed. Check session storage and the private Sablier logs."]],
  ["failed to stop instance", ["stop_failed", "error", "Sablier could not stop a container. Check Docker access and the private Sablier logs."]],
  ["failed to stop externally-started instance", ["stop_failed", "error", "Sablier could not stop an externally started container."]],
  ["instance expired could not be stopped from provider", ["stop_failed", "error", "Sablier could not stop a container after its idle session expired."]],
  ["instance expired could not be inspected before stop", ["inspection_failed", "warning", "Sablier could not verify the container before stopping it."]],
  ["instance expired but is not managed by sablier, skipping stop", ["stop_skipped", "warning", "Sablier skipped an expired container because it is no longer enabled."]],
]);

const globalRules = new Map([
  ["set groups", ["groups_refreshed", "info", "Sablier refreshed its managed group registry."]],
  ["initial group scan failed", ["discovery_failed", "error", "Initial group discovery failed. Check Docker access and the private Sablier logs."]],
  ["cannot retrieve groups from provider", ["discovery_failed", "error", "Group discovery failed. Sablier may not know about recently deployed containers."]],
  ["group event stream closed; relying on reconciliation ticker", ["discovery_delayed", "warning", "Live group discovery disconnected; Sablier is relying on periodic scans."]],
  ["group event stream permanently lost; relying on reconciliation ticker", ["discovery_delayed", "warning", "Live group discovery failed; Sablier is relying on periodic scans."]],
  ["unregistered instance scan failed", ["scan_failed", "error", "Sablier could not scan for containers outside its session management."]],
]);

function logText(body) {
  const streams = [[], []];
  for (let offset = 0; offset < body.length;) {
    if (offset + 8 > body.length || ![1, 2].includes(body[offset]) ||
        body[offset + 1] !== 0 || body[offset + 2] !== 0 || body[offset + 3] !== 0) {
      throw new Error("Invalid Docker log framing; Sablier must run without a TTY");
    }
    const length = body.readUInt32BE(offset + 4);
    if (offset + 8 + length > body.length) throw new Error("Incomplete Docker log frame");
    streams[body[offset] - 1].push(body.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return streams.flatMap(chunks => Buffer.concat(chunks).toString("utf8").split("\n")).filter(Boolean);
}

export function sanitizeEvents(body, containers, now = Date.now()) {
  const groups = new Map();
  for (const container of containers) {
    if (container.Labels?.["sablier.enable"] !== "true") continue;
    const group = container.Labels["sablier.group"] || "(ungrouped)";
    if (typeof group !== "string" || group.length > 256) throw new Error("Invalid Sablier group");
    for (const name of [...(container.Names ?? []), container.Id, container.Id?.slice(0, 12)]) {
      if (typeof name === "string") groups.set(name.replace(/^\//, ""), group);
    }
  }
  const lines = logText(body);
  const events = [];
  let ignored = 0;
  for (const line of lines) {
    // Docker supplies the date; Sablier's console timestamp has only the time of day.
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) \d{1,2}:\d\d[AP]M (?:INF|WRN|ERR|DBG) (?:[\w./-]+\/)?(?:sablier|sabliercmd)\/[\w-]+\.go:\d+ (.+)$/.exec(line);
    if (!match) { ignored++; continue; }
    const timestamp = Date.parse(match[1]);
    if (!Number.isFinite(timestamp) || timestamp < now - 3_600_000 || timestamp > now) continue;
    const message = match[2];
    let rule;
    let group = null;
    for (const [prefix, definition] of rules) {
      if (!message.startsWith(`${prefix} instance=`)) continue;
      const instance = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)(?: |$)/.exec(message.slice(prefix.length + 10));
      if (instance && groups.has(instance[1])) {
        rule = definition;
        group = groups.get(instance[1]);
      }
      break;
    }
    if (!rule) {
      for (const [prefix, definition] of globalRules) {
        if (message === prefix || message.startsWith(`${prefix} `)) {
          rule = definition;
          break;
        }
      }
    }
    if (!rule) { ignored++; continue; }
    const [type, severity, explanation] = rule;
    events.push({ timestamp: new Date(timestamp).toISOString(), group, type, severity, explanation });
  }
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const recent = events.slice(0, 100);
  const diagnostics = [];
  for (const event of recent.filter(event => event.severity !== "info")) {
    const existing = diagnostics.find(item => item.group === event.group && item.type === event.type);
    if (existing) existing.count++;
    else diagnostics.push({ group: event.group, type: event.type, severity: event.severity, explanation: event.explanation, count: 1 });
  }
  return {
    checked_at: new Date(now).toISOString(),
    events: recent,
    diagnostics,
    ignored_records: ignored,
    limited: lines.length >= 1000 || events.length > 100,
  };
}

export async function readEvents(readDocker, signal) {
  const query = new URLSearchParams({ all: "true" });
  const list = await readDocker(`/containers/json?${query}`, signal);
  if (list.status !== 200) throw new Error(`Docker event discovery returned HTTP ${list.status}`);
  const containers = JSON.parse(list.body.toString("utf8"));
  if (!Array.isArray(containers)) throw new Error("Docker did not return a container list");
  if (containers.filter(container => container.Labels?.["sablier.enable"] === "true").length > 128) {
    throw new Error("Container event mapping limit exceeded");
  }
  const daemons = containers.filter(container => container.Labels?.["sablier.diagnostics"] === "true");
  if (daemons.length !== 1) throw new Error("Expected exactly one labelled Sablier diagnostics source");
  const id = daemons[0].Id;
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Sablier diagnostics identifier");
  const now = Date.now();
  const options = new URLSearchParams({
    stdout: "true", stderr: "true", timestamps: "true", tail: "1000",
    since: String(Math.floor((now - 3_600_000) / 1000)),
  });
  const logs = await readDocker(`/containers/${id}/logs?${options}`, signal);
  if (logs.status !== 200) throw new Error(`Docker log read returned HTTP ${logs.status}`);
  return sanitizeEvents(logs.body, containers, now);
}
