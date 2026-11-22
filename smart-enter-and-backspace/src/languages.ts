// Language profiles: which Enter/Backspace behaviors apply to which language.
//
// braced   — braces create blocks. Smart Enter (brace expansion, block headers,
//            control headers, semicolons) and brace surround all apply.
// indented — indentation creates blocks (Python, YAML, F#, ...). No brace logic
//            at all; Enter is left to the editor's native auto-indent. Backspace
//            collapses to the nearest surrounding indent.
// generic  — everything else (Markdown, plaintext, ...). Only backspace helpers.

export type LanguageFamily = 'braced' | 'indented' | 'generic';

export interface LanguageProfile {
  family: LanguageFamily;
  /** Keywords that introduce a condition/body header. */
  controlKeywords: Set<string>;
  /** Modifiers and declaration starters (TypeScript/Java/C#/Go/Rust/...). */
  declKeywords: Set<string>;
  /** A capitalised bare `Name(...)` may be a constructor (C#/Java/C++/...). */
  bareNameIsConstructor: boolean;
  /** Smart `;` insertion is offered for this language. */
  semicolons: boolean;
  /** Statement starters that never take a trailing semicolon. */
  nonStatementStarters: Set<string>;
}

const CONTROL_KEYWORDS = new Set(
  'if else for foreach while do switch try catch finally using lock synchronized with when match unsafe loop'.split(
    ' ',
  ),
);

const DECL_KEYWORDS = new Set(
  `public private protected internal static readonly volatile virtual override abstract sealed extern unsafe async partial required file scoped event const
record class struct interface enum namespace case implicit explicit operator
function func fn def fun sub constructor get set export default
final native transient strictfp
pub mut dyn ref move where impl trait type let
inline template typename constexpr noexcept friend mutable
module package import from`.split(/\s+/).filter(Boolean),
);

const PRIMITIVES = new Set(
  `void int string bool double float decimal char byte sbyte short ushort uint long ulong nint nuint dynamic object var
number boolean any unknown never bigint symbol
i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 str`.split(/\s+/).filter(Boolean),
);

const NON_STATEMENT_STARTERS = new Set(
  `class interface struct enum record namespace trait impl protocol extension module
function func fn def fun sub`.split(/\s+/).filter(Boolean),
);

export function isTypeLike(t: string): boolean {
  if (!t) return false;
  if (PRIMITIVES.has(t)) return true;
  if (/[<>\[\]]/.test(t) || t.endsWith('?')) return true;
  return /^[A-Z]/.test(t);
}

const INDENTED = new Set([
  'python',
  'yaml',
  'ruby',
  'elm',
  'nim',
  'coffeescript',
  'fsharp',
  'haskell',
  'gdscript',
  'makefile',
  'haml',
  'slim',
  'sass',
  'stylus',
  'pug',
  'jade',
  'raku',
  'dhall',
]);

const BRACED = new Set([
  'csharp',
  'java',
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'c',
  'cpp',
  'objective-c',
  'objective-cpp',
  'go',
  'rust',
  'php',
  'swift',
  'kotlin',
  'scala',
  'dart',
  'groovy',
  'powershell',
  'css',
  'scss',
  'less',
  'json',
  'jsonc',
  'protobuf',
  'graphql',
  'vue',
  'svelte',
  'solidity',
  'shaderlab',
  'hlsl',
  'glsl',
]);

const TYPED = new Set([
  'csharp',
  'java',
  'c',
  'cpp',
  'objective-c',
  'objective-cpp',
  'kotlin',
  'scala',
  'dart',
  'swift',
  'groovy',
]);

const SEMICOLONS = new Set([
  'csharp',
  'java',
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'php',
  'dart',
  'c',
  'cpp',
  'objective-c',
  'objective-cpp',
  'rust',
  'scala',
  'groovy',
]);

const cache = new Map<string, LanguageProfile>();

export function profileFor(languageId: string): LanguageProfile {
  const id = languageId.toLowerCase();
  const hit = cache.get(id);
  if (hit) return hit;
  const family: LanguageFamily = INDENTED.has(id) ? 'indented' : BRACED.has(id) ? 'braced' : 'generic';
  const profile: LanguageProfile = {
    family,
    controlKeywords: CONTROL_KEYWORDS,
    declKeywords: DECL_KEYWORDS,
    bareNameIsConstructor: TYPED.has(id),
    semicolons: SEMICOLONS.has(id),
    nonStatementStarters: NON_STATEMENT_STARTERS,
  };
  cache.set(id, profile);
  return profile;
}
