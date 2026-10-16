#!/usr/bin/env node
/**
 * Local end-to-end test for the fork-sync action.
 *
 * Spins up two bare git repositories (an "upstream" and a "fork") under a temp
 * directory, exposes them over file:// remotes, and runs the built action
 * (dist/index.js) exactly the way the GitHub Actions runner would: inputs come
 * from INPUT_* environment variables, outputs are read back from the
 * GITHUB_OUTPUT file. No network access and no GitHub API calls happen, because
 * every branch input is pinned and skip-pr is on.
 *
 * Usage: npm test   (builds first)
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ACTION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'fork-sync-test-'))
const SERVER = path.join(ROOT, 'server')
const UPSTREAM = path.join(SERVER, 'acme', 'parent.git')
const FORK = path.join(SERVER, 'rui', 'fork.git')
const SERVER_URL = `file://${SERVER}`

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim()
}

function commitFile(cwd, name, content, message) {
  writeFileSync(path.join(cwd, name), `${content}\n`)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-m', message)
}

// ---------------------------------------------------------------------------
// Fixture: upstream repo A ("acme/parent")
// ---------------------------------------------------------------------------
mkdirSync(UPSTREAM, { recursive: true })
git(UPSTREAM, 'init', '--bare', '-b', 'main')

const seed = path.join(ROOT, 'seed')
mkdirSync(seed)
git(seed, 'init', '-b', 'main')
git(seed, 'remote', 'add', 'origin', `file://${UPSTREAM}`)
commitFile(seed, 'README.md', '# hello', 'c1: initial commit')
git(seed, 'push', '-q', 'origin', 'main')

// ---------------------------------------------------------------------------
// Fixture: fork B ("rui/fork") — shares history with A, then diverges
// ---------------------------------------------------------------------------
git(ROOT, 'clone', '-q', '--bare', `file://${UPSTREAM}`, FORK)

const forkWork = path.join(ROOT, 'fork-work')
git(ROOT, 'clone', '-q', `file://${FORK}`, forkWork)
commitFile(forkWork, 'fork.txt', 'fork-only change', 'f1: fork-only commit')
git(forkWork, 'push', '-q', 'origin', 'main')

// upstream moves ahead of the fork
commitFile(seed, 'feature.txt', 'upstream work', 'u1: upstream commit')
git(seed, 'push', '-q', 'origin', 'main')

// ---------------------------------------------------------------------------
// Harness: run dist/index.js the way the runner would
// ---------------------------------------------------------------------------
const OUTPUT_FILE = path.join(ROOT, 'github-output.txt')
const SUMMARY_FILE = path.join(ROOT, 'summary.md')
const RUNNER_TEMP = path.join(ROOT, 'runner-temp')
mkdirSync(RUNNER_TEMP, { recursive: true })

function runAction(overrides = {}) {
  writeFileSync(OUTPUT_FILE, '')
  writeFileSync(SUMMARY_FILE, '')
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'rui/fork',
    GITHUB_SERVER_URL: SERVER_URL,
    GITHUB_OUTPUT: OUTPUT_FILE,
    GITHUB_STEP_SUMMARY: SUMMARY_FILE,
    RUNNER_TEMP: RUNNER_TEMP,
    INPUT_TOKEN: 'local-test-token',
    'INPUT_UPSTREAM-REPO': 'acme/parent',
    'INPUT_UPSTREAM-BRANCH': 'main',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_MERGE-STRATEGY': 'merge',
    'INPUT_DRY-RUN': 'false',
    'INPUT_SKIP-PR': 'false',
    'INPUT_FAIL-ON-CONFLICT': 'false',
    ...overrides,
  }
  let exitCode = 0
  let output = ''
  try {
    output = execFileSync('node', [path.join(ACTION_DIR, 'dist', 'index.js')], {
      cwd: ACTION_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  } catch (error) {
    exitCode = error.status ?? 1
    output = `${error.stdout?.toString() ?? ''}${error.stderr?.toString() ?? ''}`
  }
  const outputs = parseOutputFile(OUTPUT_FILE)
  return { exitCode, output, outputs }
}

/** Parses the GITHUB_OUTPUT file, which @actions/core writes in heredoc format. */
function parseOutputFile(file) {
  const outputs = {}
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^(.+?)<<(.+)$/)
    if (heredoc) {
      const [, key, delimiter] = heredoc
      const value = []
      i += 1
      while (i < lines.length && lines[i] !== delimiter) {
        value.push(lines[i])
        i += 1
      }
      outputs[key] = value.join('\n')
    } else {
      const eq = lines[i].indexOf('=')
      if (eq > 0) outputs[lines[i].slice(0, eq)] = lines[i].slice(eq + 1)
    }
  }
  return outputs
}

