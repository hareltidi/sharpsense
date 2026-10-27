// SharpSense Universal Completion Engine — Phase 1 Final

//

// Ergonomic Presentation Layer over ms-dotnettools.csharp / csdevkit.

// Zero duplicate rows structurally (shadow commit); single-undo SnippetString.

// Every symbol suffix is a lookup in STRATEGY_MATRIX, never hardcoded branches.

//

// Integration contract:

//  • Roslyn is the sole semantic source — every decision reads

//    vscode.executeCompletionItemProvider + item.kind/label/detail.

//  • The shadow fetches once per accept (never per keystroke) and decorates

//    the just-committed word via insertSnippet(undoStopBefore/After:false).

//  • RHS `new` Tier 1 and Live Templates are supplemental Snippet rows with

//    sortText !0000, ranked above bare keywords but never duplicating a

//    per-symbol Roslyn row (shadow contributes zero plain-symbol rows).

//

// Matrix Key = [RoslynKindCategory] : [GenericState] : [ContextState]

//  Callable:Generic          -> R1  GetComponent<T>() + inference check

//  Callable:Standard         -> R2  DoSomething() / inferrable generic

//  Type:Generic:New/Decl     -> R3  List<T> (New vs Decl disambiguated)

//  Bare:PassThrough          -> R5  keywords / properties / fields / enums



import * as vscode from 'vscode';

import {

  collapseGenericArgs,

  detectInvokeContext,

  extractPostfixTarget,

  isBareModifierHead,

  isGenericInferrable,

  MODIFIERS,

  parseGenericArity,

  resolveBraceStyle,

  stripLeadingTrivia,

  type InvokeContext,

  type ResolvedBraceStyle,

  type SharpSenseSettings,

} from './context';

import { findPostfixTemplates } from './postfix';



const braceCache = new Map<string, { version: number; style: ResolvedBraceStyle }>();

export function cachedBraceStyle(doc: vscode.TextDocument, setting: SharpSenseSettings['braceStyle']): ResolvedBraceStyle {

  const key = doc.uri.toString();

  const hit = braceCache.get(key);

  if (hit && hit.version === doc.version) return hit.style;

  const style = resolveBraceStyle(setting, doc.getText());

  braceCache.set(key, { version: doc.version, style });

  if (braceCache.size > 50) {

    const oldest = braceCache.keys().next();

    if (!oldest.done) braceCache.delete(oldest.value);

  }

  return style;

}



function shouldAddSemicolon(prefix: string, suffix: string): boolean {

  const codeSuffix = stripLeadingTrivia(suffix);
  if (codeSuffix.startsWith(';')) return false;
  if (codeSuffix.length !== 0) return false;

  let depth = 0;

  let inStr: string | null = null;

  let esc = false;

  for (let i = 0; i < prefix.length; i++) {

    const c = prefix[i];

    if (esc) { esc = false; continue; }

    if (c === '\\' && inStr) { esc = true; continue; }

    if (inStr) {

      if (c === inStr) inStr = null;

      continue;

    }

    if (c === '"' || c === "'") { inStr = c; continue; }

    if (c === '(' || c === '[' || c === '{') depth++;

    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);

  }

  return depth === 0;

}



export function completionLabel(item: vscode.CompletionItem): string {

  const l = item.label;

  return typeof l === 'string' ? l : l.label;

}



function isCallableKind(kind: vscode.CompletionItemKind | undefined): boolean {

  return kind === vscode.CompletionItemKind.Method || kind === vscode.CompletionItemKind.Function || kind === vscode.CompletionItemKind.Constructor;

}

/** Keywords that behave like method calls (typeof(T), nameof(x), sizeof(T)) and need `()`. */
function isCallableKeyword(label: string): boolean {
  return /^(?:typeof|nameof|sizeof)$/i.test(label);
}

/** Generic callable test: any symbol whose detail/doc looks like a call signature `Name<...>(` is callable, even if Roslyn reports a broader kind. This makes `Array.Clear`, `Array.Empty<T>`, etc. work without hardcoding type names. */
function isCallableEntry(entry: ShadowEntry): boolean {
  if (isCallableKind(entry.kind)) return true;
  if (entry.kind === vscode.CompletionItemKind.Keyword && isCallableKeyword(baseNameOf(entry.label))) return true;
  const base = baseNameOf(entry.label);
  if (!base) return false;
  // Type kinds (Class/Struct/Interface) are never callable, even if their doc mentions a constructor signature.
  if (isTypeKind(entry.kind)) return false;
  // Any `Base(...)` or `Base<T>(...)` in detail/doc is a call signature.
  if (methodSignatureText(base, entry.detail, entry.doc)) return true;
  if (entry.detail && new RegExp(`\\b${escapeRegExp(base)}\\s*\\(`).test(entry.detail)) return true;
  if (entry.doc && new RegExp(`\\b${escapeRegExp(base)}\\s*\\(`).test(entry.doc)) return true;
  // Fallback: Method-like detail contains `(` and base name, regardless of kind reporting.
  if (entry.detail && entry.detail.includes('(') && entry.detail.includes(base)) return true;
  return false;
}



function isTypeKind(kind: vscode.CompletionItemKind | undefined): boolean {

  return kind === vscode.CompletionItemKind.Class || kind === vscode.CompletionItemKind.Struct || kind === vscode.CompletionItemKind.Interface;

}



function kindName(kind: vscode.CompletionItemKind | undefined): string {

  if (kind === undefined) return '?';

  return vscode.CompletionItemKind[kind] ?? String(kind);

}



function baseNameOf(label: string): string {

  return label.match(/^([A-Za-z_]\w*)/)?.[1] ?? '';

}



function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Perf: regex compilation per generic item was ~10-15% of commit path.
// Cache method-signature regexes keyed by bare name. Bounded at 128 entries (LRU).
const sigReCache = new Map<string, RegExp>();
const labelGenericReCache = new Map<string, RegExp>();
function cachedSigRe(base: string): RegExp {
  let r = sigReCache.get(base);
  if (!r) {
    r = new RegExp('\\b' + escapeRegExp(base) + '\\s*<[^<>]*>\\s*\\(');
    sigReCache.set(base, r);
    if (sigReCache.size > 128) { const k = sigReCache.keys().next(); if (!k.done) sigReCache.delete(k.value); }
  }
  return r;
}
function cachedLabelGenericRe(base: string): RegExp {
  let r = labelGenericReCache.get(base);
  if (!r) {
    r = new RegExp('^' + escapeRegExp(base) + '\\s*<[^<>]*>');
    labelGenericReCache.set(base, r);
    if (labelGenericReCache.size > 128) { const k = labelGenericReCache.keys().next(); if (!k.done) labelGenericReCache.delete(k.value); }
  }
  return r;
}

