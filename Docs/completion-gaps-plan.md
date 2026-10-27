# Filling the Rider Completion Gaps — SharpSense Plan

> Synthesis of three research reports: **Scope** (Rider/ReSharper parity, hard exclusions), **Postfix + Surround** (`.else`/`.while`/… template set + selection wrap), and **Generate** (lightweight syntactic Generate provider). All work is additive and built on the existing commit-shadow model, Roslyn-as-black-box consumer calls, and structural/syntactic text analysis — **no Roslyn fork**.

## 1. Scope & Hard Exclusions

**What we are building:** Rider/ReSharper-style *completion parity* on VS Code — the UX affordances (postfix expansion, surround-with, a Generate-style member stubber, smarter target-typed `new`, extended JIT live templates, complete-statement) that the base C# toolchain does not surface as first-class completion gestures.

**Hard exclusions (owner-mandated + derived).** SharpSense is shipped *alongside* `ms-dotnettools.csharp`, `ms-dotnettools.csdevkit`, and the Unity extension via `extensionPack`. Together those three plus SharpSense are effectively **one big package** — SharpSense only fills the gaps they leave. We do **not** reimplement what they already own:

| Excluded | Rider equivalent | Why (owned by base package) |
|---|---|---|
| Full-line / AI completion | Junie | Explicit user mandate — Junie's job |
| Basic IntelliSense / symbol completion | Basic completion | C# Dev Kit + csharp extension |
| Parameter info / hints | Parameter info | Roslyn + editor (`triggerParameterHints` already leveraged) |
| Auto-import / `using` / remove-unused | Import fixes | Roslyn code actions |
| Smart type-filtering / expected-type ranking | Type-based sorting | Roslyn / C# Dev Kit |
| Unity message IntelliSense | Unity support | Unity extension |
| Generate-menu *semantic* items (cross-file/assembly members, full Equals+GetHashCode, interface impls) | Generate menu | Roslyn code actions surfaced via the lightbulb |
| Double completion (nested delegate/collection expected-type) | Double completion | Needs Roslyn expected-type semantics on nested contexts |
| Navigate / Find-usages / Rename / Go-to / File-structure | Navigation | Base package + Dev Kit Solution Explorer |
| XML doc `///` generation | Doc-comment | C# extension |

**The fillable surface** (from the scope research, all buildable with `vscode.execute*` + syntactic/structural analysis):

