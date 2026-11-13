# Fixtures

Committed:
- `*.synthetic.html`: pages written by hand.
- JSON recorded from a public API (`greenhouse/job.json`).
- `fake/` (the test site) and `recording/` (the page that tests the recorder).

Local only (git-ignored, see `.gitignore`): pages, scripts and styles recorded from a third-party site with the
recorder's `replay`, `snapshot` and `profile` modes (for example `greenhouse/form/`, `lever/form/`, `lever/rendered.html`, `lever/closed.html`). This repository is public and
Apache-2.0: a site's own bundles, and pages recorded from the owner's logged-in session, must not be redistributed here.
Browser tests that need one of these folders skip, naming the command, when it is absent.

Recording (read-only, never submits):
- `pnpm apply:fixtures` records every site below (add `-- --site greenhouse` or `-- --site lever` for one).
- Greenhouse (defaults: board `gitlab`, job `8704363002`; change with `-- --board <b> --job <id>`).
- Lever: `pnpm apply:fixtures -- --site lever` (defaults: company `palantir`, posting `6ed76ce8-4156-4b60-b120-403538bd66cd`; change with `--company <c> --posting <id>`). Records the `/apply` form (`lever/form/`), its rendered DOM (`lever/rendered.html`) and the page of a posting that does not exist (`lever/closed.html`). `lever/confirmation.synthetic.html` is hand-written and committed.
- LinkedIn: its task adds its line here and to `apply:fixtures`.
