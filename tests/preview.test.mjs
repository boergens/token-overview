import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

test('standalone preview preserves dollar literals and produces executable JavaScript',async()=>{
  const cwd=fileURLToPath(new URL('../',import.meta.url));
  await import('../scripts/preview.mjs');
  const html=await readFile(cwd+'artifacts/preview.html','utf8');
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.ok(script.includes("? '$' + display"));
  assert.ok(!script.includes("fetch('/api/session'"));
  assert.equal((html.match(/<script type="module">/g)||[]).length,1);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  assert.doesNotThrow(()=>new AsyncFunction(script));
});
