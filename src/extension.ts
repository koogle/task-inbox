import * as vscode from 'vscode';
import { allBots, BotConfig, withMention } from './bots';
import { Conversations } from './conversation';
import { openAllChanges, openFileDiff, PrContentProvider, SCHEME } from './diff';
import { getSession, postComment, resetAuth } from './github';
import { showLog } from './log';
import { Inbox, needsAttention, Node, PrEntry } from './inbox';
import { ensureWorktree, removeWorktree, syncWorktree } from './worktree';

export function activate(context: vscode.ExtensionContext): void {
  const inbox = new Inbox(context.globalState);
  const view = vscode.window.createTreeView('taskInbox.prs', { treeDataProvider: inbox });
  const conversations = new Conversations(() => void inbox.refresh());

  inbox.onDidLoad(() => {
    const attention = inbox.entries.filter(needsAttention).length;
    view.badge = attention
      ? { value: attention, tooltip: `${attention} of ${inbox.entries.length} PRs have new comments or commits` }
      : undefined;
  });

  inbox.onDidGetNews(async fresh => {
    const describe = (e: PrEntry) =>
      [e.unread ? `${e.unread} new comment${e.unread > 1 ? 's' : ''} from ${e.unreadFrom}` : '', e.newCommits ? 'new commits' : '']
        .filter(Boolean)
        .join(', ');
    if (fresh.length > 1) {
      void vscode.window.showInformationMessage(`Task Inbox: updates on ${fresh.map(e => `#${e.pr.number}`).join(', ')}`);
      return;
    }
    const [entry] = fresh;
    const actions = [...(entry.unread ? ['Open Conversation'] : []), ...(entry.newCommits ? ['Open Changes'] : [])];
    const action = await vscode.window.showInformationMessage(`#${entry.pr.number} ${entry.pr.title}: ${describe(entry)}`, ...actions);
    if (action === 'Open Conversation') {
      await vscode.commands.executeCommand('taskInbox.openConversation', { kind: 'pr', entry });
    } else if (action === 'Open Changes') {
      await vscode.commands.executeCommand('taskInbox.openDiff', { kind: 'pr', entry });
    }
  });

  /** Resolve the PR a command applies to: the tree node it was invoked on, or a quick pick. */
  const pick = async (node?: Node): Promise<PrEntry | undefined> => {
    if (node && 'entry' in node) {
      return node.entry;
    }
    if (!inbox.entries.length) {
      await inbox.refresh(true);
    }
    const choice = await vscode.window.showQuickPick(
      inbox.entries.map(entry => ({
        label: `#${entry.pr.number} ${entry.pr.title}`,
        description: entry.bots.map(b => b.name).join(', '),
        entry,
      })),
      { placeHolder: 'Select a pull request' },
    );
    return choice?.entry;
  };

  const setting = (key: string, value: unknown) =>
    vscode.workspace.getConfiguration('taskInbox').update(key, value, vscode.ConfigurationTarget.Global);

  const run = (fn: (node?: Node) => Promise<unknown>) => async (node?: Node) => {
    try {
      await fn(node);
    } catch (err) {
      void vscode.window.showErrorMessage(`Task Inbox: ${(err as Error).message}`);
    }
  };

  const messageBot = async (entry: PrEntry) => {
    let bot: BotConfig | undefined = entry.bots[0];
    if (entry.bots.length !== 1) {
      const candidates = entry.bots.length ? entry.bots : allBots();
      const choice = await vscode.window.showQuickPick(
        [
          ...candidates.map(b => ({ label: b.name, description: b.mention || 'plain comment', bot: b as BotConfig | undefined })),
          { label: 'Plain comment', description: 'no mention', bot: undefined },
        ],
        { placeHolder: entry.bots.length ? 'Which bot?' : 'No bot detected on this PR — pick one' },
      );
      if (!choice) {
        return;
      }
      bot = choice.bot;
    }
    const text = await vscode.window.showInputBox({
      title: `#${entry.pr.number} ${entry.pr.title}`,
      prompt: `Posts a PR comment${bot ? ` to ${bot.name}` : ''}${bot?.mention ? ` (prefixed with ${bot.mention})` : ''}`,
      placeHolder: 'Message',
      ignoreFocusOut: true,
    });
    if (!text?.trim()) {
      return;
    }
    await postComment(entry.pr, withMention(bot, text.trim()));
    await inbox.markSeen(entry, { comments: true });
    void inbox.refresh();
    const action = await vscode.window.showInformationMessage(`Comment posted on #${entry.pr.number}.`, 'Open Conversation');
    if (action) {
      conversations.open(entry);
    }
  };

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new PrContentProvider()),
    vscode.commands.registerCommand('taskInbox.refresh', () => inbox.refresh(true)),
    vscode.commands.registerCommand('taskInbox.showLog', showLog),
    vscode.commands.registerCommand('taskInbox.sortByUpdated', () => setting('sortBy', 'updated')),
    vscode.commands.registerCommand('taskInbox.sortByNumber', () => setting('sortBy', 'number')),
    vscode.commands.registerCommand('taskInbox.toggleStacks', () =>
      setting('showStacks', !vscode.workspace.getConfiguration('taskInbox').get<boolean>('showStacks', true)),
    ),
    vscode.commands.registerCommand(
      'taskInbox.signIn',
      run(async () => {
        await getSession(true);
        resetAuth();
        await inbox.refresh(true);
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.openDiff',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          await openAllChanges(inbox, entry);
          await inbox.markSeen(entry, { commits: true });
          void inbox.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.openFileDiff',
      run(async node => {
        if (node?.kind === 'file') {
          await openFileDiff(node.entry, node.file, node.base);
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.openConversation',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          conversations.open(entry);
          await inbox.markSeen(entry, { comments: true });
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.markRead',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          await inbox.markSeen(entry, { comments: true, commits: true });
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.openWorktree',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          const wt = await vscode.window.withProgress({ location: { viewId: 'taskInbox.prs' } }, () => ensureWorktree(entry));
          void inbox.refresh();
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.syncWorktree',
      run(async node => {
        const entry = await pick(node);
        if (!entry?.worktree) {
          return;
        }
        try {
          await syncWorktree(entry, entry.worktree);
        } catch (err) {
          throw new Error(
            `Could not fast-forward ${entry.worktree.path} to the PR head (local commits or conflicting changes?). ${(err as Error).message}`,
          );
        } finally {
          await inbox.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.removeWorktree',
      run(async node => {
        const entry = await pick(node);
        if (!entry?.worktree || entry.worktree.isMain) {
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `Remove the worktree at ${entry.worktree.path}? The branch is kept; git refuses if there are uncommitted changes.`,
          { modal: true },
          'Remove',
        );
        if (ok) {
          await removeWorktree(entry, entry.worktree);
          await inbox.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.messageBot',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          await messageBot(entry);
        }
      }),
    ),
    vscode.commands.registerCommand(
      'taskInbox.openInBrowser',
      run(async node => {
        const entry = await pick(node);
        if (entry) {
          await vscode.env.openExternal(vscode.Uri.parse(entry.pr.url));
        }
      }),
    ),
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'github') {
        resetAuth();
        void inbox.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void inbox.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('taskInbox.sortBy') || e.affectsConfiguration('taskInbox.showStacks')) {
        inbox.rerender();
      } else if (e.affectsConfiguration('taskInbox')) {
        resetAuth();
        schedule();
        void inbox.refresh();
      }
    }),
    vscode.window.onDidChangeWindowState(s => {
      if (s.focused) {
        void inbox.refresh();
      }
    }),
    { dispose: () => clearInterval(timer) },
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  function schedule(): void {
    clearInterval(timer);
    const seconds = vscode.workspace.getConfiguration('taskInbox').get<number>('refreshIntervalSeconds', 60);
    if (seconds > 0) {
      timer = setInterval(() => {
        if (vscode.window.state.focused) {
          void inbox.refresh();
        }
      }, Math.max(seconds, 15) * 1000);
    }
  }

  schedule();
  void inbox.refresh();
}

export function deactivate(): void {}
