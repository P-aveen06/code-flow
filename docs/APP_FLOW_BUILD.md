# app_flow build: three flows, twelve flags

How the three designed flows (A "Guided", B "Workbench", C "Canvas") are built into the web
app so every piece can be switched on its own by Flagsmith. This is the contract every
change in the build follows. If code must differ from it, update this file in the same change.

## Sources

| What | Where |
|---|---|
| Flag list with each flow's values (source of truth for tokens) | `design-briefs/flags-app-flow.md` (project files) |
| Briefs per flow | `design-briefs/flow-A-guided.md`, `flow-B-workbench.md`, `flow-C-canvas.md` |
| Finished designs (one `.dc.html` per screen and state) | exported to `$DESIGNS/{A,B,C}/project/*.dc.html` (path given in each task) |
| Real content (repos, commits, copy) | `design-briefs/reference/sample-content.md` |
| Metrics and events | Claude Doc "app_flow experiment: metrics and rounds" (summarised under Journey events below) |

Each flow's `Main.dc.html` is its style sheet artboard (type scale, buttons, colours, components).
Each design file is plain HTML with inline styles and CSS variables on its root `div`. Read
them for layout, sizes, spacing, copy and states. Do not copy their inline-style approach.

## What stays the same

- Today's UI is the fallback. With `app_flow` off, or Flagsmith unreachable, or a switch off,
  that piece renders exactly as it does on `develop` today. Today's tests keep passing.
- Desktop only, 1440 × 900 is the reference viewport. Pages must not break at 1280.
- Base body size 14 px, light theme, the diagram colour meanings, all copy, and the review
  question ("Did this diagram help you understand the change?", Yes / No, keys U / C) are the
  same in every flow.
- The diagram itself is always the existing `FlowCanvas` (React Flow + ELK), shown through the
  existing `Overlay` / `SideBySide` / `OverlaySummary` choice from the `flow_view` flag. Flows
  restyle and re-place it; they never redraw it as static SVG.
- Existing flags keep working: `flow_view`, `flow_direction`, `flagsmith_mode`,
  `variant_preview`, `github_signin`, `branch_commit_count`.

## Flags

12 flags in the single `code-flow` Flagsmith project, tag `app-flow`, Development first.

| Flag | Type | Control | Variants |
|---|---|---|---|
| `app_flow` | multivariate | `a` | `b` 33%, `c` 33% (so a/b/c = 34/33/33) |
| `ui_font_family`, `ui_font_weight`, `ui_line_spacing`, `ui_buttons`, `ui_colours`, `ui_landing_layout`, `ui_signin_layout`, `ui_repos_layout`, `ui_repo_details_layout`, `ui_flow_view_layout`, `ui_branch_switch` | multivariate | `flow` | `a`, `b`, `c` at 0% |

### Resolving a piece

`web/src/appFlow/flags.ts`, pure and unit tested:

```
flow  = app_flow enabled and value in {a,b,c} ? value : null
piece(switch):
  flow is null                      -> "today"   (app_flow off shows today's UI everywhere)
  ui_<switch> flag missing           -> flow      (flags not created yet still follow app_flow)
  ui_<switch> flag disabled          -> "today"   (ablation turns a piece off)
  value "a" | "b" | "c"              -> that flow (pinned, or split in a stacking round)
  anything else, including "flow"    -> flow
```

- **Exposure**: on the landing page only, call `flagsmith.getExperimentFlag("app_flow")` once per
  visitor; `exposed = enabled && experiment?.inExperiment === true`. On the landing page also call
  `getExperimentFlag("ui_<x>")` once for any `ui_*` flag whose `experiment` field is set (a stacking
  round). Elsewhere read values with `getAllFlags()` and never record exposure.
