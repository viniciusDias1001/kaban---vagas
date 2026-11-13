# Fixtures

Committed:
- `*.synthetic.html`: pages written by hand.
- JSON recorded from a public API (`greenhouse/job.json`).
- `fake/` (the test site) and `recording/` (the page that tests the recorder).

Local only (git-ignored, see `.gitignore`): pages, scripts and styles recorded from a third-party site with the
recorder's `replay`, `snapshot` and `profile` modes (for example `greenhouse/form/`). This repository is public and
Apache-2.0: a site's own bundles, and pages recorded from the owner's logged-in session, must not be redistributed here.
Browser tests that need one of these folders skip, naming the command, when it is absent.

Recording (read-only, never submits):
- Greenhouse: `pnpm apply:fixtures` (defaults: board `gitlab`, job `8704363002`; change with `-- --board <b> --job <id>`).
- Lever and LinkedIn: each task adds its line here and to `apply:fixtures`.
