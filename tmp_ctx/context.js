"use strict";
// SharpSense Phase 1.1 — context detection.
//
// Every function here is pure and synchronous: fast string/regex scans of the
// active editor line only. They run on the keystroke hot path, so they must
// never await Roslyn IPC. Anything needing semantics (completion detail kind,
// generic arity) happens off the hot path in completions.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODIFIERS = void 0;
exports.isBareModifierHead = isBareModifierHead;
exports.detectInvokeContext = detectInvokeContext;
exports.parseGenericArity = parseGenericArity;
exports.isGenericInferrable = isGenericInferrable;
exports.resolveBraceStyle = resolveBraceStyle;
exports.extractPostfixTarget = extractPostfixTarget;
/** Unity message methods never take call-site parens when being defined. */
const UNITY_MESSAGE_NAMES = new Set([
    'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable',
    'OnDestroy', 'OnGUI', 'OnValidate', 'Reset', 'OnTriggerEnter', 'OnTriggerExit',
    'OnTriggerStay', 'OnTriggerEnter2D', 'OnTriggerExit2D', 'OnTriggerStay2D',
    'OnCollisionEnter', 'OnCollisionExit', 'OnCollisionStay', 'OnCollisionEnter2D',
    'OnCollisionExit2D', 'OnCollisionStay2D', 'OnMouseDown', 'OnMouseUp',
    'OnBecameVisible', 'OnBecameInvisible',
]);
const TYPE_KEYWORDS = new Set('void var object string int bool double float decimal'.split(' '));
exports.MODIFIERS = 'public|private|protected|internal|static|readonly|volatile|virtual|override|abstract|sealed|extern|unsafe|async|partial|required|file|scoped|event|const' +
    '|record|class|struct|interface|enum|namespace|using|case';
