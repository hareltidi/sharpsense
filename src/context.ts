// SharpSense Phase 1.1 — context detection.
//
// Every function here is pure and synchronous: fast string/regex scans of the
// active editor line only. They run on the keystroke hot path, so they must
// never await Roslyn IPC. Anything needing semantics (completion detail kind,
// generic arity) happens off the hot path in completions.ts.

export type BraceStyleSetting = 'allman' | 'k&r' | 'inherit';
export type ResolvedBraceStyle = 'allman' | 'k&r';

export interface SharpSenseSettings {
  smartParens: boolean;
  smartGenerics: boolean;
  smartBackspace: boolean;
  tabOut: boolean;
  overtype: boolean;
  postfix: boolean;
  verbose: boolean;
  braceStyle: BraceStyleSetting;
  smartSemicolon: boolean;
  generate: boolean;
  backspaceUnindentMode: 'toUnindent' | 'toTabstop' | 'toProper' | 'none';
  completionEnterBehavior: 'insert' | 'replace';
  completionTabBehavior: 'insert' | 'replace';
  smartSurroundWithBraces: boolean;
}

export type InvokeKind =
  | 'invocation'
  | 'definition'
  | 'unity-message-definition'
  | 'object-creation'
  | 'attribute'
  | 'suppress-plus-equals'
  | 'suppress-nameof'
  | 'existing-parens'
  | 'other';

export interface InvokeContext {
  kind: InvokeKind;
  /** Bare identifier under the cursor ('' when the cursor is not on one). */
  name: string;
}

/** Unity message methods never take call-site parens when being defined. */
const UNITY_MESSAGE_NAMES = new Set([
  'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable',
  'OnDestroy', 'OnGUI', 'OnValidate', 'Reset', 'OnTriggerEnter', 'OnTriggerExit',
  'OnTriggerStay', 'OnTriggerEnter2D', 'OnTriggerExit2D', 'OnTriggerStay2D',
  'OnCollisionEnter', 'OnCollisionExit', 'OnCollisionStay', 'OnCollisionEnter2D',
  'OnCollisionExit2D', 'OnCollisionStay2D', 'OnMouseDown', 'OnMouseUp',
  'OnBecameVisible', 'OnBecameInvisible',
]);

const TYPE_KEYWORDS = new Set(
  'void var object string int bool double float decimal char byte sbyte short ushort uint long ulong nint nuint dynamic'.split(' '),
);

export const MODIFIERS =
  'public|private|protected|internal|static|readonly|volatile|virtual|override|abstract|sealed|extern|unsafe|async|partial|required|file|scoped|event|const' +
  '|record|class|struct|interface|enum|namespace|using|case|new|implicit|explicit|operator';

function isTypeLike(t: string): boolean {
  if (TYPE_KEYWORDS.has(t)) {
    return true;
  }
  if (t.includes('<') || t.includes('[') || t.endsWith('?')) {
    return true;
  }
  // PascalCase is the C# convention for a named type.
  return /^[A-Z]/.test(t);
}

function stripModifiers(head: string): { hadModifier: boolean; rest: string } {
  const m = head.match(new RegExp(`^(?:(?:${MODIFIERS})\\s+)+`, 'i'));
  if (!m) {
    return { hadModifier: false, rest: head };
  }
  return { hadModifier: true, rest: head.slice(m[0].length) };
}

/**
 * True when `head` (line text before the word under cursor) is modifiers only,
 * e.g. `public ` — the word is a type reference (`public List|`) or a ctor
 * name, never a qualified definition. Reuses the single MODIFIERS source so
 * the list lives in exactly one place (SSCE Core Law: no duplicated lists).
 */
export function isBareModifierHead(head: string): boolean {
  const { hadModifier, rest } = stripModifiers(head.trimStart());
  return hadModifier && rest.trim() === '';
}

/**
 * Collapse balanced `<...>` generic argument lists to `<>` so downstream
 * single-level patterns handle arbitrarily nested generics
 * (`Dictionary<string, List<int>>` -> `Dictionary<>`). Unbalanced `<`
 * (less-than operators) have no matching close and pass through untouched.
 */
