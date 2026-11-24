import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { allBots, withMention } from './bots';
import { fetchThread, postComment, ThreadItem } from './github';
import { PrEntry } from './inbox';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function renderThread(items: ThreadItem[]): string {
  if (!items.length) {
    return '<p class="empty">No comments yet.</p>';
  }
  return items
    .map(i => {
      const state = i.state && i.state !== 'COMMENTED' ? `<span class="state">${esc(i.state.toLowerCase().replace(/_/g, ' '))}</span>` : '';
      const inline = i.inline
        .map(
          c =>
            `<div class="inline"><div class="path">${esc(c.path)}${c.line ? `:${c.line}` : ''}</div>${c.bodyHTML}</div>`,
        )
        .join('');
      return `<article class="${i.author.isBot ? 'bot' : ''}">
        <header><strong>${esc(i.author.login)}</strong>${i.author.isBot ? '<span class="tag">bot</span>' : ''}${state}
          <a href="${esc(i.url)}">${esc(new Date(i.createdAt).toLocaleString())}</a></header>
        <div class="body">${i.bodyHTML}</div>${inline}
      </article>`;
    })
    .join('');
}

function page(entry: PrEntry, nonce: string): string {
  const detected = new Set(entry.bots.map(b => b.name));
  const bots = [...entry.bots, ...allBots().filter(b => !detected.has(b.name))];
  const options = [
    ...bots.map(
      b =>
        `<option value="${esc(b.mention ?? '')}">${esc(b.name)}${detected.has(b.name) ? '' : ' (not detected)'}${b.mention ? ` — ${esc(b.mention)}` : ''}</option>`,
    ),
    '<option value="">Plain comment</option>',
  ].join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0 16px 150px; max-width: 860px; margin: 0 auto; line-height: 1.5; }
  h2 { font-size: 1.1em; margin: 16px 0; }
  article { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 10px 0; overflow: hidden; }
  article.bot { border-left: 3px solid var(--vscode-charts-purple); }
  header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--vscode-sideBar-background); font-size: 0.9em; }
  header a { margin-left: auto; color: var(--vscode-descriptionForeground); text-decoration: none; }
  .tag, .state { font-size: 0.8em; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .body, .inline { padding: 4px 10px; overflow-wrap: anywhere; }
  .inline { border-top: 1px solid var(--vscode-panel-border); }
  .path { font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); padding-top: 4px; }
  pre { overflow-x: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
  img { max-width: 100%; }
  .empty { color: var(--vscode-descriptionForeground); }
  footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
  footer > div { max-width: 860px; margin: 0 auto; display: grid; grid-template-columns: 1fr auto; gap: 6px; }
  textarea { grid-column: 1 / -1; min-height: 60px; resize: vertical; font: inherit; padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 4px; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 5px 14px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style></head>
<body>
  <h2>${esc(entry.pr.title)} <a href="${esc(entry.pr.url)}">#${entry.pr.number}</a></h2>
  <div id="thread"><p class="empty">Loading…</p></div>
  <footer><div>
    <textarea id="box" placeholder="Message the bot — posted as a PR comment (⌘/Ctrl+Enter to send)"></textarea>
    <select id="bot">${options}</select>
    <button id="send">Comment</button>
  </div></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const thread = document.getElementById('thread'), box = document.getElementById('box');
  const bot = document.getElementById('bot'), send = document.getElementById('send');
  let first = true;
  const submit = () => {
    const text = box.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true;
    vscode.postMessage({ type: 'send', text, mention: bot.value });
  };
  send.addEventListener('click', submit);
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'thread') {
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
      thread.innerHTML = data.html;
      if (first || atBottom) window.scrollTo(0, document.body.scrollHeight);
      first = false;
    } else if (data.type === 'sent') {
      box.value = ''; send.disabled = false;
    } else if (data.type === 'failed') {
      send.disabled = false;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

export class Conversations {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly onDidPost: () => void) {}

  open(entry: PrEntry): void {
    const { pr } = entry;
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('taskInbox.conversation', `💬 #${pr.number} ${pr.title}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panels.set(key, panel);

    const load = async () => {
      try {
        const html = renderThread(await fetchThread(pr));
        void panel.webview.postMessage({ type: 'thread', html });
      } catch (err) {
        console.error('[task-inbox]', err);
      }
    };
    const timer = setInterval(() => {
      if (panel.visible && vscode.window.state.focused) {
        void load();
      }
    }, 20000);
    panel.onDidDispose(() => {
      clearInterval(timer);
      this.panels.delete(key);
    });
    panel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; mention?: string }) => {
      if (msg.type === 'ready') {
        await load();
      } else if (msg.type === 'send' && msg.text) {
        try {
          await postComment(pr, withMention({ mention: msg.mention }, msg.text));
          void panel.webview.postMessage({ type: 'sent' });
          await load();
          this.onDidPost();
        } catch (err) {
          void panel.webview.postMessage({ type: 'failed' });
          void vscode.window.showErrorMessage(`Task Inbox: ${(err as Error).message}`);
        }
      }
    });
    panel.webview.html = page(entry, crypto.randomBytes(16).toString('hex'));
  }
}
