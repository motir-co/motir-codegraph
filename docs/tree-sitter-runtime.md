# Tree-sitter runtime

Which tree-sitter runtime this service installs, how a grammar is loaded
through it, and which of the 21 languages the requirement's D5 names have a
grammar that runtime can load. The language registry, the extractor and their
tests are built from this document. Every registry read below was made on
**2026-11-12** against `registry.npmjs.org`.

## Summary

- **Runtime:** `web-tree-sitter`, **0.27.2** (the version `pnpm-lock.yaml`
  resolves, pinned exactly in `package.json`).
- **Loading, in one line:** resolve the grammar package's published
  `tree-sitter-<lang>.wasm` file, then pass its path to
  `Language.load(path)`, after `Parser.init()` has run once per process, and
  hand the result to `parser.setLanguage(language)`.
- **Languages with a grammar this runtime can load (18):** TypeScript,
  JavaScript, Python, Java, Kotlin, Scala, Go, C, C++, Ruby, C#, Rust, Dart, PHP,
  Elixir, Haskell, Lua, Solidity.
- **Languages with none (3):** CUDA, Visual Basic, Swift. Their files take the
  `unsupported` outcome until a package publishes a wasm this runtime loads.

## The decision

The service installs **`web-tree-sitter` 0.27.2**, tree-sitter's own
WebAssembly runtime. It is JavaScript plus one wasm file
(`web-tree-sitter.wasm`) and has no install script and no dependencies.

**How a grammar is loaded.** A grammar package publishes a compiled
`tree-sitter-<lang>.wasm` file at its package root (for example
`tree-sitter-python/tree-sitter-python.wasm`). The service resolves that file's
path with Node's resolver (`createRequire(import.meta.url).resolve(...)`), and
calls `Language.load(path)`, which reads the bytes and instantiates them as a
WebAssembly module linked to the runtime. `Parser.init()` must have run once in
the process before the first load. The returned `Language` is handed to the
parser with `parser.setLanguage(language)`, and `parser.parse(source)` returns
the tree. One `Language` is loaded once per process and shared across parsers.

## The alternative, and why it lost

The other runtime is the Node binding, **`tree-sitter` 0.25.1** (published
2026-07-28). It is a native addon: its published manifest declares
`"install": "node-gyp-build"`, and depends on `node-addon-api` and
`node-gyp-build`. Every grammar package's native half has the same install
script.

**The observation that decided against it:** this repository installs with pnpm
11, whose `pnpm-workspace.yaml` allows the build scripts of `esbuild` only.
Adding the binding refuses to install:

