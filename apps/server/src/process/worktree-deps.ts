import fs from 'node:fs'
import path from 'node:path'

export interface PnpmWorktreeDepsResult {
  linkedRootNodeModules: boolean
  linkedPackageNodeModules: string[]
  gitExcludeUpdated: boolean
  skipped: string[]
}

export function pnpmLeanWorktreeEnv(): Record<string, string> {
  return {
    pnpm_config_verify_deps_before_run: 'false',
    npm_config_verify_deps_before_run: 'false',
  }
}

export function initializePnpmWorktreeDeps(opts: {
  repoRoot: string
  worktreeRoot: string
}): PnpmWorktreeDepsResult {
  const repoRoot = path.resolve(opts.repoRoot)
  const worktreeRoot = path.resolve(opts.worktreeRoot)
  const result: PnpmWorktreeDepsResult = {
    linkedRootNodeModules: false,
    linkedPackageNodeModules: [],
    gitExcludeUpdated: false,
    skipped: [],
  }

  linkIfMissing(path.join(repoRoot, 'node_modules'), path.join(worktreeRoot, 'node_modules'), result)

  for (const rel of discoverPackageNodeModules(repoRoot)) {
    const src = path.join(repoRoot, rel)
    const dest = path.join(worktreeRoot, rel)
    if (fs.existsSync(dest)) {
      result.skipped.push(rel)
      continue
    }
    mirrorNodeModulesDir(src, dest, repoRoot, worktreeRoot)
    result.linkedPackageNodeModules.push(rel)
  }

  ensureGitExclude(worktreeRoot, result)

  return result
}

function discoverPackageNodeModules(repoRoot: string): string[] {
  const roots = ['apps', 'packages']
  const dirs: string[] = []
  for (const root of roots) {
    const absRoot = path.join(repoRoot, root)
    if (!fs.existsSync(absRoot)) continue
    for (const name of fs.readdirSync(absRoot)) {
      const rel = path.join(root, name, 'node_modules')
      if (fs.existsSync(path.join(repoRoot, rel))) dirs.push(rel)
    }
  }
  return dirs
}

function linkIfMissing(src: string, dest: string, result: PnpmWorktreeDepsResult): void {
  if (!fs.existsSync(src)) {
    result.skipped.push(path.relative(path.dirname(dest), dest))
    return
  }
  if (fs.existsSync(dest)) {
    result.skipped.push(path.relative(path.dirname(dest), dest))
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.symlinkSync(src, dest, 'dir')
  result.linkedRootNodeModules = true
}

function mirrorNodeModulesDir(srcDir: string, destDir: string, repoRoot: string, worktreeRoot: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.vite' || entry.name === '.vite-temp') continue
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      mirrorNodeModulesDir(src, dest, repoRoot, worktreeRoot)
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(src)
      const resolved = path.resolve(path.dirname(src), target)
      const rewritten = rewriteWorkspaceTarget(resolved, repoRoot, worktreeRoot)
      const linkTarget = rewritten ?? target
      fs.symlinkSync(linkTarget, dest, 'dir')
      continue
    }
    if (entry.isDirectory()) {
      fs.symlinkSync(src, dest, 'dir')
    } else {
      fs.symlinkSync(src, dest, 'file')
    }
  }
}

function rewriteWorkspaceTarget(
  resolvedTarget: string,
  repoRoot: string,
  worktreeRoot: string
): string | null {
  const rel = path.relative(repoRoot, resolvedTarget)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!isWorkspaceSourceRel(rel)) return null
  return path.join(worktreeRoot, rel)
}

function isWorkspaceSourceRel(rel: string): boolean {
  const parts = rel.split(path.sep)
  return (
    (parts[0] === 'apps' || parts[0] === 'packages') &&
    parts.length === 2
  )
}

function ensureGitExclude(worktreeRoot: string, result: PnpmWorktreeDepsResult): void {
  const gitExcludePath = resolveGitExcludePath(worktreeRoot)
  if (!gitExcludePath) {
    result.skipped.push('.git/info/exclude')
    return
  }

  const marker = '# agent-team lean worktree dependency links'
  const block = [
    '',
    marker,
    'node_modules',
    'apps/*/node_modules',
    'packages/*/node_modules',
    '.pnpm-store',
    'dist',
    'apps/*/dist',
    'packages/*/dist',
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(gitExcludePath), { recursive: true })
  const current = fs.existsSync(gitExcludePath) ? fs.readFileSync(gitExcludePath, 'utf-8') : ''
  if (current.includes(marker)) return
  fs.appendFileSync(gitExcludePath, block)
  result.gitExcludeUpdated = true
}

function resolveGitExcludePath(worktreeRoot: string): string | null {
  const dotGit = path.join(worktreeRoot, '.git')
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory()) {
    return path.join(dotGit, 'info', 'exclude')
  }

  if (!fs.existsSync(dotGit)) return null

  const gitFile = fs.readFileSync(dotGit, 'utf-8')
  const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile)
  if (!match) return null

  const gitDir = match[1]!
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreeRoot, gitDir), 'info', 'exclude')
}
