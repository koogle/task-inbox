import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function log(message: string): void {
  channel ??= vscode.window.createOutputChannel('Task Inbox');
  channel.appendLine(`${new Date().toLocaleTimeString()} ${message}`);
}

export function showLog(): void {
  channel ??= vscode.window.createOutputChannel('Task Inbox');
  channel.show(true);
}
