// Journey Recorder - resource-builder 单测（S8 资源抓取：高保真仿制）
const test = require('node:test');
const assert = require('node:assert');
const R = require('../background/resource-builder.js');

// 构造 fetched map：模拟 content 已抓取的资源
const BASE = 'http://127.0.0.1:8899/';
const fetched = {
  'http://127.0.0.1:8899/css/main.css': { mime: 'text/css', textContent: 'body{color:#333}\n.btn{background:url("../img/bg.png")}\n@font-face{font-family:MyFont;src:url("../fonts/my.woff2") format("woff2")}' },
  'http://127.0.0.1:8899/img/bg.png': { mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUg==' },
  'http://127.0.0.1:8899/fonts/my.woff2': { mime: 'font/woff2', dataBase64: 'd09GMgABAAAAAA' },
};

// ① 外链 CSS 提取
test('resource ① extractStylesheets 提取外链样式表+相对路径解析', () => {
  const html = '<link rel="stylesheet" href="css/main.css">';
  const sheets = R.extractStylesheets(html, BASE);
  assert.strictEqual(sheets.length, 1);
  assert.strictEqual(sheets[0].href, 'css/main.css');
  assert.strictEqual(sheets[0].relAbsolute, 'http://127.0.0.1:8899/css/main.css');
});

// ② 外链 CSS 内联成 <style>
test('resource ② inlineStylesheets 外链变内联、未抓到保留外链', () => {
  const html = '<link rel="stylesheet" href="css/main.css"><div>hi</div>';
  const r = R.inlineStylesheets(html, fetched, BASE);
  assert.ok(r.html.includes('<style data-jr-src="http://127.0.0.1:8899/css/main.css">'));
  assert.ok(r.html.includes('body{color:#333}'));
  assert.strictEqual(r.used.length, 1);
  assert.strictEqual(r.missing.length, 0);
  // 未抓到的情况
  const r2 = R.inlineStylesheets('<link rel="stylesheet" href="nope.css">', fetched, BASE);
  assert.strictEqual(r2.missing.length, 1);
});

// ③ url() 相对路径解析 + 二进制转 data:base64
test('resource ③ rewriteCssUrls url()相对解析+图片转data:base64', () => {
  const css = '.btn{background:url("../img/bg.png")}';
  const { css: out, rewritten } = R.rewriteCssUrls(css, fetched, BASE);
  assert.ok(out.includes('url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")'));
  assert.strictEqual(rewritten[0].result, 'data');
  assert.strictEqual(rewritten[0].url, 'http://127.0.0.1:8899/img/bg.png'); // 相对已解析成绝对
});

// ④ @font-face 内联字体
test('resource ④ inlineFontFace src url()字体转data:base64', () => {
  const css = '@font-face{font-family:MyFont;src:url("../fonts/my.woff2") format("woff2")}';
  const out = R.inlineFontFace(css, fetched, BASE);
  assert.ok(out.includes('font-family:MyFont'));
  assert.ok(out.includes('d09GMgABAAAAAA')); // 字体转 base64
});

// ⑤ 多页去重键
test('resource ⑤ pageKey 去 hash 保留 search', () => {
  assert.strictEqual(R.pageKey('http://a.com/x#frag'), 'http://a.com/x');
  assert.strictEqual(R.pageKey('http://a.com/x?q=1#frag'), 'http://a.com/x?q=1');
  assert.strictEqual(R.pageKey('http://a.com/x?q=1'), 'http://a.com/x?q=1');
});

// ⑥ buildPageAssets 完整内联
test('resource ⑥ buildPageAssets 完整组装（外链内联+url改写）', () => {
  const html = '<link rel="stylesheet" href="css/main.css"><div class="btn">点我</div>';
  const r = R.buildPageAssets({ pageUrl: BASE, html, fetched });
  // 外链已内联
  assert.ok(r.pageHtml.includes('<style data-jr-src="http://127.0.0.1:8899/css/main.css">'));
  // CSS 里的 url("../img/bg.png") 已改写成 data:base64
  assert.ok(r.pageHtml.includes('data:image/png;base64,'));
  // @font-face 字体已转 data:base64
  assert.ok(r.pageHtml.includes('d09GMgABAAAAAA'));
  // 资源引用被记录
  assert.ok(r.assetRefs.some((x) => x.url === 'http://127.0.0.1:8899/img/bg.png'));
});

// ⑦ 已是 data: 的 url() 不应被改写
test('resource ⑦ 已是 data: 的 url() 原样保留', () => {
  const css = '.a{background:url(data:image/png;base64,AAA)}';
  const { css: out } = R.rewriteCssUrls(css, fetched, BASE);
  assert.ok(out.includes('data:image/png;base64,AAA'));
});