```text
$ pnpm add tree-sitter@0.25.1
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: tree-sitter@0.25.1
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

Taking it means adding the runtime and one entry per grammar to `allowBuilds`,
so every grammar runs code at install time, and loading a native addon that a
parser bug can crash the whole worker with. The binding also publishes a
prebuilt `.node` per platform, so a platform with no prebuild needs a compiler.
The image base (`node:22-slim`) has no `gcc`, `make` or `python3` (read inside
the image, below). The WebAssembly runtime needs none of this: it installs with
`pnpm-workspace.yaml` unchanged, has one artifact for every platform, and a
grammar that faults raises a catchable error instead of taking the process down.

Two prebuilt-wasm bundles were also read. **`tree-sitter-wasms` 0.1.13**
(published 2025-10-07) carries 36 grammars, but every one of them fails
`Language.load` under `web-tree-sitter` 0.27.2: the bundle is built with an older
tree-sitter CLI, and its wasm files do not link. **`@vscode/tree-sitter-wasm`
0.3.1** carries 16 grammars, none of which is a language missing below, so it
adds nothing the grammars' own packages do not.

## The 21 languages

The artifact this runtime consumes is the grammar's `.wasm` file. "Carried"
means the package's published tarball (read from `dist.tarball`) contains it,
and the last column says whether that file loaded under `web-tree-sitter` 0.27.2
(`Language.load` and a parse; the ABI is what `language.abiVersion` reported).
"Upstream" is the newest commit on the repository the package names, read with
`git clone --depth 1` on 2026-11-12. Every row's registry read is
`npm view <package> --json` on 2026-11-12, plus the tarball listing.

| Language     | Package                                    | Pinned version | Published  | Upstream (last commit)                                            | Artifact                                                   | Carried | Loads (ABI) |
| ------------ | ------------------------------------------ | -------------- | ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------- | ----------- |
| TypeScript   | `tree-sitter-typescript`                   | 0.23.2         | 2024-11-11 | tree-sitter/tree-sitter-typescript, 2025-01-30                    | `tree-sitter-typescript.wasm` (and `tree-sitter-tsx.wasm`) | yes     | yes (14)    |
| JavaScript   | `tree-sitter-javascript`                   | 0.25.0         | 2025-09-01 | tree-sitter/tree-sitter-javascript, 2025-09-14                    | `tree-sitter-javascript.wasm`                              | yes     | yes (15)    |
| Python       | `tree-sitter-python`                       | 0.25.0         | 2025-09-11 | tree-sitter/tree-sitter-python, 2025-09-15                        | `tree-sitter-python.wasm`                                  | yes     | yes (15)    |
| Java         | `tree-sitter-java`                         | 0.23.5         | 2024-12-21 | tree-sitter/tree-sitter-java, 2025-09-14                          | `tree-sitter-java.wasm`                                    | yes     | yes (14)    |
| Kotlin       | `@tree-sitter-grammars/tree-sitter-kotlin` | 1.1.0          | 2025-01-09 | tree-sitter-grammars/tree-sitter-kotlin, 2025-01-16               | `tree-sitter-kotlin.wasm`                                  | yes     | yes (14)    |
| Scala        | `tree-sitter-scala`                        | 0.24.0         | 2025-06-08 | tree-sitter/tree-sitter-scala, 2026-11-12                         | `tree-sitter-scala.wasm`                                   | yes     | yes (14)    |
| Go           | `tree-sitter-go`                           | 0.25.0         | 2025-08-29 | tree-sitter/tree-sitter-go, 2025-09-15                            | `tree-sitter-go.wasm`                                      | yes     | yes (15)    |
| C            | `tree-sitter-c`                            | 0.24.1         | 2025-05-24 | tree-sitter/tree-sitter-c, 2026-04-22                             | `tree-sitter-c.wasm`                                       | yes     | yes (15)    |
| C++          | `tree-sitter-cpp`                          | 0.23.4         | 2024-11-11 | tree-sitter/tree-sitter-cpp, 2026-09-17                           | `tree-sitter-cpp.wasm`                                     | yes     | yes (14)    |
| CUDA         | none                                       | —              | —          | —                                                                 | —                                                          | —       | —           |
| Ruby         | `tree-sitter-ruby`                         | 0.23.1         | 2024-11-11 | tree-sitter/tree-sitter-ruby, 2026-03-10                          | `tree-sitter-ruby.wasm`                                    | yes     | yes (14)    |
| C#           | `tree-sitter-c-sharp`                      | 0.23.5         | 2026-04-14 | tree-sitter/tree-sitter-c-sharp, 2026-09-29                       | `tree-sitter-c_sharp.wasm`                                 | yes     | yes (15)    |
| Visual Basic | none                                       | —              | —          | —                                                                 | —                                                          | —       | —           |
| Rust         | `tree-sitter-rust`                         | 0.24.0         | 2025-04-01 | tree-sitter/tree-sitter-rust, 2026-03-27                          | `tree-sitter-rust.wasm`                                    | yes     | yes (14)    |
| Dart         | `tree-sitter-dart-orchard`                 | 0.7.1          | 2026-10-29 | codeberg.org/grammar-orchard/tree-sitter-dart-orchard, 2026-11-10 | `tree-sitter-dart_orchard.wasm`                            | yes     | yes (14)    |
| PHP          | `tree-sitter-php`                          | 0.24.2         | 2025-08-18 | tree-sitter/tree-sitter-php, 2026-10-06                           | `tree-sitter-php.wasm` (and `tree-sitter-php_only.wasm`)   | yes     | yes (15)    |
| Swift        | none                                       | —              | —          | —                                                                 | —                                                          | —       | —           |
| Elixir       | `tree-sitter-elixir`                       | 0.3.5          | 2026-03-02 | elixir-lang/tree-sitter-elixir, 2026-10-20                        | `tree-sitter-elixir.wasm`                                  | yes     | yes (14)    |
| Haskell      | `tree-sitter-haskell`                      | 0.23.1         | 2024-11-10 | tree-sitter/tree-sitter-haskell, 2026-09-30                       | `tree-sitter-haskell.wasm`                                 | yes     | yes (14)    |
| Lua          | `@tree-sitter-grammars/tree-sitter-lua`    | 0.4.1          | 2025-12-31 | tree-sitter-grammars/tree-sitter-lua, 2026-02-26                  | `tree-sitter-lua.wasm`                                     | yes     | yes (15)    |
| Solidity     | `tree-sitter-solidity`                     | 1.2.13         | 2025-08-04 | none named in the manifest (author: Joran Honig)                  | `tree-sitter-solidity.wasm`                                | yes     | yes (15)    |

### The rows that need a note

- **CUDA: none.** `tree-sitter-cuda` 0.21.2 (published 2026-09-15, upstream
  tree-sitter-grammars/tree-sitter-cuda, last commit 2026-09-15) exists and is
  maintained, but its tarball carries **no `.wasm` file** (and no prebuilds).
  Searches: `npm view tree-sitter-cuda`, `npm view @tree-sitter-grammars/tree-sitter-cuda`
  (not found), `npm search "tree-sitter cuda"` (only `tree-sitter-cuda`), and the
  two bundles above (neither carries CUDA).
- **Visual Basic: none.** `npm view tree-sitter-vb`, `tree-sitter-vbnet` and
  `@tree-sitter-grammars/tree-sitter-vb` are not found. `npm search "tree-sitter
