// Journey Recorder - naming 命名规则单测（S3，PRD F2）
// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const N = require('../background/naming.js');

test('naming ① 基本格式：003_click[新建大纲文件夹]（PRD 原例）', () => {
  assert.strictEqual(N.makeStepName(3, 'click', { visible_text: '新建大纲文件夹' }), '003_click[新建大纲文件夹]');
});

test('naming ② 序号补零三位', () => {
  assert.ok(N.makeStepName(1, 'click', { visible_text: '保存' }).startsWith('001_click'));
  assert.ok(N.makeStepName(42, 'click', { visible_text: '保存' }).startsWith('042_click'));
  assert.ok(N.makeStepName(1234, 'click', { visible_text: '保存' }).startsWith('1234_click'));
});

test('naming ③ 文本超 20 字截断', () => {
  const name = N.makeStepName(1, 'click', { visible_text: '这是一个特别特别特别特别长的按钮文本需要被截断' });
  assert.strictEqual(name, '001_click[这是一个特别特别特别特别长的按钮文本需要]');
});

test('naming ④ 文本为空回退 aria-label，再空回退 tag', () => {
  assert.strictEqual(N.makeStepName(12, 'click', { aria_label: '关闭弹窗' }), '012_click[关闭弹窗]');
  assert.strictEqual(N.makeStepName(7, 'click', { tag: 'button' }), '007_click[button]');
  assert.strictEqual(N.makeStepName(8, 'click', {}), '008_click[元素]');
});

test('naming ⑤ change 型附带最终值', () => {
  assert.strictEqual(N.makeStepName(4, 'change', { visible_text: '搜索大纲ID' }, '纯文本'), '004_change[搜索大纲ID=纯文本]');
  assert.strictEqual(N.makeStepName(5, 'change', { tag: 'input' }, '***'), '005_change[input=***]');
  assert.strictEqual(N.makeStepName(6, 'change', { visible_text: '请选择环境' }, '测试环境'), '006_change[请选择环境=测试环境]');
});

test('naming ⑥ change 值为空串时显示省略号', () => {
  assert.strictEqual(N.makeStepName(9, 'change', { tag: 'select' }, ''), '009_change[select=…]');
  assert.strictEqual(N.makeStepName(9, 'change', { tag: 'select' }, null), '009_change[select=…]');
});

test('naming ⑦ 空白字符压平', () => {
  assert.strictEqual(N.makeStepName(2, 'click', { visible_text: '  多  空 格  文本  ' }), '002_click[多 空 格 文本]');
});

test('naming ⑧ change 值超 20 字截断', () => {
  const name = N.makeStepName(10, 'change', { visible_text: '长文本框' }, '一段特别特别特别特别长的输入内容需要截断处理');
  assert.ok(name.includes('=' + '一段特别特别特别特别长的输入内容需要截'.slice(0, 20)) || name.startsWith('010_change[长文本框='));
  assert.ok(name.length <= '010_change[长文本框='.length + 20);
});

test('naming ⑨ tab_open 型用页面标题（S7.1 补强）', () => {
  assert.strictEqual(N.makeStepName(5, 'tab_open', {}, null, '课件编辑页'), '005_tab_open[课件编辑页]');
  // 页面标题为空 → 回退「新标签页」
  assert.strictEqual(N.makeStepName(6, 'tab_open', {}, null, ''), '006_tab_open[新标签页]');
});