- **Postfix expansion** — close the postfix template set (`.else`/`.while`/`.lock`/`.do`/`.not`/`.par`/`.is`/`.name`/`.new`/`.checked`/`.unchecked`/`.comment`/`.let`/`.repeat`). Pure expression wrapping; reuses `expand(expr,bs)` in `src/postfix.ts`.
- **Surround-with** — selection-wrap command (if/while/for/foreach/using/try/lock/region) on a chosen range.
- **Generate menu (lightweight, in-solution only)** — `ctor` from fields, `propfull`, `Equals`+`GetHashCode`, `ToString`, `implement`/`override` stubs. Syntactic + one `executeDefinitionProvider` hop; full cross-file/metadata fidelity is deferred (see §9).
- **Smarter ExpectedNew prefill** — object-initializer `{ Prop = }` for *in-solution* types via `executeDocumentSymbolProvider`; no-op fallback for external types. (Deferred from this plan's core three features; tracked as a follow-up.)
- **Extended JIT live templates** (`cw`/`sw`/`tryf`/`ctor`/loops) and **Complete-Statement** command — high-value syntactic additions noted in §7.

**Deferred:** double-completion (needs base-package expected-type semantics on nested contexts). The Generate *semantic* items above are built only in their lightweight, in-solution form here.

## 2. Feature A — Postfix Expansion

**Grounding.** `src/postfix.ts`: `POSTFIX_TEMPLATES` (lines 37–120) currently holds `var if null notnull for foreach return await using try throw cast as switch`. Helpers already present and reused: `esc` (16–18, escapes `$`/`}`), `braced(bs, header, body)` (20–25, Allman vs K&R via `ResolvedBraceStyle`), `snip` (27–29). `findPostfixTemplates` (122–125) does `trigger.startsWith(p)` — already correct for shared prefixes (e.g. `fo` → `for`+`foreach`); **no change needed**.
`src/completions.ts`: `registerPostfixProvider` (250–325) — only rank knob is `POSTFIX_RANK` (298–301). Brace style arrives via `cachedBraceStyle(doc, getSettings().braceStyle)` (79–101), passed to `t.expand(target.expr, bs)`. Ghost-free rule at 311–313: any single-`$0` snippet gets `command: sharpsense.leaveSnippetDelayed` so the lone `$0` session exits without a gray caret (mirrors `LIVE_TEMPLATES`, 339–362).

**Templates to ADD** (all single-stop `$0` except where a `${1:...}` is genuinely needed, so they stay ghost-free and inherit `leaveSnippetDelayed` automatically):

| Trigger | C# emitted | Notes |
|---|---|---|
| `.else` | `if (!(e)) { }` | `braced(bs, 'if (!(' + esc(e) + '))', '$0')` — parenthesized negation (precedence-safe) |
| `.while` | `while (e) { }` | `braced(bs, 'while (' + esc(e) + ')', '$0')` |
| `.lock` | `lock (e) { }` | `braced(bs, 'lock (' + esc(e) + ')', '$0')` |
| `.do` | `do { } while (e);` | **custom** `doForm(bs, esc(e))` — trailing `while` can't use `braced` |
| `.not` | `!(e)` | expression form, `${esc(e)}$0` |
| `.par` | `(e)` | parenthesize |
| `.is` | `e is Type` | `${esc(e)} is ${1:Type}$0` — numbered stop (intentional session) |
| `.name` | `nameof(e)` | `nameof(${esc(e)})$0` |
| `.new` | `new Type()` | `new ${esc(e)}(\${0})` — `e` is a type e.g. `List<int>` |
| `.checked` | `checked (e)` | expr form |
| `.unchecked` | `unchecked (e)` | expr form |
| `.comment` | `/* e */` | |
| `.let` | `var name = e;` | `var ${1:name} = ${esc(e)};$0` — effective `.var` synonym (see caveat) |
| `.repeat` | `for (var i = 0; i < e; i++) { }` | `braced(bs, 'for (var ${1:i} = 0; ${1:i} < ' + esc(e) + '; ${1:i}++)', '$0')` — overlaps `.for`/`.foreach` (see caveat) |

Previews follow existing style: `.else` → `if (!(e)) { ... }`, `.while` → `while (e) { ... }`.

`doForm` (new helper near `braced`, line 25):
```ts
function doForm(bs: ResolvedBraceStyle, cond: string): string {
  const body = '$0';
  return bs === 'allman'
    ? `do\n{\n\t${body}\n}\nwhile (${cond});`
    : `do {\n\t${body}\n} while (${cond});`;
}
```

**Exact changes — `src/postfix.ts`:**
1. Append entries to `POSTFIX_TEMPLATES` (after line 119), reusing `braced`/`esc`/`snip`/`doForm`:
```ts
{ trigger: 'else', description: 'if (!(expr)) { }',
  expand: (e, bs) => snip(braced(bs, `if (!(${esc(e)}))`, '$0'), `if (!(${e})) { ... }`) },
{ trigger: 'while', description: 'while (expr) { }',
  expand: (e, bs) => snip(braced(bs, `while (${esc(e)})`, '$0'), `while (${e}) { ... }`) },
{ trigger: 'lock', description: 'lock (expr) { }',
  expand: (e, bs) => snip(braced(bs, `lock (${esc(e)})`, '$0'), `lock (${e}) { ... }`) },
{ trigger: 'do', description: 'do { } while (expr);',
  expand: (e, bs) => snip(doForm(bs, esc(e)), `do { ... } while (${e});`) },
{ trigger: 'not', description: '!(expr)', expand: (e) => snip(`!(${esc(e)})$0`, `!(${e})`) },
{ trigger: 'par', description: '(expr)', expand: (e) => snip(`(${esc(e)})$0`, `(${e})`) },
{ trigger: 'is', description: 'expr is Type', expand: (e) => snip(`${esc(e)} is \${1:Type}$0`, `${e} is Type`) },
{ trigger: 'name', description: 'nameof(expr)', expand: (e) => snip(`nameof(${esc(e)})$0`, `nameof(${e})`) },
{ trigger: 'new', description: 'new Type()', expand: (e) => snip(`new ${esc(e)}(\${0})`, `new ${e}()`) },
{ trigger: 'checked', description: 'checked (expr)', expand: (e) => snip(`checked (${esc(e)})$0`, `checked (${e})`) },
{ trigger: 'unchecked', description: 'unchecked (expr)', expand: (e) => snip(`unchecked (${esc(e)})$0`, `unchecked (${e})`) },
{ trigger: 'comment', description: '/* expr */', expand: (e) => snip(`/* ${esc(e)} */$0`, `/* ${e} */`) },
{ trigger: 'let', description: 'var name = expr;', expand: (e) => snip(`var \${1:name} = ${esc(e)};$0`, `var name = ${e};`) },
{ trigger: 'repeat', description: 'for (var i = 0; i < expr; i++) { }',
  expand: (e, bs) => snip(braced(bs, `for (var \${1:i} = 0; \${1:i} < ${esc(e)}; \${1:i}++)`, '$0'), `for (var i = 0; i < ${e}; i++) { ... }`) },
```
2. Add `doForm` near `braced` (line 25). 3. `findPostfixTemplates` unchanged.

**Exact changes — `src/completions.ts`:** extend `POSTFIX_RANK` (298–301), appending after `switch: 13` so existing ordering is preserved:
```ts
const POSTFIX_RANK: Record<string, number> = {
  await: 0, foreach: 1, for: 2, var: 3, if: 4, null: 5, notnull: 6,
  return: 7, using: 8, try: 9, throw: 10, cast: 11, as: 12, switch: 13,
  do: 14, while: 15, else: 16, lock: 17, not: 18, par: 19, let: 20,
  is: 21, name: 22, new: 23, checked: 24, unchecked: 25, comment: 26, repeat: 27,
};
```
Ghost-free attach (311–313) and `cachedBraceStyle` plumbing (274) need **no change** — new single-stop templates inherit `sharpsense.leaveSnippetDelayed`; `.is`/`.let`/`.repeat` (with `${1:...}`) keep a normal session like existing `.for`/`.cast`.

**Caveats (developer decisions):**
- **`.let`** is a Kotlin construct with no clean C# analog; kept above as a `.var` synonym. Drop if redundant.
- **`.repeat`** overlaps `.for` (`.Length`) and `.foreach`. Recommend dropping it (three near-identical loop entries). Included only because requested.
- **`.is`** expects a type name at `${1:Type}` (C# `is` takes a type) — acceptable; escaping still applies.

## 3. Feature B — Surround-With (selection)

**Trigger model:** a **command**, not a completion prefix. Completions act at the cursor via `extractPostfixTarget` (`src/context.ts:402-441`) and cannot wrap a *range*. So: new command `sharpsense.surroundWith`, registered in `src/extension.ts` (52–76), with a `package.json` keybinding gated on `editorHasSelection`:
```json
{ "command": "sharpsense.surroundWith", "key": "ctrl+k ctrl+s",
  "when": "editorTextFocus && editorLangId == csharp && editorHasSelection" }
```
This is the **only** `package.json` change. Ghost-free exit reuses the **already-registered** `sharpsense.leaveSnippetDelayed` (`src/extension.ts:83-93`) — no new snippet-exit command/keybinding.

**Reading the selection:**
```ts
const ed = vscode.window.activeTextEditor;
if (!ed || ed.document.languageId !== 'csharp') return;
const sel = ed.selection;
if (sel.isEmpty) { vscode.window.showInformationMessage('SharpSense: select an expression to surround.'); return; }
const text = ed.document.getText(sel);
const bs = cachedBraceStyle(ed.document, getSettings().braceStyle); // src/completions.ts:79-101
```

**Template set (`S` = selected text, escaped with `esc`, re-indented one level):** `indent(t, s='\t') = t.split('\n').map((l,i)=> i? s+l : l).join('\n')`. Header becomes a single `${0:placeholder}` (ghost-free); multi-stop control-var templates (`for`/`foreach`) keep a session like `.for`/`.foreach`.

| Id | Emitted (Allman, `S`=selection) | Preview |
|---|---|---|
| `if` | `if (${0:condition})\n{\n\t<indent(S)>\n}` | `if (condition) { ... }` |
| `else` | `if (!(${0:condition}))\n{\n\t<indent(S)>\n}` | `if (!(condition)) { ... }` |
| `while` | `while (${0:condition})\n{\n\t<indent(S)>\n}` | `while (condition) { ... }` |
| `do` | `do\n{\n\t<indent(S)>\n}\nwhile (${0:condition});` | `do { ... } while (condition);` |
| `for` | `for (var ${1:i}=0; ${1:i}<${0:count}; ${1:i}++)\n{\n\t<indent(S)>\n}` | `for (var i=0; i<count; i++) { ... }` |
| `foreach` | `foreach (var ${1:item} in ${0:collection})\n{\n\t<indent(S)>\n}` | `foreach (var item in collection) { ... }` |
| `using` | `using (${0:resource})\n{\n\t<indent(S)>\n}` | `using (resource) { ... }` |
| `try` | `try\n{\n\t<indent(S)>\n}\ncatch (Exception ${1:e})\n{\n\t$0\n}` | `try { ... } catch (Exception e) { }` |
| `lock` | `lock (${0:obj})\n{\n\t<indent(S)>\n}` | `lock (obj) { ... }` |
| `region` | `#region ${0:Name}\n<indent(S)>\n#endregion` | `#region Name ... #endregion` |

Block rows build via `braced(bs, header, indent(esc(S)))`; `do`/`region` use inline forms (same pattern as Feature A `doForm`); `try` appends catch with `{\n\t$0\n}` (allman/k&r identical, matching `src/postfix.ts:96`).

**Insertion (ghost-free, atomic):**
```ts
const built = picked.build(bs, text); // { snippet, preview }
await ed.insertSnippet(built.snippet, sel, { undoStopBefore: false, undoStopAfter: false });
```
Passing `sel` replaces the selected range atomically. Single-`${0}` templates render the placeholder as the active selection (no gray ghost). For multi-stop `for`/`foreach`/`try`, the session ends naturally on tab-out. No follow-up command needed.

**Reuse:** `esc`/`braced`/`snip` from `src/postfix.ts`; `cachedBraceStyle`/`resolveBraceStyle` (`src/completions.ts:79-101` / `src/context.ts:365`); `sharpsense.leaveSnippetDelayed` (`src/extension.ts:83-93`); the `getSettings` closure.

**Exact changes:**
1. New file `src/surround.ts`: `SURROUND_TEMPLATES: { id, label, preview, build(bs, text) }[]` using `esc`/`braced`/`indent`/`doForm`; plus `registerSurroundWith(context, getSettings)` (reads selection → `showQuickPick` → `insertSnippet`).
2. `src/completions.ts`: `export` `cachedBraceStyle` (line 79) so `surround.ts` reuses the 50-entry LRU (or import `resolveBraceStyle` from `context.ts` directly).
3. `src/extension.ts`: import + call `registerSurroundWith(context, getSettings)` in the try/catch block (52–76).
4. `package.json`: add `"sharpsense.surroundWith"` to `contributes.commands` (88–114) and the `keybindings` entry above. No change to `sharpsense.acceptDecorated` or its Enter/Tab bindings.

**Edge cases:** empty selection → info message, never wraps nothing; multi-line selection → `getText(sel)` includes newlines, `indent()` re-indents each line, `insertSnippet(snippet, sel)` replaces the whole range in one undo stop; selection inside an expression (`var x = foo(|bar|) + baz;`) → wrapped literally (user intent); nested surround composes (each call independent atomic edit); `undoStopBefore/After: false` merges with prior edit, consistent with `registerCommitShadow`'s `insertSnippet` calls (1739–1745, 1785).

## 4. Feature C — Generate Menu (lightweight, in-solution)

> **Scope reconciliation:** the base package already owns the *full-fidelity* Generate code actions (cross-file/assembly member resolution via the lightbulb). This Feature C is the **lightweight, syntactic** gap-filler — it produces the same stubs for the *common in-solution case* using regex type-body scans + one `executeDefinitionProvider` hop, consistent with the black-box `executeCompletionItemProvider` use in `registerExpectedNewProvider`. Cross-file/metadata fidelity is explicitly deferred (§9).

**Architecture.** New `registerGenerateProvider` in `src/completions.ts`, modeled on `registerLiveTemplateProvider` (380–436) and the async shape of `registerExpectedNewProvider` (440–618). Purely syntactic depth-aware regex scan of the enclosing type body, plus one optional async `vscode.executeDefinitionProvider` hop for Implement/Override. No Roslyn fork. Reused machinery: `isLiveScope(head)` (366–376), `cachedBraceStyle(doc, setting)` (77–101), `MODIFIERS`/`resolveBraceStyle`/`detectInvokeContext` (`src/context.ts:54/365/189`), `braced()`/`esc()` (`src/postfix.ts:20-25/16-18`), `leaveSnippetDelayed` (`src/extension.ts:83-93`, attached when a snippet has no intermediate stop — mirrors 311–313 / 598).

**New setting** `sharpsense.generate` (boolean, default `true`): add to `SharpSenseSettings` (`src/context.ts:11-21`), to `readSettings()` (`src/extension.ts:15-29`), and to `package.json` `contributes.configuration.properties` after `sharpsense.smartSemicolon` (81–85).

**Core extraction helpers (new, in `src/completions.ts`):**
- `findTypeSpan(doc, pos)` → `{ name, genericParams, openOffset, closeOffset, isStaticClass, declStart }`. Regex `/(?:^|[\s;])(class|struct|record)\s+([A-Za-z_]\w*)\s*(<[^>]*>)?/g` over `doc.getText()`; for each candidate `matchBraceAt(text, openIdx)` (count braces to depth 0), keep the **innermost** span whose `[openPos, closePos]` contains `pos` (`pos.isAfter(open) && pos.isBefore(close)`). Handles nested classes automatically.
- `relativeDepthAt(doc, span, pos)` → brace depth between `span.openOffset` and `pos.offset`. Member scope = depth **exactly 1** (inside the type body but outside any method/property body). `depth !== 1` → suppress Generate (prevents the live-template false-positive where `int c|` inside a method would read as member scope).
- `scanDirectMembers(body, typeName, modifiers)` → line-by-line walk tracking brace depth, testing each line only at its *entering* depth and only when entering depth === 1:
```ts
interface FieldInfo { type: string; name: string; param: string; assign: string; isStatic: boolean; }
interface MemberScan {
  fields: FieldInfo[]; instanceFields: FieldInfo[];
  memberNames: Set<string>; propNames: Set<string>;
  ctorParamKeys: Set<string>;        // serialized "n:p,n:p" of existing ctors
  hasEquals: boolean; hasGetHashCode: boolean; hasToString: boolean;
}
```
Regexes reuse `MODIFIERS` (`src/context.ts:54`): field (`^\s*(?:(?:${MODIFIERS})\s+)*([...\w<>\[\]]*)\s+([A-Za-z_]\w*)\s*(?:=\s*[^;]+)?\s*;$`), property (name → `propNames`+`memberNames`), method/ctor (group3 === `typeName` ⇒ ctor, stored serialized; else method name recorded; `Equals`/`GetHashCode`/`ToString` set `has*` flags). `instanceFields` excludes `isStatic` (standard ReSharper behavior).

**Provider shell:**
```ts
export function registerGenerateProvider(context, getSettings): void {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      if (!getSettings().generate || doc.languageId !== 'csharp') return undefined;
      const line = doc.lineAt(pos.line).text;
      const prefix = line.slice(0, pos.character);
      const wordMatch = prefix.match(/([A-Za-z_]\w*)$/);
      const word = wordMatch ? wordMatch[1].toLowerCase() : '';
      if (!word) return undefined;
      const head = wordMatch?.index !== undefined ? prefix.slice(0, wordMatch.index) : prefix;
      if (!isLiveScope(head)) return undefined;                       // 366
      const span = findTypeSpan(doc, pos); if (!span) return undefined;
      if (relativeDepthAt(doc, span, pos) !== 1) return undefined;
      const scan = scanDirectMembers(doc.getText().slice(span.openOffset + 1, span.closeOffset), span.name, MODIFIERS);
      const items: vscode.CompletionItem[] = [];
      if ('ctor'.startsWith(word) && scan.instanceFields.length && !scan.ctorParamKeys.has(scan.instanceFields.map(f=>f.param).join(',')))
        items.push(buildCtor(span, scan, doc, getSettings()));
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
    },
  };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('csharp', provider));
}
```
Each `build*` returns a `CompletionItem` with `sortText`, `detail`, `documentation` (Markdown codeblock, like 422), `insertText = new vscode.SnippetString(body)`, and `item.command = { command: 'sharpsense.leaveSnippetDelayed', title: '' }` (single-`${0}` snippets → ghost-free). Brace helper mirrors `src/postfix.ts:20-25`: `bracedGen(bs, header, body) = bs === 'allman' ? '${header}\n{\n${body}\n}' : '${header} {\n${body}\n}'`.

**Per-feature:**

- **`ctor`** (sort `!0001`): WHEN `ctor` prefix, depth 1, ≥1 instance field, no existing ctor with that exact param set (`ctorParamKeys` dedupe). `params = fields.map(f =>`${f.type} ${f.param}`).join(', ')`, `assigns = fields.map(f =>`\t${f.assign}`).join('\n')`; `assign = field starts with _ ? '_<base> = <param>;' : 'this.<name> = <param>;'`. Ctor name is bare `span.name` (not generic). Single `${0}` final stop.
- **`propfull`** (sort `!0002`): WHEN `propfull` prefix, member scope. For every instance field whose PascalCased name is **not** in `propNames`/`memberNames`, emit backing field + property (`get => backing; set => backing = value;`). Backing = `_${camel(name)}` (or existing `_name`). No fields → single placeholder `propfull`. Auto-`prop` stays owned by `LIVE_TEMPLATES` (360) to avoid collision.
- **`equals`** (sort `!0003`): WHEN `equals` prefix, member scope, `!(hasEquals || hasGetHashCode)`. `Equals` → `obj is ${name} other && ${fieldEqs}`; `GetHashCode` → `HashCode.Combine(${fieldNames})`. No fields → `ReferenceEquals`/`base.GetHashCode()`. (Note `.NET Core+` `HashCode.Combine`; `unchecked` alternative for old frameworks.)
- **`tostring`** (sort `!0004`): WHEN `tostring` prefix, member scope, `!hasToString`. Expression body (style-neutral): `public override string ToString() => $"${nameof(${name})} {{ ${parts} }}";${0}` where `parts` from instance fields.
- **`implement` / `override`** (sort `!0005`, per-member sub-sorted by name): WHEN prefix `implement`/`override`, member scope. **Async** `resolveBaseMembers(doc, span, pos)`: (1) parse `: BaseList` between `declStart` and `openOffset`; (2) for each base type name, `executeDefinitionProvider(doc.uri, namePos)` → `Location`s; (3) for each returned doc, reuse `findTypeSpan`+`scanDirectMembers`; (4) filter to `abstract`/`virtual` + interface members, drop any `(name, arity)` already in `scan.memberNames`; (5) emit one item each — interface method → `public ${ret} ${name}(${params}) => throw new NotImplementedException();`; abstract/virtual → `public override ${ret} ${name}(${params}) { ${body} }` via `bracedGen` (`NotImplementedException` body).

**Edge cases (consolidated table):**

| Case | Behavior |
|---|---|
| Already-existing member | Deduped via `memberNames`/`propNames`/`ctorParamKeys`/`has*` — matching item simply not offered |
| Generic class | Ctor name bare `span.name`; field types with `<T>` copied verbatim (round-trips `List<T> items`) |
| Static vs instance | `instanceFields` excludes `isStatic` for ctor/Equals/ToString/propfull; Equals/GetHashCode compare instance state only |
| Nested classes | `findTypeSpan` returns innermost enclosing type; scans never see outer members |
| Partial classes | Lightweight version aggregates only **current file's** `partial class Name` parts; cross-file partial aggregation needs Dev Kit project symbol model (flagged §9) |
| Inside a method body | `relativeDepthAt !== 1` → `undefined`; never offered |
| Comment / string position | Syntactic only, not explicitly gated (acceptable limitation; flag for future trivia check) |
| No fields for ctor/propfull | `ctor` suppressed; `propfull` falls back to placeholder property |

**Wiring:** `src/extension.ts` — import + register `registerGenerateProvider` in its own try/catch (52–76) with the other `registerXxx` calls.

## 5. Architecture & Reuse Notes

All three features are **additive** and share the existing engine:
- **Commit-shadow / ghost-free single-stop:** every new single-`$0` snippet attaches `sharpsense.leaveSnippetDelayed` (mirrors `src/completions.ts:311-313` and `LIVE_TEMPLATES` 339–362) so the lone `$0` session exits without a gray caret. Multi-stop templates (`.is`/`.let`/`.repeat`/surround `for`/`foreach`/`try`, `propfull`) keep natural sessions.
- **Brace-style aware:** `cachedBraceStyle(doc, getSettings().braceStyle)` (77–101, 50-entry LRU) → `ResolvedBraceStyle` (`src/context.ts:365`) feeds `braced()`/`doForm`/`bracedGen`. No `braceCache` divergence.
- **Scope gating:** `isLiveScope` (366–376) for live/postfix-style member scope; `relativeDepthAt === 1` for Generate; `detectInvokeContext` (`src/context.ts:189`) available for any additional context classification.
- **sortText conventions:** postfix uses `POSTFIX_RANK` (numeric 0–27); Generate uses `!000x` (`!` sorts before Roslyn's own rows, mirroring `LIVE_TEMPLATES`' `!0000` preselect-style). Surround is command-driven (no sortText).
- **No `package.json` keybinding change for completion features:** all reuse `sharpsense.acceptDecorated` (bound to Enter/Tab when `editorLangId == csharp`). Only Surround adds a new `sharpsense.surroundWith` keybinding gated on `editorHasSelection`.
- **Performance:** hot path stays synchronous (`scanDirectMembers`, `findTypeSpan`, `relativeDepthAt` are pure regex/brace-count over `doc.getText()`). Cache per `uri|version` via the existing `braceCache` LRU for brace style; the type-span scan is cheap and re-run per `provideCompletionItems` (already the model for `registerLiveTemplateProvider`/`registerExpectedNewProvider`).

## 6. Edge Cases (consolidated)

- **Partial / generic / nested classes:** `findTypeSpan` returns innermost type; `scanDirectMembers` sees only that body. Generic field types (`List<T>`) round-trip verbatim. Partial aggregation is current-file only (§9).
- **Already-existing members:** dedupe via `memberNames`/`propNames`/`ctorParamKeys`/`hasEquals`/`hasGetHashCode`/`hasToString` — features are suppressed when redundant.
- **Empty / multi-line selections (Surround):** empty → info message, no wrap; multi-line → `indent()` re-indents each line, `insertSnippet(snippet, sel)` replaces the whole range atomically with `undoStopBefore/After: false`.
- **Dedupe & collision:** `propfull` avoids `LIVE_TEMPLATES` `prop` trigger; Generate words use `startsWith` so `eq`/`equ` trigger `equals`. Postfix `findPostfixTemplates` `startsWith` already handles `fo`→`for`+`foreach`.
- **Performance / caching:** synchronous scans only; brace style from LRU (`uri|version`); no IPC on the hot path except `registerExpectedNewProvider` (existing) and Generate's async `executeDefinitionProvider` (only on `implement`/`override`).

## 7. Implementation Checklist (phased)

1. **Data + detection** — add `findTypeSpan`, `relativeDepthAt`, `scanDirectMembers` to `src/completions.ts`; add `sharpsense.generate` to `SharpSenseSettings` (`src/context.ts:11-21`), `readSettings()` (`src/extension.ts:15-29`), and `package.json` config. Export `cachedBraceStyle`.
2. **Postfix expansion** — append 14 entries to `POSTFIX_TEMPLATES` + `doForm` in `src/postfix.ts`; extend `POSTFIX_RANK` (298–301) in `src/completions.ts`. Verify no `findPostfixTemplates` change.
3. **Surround-with** — new `src/surround.ts` (`SURROUND_TEMPLATES` + `registerSurroundWith`); wire `registerSurroundWith` in `src/extension.ts` (52–76); add `sharpsense.surroundWith` command + keybinding in `package.json` (gated `editorHasSelection`).
4. **Generate provider** — `registerGenerateProvider` + `build*` helpers (ctor/propfull/equals/tostring/implement) in `src/completions.ts`; `resolveBaseMembers` async hop; wire in `src/extension.ts`.
5. **Wiring + settings** — register all new providers in `extension.ts` try/catch with logging; confirm `sharpsense.acceptDecorated` unchanged; verify `package.json` contributes (`commands`, `keybindings`, `configuration`).
6. **Edge cases + perf** — dedupe gates, `relativeDepthAt === 1` guard, multi-line Surround indent, empty-selection guard, LRU brace caching.
7. **Verification** — run F5 Extension Host against `test-workspace`; walk the manual checklist (§8).
8. **Complete Statement** — new `src/completestatement.ts` (`findUnbracedControlConstruct` + `registerCompleteStatement`); `sharpsense.completeStatement` command + Ctrl+Enter keybinding in `package.json`; wire `registerCompleteStatement` in `src/extension.ts` (own try/catch).

## 8. Verification & Test Plan

Follow `test-workspace/MANUAL_CHECKLIST.md` style (manual F5 Extension Host verification; no test runner configured). Cases per feature:

- **Postfix (Feature A):** type `x.else` → `if (!(x)) { … }` with `$0` at body, no gray ghost; `.while`/`.lock`/`.do` block correctly; `.do` trailing `while(cond);` placed after block; `.not`/`.par`/`.checked`/`.unchecked`/`.name`/`.comment` expression-wrapped; `.is` offers `${1:Type}` stop; `.new` on `List<int>` → `new List<int>();`; switch brace style to K&R → all block templates re-emit K&R; shared prefixes (`fo`→`for`+`foreach`) still resolve.
- **Surround (Feature B):** select `DoWork();` → Ctrl+K,Ctrl+S → pick `if` → `if (condition) { DoWork(); }` with `condition` selected, no ghost; multi-line selection re-indents; empty selection → info message; nested surround re-applies; undo merges as one stop.
- **Generate (Feature C):** in a class with `int _x; string Name;`, type `ctor` → ctor with `_x`/`Name` params + assignments (no duplicate if ctor exists); `propfull` → backing field + property per field (skip existing props); `equals` → Equals+GetHashCode (suppressed if present); `tostring` → override (suppressed if present); `implement` on `class C : IDisposable` (in-solution) → `Dispose()` stub; scope-gated: `ctor` inside a method body is **not** offered; static fields excluded from ctor/Equals/ToString.
- **Complete Statement (Feature D):** with `if (x) return;` on a line, place cursor and Ctrl+Enter → `if (x)\n{\n\treturn;\n}` (Allman) / `if (x) {\n\treturn;\n}` (K&R); already-braced `if (x) { return; }` is a no-op; `else x;` / `while` / `for` / `foreach` / `using` / `lock` / `fixed` wrap their single body; `do x; while (c);` → `do { x; } while (c);`; inner statement gets `;` if missing; embedded `if (a) if (b) x;` wraps innermost first; `;` not duplicated when present.
- **Ghost-free + brace-style (all):** confirm `sharpsense.leaveSnippetDelayed` fires on single-`$0` snippets (no lingering gray caret); Allman vs K&R via `resolveBraceStyle` + `braceCache`.

## 9. Open Questions / Risks

- **Double completion** (nested delegate/collection expected-type) is **deferred** — requires Roslyn expected-type semantics on nested contexts; that is base-package territory. SharpSense cannot compute a reliable expected type.
- **Implement/Override base-member enumeration** is the only feature grazing Roslyn semantics and has known ceilings:
  - **Cross-file / metadata bases:** `executeDefinitionProvider` resolves to decompiled metadata for BCL/framework types where there is no source text to regex-scan. The lightweight scan works only when the base type's **source is in the workspace**. Full fidelity needs the C# Dev Kit project model / Roslyn IL inspection — outside the "no fork" contract.
  - **Recursive interface inheritance** (e.g. `IDisposable` via a base interface) requires recursive resolution; only one level is enumerated.
  - **Fidelity gaps:** generic constraints, default params, `params`/`ref`/`out` modifiers, and XML doc comments are not reproduced — bodies are `NotImplementedException`/override stubs only.
  - **Partial aggregation** (§4/§6) and **multi-project bases** need the Dev Kit workspace model.
- **`.let` / `.repeat` redundancy** (Feature A): `.let` duplicates `.var`; `.repeat` overlaps `.for`/`.foreach`. Recommend dropping both unless explicitly required.
- **Smarter ExpectedNew prefill** and **Generate `switch` from enum** (in-solution via `executeDocumentSymbolProvider`) are high-value Med-priority follow-ups not in this plan's core three; external-framework types fall back to no-op.
- **Comment/string position** in Generate is syntactically ungated (acceptable, same class as the rest of the syntactic engine); a future trivia check could tighten it.
- **Complete Statement (Feature D) ceilings:** only single-statement un-braced bodies are wrapped; already-braced constructs are no-ops (never double-brace). `do … while` is handled (body precedes `while`). Embedded constructs (`if (a) if (b) x;`) wrap the innermost only. Syntactic only — does not move across method boundaries or re-flow multi-statement blocks.

## 10. Feature D — Complete Statement / Brace-Wrap (Rider Ctrl+Shift+Enter parity)

**Problem.** When you type a control-flow statement with a single un-braced body — `if(condition) return;` — Rider's Complete Statement (Ctrl+Shift+Enter) rewrites it to brace style:

```csharp
if (condition)
{
    return;
}
```

following the configured brace style (Allman/K&R). The same applies to `else`/`while`/`for`/`foreach`/`using`/`lock`/`fixed`/`do`/`try` and the "million edge cases" of single-statement bodies the user did not enumerate. This is the missing Rider parity piece.

**Design.** A new command `sharpsense.completeStatement` (default keybinding Ctrl+Enter, gated `editorLangId == csharp && !inSnippetMode && !suggestWidgetVisible`) that operates on the construct the cursor sits in or just finished:

1. **Locate the construct.** Walk backward from the cursor within the current non-brace-block (don't cross `{`/`}`/`;` statement boundaries) to the line that opens the control statement. Identify the keyword via a leading-token match (`if`/`else`/`while`/`for`/`foreach`/`using`/`lock`/`fixed`/`do`/`try`).
2. **Find the header end.** For `(`-headed constructs, balance parens from the keyword to locate the matching `)`. The body starts right after `)` (for `do`, the body is *before* the `while (cond);` tail — special-case it).
3. **Detect the body.** If the char after the header is `{`, the construct is already braced — **no-op** (never double-wrap). Otherwise the body is the single statement from body-start to its terminating `;`/`}`/`)` or end-of-line (spanning multiple lines if the statement is not on the header line).
4. **Wrap + complete.** Rebuild as `header` + brace-open + one extra indent on the body + brace-close, per `resolveBraceStyle`. If the body is an expression statement (not ending in `;`/`}`/`)`) append `;` — the "complete statement" half.

`esc`/`braced`/`resolveBraceStyle`/`cachedBraceStyle` reuse the existing engine; the new file `src/completestatement.ts` exports `registerCompleteStatement(context, getSettings)` and a pure `findUnbracedControlConstruct(text, cursorOffset)` used by the command and unit-testable in isolation.

**Edge cases:**
- `else if` chain — `else if (b) x;` wraps the `if` body, leaving the `else if` intact (operates on innermost).
- `do { } while` already braced — no-op. `do x; while (c);` → `do { x; } while (c);`.
- Embedded: `if (a) if (b) x;` — wraps innermost (`if (b) x;`) first; a second invocation walks outward.
- Body already ends with `;` — not duplicated.
- Already-braced construct — no-op (never double-braces).
- Cursor mid-construct (inside the condition `(`…`)`) — locate from the keyword and still wrap the body.

**Ceilings (synthesize, don't chase the "million"):** only single-statement un-braced bodies are touched; multi-statement blocks already need braces (left to the user / base package). No cross-method re-flow. Syntactic only — no Roslyn, no type awareness.

**Wiring:** `sharpsense.completeStatement` command + Ctrl+Enter keybinding in `package.json`; `registerCompleteStatement` call in `src/extension.ts` (own try/catch); no change to `sharpsense.acceptDecorated`.
