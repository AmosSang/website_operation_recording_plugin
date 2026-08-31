// Journey Recorder - pack-builder 纯函数单测（S8，F7 组包逻辑）
// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const P = require('../background/pack-builder.js');

test('pack ① sanitizeName 清洗 URL 保留字符并截断', () => {
  assert.strictEqual(P.sanitizeName('总部/大纲:详情?页*走查'), '总部_大纲_详情_页_走查');
  assert.ok(P.sanitizeName('超级长'.repeat(30)).length <= 40);
});

test('pack ② stripExt 去扩展名，无扩展名原样返回，空回退 step', () => {
  assert.strictEqual(P.stripExt('003_click[保存].png'), '003_click[保存]');
  assert.strictEqual(P.stripExt('abc'), 'abc'); // 无扩展名原样返回
  assert.strictEqual(P.stripExt(''), 'step');   // 空回退 step
});

test('pack ③ fmtDate 格式 YYYYMMDD', () => {
  // 2026-08-31 的本地时区毫秒（用 Date 构造避免依赖时间）
  const d = new Date(2026, 7, 31); // 月份 0 起，7=8 月
  assert.strictEqual(P.fmtDate(d.getTime()), '20260831');
});

test('pack ④ buildApiCallLineRefs 行号区间', () => {
  const nets = [
    { stepId: 1, ts: 100 }, { stepId: 1, ts: 200 }, { stepId: 2, ts: 300 },
  ];
  const refs = P.buildApiCallLineRefs(nets);
  assert.deepStrictEqual(refs[1], [1, 2]); // step1 占第 1-2 行
  assert.deepStrictEqual(refs[2], [3, 3]); // step2 占第 3 行
});

test('pack ⑤ extractDomains 去重排序', () => {
  const steps = [
    { page: { url: 'https://sszt-yunting.speiyou.com/#/a' } },
    { page: { url: 'https://sszt-yunting.speiyou.com/#/b' } },
    { page: { url: 'http://other.com/x' } },
  ];
  assert.deepStrictEqual(P.extractDomains(steps), ['other.com', 'sszt-yunting.speiyou.com']);
});

test('pack ⑥ inferAppName 取 hostname 首段', () => {
  assert.strictEqual(P.inferAppName({ entryUrl: 'https://sszt-yunting.speiyou.com/#/x' }, []), 'sszt-yunting');
  assert.strictEqual(P.inferAppName({}, []), '（未识别）');
});

test('pack ⑦ flattenEvents 展平 + __tabId 标注 + 按 timestamp 排序', () => {
  const chunks = [
    { tabId: 12, events: [{ timestamp: 200, type: 3 }] },
    { tabId: 14, events: [{ timestamp: 100, type: 3 }] },
  ];
  const flat = P.flattenEvents(chunks);
  assert.strictEqual(flat.length, 2);
  assert.strictEqual(flat[0].__tabId, 14); // ts 小的在前
  assert.strictEqual(flat[1].__tabId, 12);
});

test('pack ⑧ flattenEvents 空输入', () => {
  assert.deepStrictEqual(P.flattenEvents([]), []);
});

test('pack ⑨ netCallsToJsonl / eventsToJsonl 逐行 JSON', () => {
  const jsonl = P.netCallsToJsonl([{ ts: 1, call: { url: 'a' } }, { ts: 2, call: { url: 'b' } }]);
  assert.strictEqual(jsonl, '{"url":"a"}\n{"url":"b"}\n');
  assert.strictEqual(P.eventsToJsonl([{ ts: 1 }]), '{"ts":1}\n');
  assert.strictEqual(P.eventsToJsonl([]), '');
});

test('pack ⑩ buildReadme 含关键声明', () => {
  const manifest = {
    schema_version: '0.1',
    journey: {
      name: '测试旅程', recorded_at: '2026-08-31T12:00:00Z',
      app: { name: '测试应用', version_from_page: null, entry_url: 'https://a.com' },
      audio: { recorded: false, mimeType: null },
    },
  };
  const readme = P.buildReadme(manifest, false);
  assert.ok(readme.includes('schema_version: 0.1'));
  assert.ok(readme.includes('脱敏声明'));
  assert.ok(readme.includes('未开启'));
  assert.ok(readme.includes('rrweb 已知局限'));
});
