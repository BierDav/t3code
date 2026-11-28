# The T3 Code fork

Two branches matter here:

- **`placement-profiles`** is the fork: upstream T3 Code nightlies plus the
  patches listed in `.fork-kit.toml` (account fallback and placement profiles).
  Feature work lands here through pull requests.
- **`prism-nightly`** is the default branch. It holds the workflows that build
  releases (`fork-nightly.yml`, `prism-android-nightly.yml`), and the
  `.fork-kit.toml` the central fork-kit sync reads.

## Keeping up with upstream

Prism checks for new upstream nightly tags and dispatches
[this fork's sync workflow](https://github.com/BierDav/t3code/actions/workflows/fork-kit.yml)
when a sync is due. Fork Kit merges the newest nightly into `fork-kit/sync`
and keeps one pull request into `placement-profiles` up to date.

- **Clean merge and `Typecheck and test` green:** the PR merges itself.
- **Conflicts:** the PR is labelled `fork-kit:conflict` and lists the
  conflicting files with the patches they belong to. Resolve them on
  `fork-kit/sync` (`npx github:BierDav/fork-kit#v0.4.0 resolve`, or GitHub's
  conflict editor) and merge the PR yourself.
- **Holding a PR:** turn off its auto-merge. The next fork-kit run turns it
  back on for a sync PR, so to keep holding one, close it until you are ready.
  This fork does not run fork-kit's `fork-kit/hold` guard.

Upstream changes `.github/` in most nightlies, so this fork sets
`workflow_changes = "push"`: those changes are pushed without a human review.
That is acceptable here because the repository has no repository secrets, and
its one environment (`prism-android-signing`) deploys only from `prism-nightly`.

## Releases

A successful `Fork check` after a push to `placement-profiles` starts
`fork-nightly.yml` on `prism-nightly`. It builds the fork and publishes
`fork-v<version>`, where `<version>` is the newest upstream nightly merged
into it. If a build fails, dispatch it again from Actions. The fleet's
`bump-t3-nightly.sh` moves to a release once its three assets are up.

## Repository settings this relies on

- **The GitHub App** (fork-kit-bierdav) mints a token scoped to this fork.
  The `fork-kit` environment exposes its credentials only on `prism-nightly`.
  The guard on `placement-profiles` runs on `GITHUB_TOKEN`.
- **A ruleset on `placement-profiles`:** a pull request and the check
  `Typecheck and test`; no force pushes or deletion. Repository admins may
  bypass it.
- **Workflows that need Blacksmith runners are disabled** in Actions:
  upstream's CI, the desktop, web, relay and mobile previews, Mobile
  Fingerprint Check, Mobile EAS Production, Mobile Showcase Screenshots and
  Windows Tests. This fork has no Blacksmith runners, so their runs would
  queue forever. Upstream jobs guarded by `github.repository == 'pingdotgg/t3code'`
  skip on their own and stay enabled. Disabling, not editing the workflow
  files, survives fork-kit syncs, which push upstream's `.github/` changes.
- **Auto-merge** is allowed in the repository settings.
