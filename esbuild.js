const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

async function build() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });

  if (isWatch) {
    await context.watch();
    console.log('Watching for changes...');
  } else {
    await context.rebuild();
    await context.dispose();
    console.log('Build completed successfully.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
