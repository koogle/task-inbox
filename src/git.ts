import { execFile } from 'child_process';

export function git(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

export interface Remote {
  name: string;
  owner: string;
  repo: string;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function githubRemotes(cwd: string): Promise<Remote[]> {
  const out = await git(cwd, ['remote', '-v']);
  const remotes = new Map<string, Remote>();
  for (const line of out.split('\n')) {
    // Host is github.com or an ssh alias containing "github" (e.g. git@github-work:owner/repo.git).
    const m = /^(\S+)\s+(?:\w+:\/\/)?(?:[^@\/\s]+@)?[\w.-]*github[\w.-]*(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s/i.exec(line);
    if (m && !remotes.has(m[1])) {
      remotes.set(m[1], { name: m[1], owner: m[2], repo: m[3] });
    }
  }
  return [...remotes.values()];
}

export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  try {
    await git(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Fetch the PR head into the local object store (no branch is created or checked out). */
export async function fetchPr(cwd: string, remote: string, number: number): Promise<void> {
  await git(cwd, ['fetch', '--no-tags', '--quiet', remote, `pull/${number}/head`], 60000);
}

export async function headSha(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return undefined;
  }
}

export interface Worktree {
  path: string;
  head: string;
  /** Short branch name; undefined when detached. */
  branch?: string;
  /** The repository's main working tree (cannot be removed). */
  isMain: boolean;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const result: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const wt: Partial<Worktree> = {};
    let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        wt.path = line.slice(9);
      } else if (line.startsWith('HEAD ')) {
        wt.head = line.slice(5);
      } else if (line.startsWith('branch refs/heads/')) {
        wt.branch = line.slice(18);
      } else if (line === 'bare') {
        bare = true;
      }
    }
    if (wt.path && wt.head && !bare) {
      result.push({ path: wt.path, head: wt.head, branch: wt.branch, isMain: result.length === 0 });
    }
  }
  return result;
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Commits only in `local` (ahead) and only in `remote` (behind). */
export async function aheadBehind(cwd: string, local: string, remote: string): Promise<{ ahead: number; behind: number }> {
  const [ahead, behind] = (await git(cwd, ['rev-list', '--left-right', '--count', `${local}...${remote}`]))
    .trim()
    .split(/\s+/)
    .map(Number);
  return { ahead, behind };
}

export function show(cwd: string, sha: string, path: string): Promise<string> {
  return git(cwd, ['show', `${sha}:${path}`]);
}