visual basic"` and `"tree-sitter vb"` found `tree-sitter-vb-dotnet` 0.1.9
  (published 2025-07-28, upstream CodeAnt-AI/tree-sitter-vb-dotnet, last commit
  2025-07-28), whose tarball carries no `.wasm` and no prebuilds. Neither bundle
  carries Visual Basic.
- **Swift: none.** `tree-sitter-swift` 0.7.1 (published 2025-06-23, upstream
  alex-pinkus/tree-sitter-swift, last commit 2026-11-12) is maintained, but its
  tarball carries native prebuilds only, **no `.wasm`**. `npm search
"tree-sitter swift"` also found `@binclusive/tree-sitter-swift-wasm` 0.1.0
  (its one version, published 2026-07-26), whose
  `wasm/tree-sitter-swift.wasm` does load (ABI 15). It is **not adopted**:
  `tree-sitter-swift` does not name it, its repository field points at an
  unrelated monorepo (Binclusive/monorepo), and a single third-party repack is
  not a maintained grammar. `tree-sitter-wasms`' Swift wasm does not load.
- **Dart: `tree-sitter-dart-orchard`, not `tree-sitter-dart`.** The package named
  `tree-sitter-dart` is 1.0.0, published 2023-02-24, names no repository, and
  its `tree-sitter-dart.wasm` **fails** `Language.load` under 0.27.2.
  `tree-sitter-dart-orchard` 0.7.1 is a Dart grammar (its manifest's description
  reads "Parser for Dart files"), published 2026-10-29 from
  codeberg.org/grammar-orchard, and its wasm loads. Searched as well:
  `@tree-sitter-grammars/tree-sitter-dart` (not found), `@sengac/tree-sitter-dart`
  1.1.6 and `@vokturz/tree-sitter-dart` 1.0.0 (native only, no `.wasm`).
- **Kotlin and Lua: the `@tree-sitter-grammars` scope.** The unscoped
  `tree-sitter-kotlin` 0.3.8 (2024-08-03) and `tree-sitter-lua` 2.1.3
  (2022-08-14) carry no `.wasm`. The `@tree-sitter-grammars` packages are the
  maintained ones and carry it.
- **TypeScript and Java** have not been published since late 2024, though their
  upstream repositories had commits in 2025. They still load and parse. Whether a
  stale pin is acceptable is the registry's call, not this document's.
- **Queries.** Most packages also publish `queries/tags.scm`, tree-sitter's
  code-navigation query. Kotlin (`@tree-sitter-grammars`) and Haskell publish
  none; the registry writes its own for them.

## Proof of load

The script and every command, as one block. Run it from the repository root
after `pnpm install --frozen-lockfile`; it installs one grammar for the run only
and removes it, so the tree it leaves carries the runtime and no grammar.
`--ignore-scripts` keeps the grammar's own native install script from running,
because only its `.wasm` is used (without it pnpm 11 refuses the install, as
above).

```sh
pnpm install --frozen-lockfile
pnpm add --save-dev --ignore-scripts tree-sitter-python@0.25.0
cat > ts-load-proof.mjs <<'JS'
// Throwaway proof of load: one grammar's wasm through web-tree-sitter.
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
await Parser.init();
const wasm = require.resolve('tree-sitter-python/tree-sitter-python.wasm');
const python = await Language.load(wasm);
const parser = new Parser();
parser.setLanguage(python);
const tree = parser.parse('def greet(name):\n    return "hi " + name\n');
const root = tree.rootNode;
console.log('language ABI:', python.abiVersion);
console.log('root:', root.type);
console.log('first named child:', root.namedChild(0).type, root.namedChild(0).childForFieldName('name').text);
JS
node ts-load-proof.mjs
pnpm remove tree-sitter-python
rm ts-load-proof.mjs
git diff --stat
```

**On the GitHub-runner-like host** (Node v22.23.4, pnpm 11.2.2), the script's
output:

```text
language ABI: 15
root: module
first named child: function_definition greet
```

and `git diff --stat` afterwards shows only the runtime: `package.json` and
`pnpm-lock.yaml`, `web-tree-sitter` alone.

**Inside the image base** the `Dockerfile` builds (`node:22-slim`, Node
v22.23.5), with `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`
mounted at `/app` and pnpm prepared through corepack as the `Dockerfile` does,
the same block printed:

```text
image has no gcc, make or python3
+ web-tree-sitter 0.27.2
Done in 4.5s using pnpm v11.2.2
+ tree-sitter-python 0.25.0
Done in 3.2s using pnpm v11.2.2
language ABI: 15
root: module
first named child: function_definition greet
Done in 1.7s using pnpm v11.2.2
```

The image's own install line, unchanged by this decision, is the evidence that
the runtime needs no toolchain step:

```dockerfile
RUN pnpm install --frozen-lockfile
```

CI's `Docker image` job builds that `Dockerfile` with the runtime in the
lockfile on this change's pull request.
