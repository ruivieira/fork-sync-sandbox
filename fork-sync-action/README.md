# fork-sync-action

A GitHub Action that keeps a **fork** (repo B) up to date with its **upstream / parent**
repository (repo A) by opening a **pull request** that carries the incoming commits —
so nothing lands on your fork's branches without review.

```
repo A (upstream)                         repo B (fork)
  main ──●──●──●──●                          main ──●──●──●   (your own commits)
              │                                        ▲
              │ fetch                                   │ pull request
              ▼                                         │
        sync/upstream-main ── merge ────────────────────┘
        (force-pushed by the action)
```

Built on GitHub's official Actions toolkit (`@actions/core`, `@actions/github`),
bundled to a single `dist/index.js` with `@vercel/ncc`, running on the `node24`
runtime.

## What it does

1. Resolves the upstream repository — either from the `upstream-repo` input or
   automatically as the parent of the repository the workflow runs in — and both
   branch names (upstream's and the fork's default branches unless overridden).
2. Creates a throwaway git workspace, fetches the fork's `target-branch` and the
   upstream branch. No checkout of your repo needed.
3. If the fork already contains everything from upstream → exits with
   `status=up-to-date` and changes nothing.
4. Otherwise creates (or resets) a sync branch — `sync/upstream-<branch>` by
   default — at the target branch and merges upstream into it:
   fast-forwards when the fork is strictly behind, otherwise creates a merge
   commit. On conflicts, the sync branch is pointed at upstream's tip instead,
   so the pull request surfaces the conflicts for you to resolve.
5. Force-pushes the sync branch to the fork (the branch is owned by the action,
   so re-runs are idempotent) and opens a pull request `sync/... → target-branch`
   — or updates the existing open one.
6. Sets outputs (`status`, `pull-request-url`, `commit-count`, …) and writes a
   job summary.

## Quick start

