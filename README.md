# Sablier setup

Sablier, Traefik routing, and a public read-only container status endpoint for
Coolify. The Compose file preserves Sablier's 10-minute idle sessions and its
`sablier-idle-website` network alias.

## Status endpoint

After deployment, https://sablier.hesamian.com/ returns a server-rendered HTML
status page rendered with [Pug](./status/views/status.pug).
It uses Bootstrap 5.3.8 CSS from jsDelivr: running groups have green success
badges; all other statuses have red danger badges. Styling requires CDN access.
`/status` returns the same page; `/health` returns JSON and also
checks access to Docker. The page refreshes only when requested, not automatically,
so an open browser tab does not keep the service awake.

Only containers labelled `sablier.enable=true` are included, grouped by
`sablier.group`. The response contains a UTC timestamp, group names, aggregate
status, and counts of actual Docker states.

- `running`: all containers in the group are running.
- `stopped`: all containers in the group are exited.
- `partially_running`: the group contains running and exited containers.
- `attention`: another state, such as paused, restarting, or created, is present.

Stopped does not prove that Sablier hibernated a container: manual stops and
failures can have the same Docker state. Reading this endpoint wakes the status
webserver if necessary and refreshes its own 10-minute session; it does not wake
other application groups. Undeployed applications are not included.

The status webserver belongs to `sablier.group=my-app` and sleeps when idle.
Do not reuse `my-app` for unrelated apps. A request to its HTTPS route passes
through the Compose-defined blocking wake middleware before reaching Express.
Consequently, the status service reports its own group as running while you
view it; use an SSH container check to observe its sleeping state.

This endpoint is intentionally public. It does not expose container identifiers,
commands, environments, credentials, or start/stop controls. Responses are not
cached. Docker errors return HTTP 503 and are logged instead of returning an
empty, apparently healthy list.

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
`status` service opts into sleep, using the `my-app` group and a 10-minute session.
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
   Reading this status service wakes only its own `my-app` group, not the target
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
Both Docker images use
`node:lts-alpine`. The webserver runs
unprivileged with a read-only filesystem, and has no Docker socket mount.
The internal [Node.js proxy](./proxy/server.mjs) uses Dockerode's streaming
transport to access the Docker socket. It allows only `GET /containers/json`, including
query parameters; other Docker API paths and mutation methods are denied.
It limits concurrent Docker reads to eight, responses to 2 MB, and upstream
requests to three seconds. Upstream connection errors are logged and return 503.
It runs as root to access the Docker socket, on the private `status-backend`
network only. Its port is not published. A read-only Docker
socket mount alone does not restrict Docker API operations; the HTTP allowlist
supplies that restriction.

## Tests

Both Node.js services use the public npm registry (`https://registry.npmjs.org/`)
for dependencies, configured in each service's `.npmrc` and lockfile.

With Node.js 24 or newer, install dependencies and run the proxy tests:

```sh
npm ci --prefix status
npm ci --prefix proxy
npm test --prefix proxy
docker compose config --quiet
```
