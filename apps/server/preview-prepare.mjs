import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [source, output] = process.argv.slice(2);
if (source !== '/source' || output !== '/output') throw new Error('Invalid preview preparation roots');

const child = spawn(
  process.execPath,
  [
    '/verifier/node_modules/vite/bin/vite.js',
    'build',
    source,
    '--config',
    '/preview/vite.config.mjs',
    '--configLoader',
    'native',
    '--outDir',
    output,
    '--emptyOutDir',
  ],
  { env: { NODE_ENV: 'production', PATH: '' }, stdio: ['ignore', 'ignore', 'pipe'] },
);

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = (stderr + String(chunk)).slice(-4096);
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
if (code !== 0) throw new Error(`Vite preview preparation failed (${code}): ${stderr}`);

const localOutputAsset = (url) => {
  if (!url.startsWith('./') || url.includes('?') || url.includes('#') || url.includes('\\')) return null;
  const resolved = path.resolve(output, url.slice(2));
  const relative = path.relative(output, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
};

const escapeRawTextEndTag = (content, tag) => content.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);

const inlinePreparedViteEntry = async () => {
  const entryPath = path.join(output, 'index.html');
  let html = await readFile(entryPath, 'utf8');
  const inlinedFiles = new Set();

  const stylesheetTags = [...html.matchAll(/<link\b[^>]*>/gi)].filter(({ 0: tag }) =>
    /\brel\s*=\s*(["'])stylesheet\1/i.test(tag),
  );
  for (const { 0: tag } of stylesheetTags) {
    const href = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2];
    const assetPath = href ? localOutputAsset(href) : null;
    if (!assetPath) continue;
    const css = escapeRawTextEndTag(await readFile(assetPath, 'utf8'), 'style');
    html = html.replace(tag, () => `<style>${css}</style>`);
    inlinedFiles.add(assetPath);
  }

  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/script>/gi)];
  for (const { 0: tag, 2: sourceUrl } of scriptTags) {
    const assetPath = localOutputAsset(sourceUrl);
    if (!assetPath) continue;
    const javascript = escapeRawTextEndTag(await readFile(assetPath, 'utf8'), 'script');
    const openingTag = tag.slice(0, tag.indexOf('>') + 1)
      .replace(/\s+src\s*=\s*(["'])[^"']+\1/i, '')
      .replace(/\s+crossorigin(?:\s*=\s*(["'])[^"']*\1)?/i, '');
    html = html.replace(tag, () => `${openingTag}${javascript}</script>`);
    inlinedFiles.add(assetPath);
  }

  await writeFile(entryPath, html);
  await Promise.all([...inlinedFiles].map((assetPath) => rm(assetPath)));
};

await inlinePreparedViteEntry();

let files = 0;
let bytes = 0;
const realized = [];
const visit = async (directory, relative = '') => {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Invalid preview output entry');
    const target = `${directory}/${entry.name}`;
    const portable = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await visit(target, portable);
    } else {
      const size = (await stat(target)).size;
      files += 1;
      bytes += size;
      if (size > 2 * 1024 * 1024 || files > 512 || bytes > 8 * 1024 * 1024) throw new Error('Preview output exceeds bound');
      realized.push({ path: portable, content: (await readFile(target)).toString('base64') });
    }
  }
};
await visit(output);

process.stdout.write(JSON.stringify({ files: realized }));
