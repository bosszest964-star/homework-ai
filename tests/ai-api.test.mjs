import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="ai-api">([\s\S]+?)<\/script>/)?.[1];
assert.ok(script, 'ไม่พบสคริปต์ API ใน index.html');
const geminiPresets = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-3.6-flash'];
const openaiPresets = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol'];
const geminiReply = { candidates: [{ content: { parts: [{ thought: true, text: 'skip' }, { text: 'OK' }] } }] };
const openaiReply = { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] };
const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const modelFromUrl = url => decodeURIComponent(new URL(url).pathname.split('/').at(-1).replace(':generateContent', ''));
const config = (provider, model) => ({ provider, model, key: 'unit-test-key' });
const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const schema = { type: 'object', properties: { answers: { type: 'array' } } };

function loadApi(fetch) {
  const context = createContext({ fetch, setTimeout, clearTimeout, URL, AbortController, TypeError });
  runInContext(script, context, { filename: 'index.html#ai-api' });
  return context.WorksheetAI;
}

test('โมเดลเริ่มต้นของทั้งสองผู้ให้บริการตรงตามลำดับ และรองรับรหัสกำหนดเอง', () => {
  const api = loadApi();
  assert.deepEqual(Array.from(api.presets.gemini), geminiPresets);
  assert.deepEqual(Array.from(api.presets.openai), openaiPresets);
  assert.equal(api.modelFor(config('gemini')), geminiPresets[0]);
  assert.equal(api.modelFor(config('openai', ' ')), openaiPresets[0]);
  assert.equal(api.modelFor(config('gemini', ' models/gemini-personal ')), 'gemini-personal');
  assert.equal(api.modelFor(config('openai', ' ft:project:my-model ')), 'ft:project:my-model');
});

test('ใบงาน Gemini ส่ง v1beta generateContent พร้อม inlineData ที่มี MIME และ Base64 เท่านั้น', async () => {
  const api = loadApi(async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-goog-api-key'], 'unit-test-key');
    const body = JSON.parse(options.body);
    const content = body.contents[0];
    assert.equal(content.role, 'user');
    assert.deepEqual(content.parts[0], { text: 'อ่านใบงาน' });
    assert.deepEqual(content.parts[1], { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } });
    assert.equal(Buffer.from(content.parts[1].inlineData.data, 'base64').readUInt16BE(), 0xffd8);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
    return reply(200, geminiReply);
  });
  const body = api.worksheetBody('gemini', dataUrl, 'เก็บเฉพาะคำตอบ', 'อ่านใบงาน', schema);
  assert.equal((await api.generate(config('gemini'), body)).output, 'OK');
  assert.throws(() => api.worksheetBody('gemini', 'data:,', '', '', schema), /Base64/);
  const png = api.worksheetBody('gemini', 'data:image/png;base64,iVBORw0KGgo=', '', '', schema);
  assert.equal(png.contents[0].parts[1].inlineData.mimeType, 'image/png');
});

test('OpenAI ใช้โมเดลที่เลือกทั้งตอนสแกนและทดสอบ และไม่ส่ง temperature', async () => {
  const expected = [openaiPresets[0], openaiPresets[1], openaiPresets[2], 'ft:project:my-model'];
  const actual = [];
  const api = loadApi(async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
    const body = JSON.parse(options.body);
    actual.push(body.model);
    assert.equal('temperature' in body, false);
    if (body.response_format) {
      assert.equal(body.messages[1].content[1].image_url.url, dataUrl);
      assert.equal(body.response_format.json_schema.strict, true);
    } else {
      assert.equal(body.messages[0].content, 'Reply with OK.');
    }
    return reply(200, openaiReply);
  });
  await api.generate(config('openai'), api.worksheetBody('openai', dataUrl, 'instructions', 'scan', schema));
  for (const model of expected.slice(1)) {
    assert.equal(await api.testConnection(config('openai', model)), model);
  }
  assert.deepEqual(actual, expected);
});

test('Gemini สลับจาก custom เมื่อพบ 404, 403 หรือ 429 ตามลำดับและหยุดเมื่อสำเร็จ', async () => {
  const calls = [], changes = [];
  const api = loadApi(async (url, options) => {
    calls.push(modelFromUrl(url));
    assert.deepEqual(JSON.parse(options.body), { contents: [] });
    const status = [404, 403, 429, 200][calls.length - 1];
    return reply(status, status === 200 ? geminiReply : { error: { message: 'private upstream detail' } });
  });
  const result = await api.generate(config('gemini', 'models/personal-model'), { contents: [] },
    { onFallback: change => changes.push(change) });
  assert.deepEqual(calls, ['personal-model', ...geminiPresets.slice(0, 3)]);
  assert.deepEqual(changes.map(change => [change.from, change.to, change.error.status]),
    calls.slice(0, -1).map((from, index) => [from, calls[index + 1], [404, 403, 429][index]]));
  assert.equal(result.model, 'gemini-4-hydrogen');
  assert.equal(result.output, 'OK');
});