export function collapseGenericArgs(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '<') {
      out += c;
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    while (j < s.length) {
      if (s[j] === '<') {
        depth++;
      } else if (s[j] === '>') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      j++;
    }
    if (depth === 0) {
      out += '<>';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Strip leading whitespace and comments so syntactic lookaheads ignore trivia. */
export function stripLeadingTrivia(s: string): string {
  return s.replace(/^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+/, '');
}

/** Strip leading attribute lists `[Attr]` / `[Attr, Attr2]` so declaration checks ignore them. */
export function stripAttributeTrivia(s: string): string {
  return s.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '');
}

/** True when `head` (line text before the identifier under cursor) declares something. */
function isDeclarationHead(head: string): boolean {
  const withoutAttrs = stripAttributeTrivia(head);
  const { hadModifier, rest } = stripModifiers(withoutAttrs.trimStart());
  const trimmed = rest.trimEnd();
  // Collapse nested generics first so `<>` below matches qualified and
  // arbitrarily-nested type spellings (`Dictionary<string, List<int>> x`).
  const collapsed = collapseGenericArgs(trimmed);
  // `<type> <name>` shape, e.g. `void Foo`, `string Name`, `T Get<T>`,
  // `System.Text.StringBuilder sb`, `Dictionary<string, List<int>> map`.
  const twoWord = collapsed.match(/((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:<>)?(?:\[\])*\??)\s+([A-Za-z_]\w*(?:<>)?)$/);
  if (twoWord && isTypeLike(twoWord[1])) {
    return true;
  }
  // Modifier-only constructor head, e.g. `public Foo` (no return type).
  if (hadModifier && /^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) {
    return true;
  }
  // Bare `<type>` head, e.g. `void Foo|`, `List Bar|`, `public List<int> items|`
  // (head `public List<int>`). The regex is start-anchored, so only a head that
  // is exactly [modifiers +] one type matches — real statements (`x = `,
  // `M(a, `, `{ `) can never hit this.
  const single = collapsed.match(new RegExp(`^(?:(?:${MODIFIERS})\\s+)*((?:[A-Za-z_]\\w*\\.)*[A-Za-z_]\\w*(?:<>)?(?:\\[\\])*\\??)$`, 'i'));
  if (single && (hadModifier || isTypeLike(single[1]))) {
    return true;
  }
  return false;
}

/**
 * True when the cursor sits inside the parameter list of a declaration, e.g.
 * `void Foo(DateTime|` — the unclosed `(` belongs to `void Foo`, not a call.
 */
function isInsideDeclarationParens(prefix: string): boolean {
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        return c === '(' && isDeclarationHead(prefix.slice(0, i));
      }
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      return false;
    }
  }
  return false;
}

