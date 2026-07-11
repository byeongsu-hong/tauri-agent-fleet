import { createHash } from 'node:crypto'
import { access, lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { output, runCommand } from './command.ts'
import { privateDir } from './storage.ts'
import type { Revision, RuntimeVariant } from './types.ts'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export async function dirtyFingerprint(worktree: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await output(['git', 'diff', '--binary', 'HEAD'], worktree))
  const untracked = (await output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], worktree)).split('\0').filter(Boolean).sort()
  for (const path of untracked) {
    const full = join(worktree, path)
    const stat = await lstat(full)
    hash.update(path).update('\0')
    if (stat.isFile()) hash.update(await readFile(full))
    else if (stat.isSymbolicLink()) hash.update(await readlink(full))
  }
  return hash.digest('hex')
}

function parseWorktrees(raw: string): Array<{ path: string; branch?: string; commit: string }> {
  return raw.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const values = Object.fromEntries(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]))
    return {
      path: values.worktree!,
      commit: values.HEAD!,
      ...(values.branch ? { branch: values.branch.replace('refs/heads/', '') } : {})
    }
  })
}

export async function discoverRevision(repository: string, selector: string | undefined, stateRoot: string): Promise<Revision> {
  const repo = await realpath(resolve(repository))
  const common = await realpath(await output(['git', 'rev-parse', '--show-toplevel'], repo))
  const worktrees = parseWorktrees(await output(['git', 'worktree', 'list', '--porcelain'], common))
    .map((item) => ({ ...item, path: resolve(item.path) }))
  let worktree = common
  let branch: string | undefined
  const requestedPath = selector ? resolve(selector) : undefined
  if (requestedPath && await exists(requestedPath)) {
    worktree = await realpath(requestedPath)
    const match = worktrees.find((item) => item.path === worktree)
    if (!match) throw new Error(`revision path is not a registered worktree of this repository: ${worktree}`)
    branch = match.branch
  } else if (selector && selector !== 'HEAD') {
    const wanted = await output(['git', 'rev-parse', selector], common)
    const match = worktrees.find((item) => item.branch === selector || item.commit === wanted)
    if (match) {
      worktree = match.path
      branch = match.branch
    } else {
      const repoKey = createHash('sha256').update(common).digest('hex').slice(0, 8)
      const managed = join(stateRoot, 'worktrees', `${basename(common)}-${repoKey}-${wanted.slice(0, 12)}`)
      await privateDir(join(stateRoot, 'worktrees'))
      if (!await exists(managed)) await runCommand(['git', 'worktree', 'add', '--detach', managed, wanted], { cwd: common })
      worktree = managed
    }
  }
  const commit = await output(['git', 'rev-parse', 'HEAD'], worktree)
  branch ??= (await output(['git', 'branch', '--show-current'], worktree)) || undefined
  let identity: string
  try { identity = await output(['git', 'remote', 'get-url', 'origin'], common) } catch { identity = common }
  return {
    repository: createHash('sha256').update(identity).digest('hex'),
    worktree,
    ...(branch ? { branch } : {}),
    commit,
    dirtyFingerprint: await dirtyFingerprint(worktree)
  }
}

export function artifactKey(revision: Revision, variant: RuntimeVariant): string {
  return createHash('sha256')
    .update([revision.repository, revision.commit, revision.dirtyFingerprint, variant].join('\0'))
    .digest('hex')
}
