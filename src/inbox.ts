import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BotConfig, detectBots } from './bots';
import { aheadBehind, fetchPr, githubRemotes, hasCommit, listWorktrees, repoRoot, Worktree } from './git';
import { ChangedFile, fetchChanges, fetchMyPrs, hasAuth, PullRequest } from './github';
import { log } from './log';
import { findWorktree } from './worktree';

export interface RepoCtx {
  /** Local repository root. */
  root: string;
  /** Name of the git remote pointing at owner/repo. */
  remote: string;
  owner: string;
  repo: string;
}

export interface PrEntry {
  pr: PullRequest;
  ctx: RepoCtx;
  bots: BotConfig[];
  /** Working tree that has the PR branch checked out, if any. */
  worktree?: Worktree;
  /** Working tree HEAD differs from the PR head on GitHub. */
  stale: boolean;
  /** Commits the working tree is ahead of / behind the PR head; undefined if unknown. */
  drift?: { ahead: number; behind: number };
  /** Comments and reviews by others since the PR was last read. */
  unread: number;
  unreadFrom?: string;
  /** The PR head moved since the diff was last opened. */
  newCommits: boolean;
}

export interface Changes {
  base: string;
  files: ChangedFile[];
}

export type Node = { kind: 'pr'; entry: PrEntry } | { kind: 'file'; entry: PrEntry; file: ChangedFile; base: string };

type State = 'loading' | 'ok' | 'signedOut' | 'noRepo' | 'empty' | 'error';
type Seen = Record<string, { at: string; head: string }>;

const SEEN_KEY = 'taskInbox.seen';
const keyOf = (pr: PullRequest) => `${pr.owner}/${pr.repo}#${pr.number}`;
const lastOther = (pr: PullRequest) => pr.othersActivity.at(-1)?.at ?? '';

export const needsAttention = (e: PrEntry) => e.unread > 0 || e.newCommits || (e.drift?.behind ?? 0) > 0;

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out']);

/**
 * Git checkouts at or below `dir`, down to `depth` levels. Does not descend into a checkout.
 * `main` is false for linked worktrees and submodules (their `.git` is a file).
 */
async function findCheckouts(dir: string, depth: number, found: { root: string; main: boolean }[]): Promise<void> {
  const dotGit = await fs.promises.stat(path.join(dir, '.git')).catch(() => undefined);
  if (dotGit) {
    found.push({ root: dir, main: dotGit.isDirectory() });
    return;
  }
  if (depth <= 0) {
    return;
  }
  const children = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    children
      .filter(c => c.isDirectory() && !c.name.startsWith('.') && !SKIP_DIRS.has(c.name))
      .map(c => findCheckouts(path.join(dir, c.name), depth - 1, found)),
  );
}

async function discoverRepos(): Promise<RepoCtx[]> {
  const depth = vscode.workspace.getConfiguration('taskInbox').get<number>('repoScanDepth', 3);
  const checkouts: { root: string; main: boolean }[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const before = checkouts.length;
    await findCheckouts(folder.uri.fsPath, depth, checkouts);
    if (checkouts.length === before) {
      // The folder may itself sit inside a checkout.
      const root = await repoRoot(folder.uri.fsPath).catch(() => undefined);
      if (root) {
        checkouts.push({ root, main: true });
      }
    }
  }
  // Main checkouts win over linked worktrees of the same repository; otherwise keep a stable order.
  checkouts.sort((a, b) => Number(b.main) - Number(a.main) || a.root.localeCompare(b.root));
  const repos = new Map<string, RepoCtx>();
  await Promise.all(
    checkouts.map(async ({ root }) => ({ root, remotes: await githubRemotes(root).catch(() => []) })),
  ).then(all => {
    for (const { root, remotes } of all) {
      for (const r of remotes) {
        const key = `${r.owner}/${r.repo}`.toLowerCase();
        if (!repos.has(key)) {
          repos.set(key, { root, remote: r.name, owner: r.owner, repo: r.repo });
        }
      }
    }
  });
  log(`Scanned ${vscode.workspace.workspaceFolders?.length ?? 0} workspace folder(s) to depth ${depth}: ${checkouts.length} git checkout(s), ${repos.size} GitHub repo(s)`);
  for (const r of repos.values()) {
    log(`  ${r.owner}/${r.repo}  ←  ${r.root} (${r.remote})`);
  }
  return [...repos.values()];
}

