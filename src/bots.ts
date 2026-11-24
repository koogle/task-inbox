import * as vscode from 'vscode';
import { PullRequest } from './github';

export interface BotConfig {
  name: string;
  loginPattern: string;
  branchPattern?: string;
  mention?: string;
}

export function botConfigs(): BotConfig[] {
  return vscode.workspace.getConfiguration('taskInbox').get<BotConfig[]>('bots', []);
}

function regex(pattern: string | undefined): RegExp | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

/**
 * Fill the `{login}` placeholder of a mention with the bot's actual login on the PR.
 * Without a known login such a mention resolves to empty (plain comment).
 */
export function resolved(c: BotConfig, login?: string): BotConfig {
  const mention = c.mention ?? '';
  if (!mention.includes('{login}')) {
    return { ...c, mention };
  }
  return { ...c, mention: login ? mention.replaceAll('{login}', login.replace(/\[bot\]$/, '')) : '' };
}

/** All configured bots, with mentions resolved as far as possible without a PR. */
export function allBots(): BotConfig[] {
  return botConfigs().map(c => resolved(c));
}

/** Bots present on a PR: matched by login of anyone on the PR, or by head branch name. */
export function detectBots(pr: PullRequest, configs = botConfigs()): BotConfig[] {
  const found: BotConfig[] = [];
  for (const c of configs) {
    const login = regex(c.loginPattern);
    const branch = regex(c.branchPattern);
    const who = login && pr.participants.find(a => login.test(a.login));
    if (who || branch?.test(pr.headRefName)) {
      found.push(resolved(c, who ? who.login : undefined));
    }
  }
  return found;
}

export function withMention(bot: Pick<BotConfig, 'mention'> | undefined, text: string): string {
  const mention = bot?.mention?.trim();
  return mention ? `${mention} ${text}` : text;
}