function isTypeLike(t) {
    if (TYPE_KEYWORDS.has(t)) {
        return true;
    }
    if (t.includes('<') || t.includes('[') || t.endsWith('?')) {
        return true;
    }
    // PascalCase is the C# convention for a named type.
    return /^[A-Z]/.test(t);
}
function stripModifiers(head) {
    const m = head.match(new RegExp(`^(?:(?:${exports.MODIFIERS})\\s+)+`, 'i'));
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
function isBareModifierHead(head) {
    const { hadModifier, rest } = stripModifiers(head.trimStart());
    return hadModifier && rest.trim() === '';
}
/** True when `head` (line text before the identifier under cursor) declares something. */
function isDeclarationHead(head) {
    const { hadModifier, rest } = stripModifiers(head.trimStart());
    const trimmed = rest.trimEnd();
    // `<type> <name>` shape, e.g. `void Foo`, `string Name`, `T Get<T>`.
    const twoWord = trimmed.match(/([A-Za-z_]\w*(?:<[^<>]*>)?(?:\[\])*\??)\s+([A-Za-z_]\w*(?:<[^<>]*>)?)$/);
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
    const single = trimmed.match(new RegExp(`^(?:(?:${exports.MODIFIERS})\\s+)*([A-Za-z_]\\w*(?:<[^<>]*>)?(?:\\[\\])*\\??)$`, 'i'));
    if (single && (hadModifier || isTypeLike(single[1]))) {
        return true;
    }
    return false;
}
/**
 * True when the cursor sits inside the parameter list of a declaration, e.g.
 * `void Foo(DateTime|` — the unclosed `(` belongs to `void Foo`, not a call.
 */
function isInsideDeclarationParens(prefix) {
    let depth = 0;
    for (let i = prefix.length - 1; i >= 0; i--) {
        const c = prefix[i];
        if (c === ')' || c === ']' || c === '}') {
            depth++;
        }
        else if (c === '(' || c === '[' || c === '{') {
            if (depth === 0) {
                return c === '(' && isDeclarationHead(prefix.slice(0, i));
            }
            depth--;
        }
        else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
            return false;
        }
    }
    return false;
}
function detectInvokeContext(prefix, suffix) {
    // Never duplicate: `Foo(|)` or `Foo|()` already has its parens.
    if (/^\s*\(/.test(suffix)) {
        const dupName = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/)?.[1] ?? '';
        return { kind: 'existing-parens', name: dupName };
    }
    // Trailing `new List<string>|` ends with `>`, not an identifier.
    const genericNew = prefix.match(/\bnew\s+([A-Za-z_][\w.]*<[^<>]*>)$/);
    if (genericNew) {
        return { kind: 'object-creation', name: genericNew[1] };
    }
    const nameMatch = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/);
    const name = nameMatch ? nameMatch[1] : '';
    if (!name) {
        return { kind: 'other', name: '' };
    }
    // `nameof(DoSomething|)` — bare identifier, never parens.
    if (/\bnameof\s*\([^()]*$/.test(prefix)) {
        return { kind: 'suppress-nameof', name };
    }
    // `Changed += OnChanged|` / `-=` — delegate reference, never parens.
    if (/[+-]=\s*(?:[\w.]+\.)?[A-Za-z_]\w*$/.test(prefix)) {
        return { kind: 'suppress-plus-equals', name };
    }
    // `[MyAttr|]` — `[` at attribute position (not an indexer like `foo[0|`).
    if (/(?:^|[\s(,=])\[[A-Za-z_]\w*$/.test(prefix)) {
        return { kind: 'attribute', name };
    }
    // `new List|` / `new Foo|` — constructor call.
    if (/\bnew\s+[A-Za-z_][\w.]*$/.test(prefix)) {
        return { kind: 'object-creation', name };
    }
    const rawName = nameMatch?.[0] ?? name;
    const head = prefix.slice(0, prefix.length - rawName.length);
    // Destructor definition at member level, e.g. `~Foo|`. A `~` mid-expression
    // (`x = ~Foo|`) stays an invocation — the complement needs the call result.
    if (new RegExp(`^\\s*(?:(?:${exports.MODIFIERS})\\s+)*~[A-Za-z_]\\w*$`).test(prefix)) {
        return { kind: 'definition', name };
    }
    // `public List|` — the word itself is the type: the head is bare modifiers
    // and the word is type-like. A declaration, never a call.
    const headOnly = stripModifiers(head.trimStart());
    if (headOnly.hadModifier && headOnly.rest.trim() === '' && /^[A-Z]/.test(name)) {
        return { kind: 'definition', name };
    }
    // Member access `obj.Foo|` can never declare — always a call site.
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
    }
    // Unity message stub being started (`Start|` alone on a line) is a
    // definition in progress, not a call site.
    if (UNITY_MESSAGE_NAMES.has(name) && /^\s*[A-Za-z_]\w*(<[^<>]*>)?$/.test(prefix)) {
        return { kind: 'unity-message-definition', name };
    }
    return { kind: 'invocation', name };
}
/** Arity of the generic parameter list in a Roslyn detail string, 0 when none. */
function parseGenericArity(detail) {
    // Prefer the method's own generic arity (the <...> immediately before '(')
    // over the first generic in the string (which may be a return-type like Task<T>).
    const method = detail.match(/[A-Za-z_]\w*\s*<([^<>]*)>\s*\(/);
    if (method) {
        return method[1]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0).length;
    }
    const m = detail.match(/<([^<>]*)>/);
    if (!m) {
        return 0;
    }
    return m[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
}
/**
 * Heuristic for "can the user omit `<>`": every type parameter must appear in
 * the parameter list, e.g. `void Foo<T>(T x)` infers, `T Get<T>(string name)` does not.
 */
function isGenericInferrable(detail) {
    const named = detail.match(/([A-Za-z_]\w*)\s*<([^<>]*)>\s*\(/);
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
    const parenStart = detail.indexOf('(', named.index ?? 0);
    const parenEnd = detail.lastIndexOf(')');
    if (parenStart < 0 || parenEnd <= parenStart) {
        return false;
    }
    const params = detail.slice(parenStart, parenEnd + 1);
    return typeParams.every((t) => new RegExp(`\\b${t}\\b`).test(params));
}
function resolveBraceStyle(setting, documentText) {
    if (setting === 'allman' || setting === 'k&r') {
        return setting;
    }
    // `inherit`: follow the file (which usually follows .editorconfig), Allman on ties.
    const sample = documentText.length > 100000 ? documentText.slice(0, 100000) : documentText;
    const allman = (sample.match(/\)[ \t]*\r?\n\s*\{/g) ?? []).length;
    const sameLine = (sample.match(/\)[ \t]*\{/g) ?? []).length;
    if (allman === 0 && sameLine === 0) {
        return 'allman';
    }
    return allman >= sameLine ? 'allman' : 'k&r';
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
function extractPostfixTarget(prefix) {
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