export class Inbox implements vscode.TreeDataProvider<Node> {
  entries: PrEntry[] = [];
  private multiRepo = false;
  private inFlight?: Promise<void>;
  private changes = new Map<string, Promise<Changes>>();
  private notified = new Map<string, string>();
  private primed = false;

  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly loaded = new vscode.EventEmitter<void>();
  readonly onDidLoad = this.loaded.event;
  private readonly news = new vscode.EventEmitter<PrEntry[]>();
  /** Fires with PRs that got new comments or commits since the previous refresh. */
  readonly onDidGetNews = this.news.event;

  constructor(private readonly memento: vscode.Memento) {}

  refresh(interactive = false): Promise<void> {
    this.inFlight ??= this.load(interactive).finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private setState(state: State): void {
    void vscode.commands.executeCommand('setContext', 'taskInbox.state', state);
  }

  private async load(interactive: boolean): Promise<void> {
    try {
      if (!(await hasAuth())) {
        this.entries = [];
        this.setState('signedOut');
        return;
      }
      const repos = await discoverRepos();
      if (!repos.length) {
        this.entries = [];
        this.setState('noRepo');
        return;
      }
      this.multiRepo = repos.length > 1;
      const seen: Seen = { ...this.memento.get<Seen>(SEEN_KEY, {}) };
      const mine = await fetchMyPrs();
      const byRepo = new Map<string, PullRequest[]>();
      for (const pr of mine) {
        const key = `${pr.owner}/${pr.repo}`.toLowerCase();
        byRepo.set(key, [...(byRepo.get(key) ?? []), pr]);
      }
      const local = new Set(repos.map(r => `${r.owner}/${r.repo}`.toLowerCase()));
      const elsewhere = [...byRepo.keys()].filter(k => !local.has(k));
      log(`${mine.length} open PR(s) by you on GitHub; ${mine.length - elsewhere.reduce((n, k) => n + byRepo.get(k)!.length, 0)} in repositories found locally`);
      if (elsewhere.length) {
        log(`  no local checkout found for: ${elsewhere.join(', ')}`);
      }
      const perRepo = await Promise.all(
        repos.map(async ctx => {
          const key = `${ctx.owner}/${ctx.repo}`.toLowerCase();
          if (!byRepo.has(key)) {
            // No open PRs here: drop stale read-state and skip the git work.
            for (const k of Object.keys(seen)) {
              if (k.toLowerCase().startsWith(`${key}#`)) {
                delete seen[k];
              }
            }
            return [];
          }
          // Use the casing of the local remote so keys stay stable.
          const prs = byRepo.get(key)!.map(pr => ({ ...pr, owner: ctx.owner, repo: ctx.repo }));
          const worktrees = await listWorktrees(ctx.root).catch(() => [] as Worktree[]);
          // Forget read-state of PRs that are no longer open.
          const open = new Set(prs.map(keyOf));
          const prefix = `${ctx.owner}/${ctx.repo}#`;
          for (const k of Object.keys(seen)) {
            if (k.startsWith(prefix) && !open.has(k)) {
              delete seen[k];
            }
          }
          return Promise.all(prs.map(pr => this.entry(pr, ctx, worktrees, seen)));
        }),
      );
      this.entries = perRepo.flat().sort((a, b) => b.pr.updatedAt.localeCompare(a.pr.updatedAt));
      await this.memento.update(SEEN_KEY, seen);
      this.setState(this.entries.length ? 'ok' : 'empty');
      this.announce();
    } catch (err) {
      if (!this.entries.length) {
        this.setState('error');
      }
      if (interactive) {
        void vscode.window.showErrorMessage(`Task Inbox: ${(err as Error).message}`);
      }
      log(`Refresh failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.changed.fire(undefined);
      this.loaded.fire();
    }
  }

  private async entry(pr: PullRequest, ctx: RepoCtx, worktrees: Worktree[], seen: Seen): Promise<PrEntry> {
    const worktree = findWorktree(worktrees, pr);
    const stale = !!worktree && worktree.head !== pr.headRefOid;
    let drift: PrEntry['drift'];
    if (worktree && stale) {
      if (!(await hasCommit(ctx.root, pr.headRefOid))) {
        await fetchPr(ctx.root, ctx.remote, pr.number).catch(() => undefined);
      }
      drift = await aheadBehind(ctx.root, worktree.head, pr.headRefOid).catch(() => undefined);
    }
    // First sighting of a PR is the baseline: only activity after it counts as new.
    const mark = (seen[keyOf(pr)] ??= { at: lastOther(pr), head: pr.headRefOid });
    const unread = pr.othersActivity.filter(a => a.at > mark.at);
    return {
      pr,
      ctx,
      bots: detectBots(pr),
      worktree,
      stale,
      drift,
      unread: unread.length,
      unreadFrom: unread.at(-1)?.login,
      newCommits: mark.head !== pr.headRefOid,
    };
  }

  private announce(): void {
    const fresh: PrEntry[] = [];
    for (const e of this.entries) {
      if (!e.unread && !e.newCommits) {
        continue;
      }
      const signature = `${lastOther(e.pr)}|${e.pr.headRefOid}`;
      if (this.notified.get(keyOf(e.pr)) !== signature) {
        this.notified.set(keyOf(e.pr), signature);
        if (this.primed) {
          fresh.push(e);
        }
      }
    }
    this.primed = true;
    if (fresh.length) {
      this.news.fire(fresh);
    }
  }

  /** Mark a PR's comments and/or commits as seen. */
  async markSeen(entry: PrEntry, what: { comments?: boolean; commits?: boolean }): Promise<void> {
    const seen: Seen = { ...this.memento.get<Seen>(SEEN_KEY, {}) };
    const mark = { ...(seen[keyOf(entry.pr)] ?? { at: '', head: '' }) };
    if (what.comments) {
      mark.at = lastOther(entry.pr);
      entry.unread = 0;
      entry.unreadFrom = undefined;
    }
    if (what.commits) {
      mark.head = entry.pr.headRefOid;
      entry.newCommits = false;
    }
    seen[keyOf(entry.pr)] = mark;
    await this.memento.update(SEEN_KEY, seen);
    this.changed.fire(undefined);
    this.loaded.fire();
  }

  /** Changed files and merge base of a PR; cached per head commit. */
  getChanges(entry: PrEntry): Promise<Changes> {
    const { pr } = entry;
    const key = `${keyOf(pr)}@${pr.headRefOid}`;
    let p = this.changes.get(key);
    if (!p) {
      p = fetchChanges(pr);
      p.catch(() => this.changes.delete(key));
      this.changes.set(key, p);
    }
    return p;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.entries.map(entry => ({ kind: 'pr', entry }));
    }
    if (node.kind === 'pr') {
      const { base, files } = await this.getChanges(node.entry);
      return files.map(file => ({ kind: 'file', entry: node.entry, file, base }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'pr' ? this.prItem(node.entry) : this.fileItem(node);
  }

  private prItem(entry: PrEntry): vscode.TreeItem {
    const { pr, bots, worktree, drift } = entry;
    const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = keyOf(pr);
    item.contextValue = worktree ? (worktree.isMain ? 'pr.main' : 'pr.worktree') : 'pr';

    const parts = [`${this.multiRepo ? pr.repo : ''}#${pr.number}`];
    if (entry.unread) {
      parts.push(`💬 ${entry.unread} ${entry.unreadFrom ?? ''}`.trim());
    }
    if (entry.newCommits) {
      parts.push('new commits');
    }
    if (worktree) {
      const arrows = drift
        ? `${drift.behind ? ` ↓${drift.behind}` : ''}${drift.ahead ? ` ↑${drift.ahead}` : ''}`
        : entry.stale
          ? ' ≠'
          : '';
      parts.push(`${worktree.isMain ? 'checked out' : 'worktree'}${arrows}`);
    }
    if (pr.mergeable === 'CONFLICTING') {
      parts.push('conflicts');
    } else if (pr.mergeState === 'BEHIND') {
      parts.push('behind base');
    }
    if (bots.length) {
      parts.push(bots.map(b => b.name).join(', '));
    }
    item.description = parts.join(' · ');

    const color = (id: string) => new vscode.ThemeColor(id);
    switch (pr.checks) {
      case 'SUCCESS':
        item.iconPath = new vscode.ThemeIcon('pass', color('testing.iconPassed'));
        break;
      case 'FAILURE':
      case 'ERROR':
        item.iconPath = new vscode.ThemeIcon('error', color('testing.iconFailed'));
        break;
      case 'PENDING':
      case 'EXPECTED':
        item.iconPath = new vscode.ThemeIcon('sync', color('testing.iconQueued'));
        break;
      default:
        item.iconPath = new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request');
    }

    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${keyOf(pr)}**${pr.isDraft ? ' (draft)' : ''}\n\n`);
    tip.appendText(pr.title);
    tip.appendMarkdown(`\n\n\`${pr.headRefName}\` → \`${pr.baseRefName}\`\n\n`);
    tip.appendMarkdown(`- Checks: ${pr.checks?.toLowerCase() ?? 'none'}\n`);
    tip.appendMarkdown(`- Review: ${pr.reviewDecision?.toLowerCase().replace(/_/g, ' ') ?? 'none'}\n`);
    tip.appendMarkdown(`- Base: ${pr.mergeable === 'CONFLICTING' ? 'conflicts with base' : pr.mergeState === 'BEHIND' ? 'behind base branch' : 'ok'}\n`);
    tip.appendMarkdown(`- Bots: ${bots.length ? bots.map(b => b.name).join(', ') : 'none detected'}\n`);
    if (entry.unread) {
      tip.appendMarkdown(`- ${entry.unread} new comment(s), latest from ${entry.unreadFrom}\n`);
    }
    if (entry.newCommits) {
      tip.appendMarkdown(`- New commits since you last opened the diff\n`);
    }
    if (worktree) {
      const state = drift
        ? `${drift.behind} behind, ${drift.ahead} ahead of the PR on GitHub`
        : entry.stale
          ? 'differs from the PR on GitHub'
          : 'up to date';
      tip.appendMarkdown(`- Local: \`${worktree.path}\` (${state})\n`);
    }
    item.tooltip = tip;

    item.command = { command: 'taskInbox.openDiff', title: 'Open All Changes', arguments: [{ kind: 'pr', entry }] };
    return item;
  }

  private fileItem(node: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
    const { file, entry } = node;
    const item = new vscode.TreeItem(path.posix.basename(file.filename));
    item.resourceUri = vscode.Uri.file(path.join(entry.worktree?.path ?? entry.ctx.root, file.filename));
    const dir = path.posix.dirname(file.filename);
    const status = { added: 'A', removed: 'D', renamed: 'R', copied: 'C' }[file.status] ?? 'M';
    item.description = `${dir === '.' ? '' : `${dir} `}${status} +${file.additions} −${file.deletions}`;
    item.tooltip = file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename;
    item.command = { command: 'taskInbox.openFileDiff', title: 'Open File Diff', arguments: [node] };
    return item;
  }
}
