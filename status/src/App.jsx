import { useEffect, useState } from "preact/hooks";
import { io } from "socket.io-client";
import { diagnosticsMessage, formatTime, keyedRows, relativeTime } from "../shared/format.js";

function Notice({ id, message, warning = false }) {
  return (
    <p
      id={id}
      class={warning ? "alert alert-warning" : "small text-body-secondary"}
      role="status"
      aria-live="polite"
    >
      {message}
    </p>
  );
}

function Table({ headings, bodyId, children }) {
  return (
    <div class="table-responsive">
      <table class="table table-striped align-middle status-table">
        <thead>
          <tr>
            {headings.map(label => (
              <th key={label} scope="col">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody id={bodyId}>{children}</tbody>
      </table>
    </div>
  );
}

function LifecycleTime({ value, checkedAt }) {
  if (!value) {
    return <span class="text-body-secondary">Not available</span>;
  }

  return (
    <time dateTime={value} title={formatTime(value)}>
      {relativeTime(value, checkedAt)}
    </time>
  );
}

function GroupRow({ group, checkedAt }) {
  return (
    <tr>
      <th scope="row" class="text-break">{group.group}</th>
      <td data-label="Status">
        <span class={`badge ${group.status === "running" ? "text-bg-success" : "text-bg-danger"}`}>
          {group.status.replaceAll("_", " ")}
        </span>
      </td>
      <td class="text-break" data-label="Container states">
        {Object.entries(group.states).map(([name, count]) => `${name}: ${count}`).join(", ")}
      </td>
      <td data-label="Last started">
        <LifecycleTime value={group.last_started_at} checkedAt={checkedAt} />
      </td>
      <td data-label="Last stopped">
        <LifecycleTime value={group.last_stopped_at} checkedAt={checkedAt} />
      </td>
    </tr>
  );
}

function StatusPanel({ data }) {
  if (!data) return null;

  return (
    <div id="container-status">
      <p class="text-body-secondary">
        Last checked: <LifecycleTime value={data.checked_at} checkedAt={data.checked_at} />
      </p>
      {data.groups.length ? (
        <Table headings={["Group", "Status", "Container states", "Last started", "Last stopped"]}>
          {data.groups.map(group => (
            <GroupRow key={group.group} group={group} checkedAt={data.checked_at} />
          ))}
        </Table>
      ) : (
        <p class="alert alert-info">No Sablier-enabled containers found.</p>
      )}
      <footer class="mt-4 text-body-secondary">{data.note}</footer>
      <p class="small text-body-secondary">
        Times show the most recent start and stop in each group, not last traffic.
        They reset when containers are replaced. A running container&apos;s last stop
        may belong to its previous run.
      </p>
    </div>
  );
}

function EventRow({ event }) {
  const cells = {
    "Time (UTC)": formatTime(event.timestamp),
    "Group": event.group ?? "Sablier",
    "Event": event.type.replaceAll("_", " "),
    "Explanation": event.explanation,
  };

  return (
    <tr>
      {Object.entries(cells).map(([label, value]) => (
        <td key={label} class="text-break" data-label={label}>{value}</td>
      ))}
    </tr>
  );
}

function EventsPanel({ data }) {
  if (!data) return null;

  const diagnostics = keyedRows(data.diagnostics, ["group", "type", "severity", "explanation"]);
  const events = keyedRows(data.events, ["timestamp", "group", "type", "severity", "explanation"]);

  return (
    <div id="events-content">
      <ul id="diagnostics" class="list-group mb-3">
        {diagnostics.map(({ key, value }) => (
          <li
            key={key}
            class={`list-group-item ${value.severity === "error" ? "list-group-item-danger" : "list-group-item-warning"}`}
          >
            {value.group ?? "Sablier"}: {value.explanation}
            {" "}({value.count} recent event{value.count === 1 ? "" : "s"})
          </li>
        ))}
      </ul>
      <Table headings={["Time (UTC)", "Group", "Event", "Explanation"]} bodyId="events">
        {events.map(({ key, value }) => (
          <EventRow key={key} event={value} />
        ))}
      </Table>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("Connecting to live updates...");

  useEffect(() => {
    const socket = io({ autoConnect: false });
    const sessionController = new AbortController();
    let sessionTimer;
    let reconnectTimer;

    function reconnectIfNeeded() {
      if (!socket.active && !sessionController.signal.aborted) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => socket.connect(), 5_000);
      }
    }

    socket.on("connect", () => {
      clearTimeout(reconnectTimer);
      setConnected(true);
      setConnectionMessage("Live updates connected.");
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setConnectionMessage("Live updates disconnected. Displayed data may be stale; reconnecting automatically.");
      reconnectIfNeeded();
    });

    socket.on("connect_error", error => {
      console.error("Unable to connect to live updates:", error);
      setConnected(false);
      setConnectionMessage("Live updates are unavailable. Displayed data may be stale; retrying automatically.");
      reconnectIfNeeded();
    });

    socket.on("status", data => {
      setStatus(data);
      setStatusError("");
    });

    socket.on("events", data => {
      setEvents(data);
      setEventsError("");
    });

    socket.on("status:error", ({ message }) => setStatusError(message));
    socket.on("events:error", ({ message }) => setEventsError(message));
    socket.connect();

    async function renewSession() {
      try {
        // Socket messages do not pass through the HTTP wake middleware.
        const response = await fetch("/api/session", {
          cache: "no-store",
          signal: AbortSignal.any([sessionController.signal, AbortSignal.timeout(4500)]),
        });

        if (!response.ok) throw new Error(`Session renewal returned HTTP ${response.status}`);

        setSessionError("");
      } catch (error) {
        if (sessionController.signal.aborted) return;

        console.error("Unable to renew the status service session:", error);
        setSessionError("Unable to renew the status service session. Live updates may stop if it goes idle; retrying automatically.");
      } finally {
        if (!sessionController.signal.aborted) {
          sessionTimer = setTimeout(renewSession, 60_000);
        }
      }
    }

    void renewSession();

    return () => {
      sessionController.abort();
      clearTimeout(sessionTimer);
      clearTimeout(reconnectTimer);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  return (
    <>
      <h1 class="mb-3">Container status</h1>
      <Notice id="connection-state" message={connectionMessage} warning={!connected} />
      {sessionError && <Notice id="session-state" message={sessionError} warning />}
      <Notice
        id="status-state"
        message={statusError || (status ? "Container status is up to date." : "Loading container status...")}
        warning={Boolean(statusError)}
      />
      <StatusPanel data={status} />
      <section class="mt-5" aria-labelledby="events-heading">
        <h2 id="events-heading">Sablier events</h2>
        <p class="small text-body-secondary">
          Recent recognized Sablier events for currently deployed, enabled containers.
          Only public group names and fixed explanations are shown, never raw logs
          or container identifiers.
        </p>
        <Notice
          id="events-state"
          message={eventsError || (events ? diagnosticsMessage(events) : "Loading diagnostics...")}
          warning={Boolean(eventsError)}
        />
        <EventsPanel data={events} />
      </section>
      <p class="small text-body-secondary">
        Container status is checked every 30 seconds and events every 5 seconds.
        Updates arrive over Socket.IO without page reloads.
      </p>
      <p class="small text-body-secondary">
        Up to 100 events from the past hour are shown. History is bounded by the latest
        1,000 daemon log records and Docker log rotation, and may be incomplete.
      </p>
    </>
  );
}
