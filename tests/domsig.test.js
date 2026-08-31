// Journey Recorder - domsig 定位描述符单测（S3）
// 运行：node --test tests/
// 用极简 DOM stub 模拟真实节点读取面（tagName/id/attributes/getAttribute/parentElement/children/text），
// 期望值 = 2026-08-29 人工核对的快照（深嵌套/无 id/同级重复文本/aria 回退/8 层截断…）。
const test = require('node:test');
const assert = require('node:assert');
const D = require('../content/domsig.js');

function makeEl(tag, opts = {}, parent = null) {
  const attrs = Object.assign({}, opts.attrs);
  if (opts.id) attrs.id = opts.id;
  const attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  const el = {
    tagName: tag.toUpperCase(),
    id: opts.id || '',
    attributes,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    textContent: opts.text || '',
    innerText: opts.text || '',
    parentElement: parent,
    children: [],
  };
  if (parent) parent.children.push(el);
  return el;
}

test('domsig ① 深嵌套无 id：逐层 nth-of-type，body 不入链', () => {
  const root = makeEl('body');
  const d1 = makeEl('div', {}, root);
  const d2 = makeEl('div', {}, d1);
  const btn = makeEl('button', { text: '提交订单' }, d2);
  assert.deepStrictEqual(D.describe(btn), {
    css_path: 'div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)',
    semantic: 'button[text=提交订单]#same-siblings-1',
    visible_text: '提交订单',
    tag: 'button',
    aria_role: null,
    aria_label: null,
  });
});

test('domsig ② 中间层有 id：命中即截断', () => {
  const root = makeEl('body');
  const w = makeEl('div', { id: 'main-panel' }, root);
  const d = makeEl('div', {}, w);
  const btn = makeEl('button', { text: '保存' }, d);
  assert.strictEqual(D.cssPath(btn), '#main-panel > div:nth-of-type(1) > button:nth-of-type(1)');
});

test('domsig ③ 命中 data-testid：截断且带属性值', () => {
  const root = makeEl('body');
  const w = makeEl('div', { attrs: { 'data-testid': 'toolbar' } }, root);
  const btn = makeEl('button', { text: '删除' }, w);
  assert.strictEqual(D.cssPath(btn), 'div[data-testid="toolbar"] > button:nth-of-type(1)');
});

test('domsig ④ 同级同 tag 重复：nth-of-type 与 same-siblings 均为 3', () => {
  const root = makeEl('body');
  const ul = makeEl('ul', {}, root);
  makeEl('li', { text: '条目一' }, ul);
  makeEl('li', { text: '条目二' }, ul);
  const li3 = makeEl('li', { text: '条目三' }, ul);
  assert.strictEqual(D.cssPath(li3), 'ul:nth-of-type(1) > li:nth-of-type(3)');
  assert.strictEqual(D.semanticString(li3), 'li[text=条目三]#same-siblings-3');
});

test('domsig ⑤ 同级不同 tag：nth-of-type 按 tag 计数互不干扰', () => {
  const root = makeEl('body');
  makeEl('div', {}, root);
  const sec = makeEl('section', { text: '内容区' }, root);
  assert.strictEqual(D.cssPath(sec), 'section:nth-of-type(1)');
});

test('domsig ⑥ 可见文本超 20 字：截断', () => {
  const root = makeEl('body');
  const btn = makeEl('button', { text: '这是一个特别特别特别特别长的按钮文本需要被截断' }, root);
  assert.strictEqual(D.visibleText(btn), '这是一个特别特别特别特别长的按钮文本需要');
});

test('domsig ⑦ 无文本有 aria-label：semantic 文本回退 aria，aria_label 字段独立保留', () => {
  const root = makeEl('body');
  const btn = makeEl('button', { attrs: { 'aria-label': '关闭弹窗' } }, root);
  const d = D.describe(btn);
  assert.strictEqual(d.semantic, 'button[text=关闭弹窗]#same-siblings-1');
  assert.strictEqual(d.visible_text, '');
  assert.strictEqual(d.aria_label, '关闭弹窗');
});

test('domsig ⑧ 无文本无 aria：semantic 只剩 tag + 同级序号', () => {
  const root = makeEl('body');
  const btn = makeEl('button', {}, root);
  assert.strictEqual(D.semanticString(btn), 'button#same-siblings-1');
});

test('domsig ⑨ 带 role：semantic 含 role 段', () => {
  const root = makeEl('body');
  const tab = makeEl('div', { text: '基本信息', attrs: { role: 'tab' } }, root);
  assert.strictEqual(D.semanticString(tab), 'div[role=tab][text=基本信息]#same-siblings-1');
  assert.strictEqual(D.describe(tab).aria_role, 'tab');
});

test('domsig ⑩ 超过 8 层深嵌套：css 链最多 8 段', () => {
  let node = makeEl('body');
  for (let i = 0; i < 12; i++) node = makeEl('div', {}, node);
  const btn = makeEl('button', { text: '深底按钮' }, node);
  const path = D.cssPath(btn);
  assert.ok(path.split(' > ').length <= 8, 'css 链应 ≤8 段，实际: ' + path);
  assert.ok(path.endsWith('button:nth-of-type(1)'));
});
