import * as vscode from 'vscode';
import type { Settings } from './settings';
import { readSettings } from './settings';
import { registerBracketHandlers } from './brackets';

let channel: vscode.OutputChannel | undefined;
let settings: Settings;

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Smart Enter And Backspace');
  context.subscriptions.push(channel);
  settings = readSettings();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('smartEnterAndBackspace')) {
        settings = readSettings();
        if (settings.verbose) channel?.appendLine('[SmartEnterAndBackspace] settings reloaded');
      }
    }),
  );

  try {
    registerBracketHandlers(context, channel, () => settings);
    if (settings.verbose) channel.appendLine('[SmartEnterAndBackspace] activated');
  } catch (err) {
    channel.appendLine(`[SmartEnterAndBackspace] activation failed: ${String(err)}`);
  }
}

export function deactivate(): void {
  channel?.dispose();
  channel = undefined;
}
