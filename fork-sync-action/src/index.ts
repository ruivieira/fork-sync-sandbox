import * as core from '@actions/core'
import * as github from '@actions/github'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { syncRepository } from './git-ops'
import type { SyncRepoResult } from './git-ops'

type Octokit = ReturnType<typeof github.getOctokit>
type PullRequest = { number: number; html_url: string }

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/

/** Token currently in use; used to scrub credentials from error messages. */
let secret = ''

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redact(text: string): string {
  return secret ? text.split(secret).join('***') : text
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
}

function remoteUrl(server: string, fullName: string, token: string): string {
  const url = new URL(`${server.replace(/\/+$/, '')}/${fullName}.git`)
  if (token && (url.protocol === 'https:' || url.protocol === 'http:')) {
    url.username = 'x-access-token'
    url.password = token
  }
  return url.toString()
}

function csvInput(name: string): string[] {
  return core
    .getInput(name)
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

async function findOpenPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string
): Promise<PullRequest | undefined> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${head}`,
    base,
    per_page: 1,
  })
  return data[0]
}

async function openOrUpdatePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PullRequest> {
  const existing = await findOpenPullRequest(octokit, owner, repo, head, base)
  if (existing) {
    core.info(`Updating existing pull request #${existing.number} (its branch was force-pushed).`)
    await octokit.rest.pulls.update({ owner, repo, pull_number: existing.number, body })
    return existing
  }
  const { data } = await octokit.rest.pulls.create({ owner, repo, title, head, base, body })
  core.info(`Opened pull request #${data.number}: ${data.html_url}`)
  return data
}

function buildPullRequestBody(
  result: SyncRepoResult,
  server: string,
  upstreamRepo: string,
  upstreamBranch: string,
  targetBranch: string
): string {
  const custom = core.getInput('pr-body').trim()
  if (custom) return custom

  const conflictBanner =
    result.status === 'conflicts'
      ? `> [!WARNING]\n> Merging \`${upstreamBranch}\` into \`${targetBranch}\` conflicts. ` +
        `The head branch points at upstream's tip; resolve the conflicts in this pull request.\n\n`
      : ''
  const commits = result.commits.map(commit => `- ${commit.sha.slice(0, 7)} ${commit.subject}`)
  const overflow =
    result.commitCount > result.commits.length
      ? `\n- … and ${result.commitCount - result.commits.length} more`
      : ''
  return (
    `${conflictBanner}This pull request brings **${result.commitCount} commit(s)** from ` +
    `[${upstreamRepo}](${server}/${upstreamRepo}) \`${upstreamBranch}\` into \`${targetBranch}\`.\n\n` +
    `### Incoming commits\n${commits.join('\n')}${overflow}\n\n---\n` +
    `Automated by the fork-sync action.`
  )
}

