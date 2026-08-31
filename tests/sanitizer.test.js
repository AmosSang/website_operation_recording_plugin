// Journey Recorder - sanitizer 脱敏单测（S4 安全红线，验收门槛 ≥12 例）
// 运行：node --test tests/sanitizer.test.js
// 核心断言：任何输出（头/body/URL）中不得出现敏感原值；全缓冲 grep 无 "eyJ" 的代码级等价物 = 逐例断言。
const test = require('node:test');
const assert = require('node:assert');
const S = require('../content/sanitizer.js');

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789';

test('S① beibotoken 请求头被删除', () => {
  const out = S.maskHeaders({ beibotoken: FAKE_JWT, 'content-type': 'application/json' });
  assert.strictEqual(out.beibotoken, undefined);
  assert.strictEqual(out['content-type'], 'application/json');
});

test('S② authtoken / cookie / authorization 请求头全部被删', () => {
  const out = S.maskHeaders({
    authtoken: 'tok123', cookie: 'sid=1', authorization: 'Bearer xyz', 'content-type': 'text/html',
  });
  assert.strictEqual(out.authtoken, undefined);
  assert.strictEqual(out.cookie, undefined);
  assert.strictEqual(out.authorization, undefined);
  assert.strictEqual(out['content-type'], 'text/html');
});

test('S③ 白名单外的自定义头 x-foo 全丢', () => {
  const out = S.maskHeaders({ 'x-foo': 'bar', 'x-requested-with': 'fetch' });
  assert.strictEqual(out['x-foo'], undefined);
  assert.strictEqual(out['x-requested-with'], 'fetch');
});

test('S④ 值为 JWT 三段式的头被无条件删除（即使头名在白名单）', () => {
  const out = S.maskHeaders({ referer: FAKE_JWT });
  assert.strictEqual(out.referer, undefined);
});

test('S⑤ Headers 实例形态（forEach 回调签名 value,key）同样处理', () => {
  // WHATWG Headers.forEach 的回调是 (value, key) —— 值在前
  const fake = { forEach(fn) { fn(FAKE_JWT, 'beibotoken'); fn('*/*', 'accept'); } };
  const out = S.maskHeaders(fake);
  assert.strictEqual(out.beibotoken, undefined);
  assert.strictEqual(out.accept, '*/*');
});

