/**
 * Tests for the lead endpoint. No dependencies and no account needed:
 *   node worker/test.mjs
 *
 * Bindings are stubbed, so this exercises validation, the honeypot, rate
 * limiting, notification and asset fall-through without deploying.
 *
 * A caveat these stubs cannot escape: they are strongly consistent and the
 * real bindings are not, so a green run here is necessary but not sufficient.
 * Note also that per-IP rate limiting cannot be exercised from a client whose
 * egress IP rotates, since each request then presents a different key.
 */
import worker from './index.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
}

const store = new Map();
const KV = {
  async get(k) { const e = store.get(k); return e === undefined ? null : e; },
  async put(k, v) { store.set(k, v); }
};

/* Stands in for the platform rate limit binding: 5 calls per key, then blocked. */
const seen = new Map();
const LEAD_RATE_LIMIT = {
  async limit({ key }) {
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return { success: n <= 5 };
  }
};

const ASSETS = { fetch: async () => new Response('ASSET', { status: 200 }) };
const env = { LEADS: KV, LEAD_RATE_LIMIT, ASSETS };

/* Captures outbound Telegram calls. */
let outbound = [];
let telegramReply = () => new Response('{"ok":true}', { status: 200 });
globalThis.fetch = async (url, init) => {
  outbound.push({ url: String(url), body: JSON.parse(init.body) });
  return telegramReply();
};

const post = (body, headers = {}) => new Request('https://x/api/lead', {
  method: 'POST',
  headers: Object.assign(
    { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    headers
  ),
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

const valid = {
  name: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+91 98765 43210',
  message: 'Please share the 3BHK price list.',
  project: 'Embassy Chapparkallu',
  page: '/price'
};

const send = (body, e = env, headers) => worker.fetch(post(body, headers), e, { waitUntil: () => {} });

console.log('--- happy path ---');
{
  const res = await send(valid);
  const body = await res.json();
  check('valid lead accepted', res.status === 200 && body.ok === true, `status ${res.status}`);

  const keys = [...store.keys()];
  check('stored under lead:<iso>:<id>', keys.length === 1 && /^lead:\d{4}-\d\d-\d\dT[\d:.]+Z:[0-9a-f]{8}$/.test(keys[0]), keys[0]);

  const rec = JSON.parse(store.get(keys[0]));
  check('phone normalised to 10 digits', rec.phone === '9876543210', rec.phone);
  check('every field stored', rec.name === 'Asha Rao' && rec.email === 'asha@example.com'
    && rec.message.startsWith('Please share') && rec.project === 'Embassy Chapparkallu' && rec.page === '/price');
  check('IP not stored alongside the enquirer', !JSON.stringify(rec).includes('1.2.3.4'));
}

console.log('\n--- phone handling ---');
for (const [input, expected, label] of [
  ['9876543210', '9876543210', 'bare Indian mobile'],
  ['09876543210', '9876543210', 'leading zero stripped'],
  ['+91 98765-43210', '9876543210', 'country code and punctuation stripped'],
  ['+1 415 555 2671', '14155552671', 'international kept (NRI enquiry)']
]) {
  store.clear();
  const res = await send({ ...valid, phone: input });
  const rec = JSON.parse(store.get([...store.keys()][0]) || '{}');
  check(label, res.status === 200 && rec.phone === expected, `${input} -> ${rec.phone}`);
}
{
  store.clear();
  const res = await send({ ...valid, phone: '12345' });
  check('too short rejected', res.status === 422 && store.size === 0, `status ${res.status}`);
}

console.log('\n--- validation (all four fields are required in the markup) ---');
for (const [patch, label] of [
  [{ name: 'A' }, 'name under 2 chars rejected'],
  [{ email: 'not-an-email' }, 'malformed email rejected'],
  [{ email: '' }, 'missing email rejected'],
  [{ message: '' }, 'missing message rejected'],
  [{ phone: '' }, 'missing phone rejected']
]) {
  store.clear();
  const res = await send({ ...valid, ...patch });
  const body = await res.json();
  check(label, res.status === 422 && body.ok === false && store.size === 0, `status ${res.status}`);
}

console.log('\n--- honeypot ---');
{
  store.clear();
  const res = await send({ ...valid, company: 'Acme Corp' });
  const body = await res.json();
  check('filled honeypot answered 200 so the bot does not adapt', res.status === 200 && body.ok === true);
  check('honeypot submission NOT stored', store.size === 0);
}

console.log('\n--- malformed input ---');
{
  store.clear();
  check('non-JSON body rejected', (await send('not json')).status === 400);
  check('JSON array rejected', (await send([1, 2, 3])).status === 400);
  check('null body rejected', (await send('null')).status === 400);
  const big = await send({ ...valid, message: 'x'.repeat(5000) });
  check('oversized payload rejected', big.status === 413, `status ${big.status}`);
  check('nothing malformed was stored', store.size === 0);
  const wrongMethod = await worker.fetch(new Request('https://x/api/lead'), env, {});
  check('GET on /api/lead rejected', wrongMethod.status === 405);
}

console.log('\n--- storage missing ---');
{
  const res = await send(valid, { ...env, LEADS: undefined });
  check('rejects with 503 rather than silently dropping', res.status === 503);
}

console.log('\n--- rate limiting ---');
{
  store.clear(); seen.clear();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await send(valid)).status);
  check('first 5 admitted, rest 429', codes.filter(c => c === 200).length === 5
    && codes.filter(c => c === 429).length === 2, codes.join(','));
}

console.log('\n--- notification ---');
{
  store.clear(); seen.clear(); outbound = [];
  const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_IDS: '111, 222' };
  await send(valid, tgEnv);
  check('one Telegram send per group: the North Bangalore group and both All Bangalore groups',
    outbound.map(o => o.body.chat_id).join() === '-5141074270,-5486402123,-5268923231',
    outbound.map(o => o.body.chat_id).join());
  check('the first bot ignores TELEGRAM_CHAT_IDS', !outbound.some(o => ['111', '222'].includes(o.body.chat_id)));
  const text = outbound[0]?.body?.text || '';
  check('plain text, no parse_mode', !('parse_mode' in (outbound[0]?.body || {})));
  check('message carries the lead', text.includes('Asha Rao') && text.includes('9876543210')
    && text.includes('asha@example.com') && text.includes('Embassy Chapparkallu'));

  store.clear(); seen.clear(); outbound = [];
  const sent = [];
  const mailEnv = {
    ...env,
    LEAD_EMAIL_TO: 'raghuvalekar1515@gmail.com, second@example.com',
    LEAD_EMAIL_FROM: 'no-reply@embassychapparkallu.com',
    LEAD_EMAIL: { send: async (m) => { sent.push(m); return { messageId: 'mid-1' }; } }
  };
  await send(valid, mailEnv);
  check('one email per recipient', sent.length === 2, `${sent.length} sends`);
  check('subject names the enquirer', /Asha Rao/.test(sent[0]?.subject || ''), sent[0]?.subject);

  /* The point of the whole design: notification failure must not cost the lead. */
  store.clear(); seen.clear();
  const throwingEnv = {
    ...env,
    LEAD_EMAIL_TO: 'x@example.com',
    LEAD_EMAIL_FROM: 'no-reply@embassychapparkallu.com',
    LEAD_EMAIL: { send: async () => { throw new Error('address not verified'); } }
  };
  const res = await send(valid, throwingEnv);
  check('email failure still returns 200 to the visitor', res.status === 200);
  check('lead survives a failing email channel', store.size === 1);
}