async function run(): Promise<void> {
  const token = core.getInput('token')
  if (!token) {
    throw new Error(
      "The 'token' input is empty; pass a token with contents:write and pull-requests:write " +
        '(the default github.token usually works).'
    )
  }
  secret = token
  core.setSecret(token)

  const dryRun = core.getBooleanInput('dry-run')
  const skipPr = core.getBooleanInput('skip-pr')
  const failOnConflict = core.getBooleanInput('fail-on-conflict')
  const upstreamToken = core.getInput('upstream-token').trim() || token

  const { owner: forkOwner, repo: forkRepo } = github.context.repo
  const upstreamRepoInput = core.getInput('upstream-repo').trim()
  const upstreamBranchInput = core.getInput('upstream-branch').trim()
  const targetBranchInput = core.getInput('target-branch').trim()

  if (upstreamRepoInput && !REPOSITORY_PATTERN.test(upstreamRepoInput)) {
    throw new Error(`upstream-repo must look like "owner/name", got "${upstreamRepoInput}".`)
  }

  const octokit = github.getOctokit(token)

  // Only hit the API for what the inputs did not pin down.
  let forkDefaultBranch = ''
  let parentRepo = ''
  if (!upstreamRepoInput || !targetBranchInput) {
    core.info(`Looking up ${forkOwner}/${forkRepo} …`)
    const { data: fork } = await octokit.rest.repos.get({ owner: forkOwner, repo: forkRepo })
    forkDefaultBranch = fork.default_branch
    parentRepo = fork.parent?.full_name ?? ''
    if (!upstreamRepoInput && !parentRepo) {
      throw new Error(
        `${forkOwner}/${forkRepo} does not appear to be a fork. ` +
          `Set the 'upstream-repo' input to sync from a specific repository.`
      )
    }
  }

  const upstreamRepo = upstreamRepoInput || parentRepo
  let upstreamBranch = upstreamBranchInput
  if (!upstreamBranch) {
    const { owner, repo } = splitRepository(upstreamRepo)
    core.info(`Looking up the default branch of ${upstreamRepo} …`)
    const { data: upstream } = await octokit.rest.repos.get({ owner, repo })
    upstreamBranch = upstream.default_branch
  }

  const targetBranch = targetBranchInput || forkDefaultBranch
  const headBranch = core.getInput('head-branch').trim() || `sync/upstream-${upstreamBranch}`
  if (headBranch === targetBranch) {
    throw new Error(`head-branch ("${headBranch}") must differ from target-branch ("${targetBranch}").`)
  }

  const mergeStrategy = core.getInput('merge-strategy').trim()
  if (mergeStrategy !== 'merge' && mergeStrategy !== 'tip') {
    throw new Error(`merge-strategy must be "merge" or "tip", got "${mergeStrategy}".`)
  }

  const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  const originUrl = remoteUrl(server, `${forkOwner}/${forkRepo}`, token)
  const upstreamUrl = remoteUrl(server, upstreamRepo, upstreamToken)

  const workspace = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fork-sync-'))
  core.info(
    `Syncing ${upstreamRepo}:${upstreamBranch} -> ${forkOwner}/${forkRepo}:${targetBranch} ` +
      `via ${headBranch} (strategy: ${mergeStrategy}, dry-run: ${dryRun})`
  )

  const result = await syncRepository({
    workspace,
    originUrl,
    upstreamUrl,
    targetBranch,
    upstreamBranch,
    headBranch,
    mergeStrategy,
    mergeMessage: `Merge ${upstreamRepo}:${upstreamBranch} into ${targetBranch}`,
    push: !dryRun,
  })

  if (result.status === 'conflicts' && failOnConflict) {
    throw new Error(
      `Merging ${upstreamRepo}:${upstreamBranch} into ${targetBranch} conflicts. ` +
        'Resolve it manually, or set fail-on-conflict: false to open a pull request that carries the conflicts.'
    )
  }

  core.setOutput('status', result.status)
  core.setOutput('head-sha', result.headSha)
  core.setOutput('target-sha', result.targetSha)
  core.setOutput('upstream-sha', result.upstreamSha)
  core.setOutput('commit-count', String(result.commitCount))
  core.setOutput('pushed', String(result.pushed))
  core.info(`Sync result: ${result.status} — ${result.commitCount} commit(s), head ${result.headSha.slice(0, 7)}`)

  let pullRequest: PullRequest | undefined

  if (result.status === 'up-to-date') {
    core.info(`"${targetBranch}" is already up to date with ${upstreamRepo}:${upstreamBranch}.`)
  } else if (dryRun) {
    core.info('Dry run: nothing was pushed and no pull request was created.')
  } else if (skipPr) {
    core.info(`Pushed "${headBranch}" to ${forkOwner}/${forkRepo} (skip-pr: true, no pull request).`)
  } else {
    const title =
      core.getInput('pr-title').trim() || `Sync ${upstreamRepo}:${upstreamBranch} into ${targetBranch}`
    const body = buildPullRequestBody(result, server, upstreamRepo, upstreamBranch, targetBranch)
    pullRequest = await openOrUpdatePullRequest(octokit, forkOwner, forkRepo, headBranch, targetBranch, title, body)

    const labels = csvInput('labels')
    const assignees = csvInput('assignees')
    if (labels.length > 0) {
      try {
        await octokit.rest.issues.addLabels({
          owner: forkOwner,
          repo: forkRepo,
          issue_number: pullRequest.number,
          labels,
        })
      } catch (error) {
        core.warning(`Could not add labels: ${redact(errorMessage(error))}`)
      }
    }
    if (assignees.length > 0) {
      try {
        await octokit.rest.issues.addAssignees({
          owner: forkOwner,
          repo: forkRepo,
          issue_number: pullRequest.number,
          assignees,
        })
      } catch (error) {
        core.warning(`Could not add assignees: ${redact(errorMessage(error))}`)
      }
    }
  }

  core.setOutput('pull-request-number', pullRequest ? String(pullRequest.number) : '')
  core.setOutput('pull-request-url', pullRequest ? pullRequest.html_url : '')

  await core.summary
    .addHeading('Fork sync', 2)
    .addList([
      `status: ${result.status}`,
      `upstream: ${upstreamRepo}:${upstreamBranch} @ ${result.upstreamSha.slice(0, 7)}`,
      `target: ${forkOwner}/${forkRepo}:${targetBranch} @ ${result.targetSha.slice(0, 7)}`,
      `incoming commits: ${result.commitCount}`,
      `pull request: ${pullRequest ? pullRequest.html_url : 'none'}`,
    ])
    .write()
}

run().catch(error => {
  core.setFailed(redact(errorMessage(error)))
})
