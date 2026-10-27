// SharpSense — Surround-With command.
//
// Wraps the current selection in a control-flow block (if/while/for/foreach/
// using/try/lock/region) or `do { } while`. This is a command (not a completion
// prefix) because completions act at the cursor and cannot wrap a *range*.
//
// Reuses the same brace-style engine as the postfix templates: `esc`/`braced`
// from postfix.ts and `resolveBraceStyle` from context.ts. Single-stop snippets
// (`${0:...}`) are ghost-free; multi-stop ones (for/foreach/try) keep a natural
// snippet session.

import * as vscode from 'vscode';
import { resolveBraceStyle, type ResolvedBraceStyle, type SharpSenseSettings } from './context';
import { braced, esc } from './postfix';

/** Re-indent every line after the first so it nests one level inside the block. */
function indent(t: string, s = '\t'): string {
  return t.split('\n').map((l, i) => (i ? s + l : l)).join('\n');
}

export interface SurroundTemplate {
  id: string;
  /** Label shown in the Quick Pick. */
  label: string;
  /** Preview text under the label. */
  preview: string;
  /** Build the snippet body for the selected `text` at brace style `bs`. */
  build: (bs: ResolvedBraceStyle, text: string) => string;
}

const SURROUND_TEMPLATES: SurroundTemplate[] = [
  {
    id: 'if',
    label: 'if',
    preview: 'if (condition) { ... }',
    build: (bs, t) => braced(bs, 'if (${0:condition})', indent(esc(t))),
  },
  {
    id: 'else',
    label: 'if (!=cond)',
    preview: 'if (!(condition)) { ... }',
    build: (bs, t) => braced(bs, 'if (!(${0:condition}))', indent(esc(t))),
  },
  {
    id: 'while',
    label: 'while',
    preview: 'while (condition) { ... }',
    build: (bs, t) => braced(bs, 'while (${0:condition})', indent(esc(t))),
  },
  {
    id: 'do',
    label: 'do … while',
    preview: 'do { ... } while (condition);',
    build: (bs, t) => {
      const body = indent(esc(t));
      return bs === 'allman'
        ? `do\n{\n\t${body}\n}\nwhile (\${0:condition});`
        : `do {\n\t${body}\n} while (\${0:condition});`;
    },
  },
  {
    id: 'for',
    label: 'for',
    preview: 'for (var i = 0; i < count; i++) { ... }',
    build: (bs, t) => braced(bs, 'for (var ${1:i} = 0; ${1:i} < ${0:count}; ${1:i}++)', indent(esc(t))),
  },
  {
    id: 'foreach',
    label: 'foreach',
    preview: 'foreach (var item in collection) { ... }',
    build: (bs, t) => braced(bs, 'foreach (var ${1:item} in ${0:collection})', indent(esc(t))),
  },
  {
    id: 'using',
    label: 'using',
    preview: 'using (resource) { ... }',
    build: (bs, t) => braced(bs, 'using (${0:resource})', indent(esc(t))),
  },
  {
    id: 'try',
    label: 'try',
    preview: 'try { ... } catch (Exception e) { }',
    build: (bs, t) =>
      `${braced(bs, 'try', indent(esc(t)))}\ncatch (Exception \${1:e})\n{\n\t$0\n}`,
  },
  {
    id: 'lock',
    label: 'lock',
    preview: 'lock (obj) { ... }',
    build: (bs, t) => braced(bs, 'lock (${0:obj})', indent(esc(t))),
  },
  {
    id: 'region',
    label: '#region',
    preview: '#region Name ... #endregion',
    build: (_bs, t) => `#region \${0:Name}\n${indent(esc(t))}\n#endregion`,
  },
];

export function registerSurroundWith(
  context: vscode.ExtensionContext,
  getSettings: () => SharpSenseSettings,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.surroundWith', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'csharp') {
        return;
      }
      const sel = ed.selection;
      if (sel.isEmpty) {
        void vscode.window.showInformationMessage('SharpSense: select an expression to surround.');
        return;
      }
      const text = ed.document.getText(sel);
      const bs = resolveBraceStyle(getSettings().braceStyle, ed.document.getText());

      const picks = SURROUND_TEMPLATES.map((tpl) => ({
        label: tpl.label,
        description: tpl.preview,
        detail: 'SharpSense surround-with',
        template: tpl,
      }));

      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Surround selection with…',
      });
      if (!picked) {
        return;
      }

      const snippet = new vscode.SnippetString(picked.template.build(bs, text));
      await ed.insertSnippet(snippet, sel, { undoStopBefore: false, undoStopAfter: false });
    }),
  );
}
