# Default landing page and hiding apps

Two supported settings change what people see, with no custom build:

- **Branding** sets the app a browser opens first. It applies to every workspace on a host.
- **Plugin configuration** hides apps. It applies to one workspace.

Hiding an app is not access control. Its model stays loaded and its data stays reachable,
so anything that must be restricted still needs role gating.

`MODEL_ENABLED` does not do this. It is set in `compose.yml`, but the `s0.7.426`
account and workspace bundles never read it, so changing it has no effect.

## Before you change anything

Run these from the deployment directory, with your own project name and the compose files
that deployment really uses. Keep the same `-p` and `-f` values for every compose command.

1. Check the running stack uses those files:

   ```sh
   docker inspect <project>-front-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
   docker compose -p <project> -f compose.yml -f compose.override.yml config --quiet
   ```

   Don't print `docker compose config` without `--quiet`: its output includes secrets.

2. Take a backup and check it. `backup.sh` stops the stack briefly:

   ```sh
   ./backup.sh
   ```

   Check that the archives pass `gzip -t`, and copy any local compose overrides, which
   `backup.sh` does not include.

3. Record the starting health. See [Check service health](#check-service-health).

## Set the landing page

1. Copy [`examples/branding/branding.example.json`](../examples/branding/branding.example.json)
   to `branding.json` and replace the key with your public host.
2. Merge [`examples/branding/compose.branding.yml`](../examples/branding/compose.branding.yml)
   into your compose configuration.
3. Recreate the services:

   ```sh
   docker compose -p <project> -f compose.yml -f compose.override.yml up -d --no-deps --pull never front account workspace
   ```

| Field | Notes |
|---|---|
| Top-level key | Must match the browser's host exactly, including any port, e.g. `localhost:8087`. |
| `key` | Keep `huly`. Existing workspaces are tagged with this value. |
| `protocol` | Set `http` when not using TLS. The default is `https`, which produces wrong front URLs on a plain HTTP deployment. |
| `defaultApplication` | Application alias, e.g. `document`. |
| `defaultSpace` | A space that exists in every workspace on the host. `core:space:Workspace` does; a teamspace id does not, because those differ per workspace. |
| `defaultSpecial` | A navigator special of that application. For `document`, use `browser` (the Teamspaces list). |

Set all three `default*` fields together. If only `defaultApplication` is set, the other two
fall back to tracker values and the route becomes
`document/tracker:project:DefaultProject/issues`.

`BRANDING_URL` must be an absolute URL. The front serves the mounted file from its static
directory with `Cache-Control: no-store`.

### What the landing page affects

The default only applies when a browser has no stored route for that workspace. People who
have already visited return to their last route, so test with a fresh browser context.
Every workspace on the host gets the same default.

## Hide apps

An Owner opens **Settings > Configure** in the workspace and switches plugins off. The setting
is stored per workspace and takes effect after the client reloads.

Some apps have no toggle, including Inbox, Planner/Team (`time`), Drive, Settings and Support.
They need role gating if they must not be shown.

## Check the result

[`tests/ui/workspace-config.cjs`](../tests/ui/workspace-config.cjs) drives a real browser, with a
new browser context for every session. It has two levels of check, and only the second is
acceptance.

Setup, from `tests/ui`:

```sh
npm ci
npx playwright install chromium
export HULY_URL=https://huly.example.com
export HULY_STATE_FILE=/path/to/state     # default: tests/.smoke-state
export HULY_WORKSPACE=my-workspace        # default: SMOKE_WS_URL in the state file
```

Use Playwright's bundled browser rather than `CHROME_PATH`. A system Chrome started by Playwright
was seen exiting by itself after 30 seconds on macOS, even on a blank page.

The state file holds `SMOKE_EMAIL`, `SMOKE_PASSWORD` and optionally `SMOKE_WS_URL`, as plain text
or in `printf %q` form. It must be a regular file with mode 600, owned by you, with a single
hard link, and not under a directory others can write to. The tool refuses anything else, and
refuses a screenshot path that leads to that file.

### Change toggles

```sh
node workspace-config.cjs list
node workspace-config.cjs set --disable "Human resources,Office"
```

`set` needs an Owner and stops before changing anything if the selected workspace, the role or
any plugin name is wrong. It reads each plugin back after a reload and again from a new login.

### Generic checks

`verify` checks only what you name, so **passing it isn't acceptance**. `--landing-path`,
`--require` and `--forbid` are required and can't be empty:

```sh
node workspace-config.cjs verify \
  --landing-path document/core:space:Workspace/browser \
  --require document,tracker --forbid hr,love \
  --open tracker --widget calendar --screenshot landing.png
```

### Full acceptance

`phase0` checks the whole contract in
[`tests/ui/phase0-contract.json`](../tests/ui/phase0-contract.json). Run it once per role:

```sh
node workspace-config.cjs phase0 --expect-role OWNER --screenshot owner.png \
  --require-document-page --document-screenshot document.png
node workspace-config.cjs phase0 --expect-role USER --screenshot user.png
```

Use `--require-document-page` when that account can see a document. Without it, the log only
reports how many document items are visible, so it doesn't demonstrate a document page.

| Check | Requirement |
|---|---|
| Workspace and role | The client selected the target workspace, with the expected role |
| Landing route | Exactly `document/core:space:Workspace/browser` |
| Landing page | Navigator titled Documents listing Teamspaces; a Teamspaces page with at least one table row |
| Rail must include | `document`, `card`, `tracker`, `chunter`, `contact`, `calendar` |
| Rail may also include | `workbench`, `notification`, `time`, `drive`, `setting`, `support`. Anything else fails |
| Rail must not include | `hr`, `love`, `process`, `testManagement`, `products`, `recruit`, `lead`, `inventory`, `training`, `survey`, `documents`, `github`, `telegram`, `gmail`, `questions` |
| Routed apps | Cards, Tracker, Chat, Contacts and Documents each open at their own route and show their own navigator |
| Calendar | Opens in the sidebar with its time grid, without changing the route |
| Plugin toggles | Owner only: every toggle matches the contract, and an unlisted plugin fails. A `USER` run says this was not checked |
| Runtime | No uncaught page errors, fatal console errors or HTTP 5xx responses |

The tool's regression tests use a synthetic local server and don't touch a deployment:

```sh
npm run test:config
```

### Check service health

```sh
docker compose -p <project> -f compose.yml -f compose.override.yml ps --format '{{.Service}} {{.State}} health={{.Health}}'
docker compose -p <project> -f compose.yml -f compose.override.yml ps -q | xargs docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} restarts={{.RestartCount}}'
COMPOSE_PROJECT_NAME=<project> bash tests/smoke.sh --verify
```

Every service should be `running`, none `unhealthy`, with no new restarts, and the smoke test
should exit 0. Many services have no Docker healthcheck, so `health=` is empty for them and
only the running state and smoke test cover them.

## Roll back

- Plugins: switch them back on in **Settings > Configure**, or run the tool with `set --enable`.
- Branding: remove the settings from step 2 and recreate the three services.
