import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: true,
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('[Smart Enter And Backspace] esbuild watching...');
} else {
  await build(options);
  console.log('[Smart Enter And Backspace] esbuild bundle complete -> dist/extension.js');
}
