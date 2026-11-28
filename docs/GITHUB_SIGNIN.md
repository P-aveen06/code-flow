# Sign in with GitHub

Visitors can sign in with GitHub, pick one of their repositories (including a
private one), choose a branch, and analyze its latest commits. This is the
`github_signin` variant of the `github_signin` experiment. The control,
`url_import`, keeps the public URL form.

## What code-flow can see

- code-flow is a **GitHub App** with two read-only permissions: Contents and
  Metadata. It can't write to anything. It can only read the repositories each
  visitor chooses on GitHub's install page.
- To clone, the server asks GitHub for a one-hour installation token scoped to
  that one repository with `contents: read`. Git gets the token through an
  environment header (`GIT_CONFIG_*`). The token never appears in the clone
  URL, the `.git/config` file, command arguments or error messages.
- A private import is visible only to the person who imported it. Everyone
  else, signed in or not, gets the same 404 as for a repository that doesn't
  exist. This check covers every `/api/repos/{repo}/…` route and the repo
  list, including imports that are still running. Imports of public
  repositories stay shared, like URL imports.
- The browser holds a single cookie, `cf_session`. It contains only a random
  session ID and is `HttpOnly`, `SameSite=Lax`, `Path=/api` and, on HTTPS,
  `Secure`. GitHub tokens stay on the server, encrypted with a key made when
  the process starts. A restart signs everyone out, the same way it clears
  imports on the free Render host.
- A POST that carries the session cookie must also send
  `X-Requested-With: code-flow`, and its `Origin` must be the site's own
  origin. Otherwise the server refuses it, so other sites can't forge imports
  or sign-outs.
- Each person can have up to `CODEFLOW_MAX_PRIVATE_IMPORTS` private imports
  (default 3).

## How the journey works

1. **Sign in with GitHub** sends the visitor to GitHub to authorize the app,
   with a one-time `state` value in a sealed, ten-minute cookie.
2. GitHub returns them to `/api/auth/github/callback`. The server checks the
   state, exchanges the code, creates the session and redirects to the repos
   page, `/github?signed_in=1`.
3. The repos page lists the repositories the app is installed on. If it lists
   none, **Choose repositories on GitHub** opens the install page. GitHub
   returns the visitor to the Setup URL, `/github?github=installed`.
4. Picking a repository opens its details page, `/github/<repo id>`. The visitor
   chooses a branch (the default branch is selected first) and sees its latest
   commits along the branch's first-parent history, the same history the
   analysis follows. The number of commits comes from the
   `branch_commit_count` flag in Flagsmith (default 20), capped by
   `CODEFLOW_MAX_IMPORT_COMMITS`.
5. **Analyze N commits** imports that branch. The server checks that the
   repository really is one of theirs before it clones, then opens the flow.

Each branch other than the default is its own import, with an id such as
`owner__name@feature~cart` (or `p_<uid>__owner__name@feature~cart` when
private) and the name `owner/name@feature/cart`. The default branch keeps the
plain id, so it matches a pasted URL of the same repository.

The browser has to see the API as the same site for the cookie to work, so
the web app calls `/api` on its own origin. Locally, Vite proxies `/api` to the
API. On Cloudflare Pages, a Pages Function
([web/functions/api/[[path]].ts](../web/functions/api/[[path]].ts)) forwards
`/api/*` to Render.

## 1. Create the GitHub Apps

Create two apps under **GitHub → Settings → Developer settings → GitHub Apps →
New GitHub App**, one for local development and one for the hosted site. Each
app has a single callback URL, so one app can't serve both.

| Setting | Local app | Hosted app |
| --- | --- | --- |
| GitHub App name | `code-flow-local` (any free name) | `code-flow` (any free name) |
| Homepage URL | `http://localhost:5173` | `https://code-flow.pages.dev` |
| Callback URL | `http://localhost:5173/api/auth/github/callback` | `https://code-flow.pages.dev/api/auth/github/callback` |
| Expire user authorization tokens | On | On |
| Request user authorization (OAuth) during installation | **Off** | **Off** |
| Enable Device Flow | Off | Off |
| Setup URL | `http://localhost:5173/github?github=installed` | `https://code-flow.pages.dev/github?github=installed` |
| Redirect on update | On | On |
| Webhook → Active | Off | Off |
| Repository permissions | Contents: **Read-only**. Metadata: Read-only (required). | Same |
| Account and organization permissions | None | None |
| Where can this GitHub App be installed? | Only on this account | Any account |

After you create each app:

1. Copy the **App ID** and **Client ID** from the app's General page.
2. The slug is the last part of the app's public link,
   `https://github.com/apps/<slug>`.
3. Under **Client secrets**, choose **Generate a new client secret** and copy it.
4. Under **Private keys**, choose **Generate a private key**. GitHub downloads
   a `.pem` file. Keep it out of the repository.

Use the Pages origin that Cloudflare gave the project if it differs from
`code-flow.pages.dev`.

## 2. Environment variables

| Variable | Where | Value | Secret |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | API | The app's App ID | No |
| `GITHUB_APP_SLUG` | API | The app's slug | No |
| `GITHUB_CLIENT_ID` | API | The app's Client ID | No |
| `GITHUB_CLIENT_SECRET` | API | The client secret | **Yes** |
| `GITHUB_APP_PRIVATE_KEY_PATH` | API, local | Path to the `.pem` file | No (the file is) |
| `GITHUB_APP_PRIVATE_KEY` | API, hosted | The PEM text, or its base64 on one line | **Yes** |
| `CODEFLOW_MAX_PRIVATE_IMPORTS` | API, optional | Private imports per person (default 3; 0 turns them off) | No |
| `CODEFLOW_WEB_ORIGIN` | API | The site's origin. The callback URL is built from it. | No |
| `VITE_API_URL` | Web build | `/`, so the web app calls `/api` on its own origin | No |
| `VITE_GITHUB_SIGNIN_FALLBACK` | Web build, optional | Arm to show when Flagsmith is unavailable: `url_import` (default) or `github_signin` | No |
| `CODEFLOW_API_PROXY` | Vite dev server, optional | Where Vite sends `/api` (default `http://localhost:8787`) | No |
| `RENDER_API_ORIGIN` | Pages Function | The Render origin, such as `https://code-flow-api-y9k1.onrender.com` | No |