console.log('\n--- lead source (hidden field) ---');
{
  const SOURCE = 'PNZ MS Lead';
  const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_IDS: '111' };

  store.clear(); seen.clear(); outbound = [];
  const res = await send({ ...valid, lead_source: SOURCE }, tgEnv);
  const rec = JSON.parse(store.get([...store.keys()][0]) || '{}');
  check('accepted with lead_source', res.status === 200);
  check('lead_source stored on the record', rec.lead_source === SOURCE, rec.lead_source);
  const text = outbound[0]?.body?.text || '';
  check('Telegram message carries the Source line', text.includes('Source:  ' + SOURCE), JSON.stringify(text.split('\n').find(l => l.startsWith('Source'))));
  check('Source sits with the other attribution lines',
    text.indexOf('Page:') < text.indexOf('Source:') && text.indexOf('Source:') < text.indexOf('Time:'));

  /* The email body is the same formatLead() output, so assert it there too. */
  store.clear(); seen.clear();
  const sent = [];
  await send({ ...valid, lead_source: SOURCE }, {
    ...env,
    LEAD_EMAIL_TO: 'x@example.com',
    LEAD_EMAIL_FROM: 'no-reply@embassychapparkallu.com',
    LEAD_EMAIL: { send: async (m) => { sent.push(m); return { messageId: 'mid' }; } }
  });
  check('email body carries the source', (sent[0]?.text || '').includes('Source:  ' + SOURCE));

  /* A page cached before this change sends no lead_source. It must still
     submit, and must not print an empty "Source:" line. */
  store.clear(); seen.clear(); outbound = [];
  const legacy = await send(valid, tgEnv);
  const legacyRec = JSON.parse(store.get([...store.keys()][0]) || '{}');
  check('lead without lead_source still accepted', legacy.status === 200);
  check('absent lead_source stored as empty, not undefined', legacyRec.lead_source === '');
  check('no empty Source line when unset', !(outbound[0]?.body?.text || '').includes('Source:'));

  /* Caller-supplied like every other field, so it gets the same treatment. */
  store.clear(); seen.clear();
  await send({ ...valid, lead_source: 'A' + String.fromCharCode(0) + 'B C  ' });
  check('control characters stripped from lead_source',
    JSON.parse(store.get([...store.keys()][0])).lead_source === 'A B C');

  store.clear(); seen.clear();
  await send({ ...valid, lead_source: 'x'.repeat(500) });
  check('lead_source capped at 120',
    JSON.parse(store.get([...store.keys()][0])).lead_source.length === 120);

  store.clear(); seen.clear();
  const nonString = await send({ ...valid, lead_source: { evil: true } });
  check('non-string lead_source coerced to empty, lead still stored',
    nonString.status === 200 && JSON.parse(store.get([...store.keys()][0])).lead_source === '');

  /* lead_source must not become a way past the spam trap. */
  store.clear(); seen.clear();
  const trapped = await send({ ...valid, lead_source: SOURCE, company: 'Acme' });
  check('honeypot still wins over lead_source', trapped.status === 200 && store.size === 0);
}