export function detectInvokeContext(prefix: string, suffix: string): InvokeContext {
  // Never duplicate: `Foo(|)` or `Foo|()` already has its parens.
  // Trivia-tolerant so `Foo| /* c */ (...)` is still a duplicate.
  if (/^\s*\(/.test(stripLeadingTrivia(suffix))) {
    const dupName = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/)?.[1] ?? '';
    return { kind: 'existing-parens', name: dupName };
  }
  // Trailing `new List<string>|` ends with `>`, not an identifier.
  // Single-level `<...>` is the fast path; a balanced-angle fallback covers
  // nested generics (`new Dictionary<string, List<int>>|`, collapsed to `<>`).
  const genericNew =
    prefix.match(/\bnew\s+([A-Za-z_][\w.]*<[^<>]*>)$/) ??
    collapseGenericArgs(prefix).match(/\bnew\s+([A-Za-z_][\w.]*<>)$/);
  if (genericNew) {
    return { kind: 'object-creation', name: genericNew[1] };
  }

  const nameMatch = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/);
  const name = nameMatch ? nameMatch[1] : '';
  if (!name) {
    return { kind: 'other', name: '' };
  }

  // `nameof(DoSomething|)` — bare identifier, never parens. Depth-walked so
  // nested calls (`nameof(Foo(Bar|))`) still suppress; a closed `nameof(...)`
  // earlier on the line no longer suppresses what follows it.
  const nameofIdx = prefix.search(/\bnameof\s*\(/);
  if (nameofIdx !== -1) {
    let depth = 0;
    for (let i = nameofIdx; i < prefix.length; i++) {
      if (prefix[i] === '(') {
        depth++;
      } else if (prefix[i] === ')') {
        depth--;
      }
    }
    if (depth > 0) {
      return { kind: 'suppress-nameof', name };
    }
  }
  // `Changed += OnChanged|` / `-=` — delegate reference, never parens.
  if (/[+-]=\s*(?:[\w.]+\.)?[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: 'suppress-plus-equals', name };
  }
  // `[MyAttr|]` / `[Test, MyAttr|]` — `[` at attribute position (not an
  // indexer like `foo[0|`, where `[` follows a word character).
  if (/(?:^|[\s(,=])\[[^\[\]]*?[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: 'attribute', name };
  }
  // `new List|` / `new Foo|` — constructor call.
  if (/\bnew\s+[A-Za-z_][\w.]*$/.test(prefix)) {
    return { kind: 'object-creation', name };
  }

  const rawName = nameMatch?.[0] ?? name;
  const head = prefix.slice(0, prefix.length - rawName.length);
  // Destructor definition at member level, e.g. `~Foo|`. Scope-aware: only after
  // `{` / `}` / `;` or start-of-line, so `x = ~Foo|` stays invocation (complement).
  {
    const lastScope = Math.max(prefix.lastIndexOf('{'), prefix.lastIndexOf('}'), prefix.lastIndexOf(';'));
    const afterScope = lastScope >= 0 ? prefix.slice(lastScope + 1) : prefix;
    if (new RegExp(`^\\s*(?:(?:${MODIFIERS})\\s+)*~[A-Za-z_]\\w*\\s*$`).test(afterScope)) {
      return { kind: 'definition', name };
    }
  }
  // `public List|` — the word itself is the type: the head is bare modifiers
  // and the word is type-like. A declaration, never a call.
  const headOnly = stripModifiers(stripAttributeTrivia(head).trimStart());
  if (headOnly.hadModifier && headOnly.rest.trim() === '' && /^[A-Z]/.test(name)) {
    return { kind: 'definition', name };
  }
  // Explicit interface impl `void IFoo.Bar|` — dotted member name is a
  // definition, not a member access. Line-local heuristic: qualified name
  // ends with `Interface.Member` where interface is PascalCase, and the
  // Explicit interface impl `void IFoo.Bar|` — dotted member name is a
  // definition, not a member access. Line-local heuristic: qualified name
  // ends with `Interface.Member` where interface is PascalCase, and the
  // preceding head looks like a declaration (return type / modifiers). Empty
  // head (e.g. `Array.Clear|` at invocation) is *not* a definition — that
  // is `Type.StaticMethod` invocation, not `IFoo.Bar` definition.
  {
    const qm = prefix.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?:<[^<>]*>)?$/);
    if (qm) {
      const qualified = qm[1];
      const lastDot = qualified.lastIndexOf('.');
      const ifacePart = qualified.slice(0, lastDot);
      const memberPart = qualified.slice(lastDot + 1);
      const ifaceBase = ifacePart.split('.').pop() ?? '';
      if (/^[A-Z]/.test(ifaceBase) && memberPart === name) {
        const beforeQualified = prefix.slice(0, prefix.length - qm[0].length);
        const bt = beforeQualified.trimEnd();
        const lastChar = bt.slice(-1);
        const looksLikeInvocationChar = /[=(\[,;]/.test(lastChar);
        if (!looksLikeInvocationChar) {
          const lastToken = (bt.split(/\s+/).pop() ?? '').replace(/<.*>$/, '');
          const probe = bt.trim() !== '' && (isDeclarationHead(bt) || isBareModifierHead(bt) || isTypeLike(lastToken));
          if (probe) return { kind: 'definition', name };
        }
      }
    }
  }
  // Member access `obj.Foo|` can never declare — always a call site.
  // Explicit interface impl already returned above, so remaining dotted
  // heads are true member accesses (e.g. `obj.Method|`) and stay invocation.
  if (!head.trimEnd().endsWith('.')) {
    // Parameter list of a declaration, e.g. `void Foo(DateTime|`.
    if (isInsideDeclarationParens(prefix)) {
      return {
        kind: UNITY_MESSAGE_NAMES.has(name) ? 'unity-message-definition' : 'definition',
        name,
      };
    }
    // Declaration head, e.g. `void Foo|` or `public T Get<T>|`.
    if (isDeclarationHead(head)) {
      return {
        kind: UNITY_MESSAGE_NAMES.has(name) ? 'unity-message-definition' : 'definition',
        name,
      };
    }
    // Local variable/type declaration with no modifiers/head, e.g. `List<int> numbers = ...`
    // or `List numbers;` — identifier followed by optional generics then comma/equals/semicolon/bracket/newline.
    if (/^[A-Z]/.test(name)) {
      const codeSuffix = stripLeadingTrivia(suffix);
      if (/^(?:[A-Za-z_]\w*(?:\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>)?)\s*(?:[=,;)\]\{]|$)/.test(codeSuffix)) {
        return { kind: 'definition', name };
      }
    }
  }
  return { kind: 'invocation', name };
}

/** Arity of the generic parameter list in a Roslyn detail string, 0 when none. */
export function parseGenericArity(detail: string): number {
  // Prefer the method's own generic arity (the <...> immediately before '(')
  // over the first generic in the string (which may be a return-type like Task<T>).
  const method = detail.match(/[A-Za-z_]\w*\s*<([^<>]*)>\s*\(/);
  if (method) {
    return method[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
  }
  // Fallback previously counted return-type generics (e.g. Task<T> GetTask())
  // as method arity — wrong. Only count method generics.
  return 0;
}

/**
 * Heuristic for "can the user omit `<>`": every type parameter must appear in
 * the parameter list, e.g. `void Foo<T>(T x)` infers, `T Get<T>(string name)` does not.
 */
export function isGenericInferrable(detail: string): boolean {
  const clean = detail.replace(/^\s*\([^)]*\)\s*/, '');
  const named = clean.match(/([A-Za-z_]\w*)\s*<([^<>]*)>\s*\(/);
  if (!named) {
    return true;
  }
  const typeParams = named[2]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (typeParams.length === 0) {
    return true;
  }
  const parenStart = clean.indexOf('(', named.index ?? 0);
  // Find matching ')' for the parameter list, not lastIndexOf which
  // incorrectly includes trailing "where T : new()" containing ')'
  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < clean.length; i++) {
    const c = clean[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) { parenEnd = i; break; }
    }
  }
  if (parenStart < 0 || parenEnd <= parenStart) {
    return false;
  }
  const params = clean.slice(parenStart, parenEnd + 1);
  return typeParams.every((t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(params));
}

export function resolveBraceStyle(
  setting: BraceStyleSetting,
  documentText: string,
): ResolvedBraceStyle {
  if (setting === 'allman' || setting === 'k&r') {
    return setting;
  }
  // `inherit`: follow the file (which usually follows .editorconfig), Allman on ties.
  const sample = documentText.length > 100_000 ? documentText.slice(0, 100_000) : documentText;
  const allman = (sample.match(/\)[ \t]*\r?\n\s*\{/g) ?? []).length;
  const sameLine = (sample.match(/\)[ \t]*\{/g) ?? []).length;
  if (allman === 0 && sameLine === 0) {
    return 'allman';
  }
  return allman >= sameLine ? 'allman' : 'k&r';
}

export interface PostfixTarget {
  /** The receiver expression text, e.g. `Foo(1, x)`. */
  expr: string;
  /** Partial trigger after the dot, e.g. `i` for `expr.i|`. May be ''. */
  trigger: string;
  /** Column (within the line prefix) where `expr` starts. */
  exprStart: number;
}

// Deliberately excludes `<` `>` (generics), `.` (fluent chains) and `?`
// (nullables / `?.`); `(` `[` `{` are handled by depth counting instead.
const POSTFIX_STOP_AT_DEPTH_ZERO = new Set([
  ';', '{', '}', '=', ',', ':', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', ' ', '\t',
]);

/**
 * Split a line prefix like `var x = Foo(1, y).if` into receiver + trigger.
 * Walks back with bracket-depth counting so commas/ops inside calls don't
 * split the expression. Sync and line-bounded for the hot path.
 */
export function extractPostfixTarget(prefix: string): PostfixTarget | null {
  const dot = prefix.match(/\.([A-Za-z_]*)$/);
  if (!dot || dot.index === undefined) {
    return null;
  }
  const trigger = dot[1];
  const dotIndex = dot.index;
  let depth = 0;
  let i = dotIndex - 1;
  for (; i >= 0; i--) {
    const c = prefix[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        break;
      }
      depth--;
      continue;
    }
    if (depth === 0 && POSTFIX_STOP_AT_DEPTH_ZERO.has(c)) {
      break;
    }
  }
  let exprStart = i + 1;
  while (exprStart < dotIndex && (prefix[exprStart] === ' ' || prefix[exprStart] === '\t')) {
    exprStart++;
  }
  // Leftover `>` from `x=>x.if` (bare `=` stops the walk, `>` doesn't).
  while (exprStart < dotIndex && (prefix[exprStart] === '>' || prefix[exprStart] === '=')) {
    exprStart++;
  }
  const expr = prefix.slice(exprStart, dotIndex).trim();
  if (!expr || !/[A-Za-z0-9_)\]"']$/.test(expr)) {
    return null;
  }
  return { expr, trigger, exprStart };
}
