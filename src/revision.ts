import { createHash } from 'node:crypto'
import { access, lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { output, runCommand } from './command.ts'
import { privateDir } from './storage.ts'
import type { Revision, RuntimeVariant } from './types.ts'

export const CLEAN_FINGERPRINT = createHash('sha256').digest('hex')

export async function resolveInsideWorktree(worktree: string, path: string): Promise<string> {
  const root = await realpath(worktree)
  const target = await realpath(resolve(root, path))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`application root escapes its worktree: ${path}`)
  if (!(await stat(target)).isDirectory()) throw new Error(`application root is not a directory: ${path}`)
  return target
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export async function dirtyFingerprint(worktree: string): Promise<string> {
  const hash = createHash('sha256')
  const tracked = await output(['git', 'diff', '--binary', 'HEAD'], worktree)
  if (tracked) hash.update(String(Buffer.byteLength(tracked))).update('\0').update(tracked)
  const untracked = (await output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], worktree)).split('\0').filter(Boolean).sort()
  for (const path of untracked) {
    const full = join(worktree, path)
    const stat = await lstat(full)
    const kind = stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'
    hash.update(path).update('\0').update(kind).update('\0').update(String(stat.mode & 0o777)).update('\0')
    const content = stat.isFile() ? await readFile(full) : stat.isSymbolicLink() ? await readlink(full) : ''
    hash.update(String(Buffer.byteLength(content))).update('\0').update(content)
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
  const requestedPath = selector ? resolve(repo, selector) : undefined
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
      if (await exists(managed)) {
        const existing = worktrees.find((item) => item.path === managed)
        if (!existing || existing.commit !== wanted) throw new Error(`managed worktree does not match requested revision: ${managed}`)
      } else await runCommand(['git', 'worktree', 'add', '--detach', managed, wanted], { cwd: common })
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