console.log('\n--- zone (hidden field) ---');
{
  const ZONE = "North Bangalore";
  const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_IDS: '111' };
  const rec = () => JSON.parse(store.get([...store.keys()][0]) || '{}');

  store.clear(); seen.clear(); outbound = [];
  const res = await send({ ...valid, zone: ZONE }, tgEnv);
  check('accepted with zone', res.status === 200);
  check('zone stored on the record', rec().zone === ZONE, rec().zone);
  const text = outbound[0]?.body?.text || '';
  check('Telegram message carries the Zone line', text.includes('Zone:    ' + ZONE),
    JSON.stringify(text.split('\n').find(l => l.startsWith('Zone'))));
  check('Zone sits under Project', text.indexOf('Project:') < text.indexOf('Zone:')
    && text.indexOf('Zone:') < text.indexOf('Time:'));

  store.clear(); seen.clear();
  const sent = [];
  await send({ ...valid, zone: ZONE }, {
    ...env,
    LEAD_EMAIL_TO: 'x@example.com',
    LEAD_EMAIL_FROM: 'no-reply@embassychapparkallu.com',
    LEAD_EMAIL: { send: async (m) => { sent.push(m); return { messageId: 'mid' }; } }
  });
  check('email body carries the zone', (sent[0]?.text || '').includes('Zone:    ' + ZONE));

  /* A page cached before the field existed sends no zone: the site's own
     zone stands in, so every lead still names one. */
  store.clear(); seen.clear(); outbound = [];
  const legacy = await send(valid, tgEnv);
  check('lead without zone still accepted', legacy.status === 200);
  check('absent zone falls back to the site\'s zone', rec().zone === ZONE, rec().zone);
  check('Zone line printed for it too', (outbound[0]?.body?.text || '').includes('Zone:    ' + ZONE));

  store.clear(); seen.clear();
  await send({ ...valid, zone: 'North' + String.fromCharCode(0) + 'Bangalore ' });
  check('control characters stripped from zone', rec().zone === 'North Bangalore');

  store.clear(); seen.clear();
  await send({ ...valid, zone: 'x'.repeat(500) });
  check('zone capped at 60', rec().zone.length === 60);

  store.clear(); seen.clear();
  const nonString = await send({ ...valid, zone: { evil: true } });
  check('non-string zone falls back, lead still stored', nonString.status === 200 && rec().zone === ZONE);
}

