# The T3 Code fork

Two branches matter here:

- **`placement-profiles`** is the fork: upstream T3 Code nightlies plus the
  patches listed in `.fork-kit.toml` (account fallback and placement profiles).
  Feature work lands here through pull requests.
- **`prism-nightly`** is the default branch. It holds the workflows that build
  releases (`fork-nightly.yml`, `prism-android-nightly.yml`) and the scheduled
  fork-kit sync. Scheduled workflows only run from the default branch.

## Keeping up with upstream

[fork-kit](https://github.com/BierDav/fork-kit) (`.github/workflows/fork-kit.yml`)
merges the newest upstream nightly tag every two hours into the branch
`fork-kit/sync` and keeps one pull request into `placement-profiles` open for it.

- **Clean merge and `Typecheck and test` green:** the PR merges itself.
- **Conflicts:** the PR is labelled `fork-kit:conflict` and lists the
  conflicting files with the patches they belong to. Resolve them on
  `fork-kit/sync` (`npx github:BierDav/fork-kit#v0.2.0 resolve`, or GitHub's
  conflict editor) and merge the PR yourself.
- **Keeping a PR from merging itself:** add the label `fork-kit:hold`.

Upstream changes `.github/` in most nightlies, so this fork sets
`workflow_changes = "push"`: those changes are pushed without a human review.
That is acceptable here because the repository has no repository secrets, and
its one environment (`prism-android-signing`) deploys only from `prism-nightly`.

## Releases

`fork-nightly.yml` (on `prism-nightly`, every 30 minutes) builds
`placement-profiles` as it is and publishes the prerelease `fork-v<version>`,
where `<version>` is the newest upstream nightly merged into it. The fleet's
`bump-t3-nightly.sh` moves to a release once its three assets are up.

## Repository settings this relies on

- **The GitHub App:** its key is the secret `FORK_KIT_APP_KEY` in the
  environment `fork-kit`, which only `prism-nightly` can deploy to; its ID is
  the repository variable `FORK_KIT_APP_ID`.
- **A ruleset on `placement-profiles`:** a pull request and the check
  `Typecheck and test`; no force pushes or deletion. Repository admins may
  bypass it.
- **Auto-merge** is allowed in the repository settings.
