# Deploy the public demo

Cloudflare Pages serves the Vite build. One free Render Docker web service serves
the FastAPI API and runs Git imports. Render supplies 512 MB of RAM and an
ephemeral filesystem. After 15 minutes without inbound traffic, the service can
spin down. The next request can take 30–60 seconds. The hosted landing page
shows **Waking up the demo server…** after three seconds and retries the repo list
up to four times within a 75-second window. [Render free service behavior](https://render.com/docs/free)

The Docker build creates the eight-commit `shop-demo` and analyzes the most
recent 50 first-parent commits touching `api/` up to and including
`0c37fca299b94d54760fe7fa76818d19f05bf639` in Flagsmith/flagsmith. It keeps a
shallow Git clone and the base for the oldest displayed diff. The container seeds
its writable `/app/data` directory on first start, with both source clones
under `/app/data/repos`. **Check for new commits** fetches the default branch
for the baked Flagsmith example. Imports and subsequent refreshes are shared
by demo visitors and reset on Render restart, spin-down, or redeploy.

## 1. Reserve the Pages origin

Publish the reviewed code to the public repo's `main` branch before creating
the Render service. To create the Pages project for Direct Upload, use Wrangler
from the repo root. Use the resulting Pages hostname for Render CORS if
Cloudflare assigns a suffix. If Wrangler is available through npm, use
`npx wrangler` for the commands below. [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

```sh
wrangler login
wrangler pages project create code-flow --production-branch main
export CODEFLOW_WEB_ORIGIN=https://code-flow.pages.dev
```

## 2. Create the Render API service

Use one of the following methods. The service deploys from `main` when created,
with subsequent deploys triggered manually.

### Render dashboard

Choose **New → Blueprint**, connect `P-aveen06/code-flow` on `main`, and use
the root [render.yaml](../render.yaml). Enter the Pages origin for
`CODEFLOW_WEB_ORIGIN`. Leave the Flagsmith server key empty. If you create a
**Web Service** directly, use these same settings. [Render Blueprints](https://render.com/docs/blueprint-spec) · [Docker on Render](https://render.com/docs/docker)

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/P-aveen06/code-flow` |
| Name, branch, runtime | `code-flow-api`, `main`, Docker |
| Plan, disk | Free, no persistent disk |
| Root directory and build context | Repository root (`.`) |
| Dockerfile path | `./server/Dockerfile` |
| Docker command | Image default |
| Health check path | `/api/health` |
| Auto-deploy | Off |

### Render API

Set `RENDER_OWNER_ID` to the workspace ID from Render settings and load
`RENDER_API_KEY` from your credential store or enter it through the hidden
prompt. This creates the same service directly and prints its ID and URL.
Save the service ID for later deploys. [Create service API](https://api-docs.render.com/reference/create-service)

```sh
export RENDER_OWNER_ID='<your Render workspace ID>'
printf 'Render API key > ' >&2
IFS= read -rs RENDER_API_KEY
printf '\n' >&2

jq -n --arg owner "$RENDER_OWNER_ID" --arg origin "$CODEFLOW_WEB_ORIGIN" '{
  type: "web_service",
  name: "code-flow-api",
  ownerId: $owner,
  repo: "https://github.com/P-aveen06/code-flow",
  branch: "main",
  autoDeployTrigger: "off",
  serviceDetails: {
    runtime: "docker",
    plan: "free",
    healthCheckPath: "/api/health",
    envSpecificDetails: {dockerfilePath: "./server/Dockerfile", dockerContext: "."}
  },
  envVars: [
    {key: "CODEFLOW_WEB_ORIGIN", value: $origin},
    {key: "CODEFLOW_AUTO_SYNC_INTERVAL_SECONDS", value: "3600"},
    {key: "CODEFLOW_MAX_IMPORT_COMMITS", value: "50"},
    {key: "CODEFLOW_SNAPSHOT_CACHE_SIZE", value: "8"}
  ]
}' | curl --fail-with-body -sS https://api.render.com/v1/services \
  -H "Authorization: Bearer ${RENDER_API_KEY}" -H 'Content-Type: application/json' \
  --data-binary @- | jq -e '.service | select(.id and .serviceDetails.url) | {id, url: .serviceDetails.url}'
unset RENDER_API_KEY
```

Wait for the service to go live, then use the **actual** Render origin for
the web build.

## 3. Build and upload the Pages site

Use the Node version from [web/.nvmrc](../web/.nvmrc). If you use nvm, run
`nvm use` inside `web/` first. The build root is
`web/`, the build command is `npm ci && npm run build`, and the output
directory is `dist`. The `/repo/* / 200` rewrite serves the index for viewer
links and preserves their query strings. Pages also has a built-in SPA fallback.
Wrangler rejects the catch-all `/* /index.html 200` as a redirect loop.
[Pages redirect rules](https://developers.cloudflare.com/pages/configuration/redirects/) · [Pages SPA routing](https://developers.cloudflare.com/pages/configuration/serving-pages/)

Run this from the repo root. Set the two web Flagsmith variables to empty for a
local Direct Upload build so Vite won't read your Mac's Flagsmith settings
from the repo-root environment files.

```sh
export VITE_API_URL=https://code-flow-api.onrender.com
curl -fsS "$VITE_API_URL/api/health"
curl -fsS -H "Origin: $CODEFLOW_WEB_ORIGIN" "$VITE_API_URL/api/repos"
(
  cd web && npm ci &&
  VITE_HOSTED_DEMO=1 VITE_FLAGSMITH_API_URL= VITE_CODEFLOW_FLAGSMITH_ENV_KEY= npm run build
)
wrangler pages deploy web/dist --project-name code-flow --branch main
```

Open the Pages URL from Wrangler, then check that the landing page lists both
repos and that this direct path opens the viewer at the pinned commit.

```text
/repo/Flagsmith__flagsmith?commit=0c37fca299b94d54760fe7fa76818d19f05bf639
```

## Environment variables

The `VITE_*` values are public and compiled into the web bundle. Changing them
requires a rebuild and upload. The Render and Wrangler credentials are for
deploying and belong in your local credential store.

| Variable | Set where | Hosted value or behavior | Secret |
| --- | --- | --- | --- |
| `CODEFLOW_WEB_ORIGIN` | Render | Required for CORS. Set the exact Pages origin, without a path or trailing slash. | No |
| `CODEFLOW_AUTO_SYNC_INTERVAL_SECONDS` | Render | `3600`. Local default `300`, minimum `10`. Automatic refresh requires an enabled repo or global switch. | No |
| `CODEFLOW_MAX_IMPORT_COMMITS` | Render | `50` for imports and rolling refresh history. Local default and maximum `200`. | No |
| `CODEFLOW_SNAPSHOT_CACHE_SIZE` | Render | `8` recently used decoded graph snapshots across repos. Local default `16`. | No |
| `PORT` | Render | Render provides the port. The image defaults to `8787` on its own. | No |
| `CODEFLOW_DATA_DIR` | Image | `/app/data`, the path the baked indexes use. Use the image default on Render. | No |
| `CODEFLOW_LONG_FLOW_MIN_DEPTH` | Render, optional | Default `4` call layers. | No |
| `FLAGSMITH_API_URL` | Render | Unset initially. Set the tunnel SDK base URL ending in `/api/v1/` when connected. | No |
| `CODEFLOW_FLAGSMITH_SERVER_KEY` | Render | Unset initially. Use the Production server key when connected. | **Yes** |
| `CODEFLOW_FLAGSMITH_SCOPES_PATH` | Render, optional | Unset initially. Defaults to `flagsmith_scopes.json` under the data directory. | No |
| `VITE_API_URL` | Pages build | Render origin with no `/api` suffix. | No |
| `VITE_HOSTED_DEMO` | Pages build | `1` for the restart notice and cold-start retries. Off by default. | No |
| `VITE_FLAGSMITH_API_URL` | Pages build | Empty initially. Use the same public SDK base URL when connected. | No |
| `VITE_CODEFLOW_FLAGSMITH_ENV_KEY` | Pages build | Empty initially. Use the Production client-side environment key when connected. | No |
| `RENDER_OWNER_ID` | Deploy shell, API method | Render workspace ID. | No |
| `RENDER_API_KEY` | Deploy shell, API method | Render API credential. | **Yes** |
| `FLAGSMITH_ADMIN_API_KEY` | Local setup | Admin key for the setup and experiment scripts. | **Yes** |
| `CODEFLOW_FLAGSMITH_ENV_KEY` | Local simulator | Client-side key for explicit Production runs. | No |
| `CODEFLOW_SIM_ENVIRONMENT` | Local simulator | Defaults to Development. | No |
| `CODEFLOW_SIM_FLAGSMITH_ENV_KEY` | Local simulator | Client-side key for the simulation environment. | No |
| `CODEFLOW_LLM_PROVIDER` | Local, optional | Reserved for optional summaries. The demo uses rule-based summaries. | No |

See [.env.example](../.env.example) for local defaults.

## Local Docker verification and memory

Build from the repo root and publish the API on an available port.

```sh
docker build -f server/Dockerfile -t code-flow:deploy-local .
docker run --rm --memory=512m --memory-swap=512m -p 127.0.0.1::8787 \
  -e CODEFLOW_WEB_ORIGIN=https://code-flow.pages.dev \
  -e CODEFLOW_AUTO_SYNC_INTERVAL_SECONDS=3600 \
  -e CODEFLOW_MAX_IMPORT_COMMITS=50 -e CODEFLOW_SNAPSHOT_CACHE_SIZE=8 \
  code-flow:deploy-local
```

Measured with Docker Desktop on Apple Silicon (Linux arm64 container).
Docker reported **133 MB compressed content** and **580 MB of local image disk
usage**. The Uvicorn process was PID 1. Peak RSS is Linux `VmHWM` read after
each phase of the same run, rounded to the nearest MiB.

| Workload | Original 64-entry FIFO | Hosted 8-entry LRU |
| --- | ---: | ---: |
| Idle after startup and health response | 68 MiB | 68 MiB |
| Open the Flagsmith timeline, all 50 diffs at both 1 and 2 hops, and five function diffs | 275 MiB | 111 MiB |
| Then import 50 commits and open one diff from the import | 301 MiB | 128 MiB |

The import used the baked Flagsmith clone via a Git `file://` URL rewrite.
The hosted run used a 512 MiB Docker limit. Its cgroup peak was 392 MiB,
including filesystem cache and child processes, with zero OOM kills. These
figures measure the demo workload. Import memory also depends on the size of
the Python source in each commit.

The container passed `/api/health` and the repo-list, diff, code, and function
diff checks. A separate refresh test served one new commit from a local copy
of the pinned clone while keeping the timeline at 50 commits. Local Wrangler
and Chromium loaded the hosted landing page and the pinned viewer deep link.

## Later, connect Flagsmith

The self-hosted Flagsmith on the Mac stays private. The public demo uses
`overlay_summary`, vertical long flows, horizontal short flows, and manual
commit refresh. Live flag state and guarded-path highlighting, Flagsmith
experiment assignments and events, and preview switches are off. The web
app skips SDK initialization with either setting missing. The API can serve
code and diffs without the scope file and reports `connected: false` on its
flags endpoint without making a Flagsmith request. [Experiment rollout](experiment-results.md)

To connect it later, route an HTTPS tunnel to a local reverse proxy that
allows only the SDK endpoints used here. Allow `GET /api/v1/flags/`,
`GET /api/v1/identities/` (and `POST` if sending identity traits), and
`POST /api/v1/events/`, plus the browser's `OPTIONS` preflights. Configure
Flagsmith CORS for the exact Pages origin and SDK request headers. Keep the
dashboard and admin API private. Set the Production keys and both API URLs
in the table, then redeploy the API and rebuild Pages. To enable repo-scoped
live state, upload the generated scope JSON as a Render secret file named
`flagsmith_scopes.json` and set `CODEFLOW_FLAGSMITH_SCOPES_PATH` to
`/etc/secrets/flagsmith_scopes.json`. Preview switches still depend on the
selected environment's `variant_preview` flag, which is off in Production.
[Flagsmith SDK API](https://docs.flagsmith.com/integrating-with-flagsmith/flagsmith-api-overview) · [Self-hosted events](https://docs.flagsmith.com/experimentation/self-hosting) · [Render Docker secret files](https://render.com/docs/docker-secrets)
