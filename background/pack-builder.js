// Journey Recorder - 组包纯函数（S8，F7 打包导出的纯逻辑，无 chrome/JSZip 依赖）
// UMD 双端：浏览器挂 window.JourneyPack；node --test 直接 require。
// 覆盖：JSONL 展平 / api_call 行号引用 / 域名提取 / 应用名推断 / 文件名清洗 / README 组装。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneyPack = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 路径/文件名清洗（F7：目录名不能含 URL 保留字符） ----------
  function sanitizeName(name) {
    return String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^.]*$/, '') || 'step';
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  // ---------- API calls 行号引用（F6：api_calls = ["net/calls.jsonl#L120-L124"]） ----------
  // 组包时按 (stepId, ts) 稳定排序，第 i 条对应 calls.jsonl 第 (i+1) 行（1 起）。
  function buildApiCallLineRefs(netCalls) {
    const sorted = [...(netCalls || [])].sort((a, b) => {
      if (a.stepId !== b.stepId) return (a.stepId || 0) - (b.stepId || 0);
      return (a.ts || 0) - (b.ts || 0);
    });
    const byStep = {}; // stepId → [lineStart, lineEnd]
    sorted.forEach((c, i) => {
      const sid = c.stepId || 0;
      const line = i + 1;
      if (!byStep[sid]) byStep[sid] = [line, line];
      else byStep[sid][1] = line;
    });
    return byStep;
  }

  // ---------- 域名提取（F6：app.domains） ----------
  function extractDomains(steps) {
    const set = {};
    (steps || []).forEach((s) => {
      try {
        if (s.page && s.page.url) {
          const u = new URL(s.page.url);
          if (u.hostname) set[u.hostname] = 1;
        }
      } catch (e) { /* */ }
    });
    return Object.keys(set).sort();
  }

  // ---------- 应用名推断（F6：app.name，可人工改名） ----------
  function inferAppName(journey, steps) {
    const url = (journey && journey.entryUrl) || (steps && steps[0] && steps[0].page && steps[0].page.url);
    try {
      if (url) {
        const host = new URL(url).hostname;
        return host.split('.')[0] || host;
      }
    } catch (e) { /* */ }
    return '（未识别）';
  }

  // ---------- rrweb 事件分片 → 单个展平数组（标注 __tabId，供按 tab 过滤回放） ----------
  // 输入：rrEvents chunks [{ tabId, events }]；输出：[{ ...event, __tabId }]（按 timestamp 排序）
  function flattenEvents(rrEvents) {
    const out = [];
    (rrEvents || []).forEach((chunk) => {
      (chunk.events || []).forEach((ev) => {
        out.push(Object.assign({}, ev, { __tabId: chunk.tabId }));
      });
    });
    out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return out;
  }

  // ---------- netCalls → 逐行 JSONL 字符串 ----------
  function netCallsToJsonl(netCalls) {
    const sorted = [...(netCalls || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return sorted.map((n) => JSON.stringify(n.call || n)).join('\n') + (sorted.length ? '\n' : '');
  }

  // ---------- events → 逐行 JSONL 字符串 ----------
  function eventsToJsonl(flatEvents) {
    return (flatEvents || []).map((e) => JSON.stringify(e)).join('\n') + ((flatEvents || []).length ? '\n' : '');
  }

  // ---------- README.txt 组装（F7 自动生成的包说明） ----------
  function buildReadme(manifest, micEnabled) {
    const a = (manifest && manifest.journey && manifest.journey.audio) || {};
    return [
      'Journey Recorder 导出包',
      '=======================',
      '',
      'schema_version: ' + ((manifest && manifest.schema_version) || ''),
      '旅程名: ' + ((manifest && manifest.journey.name) || ''),
      '录制时间: ' + ((manifest && manifest.journey.recorded_at) || ''),
      '入口页面: ' + ((manifest && manifest.journey.app && manifest.journey.app.entry_url) || ''),
      '应用: ' + ((manifest && manifest.journey.app && manifest.journey.app.name) || '') +
        ((manifest && manifest.journey.app && manifest.journey.app.version_from_page) ? ' (' + manifest.journey.app.version_from_page + ')' : ''),
      '',
      '脱敏声明:',
      '  所有接口请求/响应体均已按内置键名清单（password/token/secret/auth/key）递归掩码，',
      '  JWT 类令牌已三段式正则脱敏。本包不包含任何敏感明文。',
      '',
      '录音状态: ' + (micEnabled ? (a.recorded ? '已录（webm）' : '开启但未采集到数据') : '未开启'),
      '口述轨: ' + (a.recorded ? (a.file || 'audio/journey.webm') + '（' + (a.mimeType || '') + '）' : '无'),
      '转写后处理: 本包不含转写文本。请用本地 whisper.cpp 对 webm 分段 [startMs,endMs,text]，',
      '  按 D10 时钟契约（t0=首 chunk 时间）回填 manifest.journey.transcripts[] 并合并进',
      '  对应 Step 的 user_note。',
      '',
      'rrweb 已知局限:',
      '  跨域样式表的 cssRules 读取受浏览器安全策略限制，rrweb 自带降级（记 href 占位）；',
      '  回放时跨域样式可能失真，证据仍以 steps/NNN_*/viewport.png + dom.html 为准。',
      '',
      '页面资源（S8，高保真仿制）:',
      '  每个唯一页面一套。pages/<page_id>/page.html 为外链 CSS 内联 + url() 子资源转',
      '  data:base64 后的完整页（图片/字体/SVG 已内联）；assets.css 为该页全部 CSS 合并；',
      '  assets/ 下为二进制资源留档。跨域/CDN 资源若抓取失败，pages 段会登记 sheets_missing。',
      '',
      '目录:',
      '  net/calls.jsonl     脱敏接口记录（逐行 JSON）',
      '  rrweb/events.jsonl 回放事件流（含 journey-step 锚点 customEvent）',
      '  audio/             口述轨（webm + 时间线）',
      '  steps/NNN_*/       每步截图 + DOM 快照',
      '  pages/<page_id>/   每页一套资源（page.html 内联版 + assets.css + assets/）',
      '  player.html        离线回放器（双击打开）',
      '',
    ].join('\n');
  }

  return {
    sanitizeName, stripExt, fmtDate,
    buildApiCallLineRefs, extractDomains, inferAppName,
    flattenEvents, netCallsToJsonl, eventsToJsonl, buildReadme,
  };
});