test('เมื่อเลือกหนึ่งในรุ่นสำรอง ระบบข้ามรุ่นที่ลองไปแล้วและรายงานเมื่อหมดตัวเลือก', async () => {
  const calls = [];
  const api = loadApi(async url => {
    calls.push(modelFromUrl(url));
    return reply(429, { error: { message: 'limited' } });
  });
  await assert.rejects(api.generate(config('gemini', geminiPresets[1]), {}), error => {
    assert.equal(error.stopsScan, true);
    assert.match(error.message, /ลองโมเดล Gemini ครบแล้ว/);
    assert.match(error.message, /โควตา/);
    return true;
  });
  assert.deepEqual(calls, [geminiPresets[1], geminiPresets[0], ...geminiPresets.slice(2)]);
});

test('คีย์ผิดแสดงข้อผิดพลาดภาษาไทยและไม่ลองซ้ำ แม้ผู้ให้บริการตอบ 403', async () => {
  for (const [provider, status, error] of [
    ['gemini', 400, { details: [{ reason: 'API_KEY_INVALID' }] }],
    ['gemini', 403, { details: [{ reason: 'API_KEY_INVALID' }] }],
    ['gemini', 400, { message: 'API key not valid. Please pass a valid API key.' }],
    ['openai', 401, { code: 'invalid_api_key' }]
  ]) {
    let calls = 0;
    const api = loadApi(async () => { calls++; return reply(status, { error }); });
    await assert.rejects(api.testConnection(config(provider)), failure => {
      assert.equal(failure.invalidKey, true);
      assert.match(failure.message, /API Key ใช้งานไม่ได้/);
      assert.doesNotMatch(failure.message, /unit-test-key/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('OpenAI ไม่สลับโมเดล และ Gemini ไม่สลับสำหรับ HTTP อื่น', async () => {
  for (const [provider, status] of [['openai', 404], ['openai', 429], ['gemini', 400], ['gemini', 503]]) {
    let calls = 0;
    const api = loadApi(async () => { calls++; return reply(status, { error: {} }); });
    await assert.rejects(api.generate(config(provider), {}), error => error.status === status);
    assert.equal(calls, 1);
  }
});

test('ทดสอบ Gemini ใช้รุ่นที่ตอบสำเร็จและส่งเฉพาะข้อความทดสอบ', async () => {
  const calls = [];
  const api = loadApi(async (url, request) => {
    calls.push(modelFromUrl(url));
    const body = JSON.parse(request.body);
    assert.deepEqual(body.contents[0].parts, [{ text: 'Reply with OK.' }]);
    assert.equal('thinkingConfig' in body.generationConfig, false);
    return calls.length === 1 ? reply(404, { error: {} }) : reply(200, geminiReply);
  });
  assert.equal(await api.testConnection(config('gemini')), geminiPresets[1]);
  assert.deepEqual(calls, geminiPresets.slice(0, 2));
});

test('รายชื่อ Gemini ใช้ GET และอ่านทุกหน้าโดยกรอง generateContent และข้ามรายการซ้ำ', async () => {
  const calls = [];
  const key = 'test&key=+';
  const api = loadApi(async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(parsed.pathname, '/v1beta/models');
    assert.equal(parsed.searchParams.get('key'), key);
    assert.equal(options.method, 'GET');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.body, undefined);
    const token = parsed.searchParams.get('pageToken');
    calls.push(token);
    const first = { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] };
    const embed = { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] };
    if (!token) return reply(200, { models: [first, embed], nextPageToken: 'a & b' });
    return reply(200, { models: [first, { name: 'models/project-preview', supportedGenerationMethods: ['generateContent'] }, null] });
  });
  assert.deepEqual(Array.from(await api.listGeminiModels(key)), ['gemini-3.8-flash', 'project-preview']);
  assert.deepEqual(calls, [null, 'a & b']);
});

test('การดึงรายการรับมือผลว่าง คีย์ถูกปฏิเสธ และตัวชี้หน้าซ้ำ', async () => {
  const empty = loadApi(async () => reply(200, {}));
  assert.equal((await empty.listGeminiModels('key')).length, 0);
  const invalid = loadApi(async () => reply(400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } }));
  await assert.rejects(invalid.listGeminiModels('key'), /API Key ใช้งานไม่ได้/);
  const repeated = loadApi(async () => reply(200, { models: [], nextPageToken: 'repeat' }));
  await assert.rejects(repeated.listGeminiModels('key'), /หน้ารายชื่อโมเดลซ้ำ/);
});

test('หมดเวลาหรือขาดการเชื่อมต่อแล้วหยุดคำขอและแสดงข้อความภาษาไทย', async () => {
  const pending = loadApi((url, { signal }) => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  await assert.rejects(pending.generate(config('gemini'), {}, { timeoutMs: 5 }), /หมดเวลารอ/);
  const offline = loadApi(async () => { throw new TypeError('network failed'); });
  await assert.rejects(offline.listGeminiModels('key'), /เชื่อมต่อ AI ไม่สำเร็จ/);
});
