// SharpSense — Phase 1.x Accept-Handler: Rider-style context-aware
// completions as a companion to the Microsoft C# + C# Dev Kit extensions
// (no fork, no second provider). Hot paths stay sync + local (string/regex
// on the editor line in context.ts); the single Roslyn detail fetch happens
// once on completion accept, not per keystroke.

import * as vscode from 'vscode';
import { detectInvokeContext, type SharpSenseSettings } from './context';
import { logRoslynRows, registerCommitShadow, registerExpectedNewProvider, registerGenerateProvider, registerLiveTemplateProvider, registerPostfixProvider } from './completions';
import { registerBracketHandlers } from './brackets';
import { registerSmartEnter } from './commands/smartEnter';
import { registerSurroundWith } from './surround';
import { registerCompleteStatement } from './completestatement';

let output: vscode.OutputChannel;
let settings: SharpSenseSettings;

function readSettings(): SharpSenseSettings {
  const config = vscode.workspace.getConfiguration('sharpsense');
  settings = {
    smartParens: config.get<boolean>('smartParens', true),
    smartGenerics: config.get<boolean>('smartGenerics', true),
    smartBackspace: config.get<boolean>('smartBackspace', true),
    tabOut: config.get<boolean>('tabOut', true),
    overtype: config.get<boolean>('overtype', true),
    postfix: config.get<boolean>('postfixTemplates', true),
    verbose: config.get<boolean>('verboseLogging', false),
    braceStyle: config.get<SharpSenseSettings['braceStyle']>('braceStyle', 'allman'),
    smartSemicolon: config.get<boolean>('smartSemicolon', true),
    generate: config.get<boolean>('generate', true),
    backspaceUnindentMode: config.get<SharpSenseSettings['backspaceUnindentMode']>('backspace.unindentMode', 'toProper'),
    completionEnterBehavior: config.get<SharpSenseSettings['completionEnterBehavior']>('completion.enterBehavior', 'insert'),
    completionTabBehavior: config.get<SharpSenseSettings['completionTabBehavior']>('completion.tabBehavior', 'replace'),
    smartSurroundWithBraces: config.get<boolean>('typing.smartSurroundWithBraces', true),
  };
  return settings;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SharpSense');
  output.appendLine('[SharpSense] starting activate...');
  try {
    output.appendLine(`[SharpSense] extensions active: ${(vscode.extensions?.all ?? []).filter((e: { id: string }) => /csharp|csdevkit/i.test(e.id)).map((e: { id: string }) => e.id).join(',') || '(none yet)'}`);
  } catch { /* best-effort diagnostics only */ }
  readSettings();
  try {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    output.appendLine(`[SharpSense] editor.tabCompletion=${String(editorCfg.get('tabCompletion'))} acceptSuggestionOnEnter=${String(editorCfg.get('acceptSuggestionOnEnter'))}`);
  } catch { /* best-effort diagnostics only */ }
  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sharpsense')) {
        readSettings();
      }
    }),
  );

  const getSettings = () => settings;
  try {
    registerCommitShadow(context, output, getSettings);
    output.appendLine('[SharpSense] commitShadow registered');
  } catch (e) { output.appendLine(`[SharpSense] commitShadow failed: ${String(e)} 
${(e as Error)?.stack ?? ''}`); }
  try {
    registerLiveTemplateProvider(context, getSettings);
    output.appendLine('[SharpSense] liveTemplates registered');
  } catch (e) { output.appendLine(`[SharpSense] liveTemplates failed: ${String(e)} 
${(e as Error)?.stack ?? ''}`); }
  try {
    registerPostfixProvider(context, getSettings);
    output.appendLine('[SharpSense] postfix registered');
  } catch (e) { output.appendLine(`[SharpSense] postfix failed: ${String(e)} 
${(e as Error)?.stack ?? ''}`); }
  try {
    registerExpectedNewProvider(context, getSettings, output);
    output.appendLine('[SharpSense] expectedNew registered');
  } catch (e) { output.appendLine(`[SharpSense] expectedNew failed: ${String(e)} 
${(e as Error)?.stack ?? ''}`); }
  try {
    registerBracketHandlers(context, output, getSettings);
    output.appendLine('[SharpSense] brackets registered');
  } catch (e) { output.appendLine(`[SharpSense] brackets failed: ${String(e)}
${(e as Error)?.stack ?? ''}`); }
  try {
    registerSurroundWith(context, getSettings);
    output.appendLine('[SharpSense] surroundWith registered');
  } catch (e) { output.appendLine(`[SharpSense] surroundWith failed: ${String(e)}
${(e as Error)?.stack ?? ''}`); }
  try {
    registerCompleteStatement(context, getSettings);
    output.appendLine('[SharpSense] completeStatement registered');
  } catch (e) { output.appendLine(`[SharpSense] completeStatement failed: ${String(e)}
${(e as Error)?.stack ?? ''}`); }
  try {
    registerGenerateProvider(context, getSettings);
    output.appendLine('[SharpSense] generate registered');
  } catch (e) { output.appendLine(`[SharpSense] generate failed: ${String(e)}
${(e as Error)?.stack ?? ''}`); }
  try {
    registerSmartEnter(context, getSettings);
    output.appendLine('[SharpSense] smartEnter registered');
  } catch (e) { output.appendLine(`[SharpSense] smartEnter failed: ${String(e)}
${(e as Error)?.stack ?? ''}`); }

  // Ghost-caret eliminator — see completions.ts expectedNew/postfix/live single-stop snippets.
  // Importers: src/completions.ts (registerExpectedNewProvider, registerPostfixProvider, registerLiveTemplateProvider)
  // Affected API: vscode.commands.registerCommand, CompletionItem.command `sharpsense.leaveSnippetDelayed` -> `leaveSnippet`
  // User verbatim: "That's AMAZING! But you can still see the ghost caret. It's a gray caret. It happens when we do the completions or the JIT completions" + "The GetComponent<>() or any other generic method that completes the <>, in fact won't show the gray caret. But the class creation JIT completion (and most likely also struct creation and records or every Jit completion... will still show that gray character."
  // Updated: every JIT (class/struct/record/new) was still ghosting (single-stop `${0}` snippets are racy at 25ms); generic commit path now ghost-free via plain `<$0>()` fast path.
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.leaveSnippetDelayed', async () => {
      // JIT snippets (class/struct/record/new) race: snippet not yet active at 25ms. Use 40ms + second try at 120ms.
      await new Promise<void>((r) => setTimeout(r, 40));
      try { await vscode.commands.executeCommand('leaveSnippet'); } catch {}
      try { await vscode.commands.executeCommand('editor.action.leaveSnippet'); } catch {}
      await new Promise<void>((r) => setTimeout(r, 80));
      try { await vscode.commands.executeCommand('leaveSnippet'); } catch {}
      try { await vscode.commands.executeCommand('editor.action.leaveSnippet'); } catch {}
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.showStatus', () => {
      const s = readSettings();
      void vscode.window.showInformationMessage(
        `SharpSense ON — parens=${s.smartParens} generics=${s.smartGenerics} backspace=${s.smartBackspace} tabOut=${s.tabOut} overtype=${s.overtype} postfix=${s.postfix} braces=${s.braceStyle} semi=${s.smartSemicolon}`,
      );
    }),
    vscode.commands.registerCommand('sharpsense.logContext', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'csharp') {
        void vscode.window.showInformationMessage('SharpSense: open a C# file first.');
        return;
      }
      const pos = ed.selection.active;
      const lineText = ed.document.lineAt(pos.line).text;
      const detected = detectInvokeContext(
        lineText.slice(0, pos.character),
        lineText.slice(pos.character),
      );
      output.appendLine(
        `[SharpSense] ${pos.line + 1}:${pos.character} -> ${detected.kind} (name="${detected.name}")`,
      );
      await logRoslynRows(output, ed.document, pos);
      output.show(true);
    }),
  );

  output.appendLine(
    `[SharpSense] activated (Phase 1.x Accept-Handler) ${JSON.stringify({
      smartParens: settings.smartParens,
      smartGenerics: settings.smartGenerics,
      smartBackspace: settings.smartBackspace,
      smartSemicolon: settings.smartSemicolon,
    })}`,
  );
}

export function deactivate(): void {
  // All registrations dispose via context.subscriptions.
}
