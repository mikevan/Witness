# Changelog

## 1.0.9

Witness leaves DeepTest and becomes its own library, `@projectrevivesolutions/witness`, at the toolkit version. The instrumenter, the runtime, the Node loader, the Vite plugin, the Playwright worker hook and fixture, the Mocha boundary, the esbuild bundle, the grammars, and the tests move here unchanged in what they measure; the hooks now read `WITNESS_*` environment names instead of `DEEPTEST_*`, so any tool can drive them. DeepTest bundles it; UntangleIt declares it for its behaviour gate.