function extractTrailingAngle(s: string): { text: string; inner: string } | undefined {
  const t = s.trimEnd();
  if (!t.endsWith('>')) return undefined;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === '>') depth++;
    else if (c === '<') {
      depth--;
      if (depth === 0) return { text: t.slice(i), inner: t.slice(i + 1, t.length - 1) };
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

export function registerPostfixProvider(context: vscode.ExtensionContext, getSettings: () => SharpSenseSettings): void {

  const provider: vscode.CompletionItemProvider = {

    provideCompletionItems(doc, pos) {

      if (!getSettings().postfix || doc.languageId !== 'csharp') return undefined;

      const line = doc.lineAt(pos.line).text;

      const target = extractPostfixTarget(line.slice(0, pos.character));

      if (!target) return undefined;

      // Bare `expr.` (no trigger chars) sorts after members via `zz_` but still
      // clutters the footer with 15 items. Only show postfix once the user has
      // typed at least one trigger char (`expr.f|`); the filtered view then makes
      // the single matching template the only item even at `zz_` rank.
      if (target.trigger.length === 0) return undefined;

      const templates = findPostfixTemplates(target.trigger);

      if (templates.length === 0) return undefined;

      const bs = cachedBraceStyle(doc, getSettings().braceStyle);

      const range = new vscode.Range(pos.line, target.exprStart, pos.line, pos.character);

      const filterText = line.slice(target.exprStart, pos.character);

      return templates.map((t) => {

        const built = t.expand(target.expr, bs);

        const item = new vscode.CompletionItem(t.trigger, vscode.CompletionItemKind.Snippet);

        (item as unknown as Record<string, unknown>).__sharpsensePostfix = true;

        item.range = range;

        item.filterText = filterText;

        // Roslyn members must win at `expr.` — postfix JIT sorts after.
        // `!` sorts before letters, `z` after; SharpSense postfix was
        // previously unsorted (interleaved with members) which put `.var`
        // style items before real members at `user.`.
        // Intra-postfix rank so `await`/`foreach`/`for` rise within the `zz_`
        // group while still after every Roslyn member.
        const POSTFIX_RANK: Record<string, number> = {
          await: 0, foreach: 1, for: 2, var: 3, if: 4, null: 5, notnull: 6,
          return: 7, using: 8, try: 9, throw: 10, cast: 11, as: 12, switch: 13,
        };
        const rank = POSTFIX_RANK[t.trigger] ?? 99;
        item.sortText = `zz_${String(rank).padStart(2, '0')}_sharpsense_${t.trigger}`;

        item.detail = `SharpSense postfix .${t.trigger} — ${t.description}`;

        item.documentation = new vscode.MarkdownString().appendCodeblock(built.preview, 'csharp');

        item.insertText = built.snippet;

        if (!/\$\{?[1-9]/.test(built.snippet.value)) {
          item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
        }

        return item;

      });

    },

  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('csharp', provider, '.'));

}

interface LiveTemplateDef {

  trigger: string;

  snippet: string;

  description: string;

}



const LIVE_TEMPLATES: LiveTemplateDef[] = [

  // Ghost-free: a SINGLE `${0:Name}` tab stop is simultaneously the active
  // selection AND the final stop, so VS Code never shows a gray ghost caret
  // (a ghost only appears at a non-active `$0`/`$1` stop). The name stays
  // editable — it IS the selected text, so typing replaces it. No
  // `leaveSnippet` is needed: the session holds just one stop and ends
  // naturally once the cursor moves on. This also fixes the double-ghost on
  // `record` (which previously had `${1}` + `${2}` + implicit `$0`).
  { trigger: 'class', snippet: 'class ${0:MyClass}\n{\n\t\n}', description: 'class declaration' },

  { trigger: 'interface', snippet: 'interface I${0:MyInterface}\n{\n\t\n}', description: 'interface declaration' },

  { trigger: 'struct', snippet: 'struct ${0:MyStruct}\n{\n\t\n}', description: 'struct declaration' },

  { trigger: 'enum', snippet: 'enum ${0:MyEnum}\n{\n\t\n}', description: 'enum declaration' },

  // Record: trailing `;` per request; single `${0}` so it shows no ghost.
  { trigger: 'record', snippet: 'record ${0:MyRecord}();', description: 'record declaration' },

  // Prop: single editable type field; no stray ghosts.
  { trigger: 'prop', snippet: 'public ${0:int} MyProperty { get; set; }', description: 'auto-property' },

];



function isLiveScope(head: string): boolean {

  if (/[=\.]/.test(head)) return false;

  const tail = head.trimStart().replace(new RegExp(`^(?:(?:${MODIFIERS})\\s+)*`, 'i'), '').trim();

  if (tail === '') return true;

  return /[{};\s]$/.test(head);

}



export function registerLiveTemplateProvider(context: vscode.ExtensionContext, _getSettings: () => SharpSenseSettings): void {

  const provider: vscode.CompletionItemProvider = {

    provideCompletionItems(doc, pos) {

      if (doc.languageId !== 'csharp') return undefined;

      const line = doc.lineAt(pos.line).text;

      const prefix = line.slice(0, pos.character);

      const wordMatch = prefix.match(/([A-Za-z_]\w*)$/);

      const word = wordMatch ? wordMatch[1].toLowerCase() : '';

      if (!word) return undefined;

      const head = wordMatch && wordMatch.index !== undefined ? prefix.slice(0, wordMatch.index) : prefix;

      if (!isLiveScope(head)) return undefined;

      const hits = LIVE_TEMPLATES.filter((t) => t.trigger.toLowerCase().startsWith(word));

      if (hits.length === 0) return undefined;

      const wordStart = pos.character - (wordMatch ? wordMatch[1].length : 0);

      const range = new vscode.Range(pos.line, wordStart, pos.line, pos.character);

      return hits.map((t) => {

        const item = new vscode.CompletionItem(t.trigger, vscode.CompletionItemKind.Snippet);

        item.range = range;

        item.filterText = t.trigger;

        item.sortText = '!0000';

        item.detail = `SharpSense ${t.description}`;

        item.documentation = new vscode.MarkdownString().appendCodeblock(t.snippet.replace(/\$\{\d+:?[^}]*\}/g, (m) => m.replace(/\$\{\d+:?/, '').replace(/\}/, '')), 'csharp');

        item.insertText = new vscode.SnippetString(t.snippet);

        return item;

      });

    },

  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('csharp', provider));

}



export function registerExpectedNewProvider(context: vscode.ExtensionContext, getSettings: () => SharpSenseSettings, output?: vscode.OutputChannel): void {

  const pendingKeys = new Set<string>();

  const provider: vscode.CompletionItemProvider = {

    async provideCompletionItems(doc, pos) {

      try {
      if (doc.languageId !== 'csharp') return undefined;

      const s = getSettings();

      if (!s.smartParens) return undefined;

      const line = doc.lineAt(pos.line).text;

      const prefix = line.slice(0, pos.character);

      const suffix = line.slice(pos.character);

      output?.appendLine(`[SharpSense] expectedNew invoked: line=${pos.line} char=${pos.character} prefix="${prefix.slice(-40)}"`);

      const triggerMatch = prefix.match(/(=>|=|\breturn)\s*new\s*[\w<>,.]*$/) || prefix.match(/(=>|=|\breturn)\s*$/);
      if (!triggerMatch || triggerMatch.index === undefined) return undefined;
      // Reject ==, !=, >=, <=: the char before '=' must not be = > < !
      const eqInTrigger = triggerMatch[1].indexOf('=');
      if (eqInTrigger !== -1) {
        const eqPos = triggerMatch.index + eqInTrigger;
        const chBeforeEq = eqPos > 0 ? prefix[eqPos - 1] : '';
        if (chBeforeEq === '=' || chBeforeEq === '>' || chBeforeEq === '<' || chBeforeEq === '!') return undefined;
      }

      const isReturnNew = (prefix.lastIndexOf('=') === -1) && /\breturn\s+new\b/.test(prefix);
      const isReturnBare = (prefix.lastIndexOf('=') === -1) && /\breturn\s*$/.test(prefix);
      const isReturnCase = isReturnNew || isReturnBare;
      const eqIdx = isReturnCase ? prefix.length : prefix.lastIndexOf('=');
      if (eqIdx === -1) return undefined;

      const beforeEq = isReturnCase ? (isReturnNew ? prefix.slice(0, prefix.lastIndexOf('new')).trimEnd() + ' ' : 'return ') : prefix.slice(0, eqIdx);

      // Arrow-bodied member (`Type Name(...) => new `): use the declared return type.
      const beforeEqTrimmed = beforeEq.trimEnd();
      const isArrowEq = !isReturnCase && (beforeEqTrimmed.endsWith('=>') || prefix[eqIdx + 1] === '>');
      let typeText: string | undefined;
      let typeMatch: RegExpMatchArray | null = null;
      // `return new ` has no cheap enclosing-method lookup — the shadow path covers return-new via scan.
      // (return new is supported below via enclosing-method return type)
      if (isArrowEq) {
        const sig = beforeEqTrimmed.endsWith('=>') ? beforeEqTrimmed.slice(0, -2) : beforeEq;
        const retMatch = sig.match(/([A-Za-z_][\w.<>,\[\]?]*?)\s+[A-Za-z_]\w*(?:<[^<>]*>)?\s*\([^()]*\)\s*$/);
        if (!retMatch) return undefined;
        typeText = retMatch[1].trim().replace(new RegExp(`^(?:(?:${MODIFIERS})\\s+)+`, 'i'), '').trim();
      } else {
        const trimmed = beforeEq.trimEnd();

        if (trimmed === 'return') {
          let rt: string | null = null;
          for (let l = pos.line - 1; l >= Math.max(0, pos.line - 40); l--) {
            const ln = doc.lineAt(l).text;
            const m = ln.match(/([A-Za-z_][\w.<>,\[\]?]*)\s+[A-Za-z_]\w*(?:<[^<>]*>)?\s*\([^()]*\)\s*[{]?/);
            if (m) { rt = m[1].trim(); break; }
          }
          if (!rt) return undefined;
          typeText = rt.replace(new RegExp(`^(?:(?:${MODIFIERS})\s+)+`, 'i'), '').trim();
        } else {


        typeMatch = trimmed.match(/(.+?)\s+([A-Za-z_]\w*)\s*$/);

        if (!typeMatch) {
          // Bare variable name on LHS (`numbers = new `): scan above for the
          // field/property/parameter declaration to resolve the type.
          const varName = trimmed.split(/\s+/).pop() ?? '';
          if (!/^[A-Za-z_]\w*$/.test(varName)) return undefined;
          const aboveLines: string[] = [];
          for (let l = pos.line - 1; l >= Math.max(0, pos.line - 30); l--) {
            aboveLines.push(doc.lineAt(l).text);
          }
          let found = false;
          for (const ln of aboveLines) {
            // Field/property: `Type name;` or `Type name = ...`
            let vm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${varName}\\s*[=;]`));
            // Constructor parameter: `Type name` at end of parameter list
            if (!vm) vm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${varName}\\s*(?:,|\\)\\s*\\{|$)`));
            if (vm) {
              typeMatch = vm;
              found = true;
              break;
            }
            // Property: `Type name { get; set; }` or `Type name =>`
            const pm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${varName}\\s*[{]`));
            if (pm) {
              typeMatch = pm;
              found = true;
              break;
            }
          }
          if (!found || !typeMatch) return undefined;
        }

        }
        if (typeMatch) typeText = (typeMatch[1] ?? '').trim().replace(new RegExp(`^(?:(?:${MODIFIERS})\s+)+`, 'i'), '').trim();
      }

      if (!typeText || typeText === 'var' || /^[0-9]/.test(typeText)) return undefined;

      if (/[=;{}]/.test(typeText)) return undefined;

      if (!/^[A-Za-z_][\w$]/.test(typeText) && !typeText.includes('<')) return undefined;

      const key = `${doc.uri.toString()}:${pos.line}:${pos.character}:${doc.version}`;
      const isPending = pendingKeys.has(key);
      if (!isPending) pendingKeys.add(key);
      if (!isPending) try {

        const res = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[] | undefined>(

          'vscode.executeCompletionItemProvider', doc.uri, pos,

        );

        const items: vscode.CompletionItem[] = Array.isArray(res) ? res : (res?.items ?? []);

        const base = (typeText.split('<')[0].split('.').pop() ?? '').trim() || baseNameOf(typeText);

        if (base) {

          for (const it of items) {

            if (baseNameOf(completionLabel(it)) !== base) continue;

            if (it.kind === vscode.CompletionItemKind.Interface) return undefined;

            if (it.kind === vscode.CompletionItemKind.Enum) return undefined;

            const detail = typeof it.detail === 'string' ? it.detail : '';

            const docText = typeof it.documentation === 'string' ? it.documentation : (typeof (it.documentation as vscode.MarkdownString | undefined)?.value === 'string' ? (it.documentation as vscode.MarkdownString).value : '');

            if (/\binterface\b/i.test(detail)) return undefined;

            if (/\babstract\b/i.test(detail)) return undefined;

            if (/\bstatic\s+class/i.test(detail) || /\bstatic\s+class/i.test(docText)) return undefined;

            // check every matching row: suppress if ANY is abstract/interface (no break)

          }

        }

      } catch {
      } finally {
        pendingKeys.delete(key);
      }

      const newStartRaw = prefix.lastIndexOf('new');
      const isNewTyped = newStartRaw !== -1;
      const newStart = isNewTyped ? newStartRaw : pos.character;

      let typedStart = isNewTyped ? (newStart + 3) : pos.character;

      while (typedStart < prefix.length && (prefix[typedStart] === ' ' || prefix[typedStart] === '\t')) typedStart++;

      const typedFragment = prefix.slice(typedStart, pos.character);

      if (typedFragment.length > 0 && /[^A-Za-z0-9_<>,]/.test(typedFragment)) return undefined;

      const range = new vscode.Range(pos.line, typedStart, pos.line, pos.character);

      const hasParenAhead = stripLeadingTrivia(suffix).startsWith('(');

      const needsSemi = !hasParenAhead && s.smartSemicolon && shouldAddSemicolon(prefix + typeText, suffix);

      const semi = needsSemi ? ';' : '';

      const snippetBody = hasParenAhead ? `${isNewTyped ? '' : 'new '}${typeText}\${0}${semi}` : `${isNewTyped ? '' : 'new '}${typeText}(\${0})${semi}`;

      const label = hasParenAhead ? `${isNewTyped ? '' : 'new '}${typeText}` : `${isNewTyped ? '' : 'new '}${typeText}()`;

      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);

      if (typedFragment.length > 0) item.range = range;

      item.filterText = typedFragment.length > 0 ? typeText : '';

      item.sortText = '!0001';

      // Index-0 default: sort first AND preselect, so Enter commits the full
      // `new Target(|);` without touching Roslyn's lower rows.
      // preselect dropped so matching locals can outrank expected-new

      item.detail = `SharpSense: create new ${typeText}()`;

      item.documentation = new vscode.MarkdownString(`Creates \`new ${typeText}()\` for \`${typeMatch?.[2] ?? typeText}\``);

      item.insertText = new vscode.SnippetString(snippetBody);

      // Single-stop `${0}`-only snippets must exit snippet mode; direct
      // `leaveSnippet` as item.command is racy (snippet not yet active), so
      // use the delayed variant that guarantees the gray ghost caret is removed.
      item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };

      output?.appendLine(`[SharpSense] expectedNew: typeText=${typeText} isNewTyped=${isNewTyped} isReturnNew=${isReturnNew} typedFragment="${typedFragment}" range=${range.start.line}:${range.start.character}-${range.end.character}`);
      return [item];

      } catch (e) {

        // Never crash the Extension Host from a completion provider — log and yield

        try { console.error('[SharpSense] expectedNew provider error', e); } catch {}

        return undefined;

      }

    },

  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('csharp', provider, '=', ' ', '<', '>', ',', '.', ':', '"', "'", '(', '[', '{'));

}



interface ShadowEntry {

  kind: vscode.CompletionItemKind | undefined;

  label: string;

  detail: string;

  doc: string;

  needsAngles: boolean;

  /**
   * Proof-based evidence (callables only). `needsAngles` is derived from
   * these, never guessed: `<>` requires provenGeneric && !provenStandard.
   * Rows without a parseable signature abstain; a generic-looking label with
   * no proof anywhere sets needsProof (post-accept hover proof decides).
   */
  provenGeneric: boolean;

  provenStandard: boolean;

  hasGenericLabel: boolean;

  needsProof: boolean;

}

/** Plain text of a Roslyn documentation field (string or MarkdownString). */
function docTextOf(it: vscode.CompletionItem): string {
  const d = it.documentation;
  if (typeof d === 'string') return d;
  if (d instanceof vscode.MarkdownString) return d.value;
  return '';
}

/** Detail-or-documentation text carrying a `Base<...>(` method signature, if any. */
function methodSignatureText(base: string, detail: string, doc: string): string | undefined {
  const re = cachedSigRe(base);
  if (re.test(detail)) return detail;
  if (doc && re.test(doc)) return doc;
  return undefined;
}



function finalizeCallableAngles(e: ShadowEntry): void {
  // Callables: `<>` only on proof (generic signature proven non-inferrable);
  // unknown rows abstain so `Task.FromResult` never gets speculative `<>`.
  // Types: untouched — keep the existing OR behaviour (generic type placeholders
  // like `Task<T>` are always wanted; veto would regress `Task` vs `Task<T>`).
  // Generic detection: any entry that looks like a call (detail/doc `Name(`) is
  // callable, not just Method/Function/Constructor kinds, so `Array.Clear` etc.
  // work without hardcoding type lists.
  if (isCallableEntry(e)) {
    e.needsAngles = e.provenGeneric && !e.provenStandard;
    e.needsProof = !e.provenGeneric && !e.provenStandard && e.hasGenericLabel;
  } else {
    e.needsProof = false;
  }
}

async function fetchShadowMap(doc: vscode.TextDocument, pos: vscode.Position, resolveFor?: string): Promise<Map<string, ShadowEntry> | undefined> {
  // Two-tier fetch, but tier-2 is LAZY and PER-WORD.
  //
  // Tier-1 (unresolved) is served from VS Code's own completion cache when the
  // widget already asked for this position/version, so it is nearly free.
  // Tier-2 (resolve) is a *different* request shape and therefore always a cache
  // miss — a full Roslyn round-trip.
  //
  // The old code ran tier-2 whenever ANY row in the whole list was ambiguous
  // (one `GetComponent<T>` poisoned every accept in the file). Now tier-2 only
  // runs when the caller explicitly asks to resolve a specific word, which the
  // accept path does only for the word it actually committed.
  const buildMap = (res: vscode.CompletionList | vscode.CompletionItem[] | undefined): Map<string, ShadowEntry> | undefined => {
    if (!res) return undefined;
    const items: vscode.CompletionItem[] = Array.isArray(res) ? res : (res.items ?? []);
    const map = new Map<string, ShadowEntry>();
    for (const it of items) {
      const label = completionLabel(it);
      const base = baseNameOf(label);
      if (!base) continue;
      const detail = typeof it.detail === "string" ? it.detail : "";
      const doc = docTextOf(it);
      // Generic callable detection: any row that looks like `Name(` or `Name<...>(` (via detail/doc) is callable, not just Method/Function/Constructor kinds. This makes `Array.Clear`, `Array.Empty<T>` etc. work without hardcoding.
      const probeVote = callableAnglesVote(base, label, detail, doc);
      const looksCallable = isCallableKind(it.kind) || probeVote !== 'unknown' || new RegExp(`\\b${escapeRegExp(base)}\\s*\\(`).test(detail) || new RegExp(`\\b${escapeRegExp(base)}\\s*\\(`).test(doc);
      if (looksCallable && !isTypeKind(it.kind)) {
        const vote = callableAnglesVote(base, label, detail, doc);
        const labelGeneric = cachedLabelGenericRe(base).test(label);
        const prior = map.get(base);
        if (prior) {
          // Caller-guaranteed: prior is also callable (same base, same first-row
          // kind). Non-callable rows never merge here — they take the type path.
          if (vote === 'generic') prior.provenGeneric = true;
          else if (vote === 'standard') prior.provenStandard = true;
          prior.hasGenericLabel = prior.hasGenericLabel || labelGeneric;
          const re = cachedSigRe(base);
          if (!re.test(prior.detail) && re.test(detail)) prior.detail = detail;
          if (doc && (!prior.doc || (!cachedSigRe(base).test(prior.doc) && re.test(doc)))) prior.doc = doc;
          continue;
        }
        const e: ShadowEntry = {
          kind: it.kind,
          label,
          detail,
          doc,
          // placeholders — finalize below
          needsAngles: false,
          provenGeneric: vote === 'generic',
          provenStandard: vote === 'standard',
          hasGenericLabel: labelGeneric,
          needsProof: false,
        };
        map.set(base, e);
      } else {
        const flag = rowNeedsAngles(it.kind, label, detail, doc);
        const prior = map.get(base);
        if (prior) {
          // Types keep the existing OR semantics (`Task` vs `Task<T>` coexistence
          // must still yield `<>`); veto would regress them.
          prior.needsAngles = prior.needsAngles || flag;
          prior.provenGeneric = prior.provenGeneric || flag;
          prior.hasGenericLabel = prior.hasGenericLabel || flag;
          const re = cachedSigRe(base);
          if (!re.test(prior.detail) && re.test(detail)) prior.detail = detail;
          if (doc && (!prior.doc || (!cachedSigRe(base).test(prior.doc) && re.test(doc)))) prior.doc = doc;
          continue;
        }
        const e: ShadowEntry = {
          kind: it.kind,
          label,
          detail,
          doc,
          needsAngles: flag,
          provenGeneric: flag,
          provenStandard: false,
          hasGenericLabel: flag,
          needsProof: false,
        };
        map.set(base, e);
      }
    }
    for (const [, e] of map) finalizeCallableAngles(e);
    return map;
  };

  const needsResolveFor = (map: Map<string, ShadowEntry>): boolean => {
    if (!resolveFor) return false;
    const base = baseNameOf(resolveFor);
    const entry = map.get(base) ?? map.get(resolveFor);
    return !!entry && entry.needsProof;
  };

  let res: vscode.CompletionList | vscode.CompletionItem[] | undefined;
  try {
    res = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[] | undefined>(
      "vscode.executeCompletionItemProvider", doc.uri, pos,
    );
  } catch {
    return undefined;
  }
  let map = buildMap(res);
  if (!map) return undefined;
  if (!needsResolveFor(map)) return map;
  // Ambiguous generic label-only (e.g. GetComponent<T> with detail="") — retry with resolve.
  // Merge the resolved rows back into the fast map (upgrade detail/doc, re-derive needsAngles)
  // instead of wholesale replacing it, so fast-path verdicts stay authoritative and a differing
  // resolved detail can't silently flip a correct tier-1 decision.
  try {
    const res2 = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[] | undefined>(
      "vscode.executeCompletionItemProvider", doc.uri, pos, undefined, 20,
    );
    const map2 = buildMap(res2);
    if (map2) {
      for (const [base, e2] of map2) {
        const e1 = map.get(base);
        if (e1) {
          // Preserve best display signature for diagnostics/static guards.
          const re = cachedSigRe(base);
          if (e2.detail && (!re.test(e1.detail) && re.test(e2.detail) || !e1.detail)) e1.detail = e2.detail;
          if (e2.doc && (!re.test(e1.doc) && re.test(e2.doc) || !e1.doc)) e1.doc = e2.doc;
          // Angles: flag-combine (not wholesale rowNeedsAngles re-derive) so a
          // resolved tier-2 generic row can't silently overwrite a proven-standard
          // tier-1 verdict for inferrable methods like Task.FromResult.
          if (isCallableKind(e1.kind)) {
            e1.provenGeneric = e1.provenGeneric || e2.provenGeneric;
            e1.provenStandard = e1.provenStandard || e2.provenStandard;
            e1.hasGenericLabel = e1.hasGenericLabel || e2.hasGenericLabel;
            finalizeCallableAngles(e1);
          } else {
            e1.needsAngles = e1.needsAngles || e2.needsAngles;
            e1.provenGeneric = e1.provenGeneric || e2.provenGeneric;
          }
        } else {
          map.set(base, e2);
        }
      }
    }
  } catch {
    // fall through to fast map
  }
  return map;
}



export function logIntegrationProof(output: vscode.OutputChannel): void {
  output.appendLine('[SharpSense] Integration proof: Roslyn is sole semantic source via vscode.executeCompletionItemProvider (ms-dotnettools.csharp + ms-dotnettools.csdevkit). Shadow contributes zero plain-symbol rows; Tier1 new + Live Templates are supplemental Snippet rows with sortText !0000; suffixes via STRATEGY_MATRIX + insertSnippet(undoStopBefore/After:false).');
}

export async function logRoslynRows(output: vscode.OutputChannel, doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {

  const probe = pos.character > 0 ? pos.translate(0, -1) : pos;

  const wordRange = doc.getWordRangeAtPosition(probe);

  const word = wordRange ? doc.getText(wordRange) : "";

  if (!word) { output.appendLine("[SharpSense] inspect: no word under cursor"); return; }

  let res: vscode.CompletionList | vscode.CompletionItem[] | undefined;

  try {

    res = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[] | undefined>(

      "vscode.executeCompletionItemProvider", doc.uri, pos,

    );

  } catch { output.appendLine("[SharpSense] inspect: Roslyn fetch failed"); return; }

  const items: vscode.CompletionItem[] = Array.isArray(res) ? res : (res?.items ?? []);

  const rows = items.filter((it) => baseNameOf(completionLabel(it)) === word);

  output.appendLine(`[SharpSense] inspect: ${rows.length} Roslyn row(s) for "${word}"`);

  rows.slice(0, 10).forEach((it, i) => {

    const label = completionLabel(it);

    const detail = (typeof it.detail === "string" ? it.detail : "").replace(/\s+/g, " ");

    const doc = docTextOf(it).replace(/\s+/g, " ").slice(0, 120);

    const base = baseNameOf(label);

    const vote = base && isCallableKind(it.kind) ? callableAnglesVote(base, label, typeof it.detail === "string" ? it.detail : "", docTextOf(it)) : (rowNeedsAngles(it.kind, label, typeof it.detail === "string" ? it.detail : "", docTextOf(it)) ? "generic" : "standard");

    output.appendLine(`  [${i}] kind=${kindName(it.kind)} label="${label}" detail="${detail}" doc="${doc}" vote=${vote}`);

  });

  if (rows.length > 10) output.appendLine(`  ... and ${rows.length - 10} more`);

}



interface PreSpot { pos: vscode.Position; lineText: string; }

type MatrixRule = "R1" | "R2" | "R3" | "R4" | "R5" | "";

const hasIntermediateStop = (b: string) => /\$\{?[1-9]/.test(b);

const finalStopIndex = (b: string): number => { const m = b.match(/\$\{0\}|\$0(?!\d)/); return m && m.index !== undefined ? m.index : -1; };



function isInsideGenericArgs(prefix: string): boolean {

  let depth = 0;

  for (let i = prefix.length - 1; i >= 0; i--) {

    const c = prefix[i];

    if (c === ">") { depth++; continue; }

    if (c === "<") { if (depth === 0) return true; depth--; continue; }

    if (depth === 0 && (c === ";" || c === "{" || c === "}" || c === "(" || c === ")" || c === "[" || c === "]")) return false;

  }

  return false;

}



type AstSlot = "Invocation" | "Declaration" | "TypeInstantiation" | "GenericTypeArgument" | "Other";



function slotOf(prefix: string, detected: InvokeContext): AstSlot {

  switch (detected.kind) {

    case "object-creation": return "TypeInstantiation";

    case "definition":

    case "unity-message-definition": return "Declaration";

    case "invocation": return isInsideGenericArgs(prefix) ? "GenericTypeArgument" : "Invocation";

    default: return "Other";

  }

}



type KindCategory = "Callable" | "Type" | "Bare";

type GenericState = "Generic" | "Standard";



function categorizeKind(kind: vscode.CompletionItemKind | undefined): KindCategory {

  if (isCallableKind(kind)) return "Callable";

  if (isTypeKind(kind)) return "Type";

  return "Bare";

}

function categorizeEntry(entry: ShadowEntry): KindCategory {
  if (isCallableEntry(entry)) return "Callable";
  if (isTypeKind(entry.kind)) return "Type";
  return "Bare";
}



type AnglesVote = 'generic' | 'standard' | 'unknown';

/**
 * Proof-based angles vote for a single callable row. Returns 'generic' ONLY
 * when a parsed `<T...>(params)` signature proves a type parameter is NOT
 * inferrable from inputs. Missing or oddly shaped rows abstain ('unknown')
 * instead of guessing — the entry-level combine + post-accept hover proof
 * resolve those, so `Task.FromResult` never gets speculative `<>`.
 */
function callableAnglesVote(base: string, label: string, detail: string, doc: string): AnglesVote {
  const sig = methodSignatureText(base, detail, doc);
  if (sig) return isGenericInferrable(sig) ? 'standard' : 'generic';
  // Bare `<...>(` without the base-name prefix (resolved items, other formats).
  if (detail && /<[^<>]*>\s*\(/.test(detail)) return isGenericInferrable(detail) ? 'standard' : 'generic';
  if (doc && /<[^<>]*>\s*\(/.test(doc)) return isGenericInferrable(doc) ? 'standard' : 'generic';
  return 'unknown';
}

function rowNeedsAngles(kind: vscode.CompletionItemKind | undefined, label: string, detail: string, doc = ''): boolean {

  const base = baseNameOf(label);

  if (!base) return false;

  if (isTypeKind(kind)) {

    if (cachedLabelGenericRe(base).test(label)) return true;

    if (cachedSigRe(base).test(detail)) return true;

    return false;

  }

  return false;

}



function deriveGenericState(category: KindCategory, entry: ShadowEntry, s: SharpSenseSettings, _afterNew: boolean): GenericState {
  // Proof-based: callable `<>` is `provenGeneric && !provenStandard`, already
  // finalized into `entry.needsAngles`. No re-parse, no unknown=>generic leak.
  // The inferrability (isGenericInferrable) was consumed at row-vote time via
  // callableAnglesVote; re-deriving it here would reintroduce the Task.FromResult bug.
  if (!entry.needsAngles) return "Standard";
  if (category === "Callable" && !s.smartGenerics) return "Standard";
  return "Generic";
}

function deriveGenericStateForEntry(entry: ShadowEntry, s: SharpSenseSettings, afterNew: boolean): GenericState {
  const cat = categorizeEntry(entry);
  return deriveGenericState(cat, entry, s, afterNew);
}



const TYPE_DEFINITION_HEAD = /(?:^|[\s;{}])(?:class|struct|interface|enum|record|namespace)\s+$/i;



function deriveDeclaration(word: string, prefix: string, slot: AstSlot, entry: ShadowEntry): boolean {

  if (slot !== "Declaration") return false;

  const head = prefix.slice(0, prefix.length - word.length);

  // Type definitions (`class Foo`, `struct Foo`) stay declarations (no suffix).
  if (TYPE_DEFINITION_HEAD.test(head)) return true;

  // Generic types used as types (variable/return/param) must get `<>`, not
  // Bare:PassThrough. Covers modifier-led and bare heads, plus cases where
  // the head is empty but the slot was classified Declaration by context.
  if (isTypeKind(entry.kind) && entry.needsAngles) return false;

  return true;

}

function resolveStrategyKey(kind: vscode.CompletionItemKind | undefined, hasGenerics: boolean, isAfterNew: boolean, isDeclaration: boolean): string {

  const category = categorizeKind(kind);

  if (category === "Bare" || isDeclaration) return "Bare:PassThrough";

  const generic: GenericState = hasGenerics ? "Generic" : "Standard";

  if (category === "Callable") return `Callable:${generic}`;

  return isAfterNew ? `Type:${generic}:New` : `Type:${generic}:Decl`;

}

function resolveStrategyKeyForEntry(entry: ShadowEntry, hasGenerics: boolean, isAfterNew: boolean, isDeclaration: boolean): string {
  const category = categorizeEntry(entry);
  if (category === "Bare" || isDeclaration) return "Bare:PassThrough";
  const generic: GenericState = hasGenerics ? "Generic" : "Standard";
  if (category === "Callable") return `Callable:${generic}`;
  return isAfterNew ? `Type:${generic}:New` : `Type:${generic}:Decl`;
}



interface SuffixContext { prefix: string; suffix: string; s: SharpSenseSettings; }

function statementTerminator(ctx: SuffixContext): string {

  return ctx.s.smartSemicolon && shouldAddSemicolon(ctx.prefix, ctx.suffix) ? ";" : "";

}

type SuffixFormatter = (ctx: SuffixContext) => string;



const STRATEGY_MATRIX: Record<string, SuffixFormatter> = {

  // Ghost-free generic: plain `()` after `<>` with only `$0` inside `<>`.
  // No `${0}` inside `()` while editing `<>` => no faint ghost at `()`.
  // Fast path (no intermediate `${1..9}`) uses plain TextEditor.edit + manual
  // selection, not a snippet session, so zero ghost. Tab from `<int|>()`
  // jumps directly inside `()` via the `>()` 2-char tabOut in brackets.ts.
  "Callable:Generic": (ctx) => `<$0>()${statementTerminator(ctx)}`,

  "Callable:Standard": (ctx) => `(\${0})${statementTerminator(ctx)}`,

  "Type:Generic:New": (ctx) => `<$0>()${statementTerminator(ctx)}`,

  "Type:Standard:New": (ctx) => `(\${0})${statementTerminator(ctx)}`,

  "Type:Generic:Decl": () => "<$0>",

  "Type:Standard:Decl": () => "",

  "Bare:PassThrough": () => "",

};



const KEY_RULE: Record<string, MatrixRule> = {

  "Callable:Generic": "R1",

  "Callable:Standard": "R2",

  "Type:Generic:New": "R2",

  "Type:Standard:New": "R2",

  "Type:Generic:Decl": "R3",

  "Type:Standard:Decl": "",

  "Bare:PassThrough": "",

};



const KEY_WHY: Record<string, string> = {

  "Callable:Generic": "R1 generic callable",

  "Callable:Standard": "R2 callable",

  "Type:Generic:New": "R2 construction",

  "Type:Standard:New": "R2 construction",

  "Type:Generic:Decl": "R3 generic type",

};



type PlannedSuffix = { body: string; why: string; rule: MatrixRule; replaceBack?: number };

/**
 * Target-type args for `= new` completions, e.g. `List<int> numbers = new List<>`
 * yields `<int>` when the committed base (`List`) matches the LHS base. Generic
 * over every type (never a per-type list): the args are sliced from the LHS
 * declaration the user already wrote. Returns undefined when there is no usable
 * target (no `=`, `var`, non-declaration `=` like `==`/`=>`, or base mismatch).
 */
function finishTargetArgs(typeText: string, committedBase: string): string | undefined {
  // Strip nullable `?` and array `[]` suffixes (`List<int>?`, `List<int>[]`) before checking.
  let clean = typeText.trim().replace(/\?+$/, '').trim();
  clean = clean.replace(/(\[\s*\])+$/g, '').trim();
  const lt = clean.indexOf('<');
  if (lt === -1 || !clean.endsWith('>')) return undefined;
  const targetBase = clean.slice(0, lt).trim().split('.').pop() ?? '';
  const wantBase = (committedBase.split('.').pop() ?? '').trim();
  if (!targetBase || !wantBase || targetBase !== wantBase) return undefined;
  return clean.slice(lt).trim();
}

function stripLeadingModifiers(t: string): string {
  return t.replace(new RegExp('^(?:(?:' + MODIFIERS + ')\\s+)+', 'i'), '').trim();
}

function findEnclosingMethodReturnType(linesAbove: string[]): string | undefined {
  const limit = Math.min(linesAbove.length, 20);
  let depth = 0;
  let scopeIdx = -1;
  for (let i = 0; i < limit; i++) {
    const line = linesAbove[i];
    for (let j = line.length - 1; j >= 0; j--) {
      const c = line[j];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { scopeIdx = i; break; }
        depth--;
      }
    }
    if (scopeIdx !== -1) break;
  }
  if (scopeIdx === -1) return undefined;
  for (let i = scopeIdx; i < limit; i++) {
    const line = linesAbove[i];
    const clean = stripLeadingTrivia(line).trim();
    if (/^\[.*\]$/.test(clean)) continue;
    const m = clean.match(/([A-Za-z_][\w.<>,\[\]?\s]*?)\s+[A-Za-z_]\w*(?:<[^<>]*>)?\s*\([^()]*\)\s*$/);
    if (!m) continue;
    if (line.includes(' new ')) continue;
    return stripLeadingModifiers(m[1]);
  }
  return undefined;
}

function targetArgsForNew(prefix: string, committedBase: string, scanAbove?: () => string[]): string | undefined {
  let newIdx = prefix.search(/\bnew\s+[A-Za-z_][\w.]*(<[^<>]*>)?$/);
  if (newIdx === -1 && prefix.trimEnd().endsWith('>')) {
    const collapsed = collapseGenericArgs(prefix);
    const cm = collapsed.match(/\bnew\s+([A-Za-z_][\w.]*<>)$/);
    if (cm) {
      const base = cm[1].slice(0, -2);
      newIdx = prefix.search(new RegExp('\\bnew\\s+' + escapeRegExp(base) + '\\s*<'));
    }
  }
  // Bare `new` / `new()` (cast scenario `(List<int>)new` or `(List<int>)new()`) has
  // no identifier yet; still try to infer from cast / LHS.
  if (newIdx === -1 && /\bnew\s*$/.test(prefix)) {
    newIdx = prefix.search(/\bnew\s*$/);
  }
  if (newIdx === -1 && /\bnew\s*\(/.test(prefix)) {
    newIdx = prefix.search(/\bnew\s*\(/);
  }
  if (newIdx === -1) return undefined;
  const beforeNew = prefix.slice(0, newIdx);
  const eqIdx = beforeNew.lastIndexOf('=');
  if (eqIdx !== -1 && /[({]/.test(beforeNew.slice(eqIdx, newIdx))) return undefined;
  const cast = beforeNew.match(/\(\s*([A-Za-z_][\w.<>,\[\]?]*?)\s*\)\s*$/);
  if (cast) return finishTargetArgs(cast[1], committedBase);
  if (/=>\s*$/.test(beforeNew)) {
    const sig = beforeNew.slice(0, beforeNew.search(/=>\s*$/));
    // Support both method `Type Name(...) =>` and property `Type Prop =>` (no parens).
    // Return type may be nested `Dictionary<string,List<int>>` so allow `<>` inside first group.
    const ret = sig.match(/([A-Za-z_][\w.<>,\[\]?\s]*?)\s+[A-Za-z_]\w*(?:<[^<>]*>)?\s*(?:\([^()]*\))?\s*$/);
    if (ret) {
      const rt = stripLeadingModifiers(ret[1].trim());
      // For `Task<List<int>> GetAsync() =>` the first group may greedily include `GetAsync`,
      // so fallback to trimming last word if needed: extract type before last identifier.
      const argsDirect = finishTargetArgs(rt, committedBase);
      if (argsDirect) return argsDirect;
      // Try stricter: `Type Prop` where Prop is property name (no parens) — rt is already type.
      return finishTargetArgs(rt, committedBase);
    }
    return undefined;
  }
  if (/\breturn\s*$/.test(beforeNew)) {
    if (!scanAbove) return undefined;
    const rt = findEnclosingMethodReturnType(scanAbove());
    if (!rt) return undefined;
    return finishTargetArgs(rt, committedBase);
  }
  if (eqIdx === -1) {
    const sib = beforeNew.match(/[?:]\s*new\s+([A-Za-z_][\w.]*<[^<>]*>)\s*\([^()]*\)\s*\?\?\s*$/) ?? beforeNew.match(/\?\s*new\s+([A-Za-z_][\w.]*<[^<>]*>)\s*(\([^()]*\))?\s*:\s*$/);
    if (sib) return finishTargetArgs(sib[1], committedBase);
    return undefined;
  }
  if (/[><!]/.test(beforeNew[eqIdx - 1] ?? '')) return undefined;
  const beforeEq = beforeNew.slice(0, eqIdx);
  // Object-initializer `new Foo { Prop = new List|` contains `{` before `=`; allow
  // the `Prop =` part after the last `{` so target-typed `new` inside initializers
  // can still infer from the property type (via hover fallback later). For now
  // treat it as the segment after `{` if present.
  let effectiveBeforeEq = beforeEq;
  if (beforeEq.includes('{')) {
    const lb = beforeEq.lastIndexOf('{');
    const afterBrace = beforeEq.slice(lb + 1).trim();
    // If after `{` is `Prop` / `Prop =` / `Prop = new` shape, keep it; otherwise
    // the LHS is still the outer declaration (`var x = new Foo`), keep original
    // for outer inference — but don't bail on `{` alone.
    if (/^[A-Za-z_]\w*\s*$/.test(afterBrace) || /^[A-Za-z_]\w*\s*=\s*$/.test(afterBrace)) {
      // Bare `Prop = new` inside initializer — need property type, which requires
      // hover. Signal via cleanEq that has `=` inside but not outer `=`; fallback
      // to undefined for now (hover can upgrade later). Keep as undefined to avoid
      // false outer inference.
      return undefined;
    }
    // Otherwise keep original beforeEq for outer inference, but don't reject
    // solely because it contains `{`.
  } else {
    if (/[=;{}]/.test(beforeEq.replace(/\{[^}]*\}.*$/, '').trimEnd())) {
      // original check for inner `=`/`;`/`{}` outside initializer
      // will be re-checked via typeText below
    }
  }
  const cleanEq = effectiveBeforeEq.replace(/\{[^}]*\}.*$/, '').trimEnd();
  // Don't reject purely on `{` when we handled initializer above; only reject
  // if cleanEq still contains `=`/`;` (multiple assignments) beyond the current `=`.
  if (/[=;]/.test(cleanEq)) return undefined;
  const typeMatch = cleanEq.match(/(.+?)\s+([A-Za-z_]\w*)\s*$/);
  if (!typeMatch) {
    // Assignment to existing variable `x = new List|` where `List<int> x;` declared earlier.
    // Scan the 20 lines above for field/property/parameter/local declarations to infer the target.
    if (scanAbove) {
      const varName = cleanEq.trim().split(/\s+/).pop() ?? '';
      if (/^[A-Za-z_]\w*$/.test(varName)) {
        const lines = scanAbove();
        const escaped = escapeRegExp(varName);
        for (const ln of lines) {
          // Local field/property: `Type name;` or `Type name = ...`
          let vm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${escaped}\\s*[=;]`));
          // Constructor parameter: `Type name` at end of parameter list line (no `;`)
          if (!vm) vm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${escaped}\\s*(?:,|\\)?\\s*\\{|$)`));
          if (vm) {
            const cand = stripLeadingModifiers(vm[1]).trim();
            const args = finishTargetArgs(cand, committedBase);
            if (args) return args;
          }
          // Property: `Type name { get; set; }` or `Type name => ...` (expression-bodied)
          const pm = ln.match(new RegExp(`([A-Za-z_][\\w.<>\\[\\], \\t?]*?)\\s+${escaped}\\s*[{]`));
          if (pm) {
            const cand = stripLeadingModifiers(pm[1]).trim();
            const args = finishTargetArgs(cand, committedBase);
            if (args) return args;
          }
        }
      }
    }
    return undefined;
  }
  const typeTextRaw = typeMatch[1].trim().replace(new RegExp('^(?:(?:' + MODIFIERS + ')\\s+)+', 'i'), '').trim();
  if (isBareModifierHead(beforeNew)) return undefined;
  // `var` with ternary/`??` sibling: `var y = cond ? new List<int>() : new List|`
  // infers from the sibling `new List<int>()` type that appears in beforeNew.
  if (typeTextRaw === 'var') {
    // Find any `new Type<...>` occurrence in beforeNew (the other branch)
    const allNews = [...beforeNew.matchAll(/new\s+([A-Za-z_][\w.<>,\[\]?]+)(?:\s*<[^<>]*>)?/g)];
    // Use collapsed generic form to handle nested `Dictionary<string,List<int>>`
    // but simple capture suffices for the sibling `List<int>` case.
    for (let i = allNews.length - 1; i >= 0; i--) {
      // Reconstruct candidate type from the match (strip leading `new` and trailing `(` part)
      const raw = allNews[i][0].replace(/^\s*new\s+/, '').trim();
      const cand = raw.split('(')[0].trim();
      const args = finishTargetArgs(cand, committedBase);
      if (args) return args;
    }
    return undefined;
  }
  const typeText = typeTextRaw;
  if (!typeText || /^[0-9]/.test(typeText)) return undefined;
  if (/[=;{}]/.test(typeText)) return undefined;
  return finishTargetArgs(typeText, committedBase);
}



function planShadowSuffix(word: string, entry: ShadowEntry, prefix: string, suffix: string, s: SharpSenseSettings, above?: () => string[]): PlannedSuffix {

  const bare = (why: string, rule: MatrixRule): PlannedSuffix => ({ body: "", why, rule });

  const detected = detectInvokeContext(prefix, suffix);

  const slot = slotOf(prefix, detected);

  const rawAfterNew = /\bnew\s+[A-Za-z_][\w.]*$/.test(prefix);

  const afterNew = slot === "TypeInstantiation" || rawAfterNew;

  // Static/abstract/interface types are never constructible with `new`; suppress the construction suffix.
  if (afterNew && isTypeKind(entry.kind)) {

    const dd = (entry.detail ?? '') + '\n' + (entry.doc ?? '');

    if (/\b(static\s+class|abstract\s+class|interface\s+[A-Za-z_])/i.test(dd)) return bare("suppressed (non-constructible type)", "");

  }

  const effectiveSlot = rawAfterNew && slot === "Other" && detected.kind === "existing-parens" ? "TypeInstantiation" as AstSlot : slot;

  const declaration = deriveDeclaration(word, prefix, effectiveSlot, entry);

  const generic = deriveGenericStateForEntry(entry, s, afterNew);

  const key = resolveStrategyKeyForEntry(entry, generic === "Generic", afterNew, declaration);

  // Trivia-tolerant lookahead: strip comments/whitespace so `Foo| /* c */ <int>` still counts as angle-ahead.
  const codeSuffix = stripLeadingTrivia(suffix);
  // Only '<' opening something shaped like type args (or an empty `<>` / a bare
  // `<` at end-of-line, i.e. the user pre-typed the brackets) suppresses; a
  // less-than comparison does not. Charset includes `/` `*` so `/*` inside `<>`
  // does not break the match.
  const hasAngleAhead = /^\s*<\s*(?:[A-Za-z_?\[\]][\w\s,.<>\[\]?\/\*]*)?>/.test(codeSuffix) || /^\s*<\s*$/.test(codeSuffix);

  const hasParenAhead = /^\s*\(/.test(codeSuffix);
  const hasDotAhead = /^\s*\./.test(codeSuffix);

  // Generic type qualifier like `GenericClass.StaticMethod` must stay bare — no `<>`
  // before the dot. Covers two subcases: dot already typed (suffix `.`) and
  // bare qualifier before the user types `.` (invocation slot, not new/decl/generic-arg).
  if (isTypeKind(entry.kind) && generic === "Generic" && hasDotAhead) return bare("suppressed (dot ahead)", KEY_RULE[key] ?? "");
  // Type used as a type in a declaration (`List numbers`, `List<int> x =`) is NOT a
  // qualifier — allow `<>`. Detect by suffix starting with an identifier (the var name)
  // or empty suffix (cursor at end of line, e.g. `List|`).
  const suffixStartsVarName = /^[A-Za-z_]\w*\b/.test(stripLeadingTrivia(suffix));
  const suffixEmptyOrVar = suffixStartsVarName || stripLeadingTrivia(suffix) === '';
  if (isTypeKind(entry.kind) && generic === "Generic" && !afterNew && !declaration && slot === "Invocation" && !isInsideGenericArgs(prefix) && !suffixEmptyOrVar) {
    return bare("suppressed (type qualifier)", KEY_RULE[key] ?? "");
  }

  if (generic === "Generic" && hasAngleAhead) return bare("suppressed (C2 angle present)", KEY_RULE[key] ?? "");

  if (slot === "Other") {

    if (detected.kind === "existing-parens" && generic === "Generic") return { body: "<$0>", why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };

    return bare(`suppressed (${detected.kind})`, "");

  }

  if (hasParenAhead) {

    if (generic === "Generic") return { body: "<$0>", why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };

    return bare("C1 already has parens", "");

  }

  if (generic === "Generic" && /\>\s*$/.test(prefix)) {

    if (key === "Type:Generic:Decl") return bare("generic args already present", "R3");

    // Unbound `<>` / `<,>` after `new` in a target-typed declaration
    // (`List<int> x = new List<>|`): swap the empty brackets for the LHS args
    // so EVERY `new` row just works, whichever row was picked. Uses balanced
    // `extractTrailingAngle` so nested `>>` is handled correctly.
    if (afterNew && isTypeKind(entry.kind)) {
      const angle = extractTrailingAngle(prefix);
      if (angle && /^[\s,]*$/.test(angle.inner)) {
        const args = targetArgsForNew(prefix, baseNameOf(word), above);
        if (args) {
          return { body: `${args}(\${0})${statementTerminator({ prefix, suffix, s })}`, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "", replaceBack: angle.text.length };
        }
      }
    }

    const parenBody = `(\${0})${statementTerminator({ prefix, suffix, s })}`;

    return { body: parenBody, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };

  }

  // Bare generic name after `new` with a matching target-typed LHS
  // (`List<int> x = new List|`): prefill `<int>` instead of an empty `<>`
  // placeholder, so the accept just works.
  if (key === "Type:Generic:New" && generic === "Generic") {
    const args = targetArgsForNew(prefix, baseNameOf(word), above);
    if (args) {
      return { body: `${args}(\${0})${statementTerminator({ prefix, suffix, s })}`, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
    }
  }

  const format = STRATEGY_MATRIX[key];

  if (!format) return bare(`no strategy for ${key}`, "");

  const body = format({ prefix, suffix, s });

  if (!body) {

    if (key === "Type:Standard:Decl") return bare("non-generic type reference", "");

    if (declaration) return bare("R4 declaration", "R4");

    return bare(`R5 kind ${kindName(entry.kind)}`, "R5");

  }

  return { body, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };

}



function locateCommittedWord(doc: vscode.TextDocument, cursor: vscode.Position, spot: PreSpot): { word: string; lineText: string } | undefined {

  const tryLine = (line: number): { word: string; lineText: string } | undefined => {

    if (line < 0 || line >= doc.lineCount || cursor.character === 0) return undefined;

    const lineText = doc.lineAt(line).text;

    if (cursor.character > lineText.length) return undefined;

    const probe = new vscode.Position(line, cursor.character - 1);

    const wordRange = doc.getWordRangeAtPosition(probe);

    const prefixUpToCursor = lineText.slice(0, cursor.character);
    if (!wordRange || wordRange.end.character !== cursor.character) {
      const generic = prefixUpToCursor.match(/([A-Za-z_]\w*)<[^<>]*>$/);
      if (generic && generic.index !== undefined) {
        const base = generic[1];
        const wordStart = generic.index;
        if (wordStart > spot.pos.character) return undefined;
        const typedLen2 = spot.pos.character - wordStart;
        if (typedLen2 < 0) return undefined;
        if (spot.lineText.slice(wordStart, spot.pos.character) !== base.slice(0, typedLen2)) return undefined;
        return { word: base, lineText };
      }
      return undefined;
    }

    if (wordRange.start.character > spot.pos.character) return undefined;

    const word = doc.getText(wordRange);

    const typedLen = spot.pos.character - wordRange.start.character;

    if (typedLen < 0) return undefined;

    if (spot.lineText.slice(wordRange.start.character, spot.pos.character) !== word.slice(0, typedLen)) return undefined;

    return { word, lineText };

  };

  return tryLine(cursor.line) ?? tryLine(cursor.line - 1) ?? tryLine(cursor.line + 1) ?? tryLine(cursor.line - 2) ?? tryLine(cursor.line + 2) ?? tryLine(cursor.line - 3) ?? tryLine(cursor.line + 3);

}



export function registerCommitShadow(context: vscode.ExtensionContext, output: vscode.OutputChannel, getSettings: () => SharpSenseSettings): void {
  logIntegrationProof(output);

  const acceptBuiltIn = () => vscode.commands.executeCommand("acceptSelectedSuggestion");

  const forward = acceptBuiltIn;

  let disposable: vscode.Disposable | undefined;
  let disposableInsert: vscode.Disposable | undefined;
  let disposableReplace: vscode.Disposable | undefined;

  const prefetchCache = new Map<string, { version: number; map: Map<string, ShadowEntry> | undefined }>();
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchInFlight: Promise<unknown> | undefined;
  let prefetchQueued = false;
  const PREFETCH_DEBOUNCE_MS = 120;

  async function runPrefetch(): Promise<void> {
    try {
      const ped = vscode.window.activeTextEditor;
      if (!ped || ped.document.languageId !== "csharp") return;
      if (ped.selections.length !== 1 || !ped.selections[0].isEmpty) return;
      const pdoc = ped.document;
      const ppos = ped.selection.active;
      const lineText = pdoc.lineAt(ppos.line).text;
      const prefix = lineText.slice(0, ppos.character);
      const suffix = lineText.slice(ppos.character);
      if (!/[A-Za-z_0-9>\)\]]$/.test(prefix)) return;
      if (stripLeadingTrivia(suffix).startsWith('(')) return;
      const key = `${pdoc.uri.toString()}|${pdoc.version}|${ppos.line}:${ppos.character}`;
      if (prefetchCache.has(key)) return;
      if (prefetchInFlight) { prefetchQueued = true; return; }
      prefetchInFlight = fetchShadowMap(pdoc, ppos).then((m) => {
        prefetchCache.set(key, { version: pdoc.version, map: m });
        if (prefetchCache.size > 24) {
          const oldest = prefetchCache.keys().next();
          if (!oldest.done) prefetchCache.delete(oldest.value);
        }
      }).catch(() => undefined).finally(() => {
        prefetchInFlight = undefined;
        if (prefetchQueued) { prefetchQueued = false; void runPrefetch(); }
      });
      await prefetchInFlight;
    } catch { /* never break typing */ }
  }

  function schedulePrefetch(): void {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => { void runPrefetch(); }, PREFETCH_DEBOUNCE_MS);
  }

  async function acceptShadow(replaceMode: boolean): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const s = getSettings();

    if (!ed || ed.document.languageId !== "csharp" || !s.smartParens) { void forward(); return; }

    if (!ed.selections.every((sel) => sel.isEmpty)) { void forward(); return; }

    const doc = ed.document;

    const versionBefore = doc.version;

    const pre: PreSpot[] = ed.selections.map((sel) => ({ pos: sel.active, lineText: doc.lineAt(sel.active.line).text }));

    // Perf: fetch Roslyn rows in parallel with the built-in accept so Enter
    // perceived latency is max(accept, fetch) not sum. fetchShadowMap is
    // already two-tier (0-resolve fast path, 20-resolve only if ambiguous
    // generic label-only row) so the common case overlaps entirely with the
    // editor's own accept animation.
    const cacheKey = `${doc.uri.toString()}|${versionBefore}|${ed.selection.active.line}:${ed.selection.active.character}`;
    const cached = prefetchCache.get(cacheKey);
    const mapPromise: Promise<Map<string, ShadowEntry> | undefined> = (cached && cached.version === versionBefore && cached.map) ? Promise.resolve(cached.map) : fetchShadowMap(doc, ed.selection.active).catch(() => undefined);
    await vscode.commands.executeCommand("acceptSelectedSuggestion");
    const after = vscode.window.activeTextEditor;
    const map = await mapPromise;

    if (!map) { output.appendLine("[SharpSense] accept: Roslyn fetch failed, left bare (already accepted)"); return; }

    if (!after || after.document !== doc || doc.version === versionBefore) { output.appendLine("[SharpSense] accept: no document change, nothing to shadow"); return; }

    // Lazily resolve ONLY the words we actually committed, and only when that
    // specific word is ambiguous (generic label, no signature proof). The old
    // code resolved the whole list whenever any single row was ambiguous, so
    // one `GetComponent<T>` in the file made every accept pay a full Roslyn
    // resolve round-trip — the visible `Fu` then `()` split.
    if (map && after) {
      for (let i = 0; i < after.selections.length; i++) {
        const sel = after.selections[i];
        const spot = pre[i];
        if (!spot || !sel.isEmpty) continue;
        const found = locateCommittedWord(doc, sel.active, spot);
        if (!found) continue;
        const base = baseNameOf(found.word);
        const entry = map.get(found.word) ?? map.get(base);
        if (!entry || !entry.needsProof) continue;
        const resolved = await fetchShadowMap(doc, sel.active, found.word).catch(() => undefined);
        if (!resolved) continue;
        const upgraded = resolved.get(found.word) ?? resolved.get(base);
        if (upgraded) {
          map.set(found.word, upgraded);
          map.set(base, upgraded);
        }
      }
    }

    if (after.selections.length > pre.length) { output.appendLine("[SharpSense] accept: cursor count changed, left bare"); return; }

    const groups = new Map<string, vscode.Position[]>();

    const replaceGroups = new Map<string, vscode.Range[]>();

    const verdicts: string[] = [];

    const names: string[] = [];

    // Hover-proof jobs for callable rows that had only a generic label but
    // no signature at fetch time (`needsProof`). At accept time they were
    // correctly treated as Standard (no speculative `<>`), but the exact
    // compiler-resolved symbol under the cursor can prove them Generic — e.g.
    // `GetComponent<PlayerController>()` vs inferrable `Task.FromResult`.
    type HoverJob = { word: string; entry: ShadowEntry; ePos: vscode.Position };
    const hoverJobs: HoverJob[] = [];

    after.selections.forEach((sel, i) => {

      const skip = (why: string) => { verdicts.push(why); };

      if (!sel.isEmpty) { skip("no cursor"); return; }

      const spot = pre[i];

      if (!spot) { skip("no pre-state"); return; }

      const found = locateCommittedWord(doc, sel.active, spot);

      if (!found) { skip("no committable word"); return; }

      const entry = map.get(found.word) ?? map.get(baseNameOf(found.word));

      if (!entry) { skip(`"${found.word}" not in Roslyn list`); return; }

      if (entry.needsProof) hoverJobs.push({ word: found.word, entry, ePos: sel.active });

      const prefix = found.lineText.slice(0, sel.active.character);

      const suffix = found.lineText.slice(sel.active.character);

      const above = () => { const out: string[] = []; for (let l = sel.active.line - 1; l >= Math.max(0, sel.active.line - 20); l--) out.push(doc.lineAt(l).text); return out; };

      const planned = planShadowSuffix(found.word, entry, prefix, suffix, s, above);

      if (!planned.body) { skip(`"${found.word}" bare (${planned.why})`); return; }

      verdicts.push(`"${found.word}" ${planned.rule}`);

      names.push(`${found.word} ${planned.rule}`);

      // Replace mode: delete any word characters immediately after the cursor so
      // the shadow suffix overwrites the old word remainder (e.g. `FooBar|` -> `Foo()`).
      // The committed word's trailing chars (from `locateCommittedWord`) already landed
      // at `sel.active`; anything non-whitespace right after is the stale tail to trim.
      if (replaceMode && suffix.trim() !== '') {
        const afterCursor = suffix;
        const firstBoundary = afterCursor.search(/[A-Za-z0-9_.<>]/);
        if (firstBoundary !== -1) {
          const deleteEnd = sel.active.character + firstBoundary;
          const delRange = new vscode.Range(sel.active, new vscode.Position(sel.active.line, deleteEnd));
          const delList = replaceGroups.get(planned.body) ?? [];
          delList.push(delRange);
          replaceGroups.set(planned.body, delList);
        }
      }

      if (planned.replaceBack && planned.replaceBack > 0 && sel.active.character - planned.replaceBack >= 0) {
        const range = new vscode.Range(sel.active.line, sel.active.character - planned.replaceBack, sel.active.line, sel.active.character);
        const list = replaceGroups.get(planned.body);
        if (list) list.push(range);
        else replaceGroups.set(planned.body, [range]);
        verdicts.push(`"${found.word}" ${planned.rule}`);
        names.push(`${found.word} ${planned.rule}`);
        return;
      }

      const list = groups.get(planned.body);

      if (list) list.push(sel.active);

      else groups.set(planned.body, [sel.active]);

    });

    // Helper: hover-proof for the deferred `needsProof` callables. Runs after
    // the main suffix so inferrable methods (Task.FromResult) never get a
    // speculative `<>`, while true generics (GetComponent<PlayerController>)
    // are upgraded via the compiler-resolved hover text.
    const proveAndUpgrade = async (): Promise<boolean> => {
      if (hoverJobs.length === 0) return false;
      // Geometry guards: document still the accepted one, and job positions
      // still inside the accepted word (not scrolled away / version churned).
      if (!after || after.document !== doc) return false;
      // Collect the subset that still needs proving and whose word range
      // encloses the job position (protects against concurrent edits).
      const pending = hoverJobs.filter((j) => {
        try {
          const r = doc.getWordRangeAtPosition(j.ePos.translate(0, -1));
          if (!r) return false;
          const w = doc.getText(r);
          return w === j.word || w === baseNameOf(j.word) || j.word === w;
        } catch { return false; }
      });
      if (pending.length === 0) return false;

      let upgraded = false;
      for (const job of pending) {
        let hovers: vscode.Hover[] | undefined;
        try {
          const probe = job.ePos.translate(0, -1);
          const p = probe.character >= 0 ? probe : job.ePos;
          hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider", doc.uri, p,
          );
        } catch { continue; }
        if (!hovers || hovers.length === 0) continue;
        const hoverText = hovers.map((h) => {
          const parts: string[] = [];
          for (const c of h.contents) {
            if (typeof c === "string") parts.push(c);
            else if (c && typeof (c as { value?: string }).value === "string") parts.push((c as { value: string }).value);
          }
          return parts.join("\n");
        }).join("\n");
        // Proof predicate: same `isGenericInferrable` rule as commit, but now
        // on the compiler-resolved hover text which is never blank/ambiguous.
        // Only non-inferrable generics upgrade; inferrable `Task.FromResult`
        // stays `()`.
        const sig = methodSignatureText(job.word, hoverText, hoverText) ?? hoverText;
        // Require a call-shaped `<...>(` signature to avoid upgrading on a
        // type hover that merely mentions `Task<T>`.
        const hasCallSig = /<[^<>]*>\s*\(/.test(sig)
          || /<[^<>]*>\s*\(/.test(hoverText);
        if (!hasCallSig) continue;
        const textForVote = sig && /<[^<>]*>\s*\(/.test(sig) ? sig : hoverText;
        if (isGenericInferrable(textForVote)) continue;
        // Suffix guard: already has `<...>` or `(` ahead (e.g. concurrent `<>`
        // insertion or user typed it) — don't duplicate.
        try {
          const lineText = doc.lineAt(job.ePos.line).text;
          const suffix = lineText.slice(job.ePos.character);
          const codeSuffix = stripLeadingTrivia(suffix);
          if (/^\s*<\s*(?:[A-Za-z_?\[\]][\w\s,.<>\[\]?]*)?>/.test(codeSuffix) || /^\s*<\s*$/.test(codeSuffix)) continue;
          if (/^\s*\(/.test(codeSuffix)) continue;
        } catch { /* ignore */ }
        // Proven non-inferrable -> append `<$0>` after the word (ghost-free: plain
        // `()` already inserted, so `<$0>` needs no second tabstop at `()`).
        // Plain `<>` + `()` is inserted via the fast path already; hover only
        // needs the brackets.
        try {
          await after.insertSnippet(new vscode.SnippetString("<$0>"), [job.ePos], { undoStopBefore: false, undoStopAfter: false });
          upgraded = true;
          verdicts.push(`"${job.word}" hover-proven Generic`);
          output.appendLine(`[SharpSense] hover-proof: "${job.word}" upgraded to <\${1}> via hover`);
        } catch { /* never break typing */ }
      }
      return upgraded;
    };

    if (groups.size === 0 && replaceGroups.size === 0) {
      // No immediate suffix, but a deferred hover-proof might still want `<>`.
      if (hoverJobs.length > 0) {
        const didUpgrade = await proveAndUpgrade();
        if (didUpgrade) {
          void vscode.commands.executeCommand("editor.action.triggerParameterHints");
        } else {
          output.appendLine(`[SharpSense] accept: ${verdicts.join("; ") || "no cursors"}`);
        }
      } else {
        output.appendLine(`[SharpSense] accept: ${verdicts.join("; ") || "no cursors"}`);
      }
      return;
    }

    type ShadowOp = { body: string; pos?: vscode.Position; range?: vscode.Range };
    const ops: ShadowOp[] = [];
    for (const [body, positions] of groups) for (const pos of positions) ops.push({ body, pos });
    for (const [body, ranges] of replaceGroups) for (const range of ranges) ops.push({ body, range });

    // Fast path: every planned body carries only the final ${0} (no tab stops
    // to step through), so skip snippet mode entirely — one atomic plain edit,
    // cursors placed by hand. No snippet session means no gray ghost, ever.
    if (ops.length > 0 && ops.every((op) => !hasIntermediateStop(op.body))) {
      await after.edit((builder: vscode.TextEditorEdit) => {
        for (const op of ops) {
          const text = op.body.replace(/\$\{0\}|\$0(?!\d)/g, "");
          if (op.range) builder.replace(op.range, text);
          else if (op.pos) builder.insert(op.pos, text);
        }
      }, { undoStopBefore: false, undoStopAfter: false });
      // All ops land in one atomic edit, so an earlier op on the same line
      // shifts later ones: accumulate a per-line delta in document order.
      const lineDelta = new Map<number, number>();
      const shiftOf = new Map<ShadowOp, number>();
      const byDoc = [...ops].sort((a, b) => {
        const pa = a.range ? a.range.start : a.pos!;
        const pb = b.range ? b.range.start : b.pos!;
        return (pa.line - pb.line) || (pa.character - pb.character);
      });
      for (const op of byDoc) {
        const st = op.range ? op.range.start : op.pos!;
        const text = op.body.replace(/\$\{0\}|\$0(?!\d)/g, "");
        const replaced = op.range ? op.range.end.character - op.range.start.character : 0;
        shiftOf.set(op, lineDelta.get(st.line) ?? 0);
        lineDelta.set(st.line, (lineDelta.get(st.line) ?? 0) + text.length - replaced);
      }
      after.selections = ops.map((op) => {
        const start = op.range ? op.range.start : op.pos!;
        const shift = shiftOf.get(op) ?? 0;
        const idx = finalStopIndex(op.body);
        const text = op.body.replace(/\$\{0\}|\$0(?!\d)/g, "");
        const col = start.character + shift + (idx < 0 ? text.length : idx);
        return new vscode.Selection(start.line, col, start.line, col);
      });
      // Hover upgrades for deferred callables ride on top of the plain edit;
      // do not `return` yet — let the hover path append `<${1}>` before param hints.
      await proveAndUpgrade();
      output.appendLine(`[SharpSense] accept: ${verdicts.join("; ")} => decorated ${names.join(", ")} at ${after.selection.active.line + 1}:${after.selection.active.character} (replace=${replaceMode})`);
      void vscode.commands.executeCommand("editor.action.triggerParameterHints");
      return;
    }

    let singleOk = false;
    let multiOk = false;
    try {
      for (const [body, positions] of groups) {
        const ordered = [...positions].sort((a, b) => (b.line - a.line) || (b.character - a.character));
        try {
          await after.insertSnippet(new vscode.SnippetString(body), ordered, { undoStopBefore: false, undoStopAfter: false });
          if (hasIntermediateStop(body)) multiOk = true;
          else singleOk = true;
        } catch { /* never break typing */ }
      }
      for (const [body, ranges] of replaceGroups) {
        const ordered = [...ranges].sort((a, b) => (b.start.line - a.start.line) || (b.start.character - a.start.character));
        try {
          await after.insertSnippet(new vscode.SnippetString(body), ordered, { undoStopBefore: false, undoStopAfter: false });
          if (hasIntermediateStop(body)) multiOk = true;
          else singleOk = true;
        } catch { /* never break typing */ }
      }
      await proveAndUpgrade();
    } finally {
      // Single-destination JIT snippets (e.g. `new HttpClient(|)`) carry only a
      // final ${0}; exiting snippet mode drops the lingering gray ghost placeholder.
      // Multi-stop bodies (`<${1}>(${0})`) stay in snippet mode so Tab can step.
      // Leave only when no multi-stop body survived, so a merged session's
      // remaining tab stops are never stranded. Hover upgrades introduce a `${1}`
      // and thus make the session multi-stop — don't auto-leave if they fired.
      if (singleOk && !multiOk) {
        try { await vscode.commands.executeCommand("leaveSnippet"); } catch { /* never break typing */ }
      }
    }

    output.appendLine(`[SharpSense] accept: ${verdicts.join("; ")} => decorated ${names.join(", ")} at ${after.selection.active.line + 1}:${after.selection.active.character}`);

    void vscode.commands.executeCommand("editor.action.triggerParameterHints");

  }

  try {
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => { if (getSettings().smartParens) schedulePrefetch(); }));
    context.subscriptions.push({ dispose: () => { if (prefetchTimer) clearTimeout(prefetchTimer); } });

    disposable = vscode.commands.registerCommand("sharpsense.acceptDecorated", async (args?: { trigger?: string }) => {
      const sm = getSettings();
      const replaceMode = args?.trigger === 'tab'
        ? sm.completionTabBehavior === 'replace'
        : sm.completionEnterBehavior === 'replace';
      void acceptShadow(replaceMode);
    });
    disposableInsert = vscode.commands.registerCommand("sharpsense.acceptDecoratedInsert", async () => {
      const sm = getSettings();
      void acceptShadow(sm.completionEnterBehavior === 'replace');
    });
    disposableReplace = vscode.commands.registerCommand("sharpsense.acceptDecoratedReplace", async () => {
      const sm = getSettings();
      void acceptShadow(sm.completionTabBehavior === 'replace');
    });

  } catch (err) {

    output.appendLine(`[SharpSense] commit shadow disabled: ${String(err)}`);

    return;

  }

  context.subscriptions.push(disposable, disposableInsert, disposableReplace);

}


// ---------- Feature C: lightweight in-solution Generate menu ----------

interface FieldInfo {
  type: string;
  name: string;
  param: string;
  assign: string;
  isStatic: boolean;
}

interface MethodInfo {
  name: string;
  returnType: string;
  params: string;
  modifiers: string;
}

interface MemberScan {
  fields: FieldInfo[];
  instanceFields: FieldInfo[];
  memberNames: Set<string>;
  propNames: Set<string>;
  ctorParamKeys: Set<string>;
  hasEquals: boolean;
  hasGetHashCode: boolean;
  hasToString: boolean;
  methodInfos: MethodInfo[];
}

interface TypeSpan {
  name: string;
  genericParams: string;
  openOffset: number;
  closeOffset: number;
  isStaticClass: boolean;
  declStart: number;
}

function matchBraceAt(text: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findTypeSpan(doc: vscode.TextDocument, pos: vscode.Position): TypeSpan | undefined {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const re = /(?:^|[\s;])(class|struct|record)\s+([A-Za-z_]\w*)\s*(<[^>]*>)?/g;
  let m: RegExpExecArray | null;
  let best: TypeSpan | undefined;
  while ((m = re.exec(text)) !== null) {
    let open = -1;
    for (let i = m.index + m[0].length; i < text.length; i++) {
      if (text[i] === '{') { open = i; break; }
      if (text[i] === ';') break;
    }
    if (open === -1) continue;
    const close = matchBraceAt(text, open);
    if (close === -1) continue;
    if (open <= offset && offset <= close) {
      if (!best || (open > best.openOffset && close < best.closeOffset)) {
        const before = text.slice(Math.max(0, m.index), open);
        best = {
          name: m[2],
          genericParams: m[3] ?? '',
          openOffset: open,
          closeOffset: close,
          isStaticClass: /\bstatic\b/.test(before),
          declStart: m.index,
        };
      }
    }
  }
  return best;
}

function relativeDepthAt(doc: vscode.TextDocument, span: TypeSpan, pos: vscode.Position): number {
  const offset = doc.offsetAt(pos);
  const text = doc.getText();
  let depth = 0;
  for (let i = span.openOffset; i < offset && i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function stripLeadingUnderscore(s: string): string { return s.replace(/^_+/, ''); }
function camelCase(s: string): string {
  const b = stripLeadingUnderscore(s);
  return b.length ? b.charAt(0).toLowerCase() + b.slice(1) : b;
}
function pascalCase(s: string): string {
  const b = stripLeadingUnderscore(s);
  return b.length ? b.charAt(0).toUpperCase() + b.slice(1) : b;
}

function scanDirectMembers(body: string, typeName: string, modifiers: string): MemberScan {
  const scan: MemberScan = {
    fields: [], instanceFields: [], memberNames: new Set(), propNames: new Set(),
    ctorParamKeys: new Set(), hasEquals: false, hasGetHashCode: false, hasToString: false, methodInfos: [],
  };
  const lines = body.split(/\r?\n/);
  let depth = 0;
  for (const rawLine of lines) {
    const line = rawLine;
    const entering = depth;
    if (entering === 1) {
      const trimmed = line.trim();
      const modRe = new RegExp(`^\\s*((?:(?:${modifiers})\\s+)*)`, 'i');
      const mods = trimmed.match(modRe)?.[1] ?? '';
      const isStatic = /\bstatic\b/i.test(mods);
      const fieldRe = new RegExp(`^\\s*(?:(?:${modifiers})\\s+)*([A-Za-z_][\\w.<>\\[\\]?]*)\\s+([A-Za-z_]\\w*)\\s*(?:=\\s*[^;]+)?\\s*;$`, 'i');
      const fm = trimmed.match(fieldRe);
      if (fm) {
        const type = fm[1];
        const name = fm[2];
        const param = camelCase(name);
        const assign = name.startsWith('_') ? `${name} = ${param};` : `this.${name} = ${param};`;
        const info: FieldInfo = { type, name, param, assign, isStatic };
        scan.fields.push(info);
        if (!isStatic) scan.instanceFields.push(info);
        scan.memberNames.add(name);
      } else {
        const propRe = new RegExp(`^\\s*(?:(?:${modifiers})\\s+)*([A-Za-z_][\\w.<>\\[\\]?]*)\\s+([A-Za-z_]\\w*)\\s*{`, 'i');
        const pm = trimmed.match(propRe);
        if (pm) {
          const name = pm[2];
          scan.propNames.add(name);
          scan.memberNames.add(name);
        } else {
          const methRe = new RegExp(`^\\s*(?:(?:${modifiers})\\s+)*([A-Za-z_][\\w.<>\\[\\]?]*)\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)`, 'i');
          const mm = trimmed.match(methRe);
          if (mm) {
            const returnType = mm[1];
            const name = mm[2];
            const paramsRaw = mm[3];
            scan.methodInfos.push({ name, returnType, params: paramsRaw, modifiers: mods });
            scan.memberNames.add(name);
            if (name === 'Equals') scan.hasEquals = true;
            if (name === 'GetHashCode') scan.hasGetHashCode = true;
            if (name === 'ToString') scan.hasToString = true;
            if (name === typeName) {
              const paramNames = paramsRaw.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
                const parts = p.split(/\s+/);
                return (parts[parts.length - 1] || '').replace(/^@/, '');
              });
              scan.ctorParamKeys.add(paramNames.join(','));
            }
          }
        }
      }
    }
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
  }
  return scan;
}

function bracedGen(bs: ResolvedBraceStyle, header: string, body: string): string {
  return bs === 'allman' ? `${header}\n{\n${body}\n}` : `${header} {\n${body}\n}`;
}

function escGen(s: string): string { return s.replace(/\$/g, '\\$').replace(/}/g, '\\}'); }

function buildCtor(span: TypeSpan, scan: MemberScan, doc: vscode.TextDocument, settings: SharpSenseSettings): vscode.CompletionItem {
  const bs = cachedBraceStyle(doc, settings.braceStyle);
  const params = scan.instanceFields.map((f) => `${f.type} ${f.param}`).join(', ');
  const assigns = scan.instanceFields.map((f) => `\t${f.assign}`).join('\n');
  const inner = assigns ? `${assigns}\n\t\${0}` : `\t\${0}`;
  const header = `public ${span.name}(${params})`;
  const snippetText = bracedGen(bs, header, inner);
  const item = new vscode.CompletionItem('ctor', vscode.CompletionItemKind.Constructor);
  item.detail = 'SharpSense ctor from fields';
  item.documentation = new vscode.MarkdownString().appendCodeblock(`${header} { ... }`, 'csharp');
  item.insertText = new vscode.SnippetString(snippetText);
  item.sortText = '!0001';
  item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
  return item;
}

function buildPropfull(span: TypeSpan, scan: MemberScan, doc: vscode.TextDocument, settings: SharpSenseSettings): vscode.CompletionItem {
  const bs = cachedBraceStyle(doc, settings.braceStyle);
  const fields = scan.instanceFields.filter((f) => !scan.propNames.has(pascalCase(f.name)) && !scan.memberNames.has(pascalCase(f.name)));
  let snippet = '';
  if (fields.length === 0) {
    snippet = `private \${1:int} \${2:_field};\npublic \${1:int} \${3:Property}\n{\n\tget => \${2:_field};\n\tset => \${2:_field} = value;\n}\${0}`;
  } else {
    const blocks = fields.map((f) => {
      const backing = f.name.startsWith('_') ? f.name : `_${camelCase(f.name)}`;
      const prop = pascalCase(f.name);
      return `private ${f.type} ${backing};\npublic ${f.type} ${prop}\n{\n\tget => ${backing};\n\tset => ${backing} = value;\n}`;
    });
    snippet = blocks.join('\n\n') + '\n\${0}';
  }
  const item = new vscode.CompletionItem('propfull', vscode.CompletionItemKind.Property);
  item.detail = 'SharpSense full property from backing field';
  item.documentation = new vscode.MarkdownString().appendCodeblock('propfull', 'csharp');
  item.insertText = new vscode.SnippetString(snippet);
  item.sortText = '!0002';
  if (fields.length > 0) item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
  return item;
}

function buildEquals(span: TypeSpan, scan: MemberScan, doc: vscode.TextDocument, settings: SharpSenseSettings): vscode.CompletionItem {
  const bs = cachedBraceStyle(doc, settings.braceStyle);
  const fields = scan.instanceFields;
  let equalsBody: string;
  let hcBody: string;
  if (fields.length) {
    equalsBody = `if (ReferenceEquals(this, obj)) return true;\nif (obj is not ${span.name} other) return false;\nreturn ${fields.map((f) => `${f.name} == other.${f.name}`).join(' && ')};`;
    hcBody = `return HashCode.Combine(${fields.map((f) => f.name).join(', ')});`;
  } else {
    equalsBody = 'return ReferenceEquals(this, obj);';
    hcBody = 'return base.GetHashCode();';
  }
  const eqInner = equalsBody.split('\n').map((l) => '\t' + l).join('\n');
  const hcInner = `\t${hcBody}\n\t\${0}`;
  const snippet = bracedGen(bs, 'public override bool Equals(object? obj)', eqInner) + '\n\n' + bracedGen(bs, 'public override int GetHashCode()', hcInner);
  const item = new vscode.CompletionItem('equals', vscode.CompletionItemKind.Method);
  item.detail = 'SharpSense Equals + GetHashCode';
  item.documentation = new vscode.MarkdownString().appendCodeblock('equals', 'csharp');
  item.insertText = new vscode.SnippetString(snippet);
  item.sortText = '!0003';
  item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
  return item;
}

function buildToString(span: TypeSpan, scan: MemberScan, doc: vscode.TextDocument, settings: SharpSenseSettings): vscode.CompletionItem {
  const bs = cachedBraceStyle(doc, settings.braceStyle);
  const fields = scan.instanceFields;
  const parts = fields.map((f) => `${f.name} = {${f.name}}`).join(', ');
  const snippet = `public override string ToString() => $"${span.name} {{ ${parts} }}";\${0}`;
  const item = new vscode.CompletionItem('tostring', vscode.CompletionItemKind.Method);
  item.detail = 'SharpSense ToString';
  item.documentation = new vscode.MarkdownString().appendCodeblock('tostring', 'csharp');
  item.insertText = new vscode.SnippetString(snippet);
  item.sortText = '!0004';
  item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
  return item;
}

interface BaseMember { name: string; returnType: string; params: string; isInterface: boolean; }

async function resolveBaseMembers(doc: vscode.TextDocument, span: TypeSpan, pos: vscode.Position): Promise<BaseMember[]> {
  const text = doc.getText();
  const slice = text.slice(span.declStart, span.openOffset);
  const colonMatch = slice.match(/:\s*([^\{]+)/);
  if (!colonMatch) return [];
  const bases = colonMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  const results: BaseMember[] = [];
  for (const base of bases) {
    const baseName = base.replace(/<.*>$/, '').trim();
    const idx = text.indexOf(baseName, span.declStart);
    if (idx < 0) continue;
    const isInterface = /^[I][A-Z]/.test(baseName);
    let locs: any;
    try {
      locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, doc.positionAt(idx));
    } catch {
      locs = undefined;
    }
    if (!Array.isArray(locs)) continue;
    for (const loc of locs) {
      let targetDoc = doc;
      try {
        if (loc?.uri && loc.uri.toString() !== doc.uri.toString()) {
          targetDoc = await vscode.workspace.openTextDocument(loc.uri);
        }
      } catch {
        continue;
      }
      const targetSpan = findTypeSpan(targetDoc, loc.range.start);
      if (!targetSpan) continue;
      const targetScan = scanDirectMembers(targetDoc.getText().slice(targetSpan.openOffset + 1, targetSpan.closeOffset), targetSpan.name, MODIFIERS);
      for (const mi of targetScan.methodInfos) {
        const isAbsVirt = /\babstract\b/i.test(mi.modifiers) || /\bvirtual\b/i.test(mi.modifiers);
        if (isInterface || isAbsVirt) {
          const arity = mi.params.trim() === '' ? 0 : mi.params.split(',').length;
          results.push({ name: mi.name, returnType: mi.returnType, params: mi.params, isInterface });
        }
      }
    }
  }
  const seen = new Set<string>();
  const out: BaseMember[] = [];
  for (const r of results) {
    const k = `${r.name}:${r.params}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function buildImplement(span: TypeSpan, scan: MemberScan, doc: vscode.TextDocument, pos: vscode.Position, settings: SharpSenseSettings): Promise<vscode.CompletionItem[]> {
  const bs = cachedBraceStyle(doc, settings.braceStyle);
  const members = await resolveBaseMembers(doc, span, pos);
  const items: vscode.CompletionItem[] = [];
  for (const m of members) {
    if (scan.memberNames.has(m.name)) continue;
    const paramList = m.params.trim();
    let snippet = '';
    if (m.isInterface) {
      snippet = `public ${m.returnType} ${m.name}(${paramList}) => throw new NotImplementedException();\${0}`;
    } else {
      const header = `public override ${m.returnType} ${m.name}(${paramList})`;
      const inner = `\tthrow new NotImplementedException();\n\t\${0}`;
      snippet = bracedGen(bs, header, inner);
    }
    const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Method);
    item.detail = `SharpSense ${m.isInterface ? 'implement' : 'override'} ${m.name}`;
    item.documentation = new vscode.MarkdownString().appendCodeblock(snippet.replace(/\${0}/g, ''), 'csharp');
    item.insertText = new vscode.SnippetString(snippet);
    item.sortText = `!0005_${m.name}`;
    item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' };
    items.push(item);
  }
  return items;
}

export function registerGenerateProvider(context: vscode.ExtensionContext, getSettings: () => SharpSenseSettings): void {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      try {
        if (!getSettings().generate || doc.languageId !== 'csharp') return undefined;
        const line = doc.lineAt(pos.line).text;
        const prefix = line.slice(0, pos.character);
        const wordMatch = prefix.match(/([A-Za-z_]\w*)$/);
        const word = wordMatch ? wordMatch[1].toLowerCase() : '';
        if (!word) return undefined;
        const head = wordMatch && wordMatch.index !== undefined ? prefix.slice(0, wordMatch.index) : prefix;
        if (!isLiveScope(head)) return undefined;
        const span = findTypeSpan(doc, pos);
        if (!span) return undefined;
        if (relativeDepthAt(doc, span, pos) !== 1) return undefined;
        const scan = scanDirectMembers(doc.getText().slice(span.openOffset + 1, span.closeOffset), span.name, MODIFIERS);
        const items: vscode.CompletionItem[] = [];
        if ('ctor'.startsWith(word) && scan.instanceFields.length > 0 && !scan.ctorParamKeys.has(scan.instanceFields.map((f) => f.param).join(','))) {
          items.push(buildCtor(span, scan, doc, getSettings()));
        }
        if ('propfull'.startsWith(word)) items.push(buildPropfull(span, scan, doc, getSettings()));
        if ('equals'.startsWith(word) && !(scan.hasEquals || scan.hasGetHashCode)) items.push(buildEquals(span, scan, doc, getSettings()));
        if ('tostring'.startsWith(word) && !scan.hasToString) items.push(buildToString(span, scan, doc, getSettings()));
        if ('implement'.startsWith(word) || 'override'.startsWith(word)) {
          const baseItems = await buildImplement(span, scan, doc, pos, getSettings());
          items.push(...baseItems);
        }
        if (items.length === 0) return undefined;
        const wordStart = pos.character - (wordMatch ? wordMatch[1].length : 0);
        const range = new vscode.Range(pos.line, wordStart, pos.line, pos.character);
        return items.map((it) => { it.range = range; it.filterText = wordMatch?.[1] ?? ''; return it; });
      } catch {
        return undefined;
      }
    },
  };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('csharp', provider));
}
