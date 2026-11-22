# Smart Enter And Backspace

Standalone, language-agnostic editor helpers for **Enter**, **Backspace**, and **`{`**.

Extracted from SharpSense so it can be installed and used with any language —
no C# / Roslyn dependency, no language server, no completion providers. Everything is
decided from the current line's text and the settings below.

## What it does

### Smart Enter

| Situation | Result |
|---|---|
| `{ \| }` (cursor between empty braces) | Expands into a multi-line block in your brace style, cursor one indent inside. |
| `void Foo()\|`, `function foo()\|`, `func foo()\|` | Adds the block open (and indents) — Allman puts `{` on the next line, K&R appends ` {` to the header. |
| `for (...)\|`, `if (...)\|`, `while (...)\|` | Newline + **one indent**, **no brace inserted**. You type the `{` yourself. |
| `doThis()\|` (unclosed statement, semicolon languages) | Appends the missing `;`, then newlines at the same indent. |

Enter is handled by binding the Enter key to `smartEnterAndBackspace.smartEnter`
(active when the editor has focus, no suggestion widget, and no active snippet).
Anything the extension does not claim falls through to a normal newline.

### Smart Backspace

* **Interior collapse** — `(   |   )` becomes `(|)` on the first press; the next press deletes the pair.
* **Empty pair delete** — `(|)` is removed in a single stroke.
* **Indent collapse** — backspacing inside leading whitespace moves to the previous tab stop
  (`toTabstop`), the previous non-blank line's indent (`toUnindent`), or deletes the blank line
  and rejoins it above (`toProper`).
* **Blank-line erase** — a single Backspace at the start of a whitespace-only line removes the
  line (braced/generic languages only).

### Smart `{`

* With text selected, typing `{` wraps the selection in a brace block honoring the brace style,
  aligned to the enclosing control-flow header when there is one.
* On a statement line immediately below an unbraced control header (`for (...)`), typing `{`
  merges the block into that header instead of leaving an orphan.

### Overtype / habit guards

* Typing a closer that already sits after the caret steps over it instead of duplicating it.
* Typing an opener directly before its own empty pair (`(|)` and you type `(`) steps inside
  instead of producing `(()`.

## Language families

Behavior is chosen by a language profile, not by hardcoded language names in the logic.

| Family | Examples | Smart Enter | Braces | Backspace |
|---|---|---|---|---|
| **braced** | C#, Java, JS/TS, C/C++, Go, Rust, Kotlin, PHP, Swift, CSS, JSON, … | full | brace styles honored | tab-stop / unindent / join modes |
| **indented** | Python, YAML, Ruby, Elm, F#, GDScript, … | none — native auto-indent | **never** | collapses to the **nearest surrounding indent** |
| **generic** | Markdown, plaintext, anything unlisted | none | none | backspace helpers only |

Indentation-based languages are explicitly excluded from every brace-related path:
no brace styles, no brace expansion, no surround, and no blank-line erase. Their Backspace
snaps to the nearest enclosing indentation level, which is what a dedent actually means there.
Set `smartEnterAndBackspace.backspace.indentedLanguagesUseNearestIndent` to `false` to fall back
to the standard unindent modes in those languages.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `smartEnterAndBackspace.smartEnter` | `true` | Master switch for the Enter behaviors. |
| `smartEnterAndBackspace.braceExpansion` | `true` | Expand `{}` into a multi-line block. |
| `smartEnterAndBackspace.braceStyle` | `inherit` | `allman`, `k&r`, or `inherit` (sample the file). |
| `smartEnterAndBackspace.smartSemicolon` | `true` | Add a missing `;` (semicolon languages only). |
| `smartEnterAndBackspace.smartSurroundWithBraces` | `true` | `{`-wraps a selection and merges orphan blocks into a parent header. |
| `smartEnterAndBackspace.smartBackspace` | `true` | Master switch for the Backspace behaviors. |
| `smartEnterAndBackspace.backspace.unindentMode` | `toProper` | `toTabstop`, `toUnindent`, `toProper`, or `none`. |
| `smartEnterAndBackspace.backspace.indentedLanguagesUseNearestIndent` | `true` | Indented languages snap to the nearest enclosing indent. |
| `smartEnterAndBackspace.overtype` | `true` | Step over existing closers; step inside empty pairs. |
| `smartEnterAndBackspace.verboseLogging` | `false` | Log each decision to the **Smart Enter And Backspace** output channel. |

## Installation / development

```powershell
cd smart-enter-and-backspace
npm install
npm run compile      # or: npm run watch
```

Then press **F5** with the `Run Smart Enter And Backspace Extension` launch configuration.

Package with `npm run package` (requires `vsce`).

## Note on installing alongside SharpSense

If you also run SharpSense, disable the equivalent features on one side.
VS Code allows only one handler per `type` / `deleteLeft` command and only one
keybinding wins for Enter, so running both extensions enabled will produce
duplicated or conflicting edits.
