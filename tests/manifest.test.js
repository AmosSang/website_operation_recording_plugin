// Journey Recorder - manifest-builder 单测（S8，F6 插件↔AI 契约）
// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const M = require('../background/manifest-builder.js');

const baseJourney = {
  journeyId: 'j_m1', startedAt: 1787890000000, status: 'recording',
  entryUrl: 'https://sszt-yunting.speiyou.com/#/loc/newFaceClass',
  tabIds: [12], micEnabled: false,
};

const baseSteps = [
  {
    id: 3, name: '003_click[新建大纲文件夹]', action: 'click',
    timestamp_ms: 1787890000000, rel_prev_ms: null, target: null,
    tags: [], artifacts: {}, user_note: '',
  },
];

test('manifest ① 基本结构且契约字段齐全', () => {
  const m = M.build({ journey: baseJourney, steps: baseSteps, audio: null, settings: { per_step_dom_snapshot: true } });
  assert.strictEqual(m.schema_version, '0.1');
  assert.strictEqual(m.journey.name, '未命名旅程');
  assert.strictEqual(m.journey.audio.recorded, false);
  assert.strictEqual(m.journey.audio.t0, null);
  assert.ok(Array.isArray(m.journey.transcripts));
  assert.ok(Array.isArray(m.steps));
  assert.strictEqual(m.steps.length, 1);
});

test('manifest ② target 字段白名单：缺省补 null 并只保留契约字段', () => {
  const m = M.build({
    journey: baseJourney,
    steps: [{ id: 1, name: '001_click[保存]', action: 'click', timestamp_ms: 1, target: { css_path: 'div.a', semantic: 'button[x]', extraField: 'should-drop' } }],
  });
  const t = m.steps[0].target;
  assert.deepStrictEqual(Object.keys(t).sort(), ['aria_label', 'aria_role', 'css_path', 'semantic', 'tag', 'visible_text']);
  assert.strictEqual(t.extraField, undefined); // 契约不落多余字段
});

test('manifest ③ change 步保留 action/value 语义（value 以 target 之外的字段承载）', () => {
  const m = M.build({
    journey: baseJourney,
    steps: [{ id: 4, name: '004_change[搜索大纲ID=纯文本]', action: 'change', timestamp_ms: 2, target: null }],
  });
  assert.strictEqual(m.steps[0].action, 'change');
});

test('manifest ④ audio 元信息：recorded=true 时带 t0/file', () => {
  const m = M.build({
    journey: baseJourney,
    steps: baseSteps,
    audio: { recorded: true, t0: 1000, endMs: 9000, file: 'audio/journey.webm', mimeType: 'audio/webm;codecs=opus' },
  });
  assert.strictEqual(m.journey.audio.recorded, true);
  assert.strictEqual(m.journey.audio.t0, 1000);
  assert.strictEqual(m.journey.audio.endMs, 9000);
  assert.strictEqual(m.journey.audio.file, 'audio/journey.webm');
});

test('manifest ⑤ domains 从传入或从 steps 提取', () => {
  const m = M.build({
    journey: baseJourney,
    steps: [{ id: 1, name: 'a', action: 'click', timestamp_ms: 1, page: { url: 'https://sszt-yunting.speiyou.com/#/x' } }],
    domains: ['sszt-yunting.speiyou.com'],
  });
  assert.deepStrictEqual(m.journey.app.domains, ['sszt-yunting.speiyou.com']);
});

test('manifest ⑥ validate 幂等：build 产物应为空错误数组', () => {
  const m = M.build({ journey: baseJourney, steps: baseSteps });
  const errs = M.validate(m);
  assert.deepStrictEqual(errs, []);
});

test('manifest ⑦ validate 缺字段报错', () => {
  const errs = M.validate({ });
  assert.ok(errs.length > 0);
  const errs2 = M.validate({ schema_version: '0.1', journey: { }, steps: [] });
  assert.ok(errs2.some((e) => /journey\.app/.test(e)));
});

test('manifest ⑧ tab_id：S7.1 多 tab 契约只增不改删', () => {
  const m = M.build({
    journey: baseJourney,
    steps: [{ id: 1, name: 'a', action: 'click', timestamp_ms: 1, tabId: 12 }],
  });
  assert.strictEqual(m.steps[0].tab_id, 12);
});

test('manifest ⑨ settings 快照回填（mic_enabled / per_step_dom_snapshot）', () => {
  const m = M.build({
    journey: { ...baseJourney, micEnabled: true },
    steps: baseSteps,
    settings: { per_step_dom_snapshot: false },
  });
  assert.strictEqual(m.journey.settings.mic_enabled, true);
  assert.strictEqual(m.journey.settings.per_step_dom_snapshot, false);
  assert.strictEqual(m.journey.settings.fullpage_screenshot, false);
});