Set all four `GITHUB_*` values and one of the private key settings, or none of
them. With none, the API turns the sign-in routes off and the web app shows
the URL form. With only some, the API refuses to start and names the missing
ones.

## 3. Run it locally

Add the local app to the repo-root `.env`:

```sh
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=code-flow-local
GITHUB_CLIENT_ID=Iv23li...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/keys/code-flow-local.private-key.pem
CODEFLOW_WEB_ORIGIN=http://localhost:5173
VITE_API_URL=/
```

Run `make dev`, then open `http://localhost:5173`. Open the site at
`localhost`, not `127.0.0.1`, because the cookie and the callback URL use
`localhost`.

To see the sign-in arm, use one of these:

- With Flagsmith running and `variant_preview` on, add `?signin=github_signin`
  to the landing page URL.
- Without Flagsmith, set `VITE_GITHUB_SIGNIN_FALLBACK=github_signin`.

### Quick start with a personal token

For a first try on your own machine, without an app, set
`CODEFLOW_GITHUB_TOKEN` to a fine-grained personal access token with
read-only Contents access to the repositories you want. URL imports then
clone with it, so you can paste the URL of a private repository. Those imports
are treated as public on that server. The API refuses to start with this token
unless `CODEFLOW_WEB_ORIGIN` is a localhost origin.

## 4. Deploy

1. On Render, add the hosted app's `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY`.
   `CODEFLOW_WEB_ORIGIN` stays the Pages origin. Redeploy the API.
2. Give the Pages project the Render origin for the proxy:

   ```sh
   cd web
   printf '%s' https://code-flow-api-y9k1.onrender.com | \
     npx wrangler pages secret put RENDER_API_ORIGIN --project-name code-flow
   ```

3. Build with `VITE_API_URL=/` and deploy **from `web/`**, so Wrangler finds
   the `functions/` folder next to `dist/`:

   ```sh
   cd web && npm ci &&
     VITE_API_URL=/ VITE_HOSTED_DEMO=1 VITE_FLAGSMITH_API_URL= VITE_CODEFLOW_FLAGSMITH_ENV_KEY= \
     npm run build &&
     npx wrangler pages deploy dist --project-name code-flow --branch main
   ```

4. Check that `https://code-flow.pages.dev/api/health` answers and that
   `https://code-flow.pages.dev/api/me` returns `"configured": true`.

Until Flagsmith is reachable from the internet, the hosted site shows the
`VITE_GITHUB_SIGNIN_FALLBACK` arm to everyone.

## 5. The commit count flag

`branch_commit_count` is a standard flag whose value is a whole number.
`make flagsmith-setup` and `make flagsmith-setup-sim` create it on, with the
value 20. Change the value in Flagsmith to list and analyze more or fewer
commits; the repo details page picks up the new value within about ten seconds.
When the flag is off, missing, outside 1 to 200, or Flagsmith is unreachable,
the page uses 20. The server also caps it at `CODEFLOW_MAX_IMPORT_COMMITS`
(50 on Render).

## 6. The experiment

The flag is `github_signin`: control `url_import`, variant `github_signin`,
split 50/50. The web app records exposure with `getExperimentFlag` and sends
these events with the visitor's `code-flow:reviewer` identity, which stays the
same through sign-in:

| Event | When | Value |
| --- | --- | --- |
| `import_started` | URL form submitted, or **Sign in with GitHub** clicked | |
| `signin_started` | **Sign in with GitHub** clicked | |
| `signin_completed` | Back from GitHub on the repos page, signed in | |
| `app_installed` | Back from the install page with repositories to pick | |
| `repo_selected` | **Analyze** pressed for a repository and branch | |
| `import_completed` | The analysis finished | ms since landing |
| `first_flow_viewed` | The first flow diagram drew | ms since landing |
| `import_abandoned` | Left after `import_started` without finishing (not while away at GitHub) | |

Each event counts once per visit. The Flagsmith experiment measures:

- **Import completed** (goal, expected to rise)
- **Time to first flow (ms)** (guardrail: lower is better, but sign-in is
  expected to add time)
- **Import abandoned** (Flagsmith is told lower is better). The simulator's
  own assumptions don't make it fall: sign-in brings more visitors into the
  journey, and each GitHub step loses a few of them.

Simulate it before real traffic. The assumptions are in
[simulator/experiments/github_signin.yaml](../simulator/experiments/github_signin.yaml):
how many visitors in each role came for a private repository, and how many
get through each step.

```sh
make flagsmith-setup-sim          # creates the github_signin flag in Development
make simulate-signin-dry-run      # offline rehearsal with the default panel
python3 scripts/flagsmith_experiment.py --experiment github_signin create
make simulate-signin              # sends the simulated journeys to Development
python3 scripts/flagsmith_experiment.py --experiment github_signin refresh --wait 120
python3 scripts/flagsmith_experiment.py --experiment github_signin status
```

Add `--model null` to the simulator for a run with no real difference between
the arms, to check that Flagsmith doesn't report one.

The first run, with 1,300 simulated visitors in Development, is written up in
[experiment-results.md](experiment-results.md#github_signin-experiment-results-simulated-visitors).
