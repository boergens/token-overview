// Read-only reporting. Credentials stay in the Worker environment.
const usageCache = new Map();

export function reportPeriod(now = Date.now()) {
  const end = new Date(now);
  return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)).toISOString(), end: end.toISOString() };
}

function tokenCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid reporting data');
  return value;
}

async function reportRows(url, headers, fetcher) {
  const rows = [], seen = new Set();
  for (let page = 0; page < 10; page++) {
    const response = await fetcher(url.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) }); // Workers' fetch has no redirect 'error'; a redirect is a non-ok response here
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Reporting credentials were rejected. Check their reporting permissions.' : `Provider reporting is unavailable (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.data) || typeof data.has_more !== 'boolean') throw new Error('Invalid reporting data');
    for (const bucket of data.data) {
      if (!Array.isArray(bucket.results)) throw new Error('Invalid reporting data');
      rows.push(...bucket.results);
    }
    if (!data.has_more) return rows;
    if (typeof data.next_page !== 'string' || !data.next_page || seen.has(data.next_page)) throw new Error('Incomplete reporting data');
    seen.add(data.next_page);
    url.searchParams.set('page', data.next_page);
  }
  throw new Error('Reporting requires too many pages. Narrow the configured project or workspace.');
}

export async function fetchTokenUsage(provider, env, fetcher = fetch, now = Date.now()) {
  const period = reportPeriod(now);
  let rows, input = 0, output = 0, scope;
  if (provider === 'chatgpt') {
    if (!env.OPENAI_ADMIN_KEY) return { status: 'not_configured', message: 'Connect OpenAI reporting to see API usage.' };
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.search = new URLSearchParams({ start_time: String(Date.parse(period.start) / 1000), end_time: String(Math.floor(now / 1000)), bucket_width: '1d', limit: '31' });
    if (env.OPENAI_PROJECT_ID) url.searchParams.append('project_ids[]', env.OPENAI_PROJECT_ID);
    rows = await reportRows(url, { Authorization: `Bearer ${env.OPENAI_ADMIN_KEY}` }, fetcher);
    for (const r of rows) { input += tokenCount(r.input_tokens); output += tokenCount(r.output_tokens); }
    // input_tokens already includes cached input: never add input_cached_tokens.
    scope = env.OPENAI_PROJECT_ID ? `Project ${env.OPENAI_PROJECT_ID} · completions usage` : 'Organization · completions usage';
  } else if (provider === 'claude') {
    if (!env.ANTHROPIC_ADMIN_KEY) return { status: 'not_configured', message: 'Anthropic’s Admin API is not available to individual accounts, so API usage can’t be read automatically. See your Claude Console.' };
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    // Omit ending_at: the endpoint excludes buckets ending after that time,
    // which would otherwise omit the current day's partially reported usage.
    url.search = new URLSearchParams({ starting_at: period.start, bucket_width: '1d', limit: '31' });
    if (env.ANTHROPIC_WORKSPACE_ID) url.searchParams.append('workspace_ids[]', env.ANTHROPIC_WORKSPACE_ID);
    rows = await reportRows(url, { 'x-api-key': env.ANTHROPIC_ADMIN_KEY, 'anthropic-version': '2023-06-01' }, fetcher);
    for (const r of rows) {
      input += tokenCount(r.uncached_input_tokens) + tokenCount(r.cache_read_input_tokens) + tokenCount(r.cache_creation?.ephemeral_1h_input_tokens) + tokenCount(r.cache_creation?.ephemeral_5m_input_tokens);
      output += tokenCount(r.output_tokens);
    }
    scope = env.ANTHROPIC_WORKSPACE_ID ? `Workspace ${env.ANTHROPIC_WORKSPACE_ID} · Messages API` : 'Organization · Messages API';
  } else {
    return { status: 'manual', message: 'Gemini API sync is not connected. Record the balance or quota shown in your API console.' };
  }
  const total = tokenCount(input + output);
  return { status: 'connected', tokens: { input, output, total }, scope, period, observedAt: new Date(now).toISOString(), message: 'Provider-reported usage may be delayed. This is usage, not a prepaid balance or rate limit.' };
}

export async function getApiUsage(env, fetcher = fetch, now = Date.now()) {
  const credentials = [env.OPENAI_ADMIN_KEY, env.OPENAI_PROJECT_ID, env.ANTHROPIC_ADMIN_KEY, env.ANTHROPIC_WORKSPACE_ID].map(v => v || '').join('\0');
  // Cache identity never contains credentials in plaintext and is never exposed.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credentials));
  const cacheKey = `${reportPeriod(now).start}:${Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')}`;
  const cached = usageCache.get(cacheKey);
  if (cached && cached.until > now) return cached.value;
  const values = await Promise.all(['claude', 'chatgpt', 'gemini'].map(async provider => {
    try { return [provider, await fetchTokenUsage(provider, env, fetcher, now)]; }
    catch (error) {
      // Never return provider response bodies, request headers, or raw errors.
      const message = /^Reporting credentials were rejected|^Provider reporting is unavailable/.test(error.message || '') ? error.message : 'Could not read complete provider usage. Try again later; no balance has been inferred.';
      return [provider, { status: 'error', message }];
    }
  }));
  const value = { period: reportPeriod(now), providers: Object.fromEntries(values) };
  usageCache.clear();
  usageCache.set(cacheKey, { until: now + 60000, value });
  return value;
}