// --- 1. diverged fork, default merge strategy --------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 1 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'synced')
  assert.equal(r.outputs['commit-count'], '2') // u1 + the merge commit
  assert.equal(r.outputs.pushed, 'true')
  assert.equal(r.outputs['pull-request-url'], '')
  const parents = git(FORK, 'show', '-s', '--format=%P', 'refs/heads/sync/upstream-main')
    .trim()
    .split(/\s+/)
  assert.equal(parents.length, 2, 'head branch should be a merge commit with two parents')
  assert.equal(r.outputs['target-sha'], git(FORK, 'rev-parse', 'refs/heads/main'), 'fork main must stay untouched')
  console.log('ok  1 - diverged fork: merge strategy creates and pushes a merge commit')
}

// --- 2. fork already contains upstream -> up-to-date --------------------------
{
  git(forkWork, 'fetch', '-q', 'origin')
  git(forkWork, 'merge', '-q', '--no-edit', 'origin/sync/upstream-main')
  git(forkWork, 'push', '-q', 'origin', 'main')
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 2 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'up-to-date')
  assert.equal(r.outputs.pushed, 'false')
  console.log('ok  2 - fork already contains upstream: reports up-to-date, pushes nothing')
}

// --- 3. conflicting merge -> head falls back to upstream tip ------------------
{
  commitFile(forkWork, 'conflict.txt', 'fork version', 'f2: fork edits conflict.txt')
  git(forkWork, 'push', '-q', 'origin', 'main')
  commitFile(seed, 'conflict.txt', 'upstream version', 'u2: upstream edits conflict.txt')
  git(seed, 'push', '-q', 'origin', 'main')

  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 3 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'conflicts')
  assert.equal(r.outputs['head-sha'], git(UPSTREAM, 'rev-parse', 'refs/heads/main'), 'head should be upstream tip')
  console.log('ok  3 - conflicting merge: head branch falls back to upstream tip')
}

// --- 3b. fail-on-conflict: true ------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_FAIL-ON-CONFLICT': 'true' })
  assert.equal(r.exitCode, 1, 'scenario 3b should fail')
  assert.ok(r.output.toLowerCase().includes('conflict'), 'failure should mention the conflict')
  console.log('ok  3b - fail-on-conflict: true fails the run')
}

// --- 4. merge-strategy: tip ----------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_MERGE-STRATEGY': 'tip' })
  assert.equal(r.exitCode, 0, `scenario 4 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'synced')
  assert.equal(r.outputs['head-sha'], git(UPSTREAM, 'rev-parse', 'refs/heads/main'))
  console.log('ok  4 - merge-strategy: tip points head at upstream tip')
}

// --- 5. dry-run pushes nothing --------------------------------------------------
{
  commitFile(seed, 'more.txt', 'more upstream work', 'u3: another upstream commit')
  git(seed, 'push', '-q', 'origin', 'main')
  const before = git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main')
  const r = runAction({ 'INPUT_DRY-RUN': 'true' })
  assert.equal(r.exitCode, 0, `scenario 5 should succeed\n${r.output}`)
  assert.equal(r.outputs.pushed, 'false')
  assert.equal(git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main'), before, 'dry-run must not touch the remote')
  console.log('ok  5 - dry-run leaves the fork untouched')
}

// --- 6. custom head branch ------------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_HEAD-BRANCH': 'custom/sync-branch' })
  assert.equal(r.exitCode, 0, `scenario 6 should succeed\n${r.output}`)
  assert.equal(r.outputs['head-sha'], git(FORK, 'rev-parse', 'refs/heads/custom/sync-branch'))
  console.log('ok  6 - custom head-branch is pushed')
}

rmSync(ROOT, { recursive: true, force: true })
console.log('\nAll local scenarios passed.')
