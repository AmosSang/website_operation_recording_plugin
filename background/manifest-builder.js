// Journey Recorder - manifest.json 组装（F6：插件↔AI 契约，字段稳定性最高优先级）
// 纯函数（UMD 双端）：浏览器挂 window.JourneyManifest；node --test 直接 require。
// 输入 = 已从 IDB 读出的结构化记录（journey + steps），输出 = F6 契约的 manifest 对象。
// 契约承诺：已有字段永不改义、只增不改删；schema_version 变更时提供迁移说明。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneyManifest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = '0.1';

  // 与 sanitizer.js BODY_MASK_KEYS 保持一致（缺省清单；可由调用方覆盖）
  const DEFAULT_BODY_MASK_KEYS = ['password', 'token', 'secret', 'auth', 'key'];

  // F6 契约：target 字段白名单（缺省补 null，不传多余字段）
  const TARGET_FIELDS = ['css_path', 'semantic', 'visible_text', 'tag', 'aria_role', 'aria_label'];

  function pickTarget(t) {
    t = t || {};
    const out = {};
    TARGET_FIELDS.forEach((f) => { out[f] = t[f] == null ? null : t[f]; });
    return out;
  }

  // 从 steps 数组 → F6 steps 段（契约只增不改删）
  function buildSteps(steps) {
    return (steps || []).map((s) => {
      const out = {
        id: s.id,
        name: s.name,
        action: s.action || 'event',
        timestamp_ms: s.timestamp_ms,
        rel_prev_ms: s.rel_prev_ms == null ? null : s.rel_prev_ms,
        target: pickTarget(s.target),
        page: s.page || null,
        tags: s.tags || [],
        artifacts: s.artifacts || {},
        api_calls: s._api_calls || [],   // F6：行号区间引用，组包层注入
        user_note: s.user_note || '',
      };
      // 多 tab（S7.1）为契约只增不改删字段，非 P0 但随包交付可溯源
      if (s.tabId != null) out.tab_id = s.tabId;
      return out;
    });
  }

  // 组装完整 manifest
  // 输入：{ journey, steps, audio, settings, domains, appName, appVersion, recordedAt }
  //   journey   = journeys store 记录（journeyId/startedAt/entryUrl/tabIds/micEnabled）
  //   steps     = steps store 数组（按 id 升序），可含组包层注入的 _api_calls
  //   audio     = { recorded, t0, endMs, file, mimeType } 或 null（F10 口述轨元信息）
  //   settings  = 本次旅程的 settings 快照
  //   domains   = 从 steps 的 page.url 提取的域名集合（或调用方直接传入）
  //   recordedAt= ISO 字符串（本地时区）
  function build({ journey, steps, audio, settings, domains, appName, appVersion, recordedAt, bodyMaskKeys }) {
    steps = steps || [];
    const j = journey || {};
    const a = audio || { recorded: false, t0: null, endMs: null, file: null, mimeType: null };
    const maskKeys = bodyMaskKeys || DEFAULT_BODY_MASK_KEYS;

    return {
      schema_version: SCHEMA_VERSION,
      journey: {
        name: j.name || '未命名旅程',
        recorded_at: recordedAt || new Date(j.startedAt || Date.now()).toISOString(),
        app: {
          name: appName || '（未识别）',
          version_from_page: appVersion || null,
          entry_url: j.entryUrl || null,
          domains: domains || [],
        },
        settings: {
          fullpage_screenshot: false, // v0.1 未做整页截图（debugger），恒 false
          per_step_dom_snapshot: !!(settings && settings.per_step_dom_snapshot),
          mic_enabled: !!j.micEnabled,
          body_mask_keys: maskKeys,
        },
        audio: {
          recorded: !!a.recorded,
          t0: a.t0 == null ? null : a.t0,
          endMs: a.endMs == null ? null : a.endMs,
          file: a.file || null,
          mimeType: a.mimeType || null,
        },
        transcripts: [], // AI 后处理回填：[{startMs,endMs,text,stepId}]（D10 时钟契约对齐）
      },
      steps: buildSteps(steps),
    };
  }

  // 冒烟校验：返回错误数组（空 = 通过）。字段齐 / 类型对 / 契约不破。
  function validate(manifest) {
    const errs = [];
    if (!manifest || typeof manifest !== 'object') return ['manifest 不是对象'];
    if (manifest.schema_version !== SCHEMA_VERSION) errs.push(`schema_version 应为 ${SCHEMA_VERSION}`);
    if (!manifest.journey) errs.push('journey 段缺失');
    else {
      if (typeof manifest.journey.recorded_at !== 'string') errs.push('journey.recorded_at 应为字符串');
      if (typeof manifest.journey.name !== 'string') errs.push('journey.name 应为字符串');
      if (!manifest.journey.app) errs.push('journey.app 缺失');
      if (!manifest.journey.audio) errs.push('journey.audio 缺失');
      if (!Array.isArray(manifest.journey.transcripts)) errs.push('journey.transcripts 应为数组');
    }
    if (!Array.isArray(manifest.steps)) errs.push('steps 应为数组');
    else {
      manifest.steps.forEach((s, i) => {
        if (typeof s.id !== 'number') errs.push(`steps[${i}].id 应为数字`);
        if (!s.name) errs.push(`steps[${i}].name 缺失`);
        if (typeof s.timestamp_ms !== 'number') errs.push(`steps[${i}].timestamp_ms 应为数字`);
        if (!s.target) errs.push(`steps[${i}].target 缺失`);
      });
    }
    return errs;
  }

  return { build, validate, SCHEMA_VERSION };
});