console.log('\n--- zone groups (Bangalore) ---');
{
  /* Notifications run in waitUntil; these checks wait for them to finish. */
  const settled = async (body, e) => {
    const waits = [];
    const res = await worker.fetch(post(body), e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  };

  /* A second bot posts to its own chats, beside the zone groups. */
  store.clear(); seen.clear(); outbound = [];
  await settled(valid, { ...env, TELEGRAM_BOT_TOKEN: 'A:TOKEN', TELEGRAM_BOT_TOKEN_2: 'B:TOKEN', TELEGRAM_CHAT_IDS_2: '333' });
  check('second bot posts to its own chat as well', outbound.length === 4
    && outbound.some(o => o.url.includes('botB:TOKEN') && o.body.chat_id === '333'), `${outbound.length} sends`);

  /* A group upgraded to a supergroup answers with its new id: the lead
     follows it there. */
  store.clear(); seen.clear(); outbound = [];
  telegramReply = () => {
    const last = outbound[outbound.length - 1];
    if (last.body.chat_id === '-5141074270') {
      return new Response('{"ok":false,"error_code":400,"description":"Bad Request: group chat was upgraded to a supergroup chat","parameters":{"migrate_to_chat_id":-100777}}', { status: 400 });
    }
    return new Response('{"ok":true}', { status: 200 });
  };
  const moved = await settled(valid, { ...env, TELEGRAM_BOT_TOKEN: 'A:TOKEN' });
  check('upgraded group: the lead is resent to its new id', moved.status === 200
    && outbound.some(o => o.body.chat_id === '-100777'), outbound.map(o => o.body.chat_id).join());

  /* The self-check asks Telegram, sends nothing and names chats by role. */
  outbound = [];
  telegramReply = () => {
    const url = outbound[outbound.length - 1].url;
    if (url.endsWith('/getMe')) return new Response('{"ok":true,"result":{"id":42,"username":"pnz_leads_bot"}}');
    if (url.endsWith('/getChat')) return new Response('{"ok":true,"result":{"type":"group","permissions":{"can_send_messages":true}}}');
    if (url.endsWith('/getChatMember')) return new Response('{"ok":true,"result":{"status":"member"}}');
    return new Response('{"ok":true}');
  };
  const res = await worker.fetch(new Request('https://x/api/lead/status?check=telegram',
    { headers: { 'cf-connecting-ip': '9.9.9.9' } }), { ...env, TELEGRAM_BOT_TOKEN: 'A:TOKEN' }, {});
  const r = await res.json();
  const chats = (r.telegram && r.telegram.bots && r.telegram.bots[0] && r.telegram.bots[0].chats) || [];
  check('self-check reports the bot can post to all three groups', r.telegram && r.telegram.delivering === true
    && chats.map(c => c.chat).join() === 'North Bangalore group,All Bangalore group 1,All Bangalore group 2', JSON.stringify(chats));
  check('self-check sends no message', !outbound.some(o => o.url.endsWith('/sendMessage')));
  const raw = JSON.stringify(r);
  check('self-check leaks no token or chat id', !raw.includes('A:TOKEN') && !raw.includes('-5141074270'));
  telegramReply = () => new Response('{"ok":true}', { status: 200 });
}

console.log('\n--- status endpoint ---');
{
  const res = await worker.fetch(new Request('https://x/api/lead/status'), {
    ...env,
    LEAD_EMAIL_TO: 'raghuvalekar1515@gmail.com',
    LEAD_EMAIL_FROM: 'no-reply@embassychapparkallu.com',
    LEAD_EMAIL: { send: async () => ({}) },
    TELEGRAM_BOT_TOKEN: 'T:OK',
    TELEGRAM_CHAT_IDS: '111,222'
  }, {});
  const s = await res.json();
  check('reports storage and channels', s.ok && s.storage === true
    && s.email.configured === true && s.email.transport === 'cloudflare'
    && s.email.recipientsSet === 1 && s.telegram.chats === 3);

  /* Must never leak who alerting reaches. */
  const raw = JSON.stringify(s);
  check('leaks no address, token or chat id',
    !raw.includes('raghuvalekar1515') && !raw.includes('T:OK') && !raw.includes('111'));
}

console.log('\n--- half-configured Telegram ---');
{
  const res = await worker.fetch(new Request('https://x/api/lead/status'),
    { ...env, TELEGRAM_BOT_TOKEN_2: 'T:OK' }, {});
  const s = await res.json();
  check('a second bot without chat ids counts as unconfigured', s.telegram.configured === false);
  const first = await (await worker.fetch(new Request('https://x/api/lead/status'),
    { ...env, TELEGRAM_BOT_TOKEN: 'T:OK' }, {})).json();
  check('the first bot needs only its token: its chats are the zone groups',
    first.telegram.configured === true && first.telegram.chats === 3);
}

console.log('\n--- Search Console verification file ---');
{
  let asked = '';
  const res = await worker.fetch(new Request('https://x/google0123456789abcdef.html'),
    { ...env, ASSETS: { fetch: async (r) => { asked = String((r && r.url) || r); return new Response('ASSET'); } } }, {});
  check('served at its exact .html address', (await res.text()) === 'ASSET'
    && asked === 'https://x/google0123456789abcdef', asked);
}

console.log('\n--- asset fall-through ---');
{
  const res = await worker.fetch(new Request('https://x/price'), env, {});
  check('non-API request falls through to ASSETS', (await res.text()) === 'ASSET');
  const root = await worker.fetch(new Request('https://x/'), env, {});
  check('root falls through to ASSETS', (await root.text()) === 'ASSET');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