test('S⑥ body 顶层 password 键 → ***', () => {
  const r = S.maskBody(JSON.stringify({ username: 'amos', password: 'p@ss123' }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.password, '***');
  assert.strictEqual(o.username, 'amos');
});

test('S⑦ body 嵌套对象中的 token 键 → ***', () => {
  const r = S.maskBody(JSON.stringify({ config: { apiToken: 'abc', name: 'x' } }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.config.apiToken, '***');
  assert.strictEqual(o.config.name, 'x');
});

test('S⑧ body 数组对象中的 secret 键 → ***', () => {
  const r = S.maskBody(JSON.stringify({ items: [{ secretKey: 's1' }, { secretKey: 's2' }] }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.items[0].secretKey, '***');
  assert.strictEqual(o.items[1].secretKey, '***');
});

test('S⑨ 键名匹配不区分大小写（Password / USER_TOKEN）', () => {
  const r = S.maskBody(JSON.stringify({ Password: 'a', USER_TOKEN: 'b', authHeader: 'c' }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.Password, '***');
  assert.strictEqual(o.USER_TOKEN, '***');
  assert.strictEqual(o.authHeader, '***');
});

test('S⑩ JWT 值出现在非敏感键下也无条件 ***', () => {
  const r = S.maskBody(JSON.stringify({ memo: FAKE_JWT, note: 'normal' }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.memo, '***');
  assert.strictEqual(o.note, 'normal');
});

test('S⑪ 纯文本 body 中的 JWT 被 regex 全局替换', () => {
  const r = S.maskBody('payload=' + FAKE_JWT + '&x=1', 'text/plain');
  assert.ok(!r.body.includes('eyJ'), '不得残留 eyJ');
  assert.ok(r.body.includes('payload=***'));
});

test('S⑫ 伪 JSON（解析失败）走 JWT 兜底，不抛异常', () => {
  const r = S.maskBody('{"a": ' + FAKE_JWT + ', broken', 'application/json');
  assert.ok(!r.body.includes('eyJ'));
});

test('S⑬ 超 256KB 截断：truncated 标记 + totalLength', () => {
  const big = JSON.stringify({ k: 'x'.repeat(300 * 1024) });
  const r = S.maskBody(big, 'application/json');
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.totalLength, big.length);
  assert.ok(r.body.length < big.length);
});

test('S⑭ URL query 中 token 类参数值打 ***，普通参数保留', () => {
  const out = S.maskUrl('https://x.com/api?a=1&access_token=' + FAKE_JWT + '&b=2#/hash');
  assert.ok(out.includes('a=1'));
  assert.ok(out.includes('b=2'));
  assert.ok(out.includes('#/hash'));
  assert.ok(!out.includes('eyJ'));
  assert.ok(out.includes('access_token=***'));
});

test('S⑮ 干净 URL / 干净 body 原样通过（不做无谓改写）', () => {
  assert.strictEqual(S.maskUrl('https://x.com/api?a=1'), 'https://x.com/api?a=1');
  const r = S.maskBody(JSON.stringify({ a: 1, b: '文本' }), 'application/json');
  assert.deepStrictEqual(JSON.parse(r.body), { a: 1, b: '文本' });
  assert.strictEqual(r.truncated, false);
});

test('S⑯ maskNetEvent 一站式：头/URL/body 全脱净，零敏感残留', () => {
  const out = S.maskNetEvent({
    kind: 'fetch', method: 'POST',
    url: 'https://x.com/login?token=' + FAKE_JWT,
    status: 200, startTs: 1, endTs: 2,
    reqHeaders: { beibotoken: FAKE_JWT, 'content-type': 'application/json' },
    reqBody: JSON.stringify({ username: 'amos', password: 'p@ss' }),
    resContentType: 'application/json',
    resBody: JSON.stringify({ data: { authToken: 'zzz', list: [1, 2] } }),
  });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('eyJ'), 'flat 中不得有 JWT');
  assert.ok(!flat.includes('p@ss'));
  assert.ok(!flat.includes('zzz'));
  const req = JSON.parse(out.reqBody);
  assert.strictEqual(req.password, '***');
  assert.strictEqual(req.username, 'amos');
  const res = JSON.parse(out.resBody);
  assert.strictEqual(res.data.authToken, '***');
  assert.deepStrictEqual(res.data.list, [1, 2]);
  assert.strictEqual(out.reqHeaders.beibotoken, undefined);
  assert.strictEqual(out.url.includes('token=***'), true);
});

test('S⑰ 超深嵌套不炸栈（深度护栏 8 层）', () => {
  let obj = { leaf: 'ok' };
  for (let i = 0; i < 20; i++) obj = { child: obj };
  const r = S.maskBody(JSON.stringify(obj), 'application/json');
  assert.ok(typeof r.body === 'string' && r.body.length > 0);
});

test('S⑰b 自定义增补键名清单生效（popup 设置扩展用）', () => {
  const r = S.maskBody(JSON.stringify({ mobile: '13800000000', other: 1 }), 'application/json', ['mobile']);
  const o = JSON.parse(r.body);
  assert.strictEqual(o.mobile, '***');
  assert.strictEqual(o.other, 1);
});

// ---- 2026-08-29 验收发现补强（echo 回显场景 + apiKey 清单缺口）----

test('S㉑ 服务端回显场景：字符串值内嵌的敏感 JSON 键值对被文本兜底打码', () => {
  // /echo-api 把请求 body 原样塞进响应 echo 字段——明文藏在字符串里
  const inner = JSON.stringify({ username: 'amos', password: 'supersecret' });
  const r = S.maskBody(JSON.stringify({ ok: true, echo: inner }), 'application/json');
  assert.ok(!r.body.includes('supersecret'), '回显的明文密码不得残留');
  assert.ok(r.body.includes('amos'), '非敏感字段保留');
});

test('S㉒ apiKey 归入默认清单（key 子串）', () => {
  const r = S.maskBody(JSON.stringify({ apiKey: 'k-123', keyword: 'kw' }), 'application/json');
  const o = JSON.parse(r.body);
  assert.strictEqual(o.apiKey, '***');
  assert.strictEqual(o.keyword, '***'); // 'key' 子串的已知误伤，接受（宁多脱不漏脱）
});

test('S㉓ urlencoded body 的敏感键值被兜底打码', () => {
  const r = S.maskBody('username=amos&password=abc123&x=1', 'application/x-www-form-urlencoded');
  assert.ok(!r.body.includes('abc123'));
  assert.ok(r.body.includes('username=amos'));
  assert.ok(r.body.includes('password=***'));
});
