import * as path from 'path';
import * as vscode from 'vscode';
import { fetchPr, git, hasCommit, show } from './git';
import { ChangedFile, fetchFile } from './github';
import { Inbox, PrEntry } from './inbox';
import { ensureWorktree } from './worktree';

export const SCHEME = 'taskinbox';

interface Ref {
  owner: string;
  repo: string;
  root: string;
  /** Empty sha means "file does not exist on this side". */
  sha: string;
}

function contentUri(entry: PrEntry, sha: string, file: string): vscode.Uri {
  const ref: Ref = { owner: entry.pr.owner, repo: entry.pr.repo, root: entry.ctx.root, sha };
  return vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: JSON.stringify(ref) });
}

/** Serves file contents at a commit: from the local git object store, falling back to the GitHub API. */
export class PrContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = JSON.parse(uri.query) as Ref;
    const file = uri.path.slice(1);
    if (!ref.sha) {
      return '';
    }
    try {
      return await show(ref.root, ref.sha, file);
    } catch {
      try {
        return await fetchFile(ref.owner, ref.repo, ref.sha, file);
      } catch {
        return '';
      }
    }
  }
}

/** Make sure the PR head (and with it the merge base) is in the local object store. */
async function ensureLocal(entry: PrEntry): Promise<void> {
  const { pr, ctx } = entry;
  if (await hasCommit(ctx.root, pr.headRefOid)) {
    return;
  }
  try {
    await fetchPr(ctx.root, ctx.remote, pr.number);
  } catch (err) {
    console.warn('[task-inbox] git fetch failed, falling back to the GitHub API', err);
  }
}

/**
 * Directory whose real files form the right side of the diff: the PR's worktree (created on demand
 * when `taskInbox.diffInWorktree` is on) or a checkout that already has the branch. Undefined means
 * "no local files; show the PR head read-only".
 */
async function workdir(entry: PrEntry): Promise<string | undefined> {
  await ensureLocal(entry);
  const useWorktrees = vscode.workspace.getConfiguration('taskInbox').get<boolean>('diffInWorktree', true);
  if (!useWorktrees) {
    return entry.worktree && !entry.stale ? entry.worktree.path : undefined;
  }
  try {
    const wt = await ensureWorktree(entry);
    entry.worktree = wt;
    if (wt.head !== entry.pr.headRefOid && !wt.isMain) {
      // Pick up new commits when it is a clean fast-forward; otherwise leave the worktree alone.
      await git(wt.path, ['merge', '--ff-only', entry.pr.headRefOid], 60000).catch(() => undefined);
    }
    return wt.path;
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Task Inbox: could not create a worktree for #${entry.pr.number}, showing a read-only diff. ${(err as Error).message}`,
    );
    return undefined;
  }
}

function sides(entry: PrEntry, file: ChangedFile, base: string, dir: string | undefined) {
  const local = vscode.Uri.file(path.join(dir ?? entry.ctx.root, file.filename));
  const left = contentUri(entry, file.status === 'added' ? '' : base, file.previous_filename ?? file.filename);
  const right =
    file.status === 'removed'
      ? contentUri(entry, '', file.filename)
      : dir
        ? local
        : contentUri(entry, entry.pr.headRefOid, file.filename);
  return { local, left, right };
}

const inView = { location: { viewId: 'taskInbox.prs' } };

export async function openAllChanges(inbox: Inbox, entry: PrEntry): Promise<void> {
  await vscode.window.withProgress(inView, async () => {
    const [{ base, files }, dir] = await Promise.all([inbox.getChanges(entry), workdir(entry)]);
    if (!files.length) {
      void vscode.window.showInformationMessage(`#${entry.pr.number} has no changed files.`);
      return;
    }
    const resources = files.map(f => {
      const s = sides(entry, f, base, dir);
      return [s.local, s.left, s.right];
    });
    await vscode.commands.executeCommand('vscode.changes', `#${entry.pr.number} ${entry.pr.title}`, resources);
  });
}

export async function openFileDiff(entry: PrEntry, file: ChangedFile, base: string): Promise<void> {
  await vscode.window.withProgress(inView, async () => {
    const { left, right } = sides(entry, file, base, await workdir(entry));
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.posix.basename(file.filename)} (#${entry.pr.number})`,
      { preview: true },
    );
  });
}
