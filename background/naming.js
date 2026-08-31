// Journey Recorder - Step 自动命名（PRD F2：{序号三位}_{动作}_{目标可见文本≤20}）
// 例：003_click[新建大纲文件夹]；change 型附带最终值：004_change[搜索大纲ID=纯文本]
// UMD：SW 里 importScripts 挂全局 JourneyNaming；node --test 直接 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneyNaming = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LABEL_LIMIT = 20;

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 优先级：manual / tab_open 型用页面标题（NNN_manual_[页面标题]、NNN_tab_open_[页面标题]）；
  // 其余：可见文本 > aria-label > tag；change 型追加 =最终值（密码已在上游替换为 ***）
  function makeStepName(seq, action, target, value, pageTitle) {
    const t = target || {};
    let label;
    if (action === 'manual' || action === 'tab_open') {
      label = clean(pageTitle) || (action === 'tab_open' ? '新标签页' : '手动锚点');
    } else {
      label = clean(t.visible_text) || clean(t.aria_label) || clean(t.tag) || '元素';
    }
    if (action === 'change') {
      const v = clean(value);
      label += '=' + (v ? v.slice(0, LABEL_LIMIT) : '…');
    }
    if (label.length > LABEL_LIMIT) label = label.slice(0, LABEL_LIMIT);
    return String(seq).padStart(3, '0') + '_' + String(action || 'event') + '[' + label + ']';
  }

  return { makeStepName };
});
