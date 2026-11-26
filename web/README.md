# code-flow web

Run `npm run dev` from this directory with the code-flow API running. Vite
reads the repo-root `.env`. Set `VITE_API_URL` for code-flow and
`VITE_FLAGSMITH_API_URL` and `VITE_CODEFLOW_FLAGSMITH_ENV_KEY` for the
self-hosted Flagsmith SDK. Use a client-side environment key for the web app.

The viewer assigns a reviewer ID saved in local storage. Add `?reviewer=demo-1`
to repeat the assignment for a demo identity. Flagsmith's `flow_view` flag
chooses `side_by_side`, `overlay`, or `overlay_summary`, with `side_by_side`
as the control fallback. Add `&view=overlay_summary` to preview the summary
variant with a developer badge and skip the experiment exposure.

`flagsmith_mode` controls the findings and live path styling. The viewer refreshes
this setting and the commit's findings on a ten-second interval. Select a
finding to highlight the calls guarded by the flag and the functions that
check it. Select it again or press Escape to clear the highlight. Select a
`file:line` link to open the corresponding source.

Press `F` to toggle fullscreen for the diagram or `Esc` to exit.

Run `npm run build && npm test` to check the web client. The demo routes are
`/repo/shop-demo?commit=f376f9c&reviewer=demo-1` and
`/repo/Flagsmith__flagsmith?commit=a9b66f5&reviewer=demo-1`.
