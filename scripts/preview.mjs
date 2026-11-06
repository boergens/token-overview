// Review-only, standalone preview; deliberately outside dist/ and never deployed.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
const read = path => readFile(root+path,'utf8');
const [html,css,layout,model,app,icon] = await Promise.all(['public/index.html','public/styles.css','public/layout.css','public/model.js','public/app.js','public/favicon.svg'].map(read));
const inlineCss = css.replace("@import url('/layout.css');",'')+'\n'+layout;
const inlineJs = model.replace(/^export /gm,'')+'\n'+app.replace(/^import .*?;\n/,'').replace("await fetch('/api/session', { cache: 'no-store', redirect: 'error' })", "Response.json({ mode: 'local-preview' })");
const iconData = `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`;
const preview = html
  .replace('<title>Allowance · Your AI usage</title>','<title>Local preview · Allowance</title>')
  .replace('<link rel="stylesheet" href="/styles.css">',()=>`<style>${inlineCss}</style>`)
  .replace('<script src="/app.js" type="module"></script>',()=>`<script type="module">${inlineJs}</script>`)
  .replaceAll('/favicon.svg',iconData)
  .replace('href="/" class="brand"','href="#main" class="brand"');
await mkdir(root+'artifacts',{recursive:true});
await writeFile(root+'artifacts/preview.html',preview);
console.log('Created artifacts/preview.html. Open locally to review; do not deploy this preview.');
