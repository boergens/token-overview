import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {fetchTokenUsage,getApiUsage,reportPeriod} from '../server/usage.js';
import {emptyState,validateState,trackingBudgetLeft} from '../public/model.js';
globalThis.crypto ??= webcrypto;
const now = Date.parse('2026-10-19T12:30:00Z');
const response = (results, extra={}) => Response.json({data:[{results}],has_more:false,next_page:null,...extra});

test('missing credentials and Gemini produce unknown usage without network calls',async()=>{
  const report = await getApiUsage({},()=>assert.fail('No credentials: no network requests'),now);
  assert.equal(report.providers.chatgpt.status,'not_configured');
  assert.equal(report.providers.claude.status,'not_configured');
  assert.equal(report.providers.gemini.status,'manual');
  for(const p of Object.values(report.providers)) assert.equal(p.tokens,undefined);
});

test('OpenAI pagination sums input and output once, including cached input',async()=>{
  let calls=0;
  const result=await fetchTokenUsage('chatgpt',{OPENAI_ADMIN_KEY:'test-openai',OPENAI_PROJECT_ID:'proj_test'},async(url,options)=>{
    const u=new URL(url);
    assert.equal(u.origin,'https://api.openai.com');
    assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,'Bearer test-openai');
    assert.equal(u.searchParams.get('project_ids[]'),'proj_test');
    assert.equal(u.searchParams.get('start_time'),String(Date.parse('2026-10-01T00:00:00Z')/1000));
    if(calls++===0)return response([{input_tokens:100,output_tokens:30,input_cached_tokens:80}],{has_more:true,next_page:'page-two'});
    assert.equal(u.searchParams.get('page'),'page-two');
    return response([{input_tokens:50,output_tokens:20,input_cached_tokens:40}]);
  },now);
  assert.deepEqual(result.tokens,{input:150,output:50,total:200});
  assert.equal(calls,2);
  assert.match(result.scope,/proj_test/);
});

test('Anthropic includes uncached, cache-read, both cache-write durations, and output',async()=>{
  const result=await fetchTokenUsage('claude',{ANTHROPIC_ADMIN_KEY:'test-anthropic',ANTHROPIC_WORKSPACE_ID:'wrkspc_test'},async(url,options)=>{
    const u=new URL(url);
    assert.equal(u.origin,'https://api.anthropic.com');
    assert.equal(u.searchParams.get('workspace_ids[]'),'wrkspc_test');
    assert.equal(u.searchParams.has('ending_at'),false);
    assert.equal(options.headers['anthropic-version'],'2023-06-01');
    return response([{uncached_input_tokens:100,cache_read_input_tokens:80,cache_creation:{ephemeral_1h_input_tokens:20,ephemeral_5m_input_tokens:30},output_tokens:40}]);
  },now);
  assert.deepEqual(result.tokens,{input:230,output:40,total:270});
});

test('broken or incomplete reporting never masquerades as a zero balance',async()=>{
  for(const result of [
    {data:[],has_more:true,next_page:null},
    {data:[{results:[{input_tokens:1}]}],has_more:false},
    {data:[{results:[{input_tokens:-1,output_tokens:2}]}],has_more:false},
    {data:[],has_more:'false'},
  ])await assert.rejects(fetchTokenUsage('chatgpt',{OPENAI_ADMIN_KEY:'test'},async()=>Response.json(result),now));
  await assert.rejects(fetchTokenUsage('chatgpt',{OPENAI_ADMIN_KEY:'test'},async()=>response([],{has_more:true,next_page:'repeated'}),now),/Incomplete/);
});

test('errors are isolated by provider and never expose credentials or upstream error bodies',async()=>{
  const key='fake-secret-must-not-be-returned';
  const data=await getApiUsage({OPENAI_ADMIN_KEY:key,ANTHROPIC_ADMIN_KEY:'test-valid'},async(url)=>{
    if(url.startsWith('https://api.openai.com'))return new Response(key,{status:403});
    return response([{uncached_input_tokens:0,cache_read_input_tokens:0,cache_creation:{ephemeral_1h_input_tokens:0,ephemeral_5m_input_tokens:0},output_tokens:0}]);
  },now);
  assert.equal(data.providers.chatgpt.status,'error');
  assert.equal(data.providers.claude.status,'connected');
  assert.equal(data.providers.claude.tokens.total,0);
  assert.equal(JSON.stringify(data).includes(key),false);
});

test('cache expires and credential changes cannot reuse another account report',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return response([{input_tokens:1,output_tokens:2}]);};
  await getApiUsage({OPENAI_ADMIN_KEY:'cache-a'},fetcher,now);
  await getApiUsage({OPENAI_ADMIN_KEY:'cache-a'},fetcher,now+1000);
  assert.equal(calls,1);
  await getApiUsage({OPENAI_ADMIN_KEY:'cache-b'},fetcher,now+2000);
  assert.equal(calls,2);
  await getApiUsage({OPENAI_ADMIN_KEY:'cache-b'},fetcher,now+62000);
  assert.equal(calls,3);
});

test('old backups migrate without merging chat and API balances',()=>{
  const old=emptyState(); delete old.api; old.version=1;
  old.providers.claude.plan='Pro';
  const clean=validateState(old);
  assert.equal(clean.version,2);
  assert.equal(clean.providers.claude.plan,'Pro');
  assert.equal(clean.api.claude.reading,null);
  const next=structuredClone(clean);
  next.api.claude.reading={unit:'usd',remaining:12.5,total:null,scope:'Prepaid balance',observedAt:new Date().toISOString(),resetsAt:null,source:'manual'};
  const saved=validateState(next);
  assert.equal(saved.api.claude.reading.unit,'usd');
  assert.deepEqual(saved.providers.claude.windows,{});
  assert.throws(()=>validateState({...saved,api:{...saved.api,claude:{...saved.api.claude,budgetTokens:-1}}}));
});

test('personal budgets are unknown until usage is available, clamp at zero, and do not cross months',()=>{
  const report={status:'connected',tokens:{total:200},period:reportPeriod(now)};
  assert.equal(trackingBudgetLeft({budgetTokens:1000},report,now),800);
  assert.equal(trackingBudgetLeft({budgetTokens:100},report,now),0);
  assert.equal(trackingBudgetLeft({budgetTokens:1000},{status:'error'},now),null);
  assert.equal(trackingBudgetLeft({budgetTokens:1000},report,Date.parse('2026-11-01T00:00:00Z')),null);
});