- **Not ready**: until Flagsmith answers or fails, `ready` is false and pages render an empty
  shell (no flash of today's UI).
- **Flagsmith unreachable**: flow comes from `VITE_APP_FLOW_FALLBACK` (`a`/`b`/`c`, else null), all
  pieces follow it.
- **Preview** (only when `variant_preview` is on): URL params `?app_flow=a|b|c|off` and
  `?ui_<switch>=flow|off|a|b|c` override, are saved in `sessionStorage` under
  `code-flow:app-flow-preview` so they survive navigation, and `?app_flow=reset` clears them.
  A preview visitor is never exposed and sends no Flagsmith events.

### Style pieces become attributes on `<html>`

`AppFlowProvider` sets, on `document.documentElement`:
`data-cf-font`, `data-cf-weight`, `data-cf-leading`, `data-cf-buttons`, `data-cf-colours`
to `a`/`b`/`c`, and removes the attribute for "today". `web/src/appFlow/tokens.css` overrides
token variables under `:root[data-cf-colours="a"] { ... }` and so on. Portals and modals therefore
inherit tokens without extra work.

## Token vocabulary (the only way flows get colour, type and button shape)

Today's `:root` in `web/src/styles.css` keeps today's values as defaults. Names marked *new* are
added with defaults that reproduce today's look exactly. **Flow layout CSS may only set layout
(display, grid, flex, gap, sizes, positions, padding, margins, borders' width and style) and must
read every colour, font, weight, line height, radius-of-buttons and button size from these
variables.** No hex colours, font names, weights or line heights in flow CSS or TSX. That rule is
what makes a mix like "Flow B's flow view with Flow A's colours and buttons" work.

| Switch | Variables it sets |
|---|---|
| `ui_colours` | `--color-bg`, `--color-surface`, `--color-sunken`, `--color-border`, `--color-border-strong`, `--color-text`, `--color-text-muted`, `--color-text-subtle`, `--color-accent`, `--color-accent-hover`, `--color-accent-soft`, `--color-accent-text`, *new* `--color-canvas` (diagram background), *new* `--color-grid` (canvas dot grid; today `transparent`), *new* `--color-panel-header`, *new* `--color-selection`, *new* `--color-selection-soft`, *new* `--shadow-card`, *new* diagram set `--diagram-added`, `--diagram-removed`, `--diagram-changed`, `--diagram-context`, `--diagram-added-fill`, `--diagram-removed-fill`, `--diagram-changed-fill`, `--diagram-context-fill`, `--diagram-added-text`, `--diagram-removed-text`, `--diagram-changed-text` |
| `ui_font_family` | `--font-sans`, `--font-mono`, *new* type scale `--text-display`, `--text-h1`, `--text-h2`, `--text-h3`, `--text-body` (14 px always), `--text-small` (12 px), `--text-mono` |
| `ui_font_weight` | *new* `--weight-body`, `--weight-label`, `--weight-heading`, `--weight-display`, `--weight-mono` |
| `ui_line_spacing` | *new* `--leading-body`, `--leading-heading`, `--leading-code` (today's `--leading-normal` / `--leading-tight` become aliases of the first two) |
| `ui_buttons` | *new* `--btn-height`, `--btn-height-sm`, `--btn-pad-x`, `--btn-pad-x-sm`, `--btn-radius`, `--btn-border-width`, `--btn-shadow`, `--btn-secondary-bg`, `--btn-secondary-text`, `--btn-secondary-border`, `--btn-tertiary-decoration` |

Values per flow come from `flags-app-flow.md` rows 2 to 6 and each design's root variables.
Mapping notes:

- Flow C's ink `#0E0E10` is its `--color-accent` (hover `#323236`, soft `#EEEEF0`); C's blue
  `#2F6BFF` is `--color-selection` (soft `#EDF2FF`). For A and B, `--color-selection` equals the accent.
- B's panel header `#F8FAFB` is `--color-panel-header`; for A and C it equals `--color-surface`.
- C's canvas `#F6F6F4` + dot grid `#D9D9D7` are `--color-canvas` / `--color-grid`; A uses its bg and
  grid `#DDD8EC`; B uses its bg and grid `#DCE3EC`. Today: canvas = today's diagram background,
  grid = transparent.
- Diagram shades: A and B darkened ones, C today's. Text tones (`--diagram-*-text`) come from B and C;
  for A use the stroke colour. Today's fills stay `color-mix(in srgb, <stroke> 9%, var(--color-surface))`.
- Buttons: A pill 44/36 px, pad 20/14, secondary = surface + 1.5 px accent border + accent text;
  B square radius 4, 32/28 px, pad 12/8, secondary `#F1F3F5` with a 1 px border; C soft radius 12,
  40/32 px, pad 16/12, no border, secondary tonal `#EEEEF0`, tertiary underlined. Primary is always
  solid `--color-accent` with `--color-accent-text`.
- Fonts load from Google Fonts only for the chosen family (`web/src/appFlow/fonts.ts` adds one
  `<link>`): A Plus Jakarta Sans 400/600/700 + JetBrains Mono 400/600; B IBM Plex Sans 400/500/600 +
  IBM Plex Mono 400/500; C Geist 300/400/500 + Geist Mono 400/500. Today loads nothing (as now).

Shared button: `web/src/appFlow/ui/Button.tsx` renders today's `.btn` classes
(`btn`, `btn--primary`, `btn--secondary`, `btn--tertiary`, `btn--sm`) as `<button>`, `<a>` or an
`AppLink`. Today's `.btn` CSS is rewritten on the button variables so today's screens also change
shape when only `ui_buttons` is on.

## Code layout

```
web/src/appFlow/
  types.ts               contract types (scaffold, do not change)
  flags.ts               piece resolution, exposure, preview overrides (+ tests)
  AppFlowProvider.tsx    context, <html> data attributes, font loading; useAppFlow(), usePiece()
  SignInContext.tsx      useSignIn(): how the landing's "Sign in with GitHub" behaves per sign-in piece
  SignInSlot.tsx         where an inline sign-in panel goes on any landing
  screens.tsx            one switch per screen: today's page or flows/<x>/<Screen>
  journey.ts             app_flow journey events (+ tests)
  tokens.css             token overrides per style piece
  fonts.ts               Google Fonts loader
  ui/Button.tsx          shared button
  hooks/                 data hooks shared by today's pages and all flows
  flows/a|b|c/
    kit.tsx, kit.css     the flow's header and repeated primitives, from its Main.dc.html
    Landing.tsx          LandingA / LandingB / LandingC
    SignIn.tsx           SignInPageA (route /signin) / SignInPanelB / SignInModalC
    Repos.tsx            ReposA / ReposB / ReposC
    RepoDetails.tsx      RepoDetailsA / ...  (includes the analyzing state)
    FlowView.tsx         FlowViewA / ...
    BranchSwitch.tsx     BranchSwitchA / BranchSwitchB / BranchSwitchC
    *.css                layout CSS, classes prefixed `fa-` (A), `fb-` (B), `fc-` (C)
```

### Screen switches (`screens.tsx`)

| Route | Switch | today | a / b / c |
|---|---|---|---|
| `/` | `landing_layout` | `pages/Landing` | `LandingA/B/C` |
| `/signin` (new) | `signin_layout` | redirect to `/` | `SignInPageA` when the piece is `a`, else redirect to `/` |
| `/github` | `repos_layout` | `pages/GitHubRepos` | `ReposA/B/C` |
| `/github/:id` | `repo_details_layout` | `pages/GitHubRepo` | `RepoDetailsA/B/C` |
| `/repo/:id` | `flow_view_layout` | `pages/Viewer` (RepoReview) | `FlowViewA/B/C` |
| inside every flow view | `branch_switch` | link "Switch branch" to `/github/<githubId>?branch=` when the GitHub repo is known, else nothing | `BranchSwitchA/B/C` |

Today's top bar (`App.tsx`) shows only when the current page's piece is `today`; flow screens
render their own header from `flows/<x>/kit.tsx`.

### Sign-in across mixed pieces

- `useSignIn().start()` is what every landing's main "Sign in with GitHub" button calls:
  `today` scrolls to `#import`; `a` navigates to `/signin`; `b` scrolls to and focuses
  `#signin-panel`; `c` opens `SignInModalC` (rendered once at the app root by the provider).
- Signed-in visitors see "Choose a repository" (to `/github`) instead, from `useMe()`.
- `<SignInSlot today={...} placement="hero|section" />` sits where each landing would hold an inline
  panel (B's hero; a section near the top in A and C; today's `#import` section). It renders
  `today` for the today piece, `SignInPanelB` for `b`, nothing for `a`/`c`.
- A failed sign-in returns to `/?signin_error=…`. With piece `a` the landing forwards it to
  `/signin?signin_error=…`; with `c` it opens the modal showing the error; `b` shows it in the panel.
- When `app_flow` is on, today's landing always offers sign-in (the `github_signin` variant), since
  the tested journey starts there. With `app_flow` off, `github_signin` decides as today.

### Branch switch contract

`BranchSwitchX({ repoId, currentBranch })` renders its own trigger and its own UI and must work
inside any flow view: A a 640 px modal (pick branch, then latest commits + Analyze, then progress);
B a 416 px dropdown (analyzes inside itself); C a 352 px popover with a commit rail that fills in
while analyzing. Data comes only from `useBranchSwitch` (below). Opening it calls
`markBranchSwitchOpened()`. When the new branch is ready it navigates to `/repo/<newId>`.

## Shared data hooks (`web/src/appFlow/hooks/`)

Extracted from today's pages without changing their behaviour. Today's pages use them too.

```ts
useMe(): { me: RequestState<Me>; refresh(): void; signOut(): Promise<void> }
useLandingJourney(): { signinError: string | null }
  // landing only: cleans return params, beginJourney (github_signin) + beginAppFlowJourney, watchForAbandon
useLandingRepos(): { repos: RequestState<Repo[]>; waking: boolean; reload(): void }
useUrlImport(): { fields: ImportFields; edit(field, value): void; formError: FormError | null;
  submit(): void; busy: boolean; submitting: boolean; job: Job | null; update?: ImportStatus;
  pollError: string | null; retry(): void }
useGitHubRepoList(search): { me: RequestState<Me>; repos: RequestState<GitHubRepoChoice[]>;
  installed: boolean; signOut(): void }   // fires signin_completed / app_installed as today
useRepoDetails(repoId, search): { branches: RequestState<GitHubBranches>; branch: string;
  setBranch(name): void; commitCount: { count: number; ready: boolean };
  commits: RequestState<GitHubCommitList>; subdir: string; setSubdir(v): void;
  formError: string | null; analyze(): void; submitting: boolean; busy: boolean;
  job: Job | null; update?: ImportStatus; pollError: string | null; retry(): void }
useRepoReview(id, search, initial): everything today's RepoReview computes (commits, selected,
  diff, layout, view, direction, selection, code pane state, review context, handlers ...)
useReviewQuestion(context, onReview): { canReview; answered; submit(outcome); sendsReviewEvents }
  // the U / C keys and timing from ReviewBar; ReviewBar keeps its markup on top of it
useBranchSwitch(repoId, open): {
  info: RequestState<RepoBranches>; selected: string | null; select(name): void;
  commits: RequestState<GitHubCommitList>;          // selected branch, limit = branch_commit_count
  analyze(): void; progress: { text: string; current: number; total: number } | null;
  error: string | null; githubRepoId: number | null }
```

## Server: branches of an imported repo (new)

Access-checked routes on the existing repo router (same rules as other `/api/repos/{repo}/*`):

- `GET /api/repos/{repo}/branches` → `{ repo, full_name, default_branch, current_branch,
  branches: string[] (default first, then by name, at most 100), analyzed: { branch, id, status }[] }`.
  `analyzed` lists imports in the store with the same GitHub URL and subfolder (and the same owner
  for private imports). Public repos use the GitHub REST API without a token (optional
  `CODEFLOW_GITHUB_API_TOKEN` raises the rate limit); private imports use the app installation token.
- `GET /api/repos/{repo}/branches/commits?branch=&limit=` → the same JSON shape as
  `/api/github/repos/{id}/commits`.
- `POST /api/repos/{repo}/branches` `{ branch, max_commits }` → `ImportResponse`. Imports the same
  source on that branch (default branch keeps the plain id), keeping private ownership.

Client functions in `web/src/api.ts`: `fetchRepoBranches`, `fetchRepoBranchCommits`, `importRepoBranch`.

## Journey events

Everything below is sent to Flagsmith only for visitors exposed to `app_flow` (and never in preview).
Each event name is sent at most once per journey. The journey lives in `sessionStorage` under
`code-flow:app-flow-journey` so it survives the GitHub round trip.

| Event | When | Value |
|---|---|---|
| `signin_completed`, `repo_selected`, `import_completed`, `first_flow_viewed`, `import_abandoned` | as today (`signinEvents.trackSignin` forwards them via `forwardJourneyEvent`) | as today |
| `diff_understood` / `diff_confusing` | review answered (also sent today for `flow_view` visitors; never twice) | ms to answer |
| `diagram_moves` | with the review answer | user pans + zooms + node drags since the diagram showed |
| `branch_switched` | flow view of a second branch of the same repo opens, after an "understood" answer | ms since the branch switch opened (0 if unknown) |
| `journey_completed` (main metric) | same moment as `branch_switched` | ms since landing |
| `journey_clicks` | with `journey_completed` | clicks since landing |
| `dead_clicks` | with `journey_completed`, or on `pagehide` if not completed | clicks on things that do not respond |

- "Same repo, second branch": import ids look like `owner__name`, `owner__name@feature~x`,
  `p_<uid>__owner__name@x`; the family is the part before `@`. Completed when the family matches the
  understood import's family and the id differs.
- Dead click: a click whose target has no ancestor among `a, button, input, select, textarea, label,
  summary, [role=button], [role=tab], [role=option], [tabindex], .react-flow` and no text selection.
- Diagram moves: `onMoveEnd` with a real event (user pan/zoom) and `onNodeDragStop` in `FlowCanvas`.

## Build order

1. Scaffold (contract files above) on branch `claude/project-thread-u2cf2i` from `develop`.
2. Foundation, in parallel: F1 flags + provider + routing + screen switches, F2 tokens + button +
   today CSS on variables, F3 shared hooks, F4 journey events, F5 server branch routes + client +
   `useBranchSwitch`, F6 Flagsmith setup for the 12 flags, F7 per-flow kits.
3. Screens, in parallel per flow: entry (landing + sign-in), repos (repos page + repo details +
   analyzing), flow (flow view + branch switch).
4. Integration: build, tests, screenshots of every screen per flow against the designs, mixes,
   journey events checked in the browser console, fix pass.
5. Flags created in Development; simulator `app_flow.yaml` (later, in the experiment work).

## Rules for every task

- Work only in your own git worktree and branch; touch only the files your task owns. Contract
  files (`types.ts`, signatures in `journey.ts`, `SignInSlot.tsx`, `AppFlowProvider.tsx` exports)
  keep their names and shapes.
- TypeScript strict, function components, no new dependencies.
- Accessible markup: real `<button>` / `<a href>` / `<label>`; icon-only buttons get `aria-label`;
  modals trap focus and close on Escape; text contrast at least 4.5:1.
- `cd web && npm run build && npm test` must pass before you commit. Server: `cd server && uv run pytest`.
- Commit with a clear message on your branch. Do not push.
