# Witness

"Coverage tells you a line ran. Witness tells you which test ran it, which way every decision went, and which functions it entered."

Witness is the instrumentation MikeVan's AI Development Toolkit owns: one instrument for every JavaScript framework the toolkit serves, shared by DeepTest and UntangleIt and bundled into each at build time, so neither tool depends on the other being installed. It is a library, `@projectrevivesolutions/witness`, beside `@projectrevivesolutions/complexity`.

It never writes to a file in a project. The instrumenter hands the engine counted text in memory, in the moment between reading a file and running it; the file on disk is never opened for writing and the counted text is never saved. The only files a tool writes are its own, under its own folder in the project (`.deeptest\`, `.untangleit\`).

## What is in it

- `src/instrument.ts`, the instrumenter: textual insertion on the tree-sitter parse tree, counters on the same lines the code was on, maps in Istanbul's shape, nothing regenerated and no source map. Checked line for line against istanbul-lib-instrument by the test suite.
- `hooks/witness.cjs`, the runtime: `globalThis.__witness__`, with an Istanbul-shaped `__coverage__` view beside it, recording per test the lines, decision outcomes, and function entries.
- `hooks/witness-loader.mjs`: Node's loader, through `module.registerHooks` (Node 22.15 or later), ES modules and CommonJS alike.
- `hooks/witness-vite.mjs`: a Vite plugin for code that runs in a browser page, with the maps embedded and the runtime injected ahead of every module.
- `hooks/witness-playwright-loader.mjs` and `hooks/witness-playwright.template.ts`: Playwright's workers, where a resolve hook answers a spec's import of the component package with the Witness fixture, so no spec changes.
- `hooks/mocha.cjs`: the Mocha test boundary.
- `dist/hooks/witness-instrument.cjs`: the instrumenter bundled whole, web-tree-sitter included, for a process without this package's `node_modules`; the grammars ship in `dist/`.

The library entry (`dist/index.js`) exports `createInstrumenter`, `hooksDir`, `wasmDir`, `HOOK_FILES`, `ENV` (the environment the hooks read), and `nodeSupportsWitness`. The design, the rules, and what proves it are in `docs/witness.md`.

## Build and test

```powershell
npm install
npm test
npm run build
```

`npm test` runs the rewrite tests, the differential test against istanbul-lib-instrument over every fixture and Witness's own source, the loader end to end in a child Node, the Vite plugin, and the Playwright worker hook.

## Where it is used

DeepTest measures Mocha and Playwright component tests through Witness and bundles it into its VSIX; UntangleIt bundles it for its behaviour gate. Each tool copies the hook files from `dist/hooks` into its own folder in a project and sets the `WITNESS_*` environment on the process it launches. The toolkit's documents, this one included, live in `MADTPackage\library`.

Michael Van Geertruy, with Claude. Project Revive Solutions, LLC. GPL-3.0-only.
