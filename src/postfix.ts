// SharpSense Phase 1.4 — postfix template definitions.
//
// Each template expands `expr.trigger` into its C# shape. `expr` is embedded
// via snippet-escaping (user code may contain `$`, e.g. interpolated strings),
// so expansions are built as raw snippet strings, never by interpolation.

import * as vscode from 'vscode';
import type { ResolvedBraceStyle } from './context';

export interface PostfixExpansion {
  snippet: vscode.SnippetString;
  preview: string;
}

/** Escape user code for embedding in a snippet value. */
export function esc(text: string): string {
  return text.replace(/[$}]/g, (c) => `\\${c}`);
}

export function braced(bs: ResolvedBraceStyle, header: string, body: string): string {
  if (bs === 'allman') {
    return `${header}\n{\n\t${body}\n}`;
  }
  return `${header} {\n\t${body}\n}`;
}

/** `do { } while (cond);` — the trailing `while` lives after the body, so `braced` can't shape it. */
export function doForm(bs: ResolvedBraceStyle, cond: string): string {
  const body = '$0';
  return bs === 'allman'
    ? `do\n{\n\t${body}\n}\nwhile (${cond});`
    : `do {\n\t${body}\n} while (${cond});`;
}

export function snip(value: string, preview: string): PostfixExpansion {
  return { snippet: new vscode.SnippetString(value), preview };
}

export interface PostfixTemplate {
  trigger: string;
  description: string;
  expand: (expr: string, bs: ResolvedBraceStyle) => PostfixExpansion;
}

export const POSTFIX_TEMPLATES: PostfixTemplate[] = [
  {
    trigger: 'var',
    description: 'Introduce local: var name = expr;',
    expand: (e) => snip(`var \${1:name} = ${esc(e)};`, `var name = ${e};`),
  },
  {
    trigger: 'if',
    description: 'Wrap in if (expr)',
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)})`, '$0'), `if (${e}) { ... }`),
  },
  {
    trigger: 'null',
    description: 'if (expr == null)',
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)} == null)`, '$0'), `if (${e} == null) { ... }`),
  },
  {
    trigger: 'notnull',
    description: 'if (expr != null)',
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)} != null)`, '$0'), `if (${e} != null) { ... }`),
  },
  {
    trigger: 'for',
    description: 'Index loop over expr (uses .Length)',
    expand: (e, bs) =>
      snip(
        braced(bs, `for (var \${1:i} = 0; \${1:i} < ${esc(e)}.Length; \${1:i}++)`, '$0'),
        `for (var i = 0; i < ${e}.Length; i++) { ... }`,
      ),
  },
  {
    trigger: 'foreach',
    description: 'foreach (var item in expr)',
    expand: (e, bs) =>
      snip(
        braced(bs, `foreach (var \${1:item} in ${esc(e)})`, '$0'),
        `foreach (var item in ${e}) { ... }`,
      ),
  },
  {
    trigger: 'return',
    description: 'return expr;',
    expand: (e) => snip(`return ${esc(e)};`, `return ${e};`),
  },
  {
    trigger: 'await',
    description: 'await expr;',
    expand: (e) => snip(`await ${esc(e)};`, `await ${e};`),
  },
  {
    trigger: 'using',
    description: 'using (expr) { ... }',
    expand: (e, bs) => snip(braced(bs, `using (${esc(e)})`, '$0'), `using (${e}) { ... }`),
  },
  {
    trigger: 'try',
    description: 'Wrap expr in try/catch',
    expand: (e, bs) =>
      snip(
        `${braced(bs, 'try', `${esc(e)};`)}\ncatch (Exception \${1:e})\n${bs === 'allman' ? '{\n\t$0\n}' : '{\n\t$0\n}'}`,
        `try { ${e}; } catch (Exception e) { ... }`,
      ),
  },
  {
    trigger: 'throw',
    description: 'throw expr;',
    expand: (e) => snip(`throw ${esc(e)};`, `throw ${e};`),
  },
  {
    trigger: 'cast',
    description: '(Target)expr',
    expand: (e) => snip(`(\${1:Target})${esc(e)}$0`, `(Target)${e}`),
  },
  {
    trigger: 'as',
    description: 'expr as Target',
    expand: (e) => snip(`${esc(e)} as \${1:Target}$0`, `${e} as Target`),
  },
  {
    trigger: 'switch',
    description: 'switch (expr) { ... }',
    expand: (e, bs) => snip(braced(bs, `switch (${esc(e)})`, '$0'), `switch (${e}) { ... }`),
  },
  {
    trigger: 'else',
    description: 'if (!(expr)) { }',
    expand: (e, bs) => snip(braced(bs, `if (!(${esc(e)}))`, '$0'), `if (!(${e})) { ... }`),
  },
  {
    trigger: 'while',
    description: 'while (expr) { }',
    expand: (e, bs) => snip(braced(bs, `while (${esc(e)})`, '$0'), `while (${e}) { ... }`),
  },
  {
    trigger: 'lock',
    description: 'lock (expr) { }',
    expand: (e, bs) => snip(braced(bs, `lock (${esc(e)})`, '$0'), `lock (${e}) { ... }`),
  },
  {
    trigger: 'do',
    description: 'do { } while (expr);',
    expand: (e, bs) => snip(doForm(bs, esc(e)), `do { ... } while (${e});`),
  },
  {
    trigger: 'not',
    description: '!(expr)',
    expand: (e) => snip(`!(${esc(e)})$0`, `!(${e})`),
  },
  {
    trigger: 'par',
    description: '(expr)',
    expand: (e) => snip(`(${esc(e)})$0`, `(${e})`),
  },
  {
    trigger: 'is',
    description: 'expr is Type',
    expand: (e) => snip(`${esc(e)} is \${1:Type}$0`, `${e} is Type`),
  },
  {
    trigger: 'name',
    description: 'nameof(expr)',
    expand: (e) => snip(`nameof(${esc(e)})$0`, `nameof(${e})`),
  },
  {
    trigger: 'new',
    description: 'new Type()',
    expand: (e) => snip(`new ${esc(e)}(\${0})`, `new ${e}()`),
  },
  {
    trigger: 'checked',
    description: 'checked (expr)',
    expand: (e) => snip(`checked (${esc(e)})$0`, `checked (${e})`),
  },
  {
    trigger: 'unchecked',
    description: 'unchecked (expr)',
    expand: (e) => snip(`unchecked (${esc(e)})$0`, `unchecked (${e})`),
  },
  {
    trigger: 'comment',
    description: '/* expr */',
    expand: (e) => snip(`/* ${esc(e)} */$0`, `/* ${e} */`),
  },
  {
    trigger: 'let',
    description: 'var name = expr;',
    expand: (e) => snip(`var \${1:name} = ${esc(e)};$0`, `var name = ${e};`),
  },
  {
    trigger: 'repeat',
    description: 'for (var i = 0; i < expr; i++) { }',
    expand: (e, bs) =>
      snip(
        braced(bs, `for (var \${1:i} = 0; \${1:i} < ${esc(e)}; \${1:i}++)`, '$0'),
        `for (var i = 0; i < ${e}; i++) { ... }`,
      ),
  },
];

export function findPostfixTemplates(partial: string): PostfixTemplate[] {
  const p = partial.toLowerCase();
  return POSTFIX_TEMPLATES.filter((t) => t.trigger.startsWith(p));
}
