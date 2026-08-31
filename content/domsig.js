// Journey Recorder - 定位描述符（决策 D3：事件监听里第一时间同步计算，纯函数无副作用）
// css_path：向上爬 ≤8 层，命中 #id 或 [data-*] 即止，否则 tag:nth-of-type(n)
// semantic：tag[role=x][text=可见文本≤20]#same-siblings-n（跨版本比对的长命定位串）
// UMD：浏览器(ISOLATED world)挂 window.JourneyDomsig；node --test 直接 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneyDomsig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DEPTH = 8;
  const TEXT_LIMIT = 20;

  function tagName(el) {
    return String((el && el.tagName) || '').toLowerCase();
  }

  function attr(el, name) {
    try {
      if (!el || !el.getAttribute) return null;
      const v = el.getAttribute(name);
      return v == null ? null : String(v);
    } catch (e) { return null; }
  }

  // 同类型兄弟中的序号（1 起）
  function sameTypeIndex(el) {
    const p = el.parentElement || el.parentNode;
    if (!p) return 1;
    const tag = tagName(el);
    const kids = p.children || [];
    let n = 0;
    for (let i = 0; i < kids.length; i++) {
      if (tagName(kids[i]) === tag) {
        n++;
        if (kids[i] === el) return n;
      }
    }
    return 1;
  }

  // 可见文本：压平空白、截 20 字
  function visibleText(el) {
    try {
      const t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
      return String(t).replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
    } catch (e) { return ''; }
  }

  // 第一个非空 data-* 属性 → [data-x="y"]（遍历顺序稳定）
  function dataSelector(node) {
    try {
      const attrs = node.attributes;
      if (!attrs) return null;
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        if (a && a.name && String(a.name).indexOf('data-') === 0 && a.value) {
          return '[' + a.name + '="' + String(a.value).replace(/"/g, '\\"') + '"]';
        }
      }
    } catch (e) { /* */ }
    return null;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && depth < MAX_DEPTH) {
      const tag = tagName(node);
      if (!tag || tag === 'html' || tag === 'body' || tag === '#document') break; // 根壳不入链
      const id = node.id || attr(node, 'id');
      if (id) { parts.unshift('#' + id); break; }
      const data = dataSelector(node);
      if (data) { parts.unshift(tag + data); break; }
      parts.unshift(tag + ':nth-of-type(' + sameTypeIndex(node) + ')');
      node = node.parentElement || node.parentNode;
      depth++;
    }
    return parts.length ? parts.join(' > ') : tagName(el);
  }

  function semanticString(el) {
    const tag = tagName(el) || 'unknown';
    const role = attr(el, 'role');
    let text = visibleText(el) || attr(el, 'aria-label') || '';
    let s = tag;
    if (role) s += '[role=' + role + ']';
    if (text) s += '[text=' + text + ']';
    s += '#same-siblings-' + sameTypeIndex(el);
    return s;
  }

  // 总入口：点击瞬间同步调用，全部为读取操作
  function describe(el) {
    return {
      css_path: cssPath(el),
      semantic: semanticString(el),
      visible_text: visibleText(el),
      tag: tagName(el),
      aria_role: attr(el, 'role'),
      aria_label: attr(el, 'aria-label'),
    };
  }

  return { describe, cssPath, semanticString, visibleText, sameTypeIndex };
});
