# Default landing page and hiding apps

Two supported settings change what people see, with no custom build:

- **Branding** sets the app a browser opens first. It applies to every workspace on a host.
- **Plugin configuration** hides apps. It applies to one workspace.

Hiding an app is not access control. Its model stays loaded and its data stays reachable,
so anything that must be restricted still needs role gating.

`MODEL_ENABLED` does not do this. It is set in `compose.yml`, but the `s0.7.426`
account and workspace bundles never read it, so changing it has no effect.

## Set the landing page

1. Copy [`examples/branding/branding.example.json`](../examples/branding/branding.example.json)
   to `branding.json` and replace the key with your public host.
2. Merge [`examples/branding/compose.branding.yml`](../examples/branding/compose.branding.yml)
   into your compose configuration.
3. Recreate the services:

   ```sh
   docker compose up -d --no-deps front account workspace
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

[`tests/ui/workspace-config.cjs`](../tests/ui/workspace-config.cjs) logs in with a fresh browser
context and reports the landing route and rail. It can also change the toggles. From `tests/ui`,
after `npm ci`:

```sh
export HULY_URL=https://huly.example.com
node workspace-config.cjs list
node workspace-config.cjs set --disable "Human resources,Office"
node workspace-config.cjs verify --landing document \
  --require document,tracker --forbid hr,love \
  --open tracker,document --widget calendar --screenshot landing.png
```

It reads the login from `tests/.smoke-state`, or from the file named by `HULY_STATE_FILE`, and
needs an Owner account to change toggles. Set `HULY_WORKSPACE` to use a workspace other than
the one in that file.

## Roll back

- Plugins: switch them back on in **Settings > Configure**, or run the tool with `set --enable`.
- Branding: remove the settings from step 2 and recreate the three services.
