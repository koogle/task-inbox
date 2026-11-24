import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { branchExists, fetchPr, git, listWorktrees, Worktree } from './git';
import { PullRequest } from './github';
import type { PrEntry } from './inbox';

/** Local branch a PR is checked out as. Fork PRs get `pr-N` to avoid clashing with local names. */
export function localBranch(pr: PullRequest): string {
  return pr.isCrossRepository ? `pr-${pr.number}` : pr.headRefName;
}

/** The working tree (possibly the main checkout) that has the PR's branch checked out. */
export function findWorktree(worktrees: Worktree[], pr: PullRequest): Worktree | undefined {
  const branch = localBranch(pr);
  return worktrees.find(w => w.branch === branch);
}

function worktreeDir(entry: PrEntry, mainRoot: string): string {
  const { ctx, pr } = entry;
  let base = vscode.workspace.getConfiguration('taskInbox').get<string>('worktreeDir', '').trim();
  if (base.startsWith('~')) {
    base = path.join(os.homedir(), base.slice(1));
  }
  return base
    ? path.join(base, ctx.repo, `pr-${pr.number}`)
    : path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}.worktrees`, `pr-${pr.number}`);
}

/** Return the working tree for a PR, creating a git worktree on its branch if none exists. */
export async function ensureWorktree(entry: PrEntry): Promise<Worktree> {
  const { ctx, pr } = entry;
  const worktrees = await listWorktrees(ctx.root);
  const existing = findWorktree(worktrees, pr);
  if (existing) {
    return existing;
  }
  const branch = localBranch(pr);
  // Place new worktrees next to the main checkout, even when this window is itself a worktree.
  const dir = worktreeDir(entry, worktrees[0]?.path ?? ctx.root);
  if (await branchExists(ctx.root, branch)) {
    await fetchPr(ctx.root, ctx.remote, pr.number).catch(() => undefined);
    await git(ctx.root, ['worktree', 'add', dir, branch], 120000);
  } else if (pr.isCrossRepository) {
    const ref = `refs/remotes/${ctx.remote}/pr/${pr.number}`;
    await git(ctx.root, ['fetch', '--no-tags', '--quiet', ctx.remote, `+pull/${pr.number}/head:${ref}`], 60000);
    await git(ctx.root, ['worktree', 'add', '--no-track', '-b', branch, dir, ref], 120000);
  } else {
    const ref = `refs/remotes/${ctx.remote}/${pr.headRefName}`;
    await git(ctx.root, ['fetch', '--no-tags', '--quiet', ctx.remote, `+refs/heads/${pr.headRefName}:${ref}`], 60000);
    await git(ctx.root, ['worktree', 'add', '--track', '-b', branch, dir, `${ctx.remote}/${pr.headRefName}`], 120000);
  }
  const created = findWorktree(await listWorktrees(ctx.root), pr);
  if (!created) {
    throw new Error(`Worktree for #${pr.number} was not created`);
  }
  return created;
}

/** Fast-forward a working tree to the PR head. Fails (without changing anything) if it has diverged. */
export async function syncWorktree(entry: PrEntry, wt: Worktree): Promise<void> {
  const { ctx, pr } = entry;
  await fetchPr(ctx.root, ctx.remote, pr.number);
  await git(wt.path, ['merge', '--ff-only', pr.headRefOid], 60000);
}

/** Remove a PR worktree. Git refuses if it has uncommitted changes or is the main checkout. */
export async function removeWorktree(entry: PrEntry, wt: Worktree): Promise<void> {
  await git(entry.ctx.root, ['worktree', 'remove', wt.path], 60000);
}
