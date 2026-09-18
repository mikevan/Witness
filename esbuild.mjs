// The hooks run inside the project's own Node process, a Vite build, or a
// browser page, where this package's node_modules does not exist. So the
// instrumenter is bundled whole (web-tree-sitter included) into one CommonJS
// file beside the hooks, and the grammars are copied to dist/ for the tools
// to ship. tsc has already written dist/index.js and the types for the
// library entry point.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// web-tree-sitter ships ESM and CJS builds. Its ESM build uses import.meta.url,
// which is undefined inside a CommonJS bundle, so the bundler is pointed at
// the CJS file directly; the package's exports map hides it from a plain alias.
const treeSitterCjs = {
  name: 'web-tree-sitter-cjs',
  setup(build) {
    build.onResolve({ filter: /^web-tree-sitter$/ }, () => ({
      path: fileURLToPath(new URL('./node_modules/web-tree-sitter/web-tree-sitter.cjs', import.meta.url)),
    }));
  },
};

mkdirSync('dist/hooks', { recursive: true });
copyFileSync('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/web-tree-sitter.wasm');
for (const file of readdirSync('vendor')) {
  if (file.endsWith('.wasm')) {
    copyFileSync(`vendor/${file}`, `dist/${file}`);
  }
}
for (const file of readdirSync('hooks')) {
  copyFileSync(`hooks/${file}`, `dist/hooks/${file}`);
}

await esbuild.build({
  entryPoints: ['src/hook.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/hooks/witness-instrument.cjs',
  plugins: [treeSitterCjs],
  sourcemap: false,
  logLevel: 'info',
});
