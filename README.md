# Sablier setup

Sablier, Traefik routing, and a public read-only container status endpoint for
Coolify. The Compose file preserves Sablier's 10-minute idle sessions and its
`sablier-idle-website` network alias.

## Status endpoint

After deployment, https://sablier.hesamian.com/ returns a
[Preact dashboard written in JSX](./status/src/App.jsx).
It uses cacheable Bootstrap 5.3.8 CSS from jsDelivr: running groups have green
success badges; all other statuses have red danger badges. Styling requires CDN access.
`/status` returns the same page; `/api/status` returns JSON and also
checks access to Docker. `/api/events` returns sanitized diagnostics, and
`/api/session` renews the service's idle session without reading Docker.
The existing `/health`, `/events`, and `/session` routes remain compatibility
aliases; the Docker health check continues to use `/health`.
[Socket.IO](https://socket.io/) delivers JSON snapshots
without reloading the page. Preact reconciles keyed group, event, and diagnostic
rows so unchanged DOM nodes are preserved. Container status is checked every
30 seconds; diagnostics every 5 seconds. Preact, its hooks, Luxon, and the Socket.IO
browser client are bundled by [Vite](./status/vite.config.js) from pinned npm
dependencies and served locally. Express serves the production build from
`status/dist` with `express.static`; no browser import maps or manually exposed
vendor modules are needed. A separate `/api` router exposes only the fixed,
read-only status, events, and session endpoints. It uses the restricted internal
Docker proxy with the existing validation, response limits, and error handling;
it is not an unrestricted Docker reverse proxy. Unknown API paths return JSON
404 responses and never fall through to frontend files.
Backend data loading, validation, summaries, and concurrency helpers live in
[status/utils.js](./status/utils.js); [status/server.js](./status/server.js)
wires the HTTP routes and Socket.IO connections.
Shared time formatting and row-key helpers live in
[status/shared/format.js](./status/shared/format.js).
The dashboard requires JavaScript; without it, `/api/status` and `/api/events` remain
available as read-only JSON. Unlike the previous Pug page, the initial HTML
does not contain container data and remains available when Docker is unavailable.
An open tab keeps the status service awake; close it to allow idle sleep.

Container status and Sablier events have separate tabs with standard button
controls (Tab to focus, Enter or Space to select).
Both continue receiving live updates while either tab is selected. Status updates,
diagnostic checks, event timestamps, and lifecycle times show relative ages such
as "12 seconds ago", refreshed every second using the browser's current time.
Exact UTC timestamps are available only on hover over time entries. A running-container
progress bar counts individual containers across all
groups: 100% when all are running and 0% when none are running (including an empty
deployment). Paused, exited, and other non-running states still count toward the total.

Only containers labelled `sablier.enable=true` are included, grouped by
`sablier.group`. The response contains a UTC timestamp, group names, aggregate
status, and counts of actual Docker states.
Each group also includes a sorted, deduplicated `urls` list and clickable links
from its containers' Traefik HTTP router `Host(...)` labels, including stopped
containers. Only literal hostnames are supported; wildcard `HostRegexp` and
negated rules are not inferred. Routers with TLS enabled (`tls=true` or `tls.*`
options) use HTTPS; otherwise links use HTTP. Entry-point defaults, custom ports,
and path rules are not inferred: links point to the host root, not necessarily
the application's path. Containers with `traefik.enable=false` are excluded from
URL discovery. Groups without discoverable URLs show "Not available".
The dashboard collapses each group's links behind a keyboard-accessible
"Show domains" disclosure; expand it to view and open the URLs.
These hostnames are public in both the dashboard and JSON; other routing labels
are not exposed. Clicking a link may wake that application through Sablier;
displaying the links does not request the applications.
The page also shows the most recent Docker start and stop timestamps in each
group, with relative ages and exact UTC times available on hover. These are lifecycle times, not
last-request activity. A running container's last stop can refer to its previous
run; timestamps reset when a deployment replaces the container.

The internal proxy inspects only Sablier-enabled containers and attaches only
their start/stop timestamps to its existing list response. It does not expose
an inspect endpoint or forward container configuration. Timing reads share the
existing 3-second deadline, with at most 128 enabled containers per request.

- `running`: all containers in the group are running.
- `stopped`: all containers in the group are exited.
- `partially_running`: the group contains running and exited containers.
- `attention`: another state, such as paused, restarting, or created, is present.

Stopped does not prove that Sablier hibernated a container: manual stops and
failures can have the same Docker state. Reading this endpoint wakes the status
webserver if necessary and refreshes its own 10-minute session; it does not wake
other application groups. Undeployed applications are not included.

The status webserver belongs to `sablier.group=sablier-status` and sleeps when idle.
Do not reuse `sablier-status` for unrelated apps. A request to its HTTPS route passes
through the Compose-defined blocking wake middleware before reaching Express.
Consequently, the status service reports its own group as running while you
view it; use an SSH container check to observe its sleeping state.

This endpoint is intentionally public. It does not expose container identifiers,
commands, environments, credentials, or start/stop controls. Responses are not
cached. HTML, health responses, and all proxy responses send
`Cache-Control: no-store, no-cache, max-age=0, must-revalidate`, with legacy and
shared-cache directives. Dynamic-response ETags are disabled.
Each status read queries Docker again; no container data is cached.
The static Bootstrap stylesheet is separate and may be cached by the CDN and browser.
Configure any external CDN or reverse-proxy rules to honor these headers or bypass
caching for this hostname; rules that override origin headers are outside the app's control.
Docker errors return HTTP 503 and are logged instead of returning an
empty, apparently healthy list.

### Public Sablier diagnostics

The webserver reads diagnostics every 5 seconds per live connection and publishes
a sanitized Sablier event timeline and rule-based summaries as JSON.
`/api/events` is available as a read-only JSON endpoint. Diagnostics are independent:
an unavailable log source returns HTTP 503 from `/api/events` and sends an explicit
streamed error without hiding container status. Previously displayed events are
marked stale until a read succeeds. Status failures likewise preserve the previous
status and mark it stale without interrupting diagnostics.
Summaries describe recent history, not proof of an ongoing failure.

Socket.IO uses `/socket.io/` with at most eight simultaneous dashboard connections.
Its reads share the existing eight-request concurrency limit with JSON requests;
reads never overlap within a live connection. Disconnects release connection slots
and stop further reads. Socket.IO provides heartbeats, automatic reconnection,
and HTTP long-polling fallback when WebSocket upgrades are unavailable.
Rejected connections retry automatically, and every new connection requests fresh
snapshots. The socket exposes no container-control actions.

Socket messages do not pass through the HTTP wake middleware. An open dashboard
therefore calls the read-only `/api/session` endpoint once a minute to renew the status
service's Sablier session without another Docker read. Closing the page stops both
the socket and session renewal. Connection and renewal notices warn when updates
may stop or displayed data may be stale.

Reverse proxies must forward `/socket.io/`, including WebSocket upgrades and
long-polling GET/POST requests. Do not cache Socket.IO transport responses;
the server sends `Cache-Control: no-store, no-cache, max-age=0, must-revalidate`.
The former `/live` SSE endpoint has been removed.

The proxy reads **only the Sablier daemon's logs**, never application logs.
It resolves exactly one container labelled `sablier.diagnostics=true`, set on
the daemon in Compose. Do not apply this label to application containers or
run multiple labelled daemons on the same host. Compose sets `NO_COLOR=1`
for predictable parsing of Sablier 1.19.1's console output and uses Docker's
`json-file` logging driver with rotation at 5 MB and two files. Do not enable
a TTY on the daemon. Redeploy this stack to apply the label, environment,
logging configuration, and updated proxy image.

The public response includes only event timestamps, existing public group
names, fixed event types, severity, and fixed diagnostic explanations. Raw
messages, error strings, container names/IDs, URLs, credentials, and application
stdout/stderr are never forwarded. Group names are already public via the
status page; do not put secrets in group labels.

Recognized events include group discovery/registry refresh, unregistered stops,
start requests, readiness, idle expiration, and known start/stop/discovery
failures. An `unregistered` event means an enabled container had no
Sablier-managed session, not that it was missing from Docker. Expiration means
Sablier requested a stop, not that Docker confirmed it succeeded.

Each read examines at most the latest 1,000 daemon log records from the past
hour and returns at most 100 recognized events, newest first. Historical
events are mapped using currently deployed, enabled containers and their
current group labels; events for removed/replaced containers are omitted.
Registry/provider events are displayed under `Sablier` instead of a group.
Unknown messages/formats are omitted and counted, never published as raw text.
The response flags when a history limit is reached. Empty results mean no
recognized events in the available window, not a clean bill of health.
History comes from Docker logs, is not persisted by the webserver, can be
shortened by rotation, and resets when the daemon container is replaced.

Log discovery and reads share a 3-second deadline, 2 MB per upstream response,
and the proxy's eight-request concurrency limit. Event mapping is limited to
128 enabled containers and group labels of at most 256 characters.
Log-source, framing, size, and Docker errors are logged privately and return
a generic public HTTP 503. `/api/status` and its `/health` alias remain container-status checks and
does not depend on diagnostic log availability.

## Set up Sablier in Coolify

### 1. Prerequisites

- Coolify uses Traefik, with entry points named `http` and `https`, and a
  certificate resolver named `letsencrypt`.
- The external Docker network `coolify` already exists on the deployment server.
- `sablier.hesamian.com` resolves to the Coolify server. Cloudflare proxying is
  supported for this HTTP/HTTPS status website.
- Applications to be suspended run on the same Docker host and are reachable
  by Traefik on the `coolify` network.

### 2. Create the GitHub-backed application

In the Coolify project/environment, add an application from the public Git
repository and configure:

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/amir734jj/sablier-setup` |
| Branch | `main` |
| Build pack | Docker Compose |
| Base directory | `/` |
| Compose location | `/docker-compose.yml` |

Use the single [Compose file](./docker-compose.yml) in this repository. It builds
the Express status image from [status/Dockerfile](./status/Dockerfile) and the
restricted Docker proxy from [proxy/Dockerfile](./proxy/Dockerfile).
There is no Python service and no additional Compose file.

The Compose labels already route `sablier.hesamian.com` to the status service's
internal port 8080, enable HTTPS, and redirect HTTP to HTTPS. Do not add a public
route or publish a host port for Sablier's internal API or the Docker proxy.
Sablier itself and `docker-status-proxy` must remain running. Only the Node.js
`status` service opts into sleep, using the `sablier-status` group and a 10-minute session.
Its Docker health check runs directly against localhost and does not go through
the wake middleware.

The status and Docker proxy health checks are defined in their Dockerfiles and
inherited by Compose, including the proxy's `service_healthy` startup dependency.
They use Alpine's built-in BusyBox `wget`, without installing extra packages.
Sablier's check stays in Compose because it uses an external image.

Leave Coolify's Domains list empty for this stack: the Compose labels manage
the status hostname. In particular, do not assign `sablier.hesamian.com` to the
`sablier` service. Coolify generates a more-specific route to Sablier's internal
API, overriding the status route and returning 404 at `/`. If already assigned,
remove that domain without deleting its DNS record, then redeploy.

When replacing the existing Sablier service resource, stop the old stack before
deploying this one. Do not run two Sablier providers with the same network alias.
Keep the old resource stopped for rollback until the new deployment is verified.
The alias `sablier-idle-website` is deliberately retained so existing Traefik
middleware continues to find Sablier after migration.

Deploy, then confirm `sablier`, `status`, and `docker-status-proxy` are healthy.
Saving a Compose edit or labels without deploying does not update containers.

### 3. Enable the Traefik Sablier plugin

In the server's Coolify proxy configuration, retain the existing configuration
and add these Traefik command arguments if they are not already present:

```yaml
- --experimental.plugins.sablier.moduleName=github.com/sablierapp/sablier-traefik-plugin
- --experimental.plugins.sablier.version=v1.4.0
```

This setup also uses the file provider:

```yaml
- --providers.file.directory=/traefik/dynamic/
- --providers.file.watch=true
```

Apply the proxy configuration and restart the proxy when changing its static
arguments. Preserve its existing Docker provider, entry points, certificate
resolver, mounts, and other application routes.

### 4. Add middleware for each application group

The current host stores Sablier middleware in
`/data/coolify/proxy/dynamic/sablier-apps.yaml`, mounted inside Traefik's watched
dynamic configuration directory. Add a named middleware for each group:

```yaml
http:
  middlewares:
    sablier-example-app:
      plugin:
        sablier:
          sablierUrl: http://sablier-idle-website:10000
          group: example-app
          sessionDuration: 10m
          keepAliveInterval: 30s
          blocking:
            timeout: 1m
```

Merge this into the existing file; do not replace unrelated middleware.
`example-app` must match the target containers' `sablier.group` label.

For browser page navigation, a loading-page variant can use `dynamic` instead
of `blocking`:

```yaml
    sablier-example-app-page:
      plugin:
        sablier:
          sablierUrl: http://sablier-idle-website:10000
          group: example-app
          sessionDuration: 10m
          keepAliveInterval: 30s
          dynamic:
            displayName: example-app
            showDetails: false
            refreshFrequency: 5s
```

The loading page is HTML. Keep APIs and other non-page requests on the blocking
variant rather than returning a loading page where a caller expects API data.
The existing setup does this with a second HTTPS router whose rule adds the
following condition to the normal host/path rule:

```text
Method(`GET`) && HeaderRegexp(`Accept`, `(?i)text/html`)
```

This selects the loading-page middleware only for browser HTML GETs.
When adding that router, copy the normal router's entry point, TLS settings,
and backend service; retain its non-Sablier middleware, but replace the blocking
Sablier middleware with `sablier-example-app-page@file`. Keep the general router on
the blocking middleware. Ensure the browser-specific router has higher priority;
the existing setup uses its longer rule's default Traefik priority.

### 5. Opt applications into sleep/wake

In the target application's Coolify container labels, add:

```text
sablier.enable=true
sablier.group=example-app
traefik.docker.allownonrunning=true
```

Keep its existing Traefik routing labels. Append the file-provider middleware to
the appropriate existing router's middleware list, preserving other middleware:

```text
traefik.http.routers.<existing-router-name>.middlewares=<existing-middlewares>,sablier-example-app@file
```

If there were no existing middleware, use only `sablier-example-app@file` as the value.
Do not create a literal router named `<existing-router-name>`: use the actual
router name from that application's labels. Apply the wake middleware to the
router that serves application traffic.

Give unrelated apps different groups so they sleep independently. Put services
that must wake together in the same group, such as a frontend/API pair or
CAPTCHA and its cache. Each target service should have a working readiness
health check. Keep shared databases, Traefik, the Sablier daemon, and the internal
Docker proxy out of sleep groups.

Redeploy the target application or stack to apply the labels.

### 6. Verify sleep and wake

1. Open a target application and confirm its normal page/API works.
2. Stop sending requests to that app for longer than its 10-minute session.
   Background polling and HTTP monitoring through its router can extend the
   session.
3. Check https://sablier.hesamian.com/ for the group's `stopped` status.
   Reading this status service wakes only its own `sablier-status` group, not the target
   application's group.
4. Open the target app again. Depending on the middleware, the request waits or
   shows a loading page while the group starts.
5. Confirm the group returns to `running` and the real app responds.

An SSH-only status check is also available:

```sh
docker ps -a --filter label=sablier.enable=true --format 'table {{.Label "sablier.group"}}\t{{.Status}}'
```

If an app does not wake, check that its router still exists while stopped, its
middleware name includes `@file`, its group matches the container labels, and
Traefik can reach `sablier-idle-website:10000`. Inspect the Coolify deployment,
Sablier logs, and the target app's health check before changing timeouts.

### Manual deployment alternative

From a checkout on the Coolify Docker host:

```sh
docker compose up -d --build
```

## Status service isolation

The single Express webserver is [status/server.js](./status/server.js). Its
Dockerfile and npm manifests are also in [status](./status).
The status service uses Lodash to group containers, count states, and select
the latest lifecycle timestamps. Luxon handles ISO timestamp parsing, UTC
formatting, and relative ages.
Both Docker images use
`node:lts-alpine`. The webserver runs
unprivileged with a read-only filesystem, and has no Docker socket mount.
The internal [Node.js proxy](./proxy/server.mjs) uses Dockerode's streaming
transport to access the Docker socket. Its HTTP allowlist permits only
`GET /containers/json` (including query parameters) and the fixed `GET /events`
diagnostics route. The latter resolves the labelled daemon and reads its logs
internally through [proxy/events.mjs](./proxy/events.mjs); callers cannot select
a container, supply log query parameters, or access a raw Docker logs endpoint.
Other Docker API paths and mutation methods are denied.
It limits concurrent Docker reads to eight, responses to 2 MB, and upstream
requests to three seconds. Upstream connection errors are logged and return 503.
Lifecycle inspections run sequentially within that same request deadline.
It runs as root to access the Docker socket, on the private `status-backend`
network only. Its port is not published. A read-only Docker
socket mount alone does not restrict Docker API operations; the HTTP allowlist
supplies that restriction.

## Local development

Use Node.js 24 or newer. Install dependencies and start the backend:

```sh
npm ci --prefix status
npm start --prefix status
```

In another terminal, start Vite:

```sh
npm run dev --prefix status
```

Open the URL Vite prints (normally `http://localhost:5173`). Its development
proxy forwards `/api/` and `/socket.io/` (including WebSocket upgrades) to Express
on port 8080, along with the legacy JSON aliases. JSX changes update through
Vite's hot reload.

For production, `npm run build --prefix status` generates `status/dist`, then
`npm start --prefix status` serves that build and the API on port 8080.
The [Dockerfile](./status/Dockerfile) builds the frontend in a separate stage,
removes development dependencies, and copies the generated assets into the runtime
image. Its `npm ci` step requires the lockfile to match the dependency manifest.

## Tests

Both Node.js services use the public npm registry (`https://registry.npmjs.org/`)
for dependencies, configured in each service's `.npmrc` and lockfile.

With Node.js 24 or newer, install dependencies and run the status and proxy tests:

```sh
npm ci --prefix status
npm ci --prefix proxy
node --test status/timing.test.js
npm test --prefix proxy
docker compose config --quiet
```

Status server tests use temporary frontend build fixtures, so they do not require
running Vite or building the dashboard.
