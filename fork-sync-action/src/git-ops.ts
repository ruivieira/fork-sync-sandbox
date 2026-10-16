import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export interface CommitInfo {
  sha: string
  subject: string
}

export interface SyncRepoOptions {
  /** Directory in which a throwaway git repository is created. */
  workspace: string
  /** Remote URL of the fork: the target branch is fetched from here and the head branch pushed to it. */
  originUrl: string
  /** Remote URL of the upstream repository: the upstream branch is fetched from here. */
  upstreamUrl: string
  /** Branch on the fork that receives the changes (pull request base). */
  targetBranch: string
  /** Branch on the upstream repository to pull from. */
  upstreamBranch: string
  /** Branch on the fork that carries the changes (pull request head). */
  headBranch: string
  /** "merge": merge upstream into the target branch. "tip": head points at upstream's tip. */
  mergeStrategy: 'merge' | 'tip'
  /** Commit message used when the merge creates a merge commit. */
  mergeMessage: string
  /** Push the head branch to the fork when true. */
  push: boolean
}

export interface SyncRepoResult {
  /** "up-to-date": nothing to do. "synced": head branch ready. "conflicts": the merge conflicted and head points at upstream's tip. */
  status: 'up-to-date' | 'synced' | 'conflicts'
  targetSha: string
  upstreamSha: string
  headSha: string
  commitCount: number
  commits: CommitInfo[]
  pushed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.toString()
  } catch (error) {
    const err = error as { stderr?: string | Buffer; message: string }
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} failed:\n${stderr.trim() || err.message}`)
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

async function listCommits(cwd: string, from: string, to: string, limit = 30): Promise<CommitInfo[]> {
  const out = await git(cwd, ['log', `--max-count=${limit}`, '--pretty=format:%H%x1f%s', `${from}..${to}`])
  const trimmed = out.trim()
  if (!trimmed) return []
  return trimmed.split('\n').map(line => {
    const sep = line.indexOf('\x1f')
    return { sha: line.slice(0, sep), subject: line.slice(sep + 1) }
  })
}

export async function syncRepository(opts: SyncRepoOptions): Promise<SyncRepoResult> {
  const {
    workspace,
    originUrl,
    upstreamUrl,
    targetBranch,
    upstreamBranch,
    headBranch,
    mergeStrategy,
    mergeMessage,
    push,
  } = opts

  await mkdir(workspace, { recursive: true })
  await git(workspace, ['init', '--initial-branch=main'])
  await git(workspace, ['config', 'user.name', 'github-actions[bot]'])
  await git(workspace, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  await git(workspace, ['config', 'commit.gpgsign', 'false'])
  await git(workspace, ['remote', 'add', 'origin', originUrl])
  await git(workspace, ['remote', 'add', 'upstream', upstreamUrl])

  try {
    await git(workspace, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
    ])
  } catch (error) {
    throw new Error(
      `Could not fetch the target branch "${targetBranch}" from the fork. Does the branch exist? ` +
        `(${errorMessage(error)})`
    )
  }
  try {
    await git(workspace, [
      'fetch',
      '--no-tags',
      'upstream',
      `+refs/heads/${upstreamBranch}:refs/remotes/upstream/${upstreamBranch}`,
    ])
  } catch (error) {
    throw new Error(
      `Could not fetch the upstream branch "${upstreamBranch}". Does it exist, and does the token have read ` +
        `access to the upstream repository? (${errorMessage(error)})`
    )
  }

  const targetSha = (await git(workspace, ['rev-parse', `refs/remotes/origin/${targetBranch}`])).trim()
  const upstreamSha = (await git(workspace, ['rev-parse', `refs/remotes/upstream/${upstreamBranch}`])).trim()

  if (await isAncestor(workspace, upstreamSha, targetSha)) {
    return { status: 'up-to-date', targetSha, upstreamSha, headSha: targetSha, commitCount: 0, commits: [], pushed: false }
  }

  let status: 'synced' | 'conflicts' = 'synced'
  if (mergeStrategy === 'tip') {
    await git(workspace, ['checkout', '-B', headBranch, upstreamSha])
  } else {
    await git(workspace, ['checkout', '-B', headBranch, targetSha])
    try {
      // Fast-forwards when possible, otherwise creates a merge commit with our message.
      await git(workspace, ['merge', '--no-edit', '-m', mergeMessage, upstreamSha])
    } catch {
      // Conflicting (or impossible) merge: fall back to pointing the head branch at
      // upstream's tip so the pull request surfaces the conflicts for manual resolution.
      await git(workspace, ['merge', '--abort']).catch(() => undefined)
      await git(workspace, ['checkout', '-B', headBranch, upstreamSha])
      status = 'conflicts'
    }
  }

  const headSha = (await git(workspace, ['rev-parse', 'HEAD'])).trim()
  const commitCount = parseInt(
    (await git(workspace, ['rev-list', '--count', `${targetSha}..${headSha}`])).trim(),
    10
  )
  const commits = await listCommits(workspace, targetSha, headSha)

  let pushed = false
  if (push) {
    // The head branch is owned by this action; force-push keeps re-runs idempotent.
    await git(workspace, ['push', '--force', 'origin', `refs/heads/${headBranch}:refs/heads/${headBranch}`])
    pushed = true
  }

  return { status, targetSha, upstreamSha, headSha, commitCount, commits, pushed }
}
