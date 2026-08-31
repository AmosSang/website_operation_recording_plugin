// Journey Recorder - 脱敏器（S4 安全红线：脱敏在写入 IndexedDB 前完成，原始数据不留痕）
// 实际执行点 = MAIN world 网络钩子「就地脱敏」（D2）：敏感原始值连 postMessage 都不过。
// 规则（PRD F5 硬性）：
//   ① 请求头白名单外全丢；beibotoken/authtoken/cookie/authorization 必删；值匹配 JWT 三段式特征的头必删
//   ② body 键名含 password/token/secret/auth（不限大小写）→ 值替换 ***，递归嵌套与数组
//   ③ JWT 三段式（eyJ 开头）在纯文本中全局替换 ***
//   ④ URL query 参数名含敏感词 → 值替换 ***
//   ⑤ body/响应体超 256KB 截断存样本 + 总长度标记
// UMD：浏览器挂 window.JourneySanitizer；node --test 直接 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneySanitizer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BODY_LIMIT = 256 * 1024; // 256KB，PRD F5
  const MASK = '***';

  // 头白名单：之外全丢（小写比较）
  const HEADER_ALLOWLIST = [
    'content-type', 'accept', 'accept-language', 'accept-encoding',
    'user-agent', 'referer', 'origin', 'x-requested-with',
  ];

  // 必删头（双保险，白名单本已不含）
  const HEADER_DENYLIST = ['beibotoken', 'authtoken', 'cookie', 'authorization', 'proxy-authorization', 'set-cookie'];

  // body 键名掩码子串（不区分大小写）。'key' 为 2026-08-29 增补：apiKey/accessKey 类
  // 不含 password/token/secret/auth 子串，S4 验收中被夹具 echo 场景暴露（宁多脱不漏脱）。
  const BODY_MASK_KEYS = ['password', 'token', 'secret', 'auth', 'key'];

  // JWT 三段式：eyJ 开头 + 两个 . 分段
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

  function isSensitiveKey(key, extraKeys) {
    const k = String(key || '').toLowerCase();
    if (!k) return false;
    for (let i = 0; i < BODY_MASK_KEYS.length; i++) {
      if (k.indexOf(BODY_MASK_KEYS[i]) !== -1) return true;
    }
    if (extraKeys) {
      for (let i = 0; i < extraKeys.length; i++) {
        const x = String(extraKeys[i] || '').toLowerCase().trim();
        if (x && k.indexOf(x) !== -1) return true;
      }
    }
    return false;
  }

  function looksLikeJwt(value) {
    return typeof value === 'string' && value.length > 20 &&
      value.trimLeft().indexOf('eyJ') === 0 && (value.match(/\./g) || []).length >= 2;
  }

  // ① 请求头：白名单外全丢；JWT 特征值的头必删（白名单头若值是 JWT 也删）
  function maskHeaders(headers) {
    const out = {};
    if (!headers) return out;
    let entries;
    if (typeof headers.forEach === 'function') {
      entries = [];
      headers.forEach((v, k) => entries.push([k, v]));
    } else if (Array.isArray(headers)) {
      entries = headers.map((p) => [p[0], p[1]]);
    } else {
      entries = Object.keys(headers).map((k) => [k, headers[k]]);
    }
    for (const pair of entries) {
      const name = String(pair[0] || '').toLowerCase();
      const value = pair[1];
      if (HEADER_DENYLIST.indexOf(name) !== -1) continue;
      if (HEADER_ALLOWLIST.indexOf(name) === -1) continue;
      if (looksLikeJwt(value)) continue; // 白名单头被塞了 JWT 也不留
      out[name] = String(value);
    }
    return out;
  }

  // 递归掩码：对象/数组按键名替换值；JWT 值无条件 ***
  function deepMask(value, extraKeys, depth) {
    if (depth > 8) return '…'; // 深度护栏
    if (Array.isArray(value)) return value.map((v) => deepMask(v, extraKeys, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) {
        if (isSensitiveKey(k, extraKeys) || looksLikeJwt(value[k])) {
          out[k] = MASK;
        } else {
          out[k] = deepMask(value[k], extraKeys, depth + 1);
        }
      }
      return out;
    }
    return value;
  }

  // 文本级兜底（S4 验收补强）：结构化掩码之后的最后一道网。
  // 覆盖「服务端回显」类场景——敏感键值对内嵌在字符串里（如 echo 的响应），
  // deepMask 只看键名挡不住。两种形态：JSON 键值对 / urlencoded 键值；JWT 永远先替换。
  const SENSITIVE_JSON_KV_RE =
    /("[^"]*(?:password|token|secret|auth|key)[^"]*"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/gi;
  const SENSITIVE_URLED_KV_RE =
    /(^|&)([A-Za-z0-9_\-]*(?:password|token|secret|auth|key)[A-Za-z0-9_\-]*)=([^&]*)/g;

  function scrubText(text) {
    let t = String(text == null ? '' : text).replace(JWT_RE, MASK);
    t = t.replace(SENSITIVE_JSON_KV_RE, '$1"' + MASK + '"');
    t = t.replace(SENSITIVE_URLED_KV_RE, (m, pre, k) => pre + k + '=' + MASK);
    return t;
  }

  // ② 请求/响应体：JSON 解析后递归掩码；非 JSON 文本做 JWT 正则替换；超限截断。
  //    两条路径最终都过 scrubText 兜底（内嵌字符串里的敏感键值对也无处可逃）。
  function maskBody(bodyText, contentType, extraKeys) {
    if (bodyText == null) return { body: null, truncated: false, totalLength: 0 };
    const text = String(bodyText);
    const totalLength = text.length;
    const truncated = totalLength > BODY_LIMIT;
    const sample = truncated ? text.slice(0, BODY_LIMIT) : text;
    const ct = String(contentType || '').toLowerCase();
    let out;
    if (ct.indexOf('json') !== -1 || /^\s*[[{]/.test(sample)) {
      try {
        out = JSON.stringify(deepMask(JSON.parse(sample), extraKeys, 0));
      } catch (e) {
        out = sample; // 伪 JSON / 解析失败：交给兜底层
      }
    } else {
      out = sample;
    }
    return { body: scrubText(out), truncated, totalLength };
  }

  // ④ URL query：参数名含敏感词 → 值打 ***（hash 部分不动）
  function maskUrl(url, extraKeys) {
    let u = String(url || '');
    const qIdx = u.indexOf('?');
    if (qIdx === -1) return u;
    const base = u.slice(0, qIdx);
    let rest = u.slice(qIdx + 1);
    const hIdx = rest.indexOf('#');
    let hash = '';
    if (hIdx !== -1) { hash = rest.slice(hIdx); rest = rest.slice(0, hIdx); }
    const parts = rest.split('&').map((kv) => {
      const eq = kv.indexOf('=');
      if (eq === -1) return kv;
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (isSensitiveKey(decodeURIComponent(k), extraKeys)) return k + '=' + MASK;
      return kv;
    });
    return base + '?' + parts.join('&') + hash;
  }

  // 便捷：整条网络事件一次脱净（net-hook 调用）
  function maskNetEvent(evt, extraKeys) {
    const o = evt || {};
    const req = maskBody(o.reqBody, o.reqContentType, extraKeys);
    const res = maskBody(o.resBody, o.resContentType, extraKeys);
    return {
      kind: o.kind || 'fetch',
      method: o.method || 'GET',
      url: maskUrl(o.url, extraKeys),
      status: o.status ?? null,
      startTs: o.startTs ?? null,
      endTs: o.endTs ?? null,
      reqHeaders: maskHeaders(o.reqHeaders),
      reqBody: req.body,
      reqTruncated: req.truncated,
      reqTotalLength: req.totalLength,
      resContentType: o.resContentType || null,
      resBody: res.body,
      resTruncated: res.truncated,
      resTotalLength: res.totalLength,
      err: o.err || null,
    };
  }

  return {
    MASK, BODY_LIMIT, HEADER_ALLOWLIST, HEADER_DENYLIST, BODY_MASK_KEYS,
    isSensitiveKey, looksLikeJwt, maskHeaders, deepMask, scrubText, maskBody, maskUrl, maskNetEvent,
  };
});