In the **fork** (repo B), drop this into `.github/workflows/sync-upstream.yml`
(after pushing this action to its own repository and tagging it, see
[Publishing](#publishing-this-action)):

```yaml
name: Sync upstream

on:
  schedule:
    - cron: "30 6 * * *"   # daily at 06:30 UTC
  workflow_dispatch: {}     # also runnable manually

permissions:
  contents: write          # push the sync branch
  pull-requests: write     # open the pull request

concurrency:
  group: sync-upstream     # never two syncs at once

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: YOUR_USERNAME/fork-sync-action@v1
```

That's all — upstream repo, upstream branch and target branch are all
auto-detected. Remember to enable Actions in the fork once
(*Settings → Actions → General → Allow all actions and workflows*), because
GitHub disables workflows in forks by default.

## Examples

### 1. Minimal: sync default branches on a schedule

See [Quick start](#quick-start). Everything is auto-detected from the fork's
parent repository.

### 2. Pick the branches when triggering manually

```yaml
name: Sync upstream

on:
  workflow_dispatch:
    inputs:
      upstream-branch:
        description: "Branch on the parent repo to pull from"
        default: main
      target-branch:
        description: "Branch on the fork to update"
        default: main

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: YOUR_USERNAME/fork-sync-action@v1
        with:
          upstream-branch: ${{ inputs.upstream-branch }}
          target-branch: ${{ inputs.target-branch }}
```

### 3. Fully pinned repositories, branches and pull-request metadata

Works even when the repo running the workflow is *not* a GitHub fork (any repo
can pull from any other repo it can read):

```yaml
      - uses: YOUR_USERNAME/fork-sync-action@v1
        with:
          upstream-repo: octocat/Hello-World
          upstream-branch: develop
          target-branch: develop
          head-branch: sync/develop-from-hello-world
          pr-title: "chore: pull latest develop from Hello-World"
          labels: automated, dependencies
          assignees: rui
```

### 4. Private upstream repository

The default `github.token` can only read the upstream repo if it is public (or
in the same org with matching permissions). For a private upstream, pass a PAT
that can read it:

```yaml
      - uses: YOUR_USERNAME/fork-sync-action@v1
        with:
          upstream-token: ${{ secrets.UPSTREAM_READ_PAT }}
```

The main `token` (used for pushing the branch and opening the PR in the fork)
still defaults to `github.token`.

### 5. React to the result: auto-merge clean syncs, warn on conflicts

```yaml
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - id: sync
        uses: YOUR_USERNAME/fork-sync-action@v1

      - name: Auto-merge clean sync pull requests
        if: steps.sync.outputs.status == 'synced' && steps.sync.outputs.pull-request-url != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ steps.sync.outputs.pull-request-number }}
        run: gh pr merge --auto --merge --repo "$GITHUB_REPOSITORY" "$PR"

      - name: Warn on conflicts
        if: steps.sync.outputs.status == 'conflicts'
        run: |
          echo "::warning::Upstream diverged — resolve conflicts in ${{ steps.sync.outputs.pull-request-url }}"

      - name: Nothing to do
        if: steps.sync.outputs.status == 'up-to-date'
        run: echo "Fork is already up to date."
```

### 6. CI for the action itself (typecheck, build, offline tests)

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run typecheck
      - run: npm test          # rebuilds dist/ and runs the offline scenario tests
      - run: git diff --exit-code -- dist   # fail if dist/ was not committed
```

### 7. Trying it out safely: dry-run

Runs the whole sync logic (fetch, merge, conflict detection) but pushes nothing
and opens no pull request — good for a first run or a smoke test:

```yaml
      - uses: YOUR_USERNAME/fork-sync-action@v1
        with:
          dry-run: true
```

Related: `skip-pr: true` pushes the sync branch but lets you open the pull
request yourself.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | no | `${{ github.token }}` | Token for repo info, pushing the branch and opening the PR. Needs `contents:write`, `pull-requests:write`. |
| `upstream-repo` | no | fork's parent | Upstream repository as `owner/name`. |
| `upstream-branch` | no | upstream default branch | Branch on the upstream repo to pull from. |
| `target-branch` | no | fork default branch | Branch on the fork to update (PR base). |
| `head-branch` | no | `sync/upstream-<upstream-branch>` | Branch on the fork carrying the changes (PR head). |
| `merge-strategy` | no | `merge` | `merge`: merge upstream into the target branch (fast-forward when possible). `tip`: head points at upstream's tip; divergence shows as conflicts in the PR. |
| `fail-on-conflict` | no | `false` | Fail instead of opening a conflicted pull request. |
| `upstream-token` | no | `token` | Separate token to fetch from a private upstream. |
| `pr-title` | no | `Sync <upstream>:<branch> into <target>` | Pull request title. |
| `pr-body` | no | generated summary | Pull request body (commit list + conflict banner). |
| `labels` | no | — | Comma-separated labels for the PR. |
| `assignees` | no | — | Comma-separated usernames to assign. |
| `dry-run` | no | `false` | Compute everything, push nothing, open no PR. |
| `skip-pr` | no | `false` | Push the sync branch but open no PR. |

## Outputs

| Output | Description |
|---|---|
| `status` | `up-to-date`, `synced` or `conflicts`. |
| `pull-request-number` | Number of the opened/updated PR (empty when none). |
| `pull-request-url` | URL of the opened/updated PR (empty when none). |
| `head-sha` | SHA of the produced head branch. |
| `target-sha` / `upstream-sha` | SHAs of the target and upstream branches. |
| `commit-count` | Commits the PR brings in. |
| `pushed` | `true` when the head branch was pushed. |

## Notes and caveats

- **Workflow permissions**: the workflow needs `contents: write` (push the sync
  branch) and `pull-requests: write` (open the PR). The examples include them.
- **PRs created with `github.token` do not trigger other workflows** — GitHub
  blocks workflow-triggered-by-workflow recursion. If the sync PR must run your
  CI (e.g. before auto-merge), pass a PAT as `token`.
- **The head branch is force-pushed** on every run. Don't commit to
  `sync/upstream-*` manually; use `head-branch` if you need your own name.
- **One rolling PR per branch pair**: re-runs update the same open pull request
  (branch is force-pushed, body refreshed) instead of piling up new PRs.
- **Upstream default branch changes** are picked up automatically when you don't
  pin `upstream-branch`.
- Works on GitHub Enterprise Server too — the action honors
  `GITHUB_SERVER_URL`/`GITHUB_API_URL`.

## Publishing this action

`uses:` references a repository + ref, so the action folder must be pushed to
GitHub. Two options:

1. **Own repository (recommended)**: push the contents of this folder to e.g.
   `YOUR_USERNAME/fork-sync-action`, commit the built `dist/`, then tag it:

   ```bash
   git tag v1 && git push origin v1
   # later: git tag -f v1 && git push -f origin v1   # to move the tag
   ```

   Then reference it as `YOUR_USERNAME/fork-sync-action@v1`.

2. **Subdirectory of an existing repo** (this is how it lives today, inside
   `basic-ops-tasks`): reference it with the path syntax —
   `uses: YOUR_USERNAME/basic-ops-tasks/fork-sync-action@main`.

`dist/index.js` is the artifact the runner executes — always rebuild
(`npm run build`) and commit it together with `src/` changes.

## Testing

Four levels, from fastest to most real. Levels 1–2 run entirely on your
machine; levels 3–4 touch real GitHub.

### 1. Offline scenario tests (seconds, no network)

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # ncc bundle -> dist/index.js
npm test              # rebuild + offline end-to-end scenarios
```

`test/local-sync.test.mjs` builds two bare git repositories behind `file://`
remotes (an upstream and a diverged fork), runs the compiled action exactly the
way the runner would (inputs via `INPUT_*` env vars, outputs parsed back from
`GITHUB_OUTPUT`), and covers: merge sync, up-to-date, conflict fallback to
upstream tip, `fail-on-conflict`, the `tip` strategy, dry-run, and custom head
branches. It needs no network and no GitHub API calls.

### 2. Static validation with actionlint

[actionlint](https://github.com/rhysd/actionlint) lints workflow files and,
through the local `uses: ./fork-sync-action` reference, cross-checks every
`with:` input and `steps.*.outputs.*` reference against `action.yml` — it
catches typos in input names, invalid expression contexts, and bad YAML before
GitHub ever sees them:

```bash
curl -fsSL "$(curl -fsSL https://api.github.com/repos/rhysd/actionlint/releases/latest \
  | grep -oE 'https://[^"]+_linux_amd64\.tar\.gz' | head -1)" | tar xz -C ~/.local/bin actionlint
actionlint    # run from the repository root (.github/workflows is picked up automatically)
```

### 3. Live smoke test, zero side effects (dry-run)

`.github/workflows/fork-sync-smoke.yml` (at the repository root — GitHub only
reads workflows from `<repo>/.github/workflows/`, not from subdirectories)
runs this action from a real GitHub runner against a real public upstream in
`dry-run: true` mode: it does the actual fetch and merge and reports
`status`/outputs, but pushes nothing and opens no pull request. Trigger it
manually from the Actions tab ("Run workflow", optionally choosing which
public repo to pull from), or let it run automatically on pushes/PRs that
touch `fork-sync-action/**`.

When the action moves to its own repository, move the workflow along with it
and change `uses: ./fork-sync-action` to `uses: ./`.

### 4. Full end-to-end with throwaway repos

The only level that exercises the push and the pull request for real:

1. Create a sandbox upstream repo A and fork it to get B (or use any existing
   repo as B and point `upstream-repo` at any repo it can read). Enable
   Actions in B — GitHub disables workflows in forks until you do.
2. Add the sync workflow to B. While iterating, reference the action by
   branch, not by tag:
   `uses: ruivieira/basic-ops-tasks/fork-sync-action@your-branch`.
3. Push commits to A, run the workflow from B's Actions tab, and verify the
   pull request appears in B with the right commits.
4. Deliberately test the conflict path: commit the same line in A and B,
   re-run, then resolve the conflicted PR in B.
5. Delete the sandbox repos when done.

Gotchas that only show up at this level:

- PRs opened with `github.token` do not trigger other workflows in B; pass a
  PAT as `token` if the sync PR must run CI.
- Only tag `v1` after this level passes. Iterate on a branch ref and move the
  tag afterwards (`git tag -f v1 && git push -f origin v1`).

[act](https://github.com/nektos/act) (Docker/Podman) can also run workflows
locally, which is handy for workflow-syntax issues — but the parts that matter
here (hub API calls, pull request creation) still talk to real GitHub, so
level 4 with sandbox repos remains the honest test.

## Why TypeScript + actions/toolkit?

- **actions/toolkit is GitHub's official framework for writing Actions**
  (`@actions/core` for inputs/outputs/logging/failures, `@actions/github` for a
  pre-authenticated Octokit). Everything first-party — `actions/checkout`,
  `actions/setup-node`, … — is built with it, and it is the best-supported path.
- **Probot is not an Actions framework.** Probot is a framework for *GitHub
  Apps*: long-lived services that react to webhook events (installations, issue
  comments, …). Use it (or plain Octokit) when you need event-driven bot
  behavior; for something that runs on a schedule inside a workflow, it's the
  wrong tool.
- Alternatives for Actions specifically: a **composite action** of bash + `gh`
  CLI (zero build step, fine for glue code, but stringly-typed and harder to
  test), a **Docker action** (any language, but ~10–30 s of image pull per run),
  or **Go/Rust** (single static binary, but no official toolkit and more
  boilerplate). For "git + REST API on a timer", TypeScript + toolkit bundled
  with `ncc` is the sweet spot: type-safe, unit-testable, starts in ~1 s.

## Alternatives worth knowing

- GitHub's built-in **"Sync fork"** button and the
  `POST /repos/{owner}/{repo}/merge-upstream` REST endpoint merge upstream
  *directly* into a branch — no pull request, no review. That's the behavior to
  reach for when you want no review step.
- Existing actions such as `repo-sync/github-sync` or
  `aormsby/Fork-Sync-With-Upstream-action` push upstream commits straight onto
  a branch. This action differs on purpose: changes arrive as a reviewable PR.
