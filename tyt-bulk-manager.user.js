// ==UserScript==
// @name         TYT Bulk Manager
// @namespace    https://github.com/caccac11/TYT-Bulk-Manager
// @version      1.6.4
// @description  Quản lý truyện và chương TYT: nhập/xuất TXT, cập nhật, Retry riêng chương lỗi, đổi tên, đánh số và thống kê doanh thu.
// @author       Gin Kai
// @homepageURL  https://github.com/caccac11/TYT-Bulk-Manager
// @supportURL   https://github.com/caccac11/TYT-Bulk-Manager/issues
// @updateURL    https://raw.githubusercontent.com/caccac11/TYT-Bulk-Manager/main/tyt-bulk-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/caccac11/TYT-Bulk-Manager/main/tyt-bulk-manager.user.js
// @match        https://tytnovel.info/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.6.4';
  const MAX_CHAPTER_NUMBER = 9999;
  const MAX_MULTI = 10;
  const CACHE_TTL = 60 * 1000;
  const CACHE_MAX_ENTRIES = 100;
  const ID_RE = /^[0-9a-f]{24}$/i;
  const STORY_RE = /\/mystory\/([0-9a-f]{24})(?:\/|$)/i;
  const EDIT_RE = /\/mystory\/([0-9a-f]{24})\/chapters\/([0-9a-f]{24})\/edit\/?(?:[?#].*)?$/i;
  const CHAPTER_HEADING_RE = /^\s*(?:chương|chapter|chap)\s*([0-9]{1,6})\s*(?:[:：.\-–—)]\s*(.*?))?\s*$/i;
  const CN_HEADING_RE = /^\s*第\s*([0-9]{1,6})\s*章\s*(.*?)\s*$/i;
  const BLANK_P = '<p>&nbsp;</p>';
  const SCRIPT_INFO = Object.freeze({
    authorName: 'Gin Kai',
    authorProfileUrl: 'https://tytnovel.info/profile/68d1850877d97e06be011ae8',
    authorMessage: '1 Editor siêu flop trên TYT, nếu có thể thì hãy ghé qua đọc thử truyện của mình làm nhé~',
  });


  const UPDATE_INFO = Object.freeze({
    checkUrl: 'https://raw.githubusercontent.com/caccac11/TYT-Bulk-Manager/main/tyt-bulk-manager.user.js',
    downloadUrl: 'https://raw.githubusercontent.com/caccac11/TYT-Bulk-Manager/main/tyt-bulk-manager.user.js',
    cacheKey: 'tyt_bulk_update_cache_v1',
    notifiedKey: 'tyt_bulk_update_notified_version',
    cacheMs: 30 * 60 * 1000,
    failCacheMs: 5 * 60 * 1000,
    timeoutMs: 15000,
  });

  const defaults = {
    maxPages: 200,
    maxItems: 9999,
    readWorkers: 4,
    writeWorkers: 2,
    deleteWorkers: 2,
    writeDelay: 120,
    getDelay: 40,
    renameTemplate: 'Chương {num}: {tail}',
    renumberStart: 1,
    selectedOnly: false,
    parseNumberFromFilename: true,
    singleUpload: false,
    published: '1',
    panelWidth: 1040,
  };

  const state = {
    cfg: loadConfig(),
    stories: [],
    storyId: '',
    storyTitle: '',
    files: [],
    chapters: [],
    chapterMeta: null,
    earnings: new Map(),
    wallet: null,
    editCache: new Map(),
    txtRetryJobs: new Map(),
    busy: false,
    cancelled: false,
    logs: [],
    activeRequests: new Set(),
    lastChapterSelectionIndex: null,
    chapterViewPage: 1,
  };

  function loadConfig() {
    try {
      const saved = GM_getValue('tyt_bulk_browser_config', {});
      return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch (_) {
      return { ...defaults };
    }
  }

  function saveConfig() {
    try { GM_setValue('tyt_bulk_browser_config', state.cfg); } catch (_) {}
  }


  function versionParts(value) {
    return String(value || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(x => Number(x) || 0);
  }

  function compareVersions(a, b) {
    const aa = versionParts(a), bb = versionParts(b);
    const length = Math.max(aa.length, bb.length);
    for (let i = 0; i < length; i++) {
      const av = aa[i] || 0, bv = bb[i] || 0;
      if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
  }

  function isNewerVersion(remoteVersion, localVersion = VERSION) {
    return compareVersions(remoteVersion, localVersion) > 0;
  }

  function readUpdateCache() {
    try {
      const cached = GM_getValue(UPDATE_INFO.cacheKey, null);
      return cached && typeof cached === 'object' ? cached : null;
    } catch (_) {
      return null;
    }
  }

  function writeUpdateCache(remoteVersion, ok) {
    try {
      GM_setValue(UPDATE_INFO.cacheKey, {
        checkedAt: Date.now(),
        remoteVersion: String(remoteVersion || ''),
        ok: !!ok,
      });
    } catch (_) {}
  }

  function renderUpdateStatus(remoteVersion = '') {
    const badge = document.querySelector('#tytb-update-badge');
    const versionEl = document.querySelector('#tytb-version');
    const panel = document.querySelector('#tytb-panel');
    const newer = isNewerVersion(remoteVersion);
    panel?.classList.toggle('tytb-has-update', newer);
    if (versionEl) {
      versionEl.title = newer
        ? `Đang dùng v${VERSION}; có bản mới v${remoteVersion}.`
        : `Phiên bản hiện tại v${VERSION}.`;
    }
    if (!badge) return newer;
    badge.hidden = !newer;
    badge.dataset.version = newer ? String(remoteVersion) : '';
    badge.title = newer ? `Cập nhật TYT Bulk từ v${VERSION} lên v${remoteVersion}` : '';
    const longLabel = badge.querySelector('.tytb-update-long');
    if (longLabel) longLabel.textContent = newer ? `v${remoteVersion} mới` : 'Có bản mới';
    return newer;
  }

  function notifyUpdateOnce(remoteVersion) {
    if (!isNewerVersion(remoteVersion)) return;
    let previous = '';
    try { previous = String(GM_getValue(UPDATE_INFO.notifiedKey, '') || ''); } catch (_) {}
    if (previous === String(remoteVersion)) return;
    try { GM_setValue(UPDATE_INFO.notifiedKey, String(remoteVersion)); } catch (_) {}
    if (typeof GM_notification === 'function') {
      try {
        GM_notification({
          title: 'TYT Bulk có bản mới',
          text: `v${VERSION} → v${remoteVersion}. Mở panel và bấm “Cập nhật” để cài.`,
          timeout: 9000,
        });
      } catch (_) {}
    }
  }

  function requestRemoteVersion() {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest không khả dụng.'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: UPDATE_INFO.checkUrl,
        headers: { Accept: 'text/plain,*/*;q=0.8' },
        timeout: UPDATE_INFO.timeoutMs,
        onload: response => {
          const status = Number(response?.status) || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`Máy chủ cập nhật trả HTTP ${status || '?'}.`));
            return;
          }
          const text = String(response?.responseText || '');
          const match = text.match(/^\s*\/\/\s*@version\s+([^\s]+)\s*$/m);
          if (!match) {
            reject(new Error('Không đọc được @version từ bản cập nhật.'));
            return;
          }
          resolve(match[1].trim());
        },
        ontimeout: () => reject(new Error('Kiểm tra cập nhật bị quá thời gian.')),
        onerror: () => reject(new Error('Không kết nối được máy chủ cập nhật.')),
      });
    });
  }

  async function checkForUpdates({ force = false, userInitiated = false } = {}) {
    if (!force) {
      const cached = readUpdateCache();
      if (cached?.checkedAt) {
        const ttl = cached.ok ? UPDATE_INFO.cacheMs : UPDATE_INFO.failCacheMs;
        if (Date.now() - Number(cached.checkedAt) < ttl) {
          const remoteVersion = String(cached.remoteVersion || '');
          const newer = renderUpdateStatus(remoteVersion);
          if (newer) notifyUpdateOnce(remoteVersion);
          return remoteVersion;
        }
      }
    }

    if (userInitiated) setStatus('Đang kiểm tra cập nhật...');
    try {
      const remoteVersion = await requestRemoteVersion();
      writeUpdateCache(remoteVersion, true);
      const newer = renderUpdateStatus(remoteVersion);
      if (newer) {
        log(`Có bản cập nhật v${remoteVersion}. Bấm “Cập nhật” trên thanh tiêu đề để cài.`, 'warn');
        notifyUpdateOnce(remoteVersion);
        if (userInitiated) alert(`Có bản mới v${remoteVersion}.

Bản hiện tại: v${VERSION}.
Bấm “Cập nhật” trên thanh tiêu đề để mở trình cài của Tampermonkey.`);
      } else if (userInitiated) {
        log(`Đang dùng bản mới nhất v${VERSION}.`, 'success');
        alert(`Bạn đang dùng bản mới nhất: v${VERSION}.`);
      }
      return remoteVersion;
    } catch (error) {
      writeUpdateCache('', false);
      debugLog('Kiểm tra cập nhật không thành công', error, 'warn');
      if (userInitiated) alert(`Không kiểm tra được cập nhật.

${friendlyError(error)}`);
      return '';
    } finally {
      if (userInitiated && !state.busy) setStatus('Sẵn sàng.');
    }
  }

  async function openUpdateInstaller() {
    if (state.busy) {
      alert('Hãy chờ tác vụ hiện tại hoàn tất hoặc hủy tác vụ trước khi cập nhật script.');
      return;
    }
    let remoteVersion = document.querySelector('#tytb-update-badge')?.dataset.version || '';
    if (!isNewerVersion(remoteVersion)) {
      remoteVersion = await checkForUpdates({ force: true, userInitiated: true });
    }
    if (!isNewerVersion(remoteVersion)) return;
    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(UPDATE_INFO.downloadUrl, { active: true, insert: true, setParent: true });
      } else {
        const opened = window.open(UPDATE_INFO.downloadUrl, '_blank');
        if (!opened) throw new Error('Popup bị chặn.');
        try { opened.opener = null; } catch (_) {}
      }
      log(`Đã mở trình cài bản v${remoteVersion}. Tampermonkey sẽ xử lý bước cập nhật tiếp theo.`, 'info');
    } catch (error) {
      debugLog('Không mở được trình cài cập nhật', error, 'warn');
      alert('Không mở được trình cài cập nhật. Hãy cho phép mở tab mới rồi thử lại.');
    }
  }

  const backgroundTimer = (() => {
    let worker = null;
    let seq = 0;
    const pending = new Map();
    try {
      const blob = new Blob([`self.onmessage = event => {
        const data = event.data || {};
        setTimeout(() => self.postMessage(data.id), Math.max(0, Number(data.ms) || 0));
      };`], { type: 'text/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl);
      worker.onmessage = event => {
        const resolve = pending.get(event.data);
        if (!resolve) return;
        pending.delete(event.data);
        resolve();
      };
      worker.onerror = () => {
        worker = null;
        for (const resolve of pending.values()) resolve();
        pending.clear();
      };
    } catch (_) {
      worker = null;
    }
    return ms => {
      const wait = Math.max(0, Number(ms) || 0);
      if (!worker) return new Promise(resolve => setTimeout(resolve, wait));
      return new Promise(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        worker.postMessage({ id, ms: wait });
      });
    };
  })();

  function sleep(ms) { return backgroundTimer(ms); }
  function yieldBrowser() {
    return new Promise(resolve => {
      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      } else {
        queueMicrotask(resolve);
      }
    });
  }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }
  function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function normSpace(s) { return String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
  function parseHtml(text) { return new DOMParser().parseFromString(String(text || ''), 'text/html'); }
  function naturalKey(s) { return String(s).split(/(\d+)/).map(x => /^\d+$/.test(x) ? Number(x) : x.toLocaleLowerCase('vi')); }
  function naturalCompare(a, b) {
    const aa = naturalKey(a), bb = naturalKey(b);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      if (aa[i] === undefined) return -1;
      if (bb[i] === undefined) return 1;
      if (aa[i] === bb[i]) continue;
      if (typeof aa[i] === typeof bb[i]) return aa[i] < bb[i] ? -1 : 1;
      return String(aa[i]) < String(bb[i]) ? -1 : 1;
    }
    return 0;
  }
  function moneyInt(s) { return Number(String(s || '').replace(/[^0-9-]/g, '')) || 0; }
  function fmtMoney(n) { return new Intl.NumberFormat('vi-VN').format(Number(n) || 0) + ' đ'; }
  function safeName(s, fallback='TYT') {
    const out = normSpace(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
    return out || fallback;
  }
  function visibleTextLength(html) { return normSpace(parseHtml(`<body>${html || ''}</body>`).body.textContent).length; }
  function currentStoryIdFromUrl() { return (location.pathname.match(STORY_RE) || [])[1] || ''; }

  const startLocks = new Map();
  const lastStart = new Map();
  async function throttle(bucket, interval) {
    const previous = startLocks.get(bucket) || Promise.resolve();
    let unlock;
    const mine = new Promise(resolve => { unlock = resolve; });
    startLocks.set(bucket, previous.then(() => mine));
    await previous;
    try {
      const wait = Math.max(0, Number(interval) - (Date.now() - (lastStart.get(bucket) || 0)));
      if (wait) await sleep(wait);
      lastStart.set(bucket, Date.now());
    } finally {
      unlock();
    }
  }

  function requestBucket(url, method) {
    const u = String(url).toLowerCase();
    if (method === 'POST') return ['write', state.cfg.writeDelay];
    // TYT hiện trả 404 nginx giả khi GET dồn quá nhanh. Tách bucket và đặt
    // khoảng nghỉ tối thiểu để không làm rơi nguyên trang/chương.
    if (u.includes('/chapters/') && /\/edit\/?(?:[?#].*)?$/.test(u)) return ['read-edit', Math.max(120, state.cfg.getDelay)];
    if (u.includes('/chapters')) return ['read-list', Math.max(180, state.cfg.getDelay)];
    if (u.includes('/earning') || u.includes('/mypayments')) return ['earning', Math.max(90, state.cfg.getDelay + 50)];
    return ['default', Math.max(60, state.cfg.getDelay)];
  }

  async function requestText(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const [bucket, interval] = requestBucket(url, method);
    const retries = method === 'GET'
      ? Math.max(0, Number.isInteger(options.retries) ? options.retries : 2)
      : 0;
    const retryStatuses = new Set(options.retryStatuses || [408, 425, 429, 500, 502, 503, 504]);
    const retryBaseMs = Math.max(250, Number(options.retryBaseMs) || 700);
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (state.cancelled) throw new Error('Đã hủy.');
      await throttle(bucket, interval + Math.floor(Math.random() * 35));

      const headers = new Headers(options.headers || {});
      if (!headers.has('Accept')) {
        headers.set('Accept', options.ajax
          ? 'application/json, text/javascript, */*; q=0.01'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      }
      if (options.ajax) headers.set('X-Requested-With', 'XMLHttpRequest');

      const controller = new AbortController();
      state.activeRequests.add(controller);
      const timeoutMs = Number(options.timeoutMs) || (method === 'POST' ? 60000 : 45000);
      let finished = false;
      let timedOut = false;

      // Bộ đếm timeout nằm trong Web Worker, nhưng request vẫn là fetch cùng origin
      // của chính Chrome. Nhờ vậy giữ được phiên Cloudflare/TLS của tab trình duyệt.
      sleep(timeoutMs).then(() => {
        if (finished) return;
        timedOut = true;
        try { controller.abort(); } catch (_) {}
      });

      try {
        const response = await fetch(new URL(url, location.origin).href, {
          method,
          body: options.body,
          headers,
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
        });
        const text = await response.text();
        const finalUrl = response.url || new URL(url, location.origin).href;

        if (/Just a moment|cf-browser-verification|challenge-platform|Attention Required/i.test(text)) {
          throw new Error('Cloudflare đang yêu cầu challenge trong tab trình duyệt. Hãy tải lại trang TYT và hoàn tất kiểm tra rồi chạy lại.');
        }
        if (/id=["']body_login["']|href=["']\/login\b|>\s*Đăng\s*Nhập\s*</i.test(text)) {
          throw new Error('Phiên đăng nhập đã hết. Hãy đăng nhập lại TYT trong chính tab Chrome này.');
        }
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status} ${method} ${finalUrl}: ${normSpace(parseHtml(text).body.textContent).slice(0, 400)}`);
          err.status = response.status;
          err.url = finalUrl;
          throw err;
        }
        return { text, response };
      } catch (err) {
        if (timedOut || (err && err.name === 'AbortError' && !state.cancelled)) {
          lastErr = new Error(`Request bị treo quá ${Math.round(timeoutMs / 1000)} giây: ${new URL(url, location.origin).href}`);
        } else if (state.cancelled && err && err.name === 'AbortError') {
          lastErr = new Error('Đã hủy.');
        } else {
          lastErr = err;
        }
        const retryable = attempt < retries && (!lastErr.status || retryStatuses.has(lastErr.status));
        if (!retryable) break;
        const waitMs = Math.min(12000, retryBaseMs * (2 ** attempt) + Math.random() * 650);
        await sleep(waitMs);
      } finally {
        finished = true;
        state.activeRequests.delete(controller);
      }
    }

    throw lastErr || new Error('Không kết nối được TYT.');
  }

  async function postForm(url, payload, referer = '') {
    const body = new URLSearchParams();
    Object.entries(payload || {}).forEach(([k, v]) => body.set(k, String(v ?? '')));
    const { text } = await requestText(url, {
      method: 'POST',
      ajax: true,
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });
    let obj = null;
    try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) {}
    if (obj && typeof obj === 'object') {
      const ok = obj.status === true || obj.success === true;
      let msg = String(obj.message || obj.error || (ok ? 'OK' : 'Máy chủ báo thất bại.'));
      if (!ok && obj.data) {
        const d = typeof obj.data === 'string' ? normSpace(parseHtml(obj.data).body.textContent) : JSON.stringify(obj.data);
        if (d) msg += ` | ${d.slice(0, 800)}`;
      }
      if (!ok) throw new Error(msg);
      return { ok: true, message: msg, data: obj };
    }
    if (/success|thành công|cập nhật xong/i.test(text)) return { ok: true, message: normSpace(parseHtml(text).body.textContent).slice(0, 300) || 'OK' };
    throw new Error(`Không đọc được JSON phản hồi: ${text.slice(0, 500)}`);
  }

  async function mapLimit(items, limit, worker, onProgress) {
    const arr = Array.from(items || []);
    const results = new Array(arr.length);
    let cursor = 0, done = 0;
    async function runner() {
      while (true) {
        if (state.cancelled) throw new Error('Đã hủy.');
        const i = cursor++;
        if (i >= arr.length) return;
        try { results[i] = await worker(arr[i], i); }
        catch (error) { results[i] = { ok: false, error }; }
        done++;
        if (onProgress) onProgress(done, arr.length, results[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit | 0), Math.max(1, arr.length)) }, runner));
    return results;
  }

  const LOG_LIMIT = 300;
  const LOG_LABELS = {
    info: 'Thông tin',
    success: 'Hoàn tất',
    warn: 'Cảnh báo',
    error: 'Lỗi',
  };

  function cleanLogMessage(message) {
    return String(message ?? '')
      .replace(/https?:\/\/\S+/gi, 'liên kết TYT')
      .replace(/\b[0-9a-f]{24}\b/gi, 'mã nội bộ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function friendlyError(error) {
    const raw = String(error?.message || error || 'Đã xảy ra lỗi không xác định.');
    if (state.cancelled || /đã hủy|abort/i.test(raw)) return 'Tác vụ đã được hủy.';
    if (/phiên đăng nhập|đăng nhập lại|body_login|\/login\b/i.test(raw)) return 'Phiên đăng nhập đã hết. Hãy đăng nhập lại TYT rồi thử lại.';
    if (/cloudflare|challenge|just a moment|attention required/i.test(raw)) return 'TYT đang yêu cầu xác minh trình duyệt. Hãy mở lại trang TYT, hoàn tất xác minh rồi thử lại.';
    if (/bị treo quá|timeout|timed out/i.test(raw)) return 'Kết nối phản hồi quá chậm. Hãy kiểm tra mạng và thử lại.';
    if (/HTTP\s*429|status\s*429/i.test(raw)) return 'TYT đang giới hạn tần suất thao tác. Hãy giảm số luồng hoặc tăng khoảng nghỉ rồi thử lại.';
    if (/HTTP\s*404|vẫn 404|không còn xuất hiện/i.test(raw)) return 'Không tìm thấy dữ liệu cần thao tác. Hãy tải lại danh sách rồi thử lại.';
    if (/HTTP\s*5\d\d|nginx|máy chủ/i.test(raw)) return 'Máy chủ TYT đang bận hoặc tạm thời không ổn định. Hãy thử lại sau.';
    if (/failed to fetch|networkerror|load failed|không kết nối/i.test(raw)) return 'Không thể kết nối tới TYT. Hãy kiểm tra mạng và trạng thái đăng nhập.';
    if (/không đọc được JSON|endpoint|new_multi|add_multi|Story ID|Chapter ID/i.test(raw)) return 'Cấu trúc trang TYT có thể đã thay đổi. Hãy tải lại trang; nếu lỗi vẫn còn, cần cập nhật script.';
    return cleanLogMessage(raw)
      .replace(/HTTP\s*\d+\s*(GET|POST)?/gi, '')
      .replace(/\b(GET|POST)\b/gi, '')
      .replace(/\s*\|\s*/g, ' ')
      .trim() || 'Đã xảy ra lỗi không xác định.';
  }

  function debugLog(context, detail = null, level = 'log') {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](`[TYT Bulk][Kỹ thuật] ${context}`, detail ?? '');
  }

  function log(message, level = 'info') {
    if (!LOG_LABELS[level]) level = 'info';
    const clean = cleanLogMessage(message);
    if (!clean) return;
    const now = new Date();
    const entry = {
      time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestamp: now.getTime(),
      message: clean,
      level,
    };
    const previous = state.logs.at(-1);
    if (previous && previous.message === entry.message && previous.level === entry.level && entry.timestamp - previous.timestamp < 1500) return;
    state.logs.push(entry);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);

    const el = document.querySelector('#tytb-log');
    if (el) {
      const row = document.createElement('div');
      row.className = `tytb-log-entry tytb-log-${level}`;
      const time = document.createElement('span');
      time.className = 'tytb-log-time';
      time.textContent = entry.time;
      const badge = document.createElement('span');
      badge.className = 'tytb-log-badge';
      badge.textContent = LOG_LABELS[level];
      const content = document.createElement('span');
      content.className = 'tytb-log-message';
      content.textContent = entry.message;
      row.append(time, badge, content);
      el.appendChild(row);
      while (el.children.length > LOG_LIMIT) el.firstElementChild?.remove();
      el.scrollTop = el.scrollHeight;
    }
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[TYT Bulk]', clean);
  }

  function logError(context, error, fallback = '') {
    debugLog(context, error, 'error');
    log(`${context}: ${fallback || friendlyError(error)}`, 'error');
  }

  function clearActivityLog() {
    state.logs = [];
    const el = document.querySelector('#tytb-log');
    if (el) el.replaceChildren();
  }

  async function copyActivityLog() {
    if (!state.logs.length) {
      alert('Nhật ký đang trống.');
      return;
    }
    const text = state.logs
      .map(item => `[${item.time}] [${LOG_LABELS[item.level]}] ${item.message}`)
      .join('\n');
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (error) {
      debugLog('Clipboard API không khả dụng', error, 'warn');
    }
    if (!copied) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand('copy');
        area.remove();
      } catch (error) {
        debugLog('Không sao chép được nhật ký', error, 'error');
      }
    }
    if (copied) log('Đã sao chép nhật ký hoạt động.', 'success');
    else alert('Không thể sao chép tự động. Hãy thử lại trên trang HTTPS.');
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (seconds < 60) return `${seconds} giây`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} phút ${rest} giây` : `${minutes} phút`;
  }

  function setStatus(text) {
    const el = document.querySelector('#tytb-status');
    if (el) el.textContent = text;
  }
  function setProgress(done, total) {
    const pct = total ? Math.round(done * 100 / total) : 0;
    const bar = document.querySelector('#tytb-progress-bar');
    const txt = document.querySelector('#tytb-progress-text');
    if (bar) bar.style.width = `${clamp(pct, 0, 100)}%`;
    if (txt) txt.textContent = `${clamp(pct, 0, 100)}%`;
  }
  function requireStory() {
    if (!ID_RE.test(state.storyId)) throw new Error('Chưa chọn truyện.');
    return state.storyId;
  }
  function selectedChapters() { return state.chapters.filter(ch => ch.selected); }
  function targetChapters() {
    return state.cfg.selectedOnly ? selectedChapters() : state.chapters.slice();
  }

  async function runTask(name, fn) {
    if (state.busy) { alert('Một tác vụ khác đang được thực hiện.'); return; }
    const startedAt = Date.now();
    state.busy = true;
    state.cancelled = false;
    updateBusyUI(true);
    setStatus(`${name}...`);
    setProgress(0, 1);
    log(`Bắt đầu: ${name}.`);
    try {
      await fn();
      if (state.cancelled) throw new Error('Đã hủy.');
      const elapsed = formatDuration(Date.now() - startedAt);
      setStatus(`${name}: hoàn tất`);
      setProgress(1, 1);
      log(`${name} hoàn tất sau ${elapsed}.`, 'success');
      if (document.hidden && typeof GM_notification === 'function') {
        try { GM_notification({ title: 'TYT Bulk', text: `${name} đã hoàn tất.`, timeout: 6000 }); } catch (_) {}
      }
    } catch (err) {
      if (state.cancelled) {
        setStatus(`${name}: đã hủy`);
        log(`${name} đã được hủy.`, 'warn');
      } else {
        const message = friendlyError(err);
        setStatus(`${name}: không thành công`);
        logError(name, err, message);
        if (document.hidden && typeof GM_notification === 'function') {
          try { GM_notification({ title: 'TYT Bulk', text: `${name} không thành công: ${message}`.slice(0, 240), timeout: 10000 }); } catch (_) {}
        }
        alert(`${name} không thể hoàn tất.\n\n${message}`);
      }
    } finally {
      state.editCache.clear();
      state.busy = false;
      updateBusyUI(false);
    }
  }

  function updateBusyUI(busy) {
    document.querySelectorAll('#tytb-panel button[data-action], #tytb-panel input[type=file], #tytb-story').forEach(el => {
      if (el.id !== 'tytb-cancel') el.disabled = !!busy;
    });
    document.querySelectorAll('#tytb-panel label.tytb-file-picker').forEach(label => {
      label.classList.toggle('disabled', !!busy);
    });
    const cancel = document.querySelector('#tytb-cancel');
    if (cancel) cancel.disabled = !busy;
    syncChapterPagerButtons();
  }

  function extractMaxPage(doc) {
    let max = 1;
    doc.querySelectorAll('a[href], [data-page], [data-page-number]').forEach(el => {
      const href = el.getAttribute('href') || '';
      const values = [
        ...(href.match(/[?&]page=(\d+)/g) || []).map(x => x.match(/(\d+)/)?.[1]),
        ...(href.match(/\/page\/(\d+)/g) || []).map(x => x.match(/(\d+)/)?.[1]),
        el.getAttribute('data-page'), el.getAttribute('data-page-number'),
      ];
      values.forEach(v => { const n = Number(v); if (Number.isFinite(n)) max = Math.max(max, n); });
    });
    return max;
  }

  function urlWithPage(path, page) {
    const u = new URL(path, location.origin);
    if (page > 1) u.searchParams.set('page', String(page));
    else u.searchParams.delete('page');
    return u.pathname + u.search;
  }

  function parseStories(doc) {
    const found = new Map();
    const put = (id, title, score) => {
      title = normSpace(title);
      if (!title || ID_RE.test(title) || title === id) return;
      const current = found.get(id);
      if (!current || score > current.score || (score === current.score && title.length > current.title.length)) {
        found.set(id, { title, score });
      }
    };

    // Cấu trúc hiện tại của /mystory: mỗi truyện nằm trong một .list-group-item.
    // Chỉ lấy anchor tên truyện trong vùng flex-grow-1; tuyệt đối không để nút Sửa Truyện
    // (cùng href nhưng không có text) ghi đè tên bằng Story ID.
    doc.querySelectorAll('.list-group-item').forEach(item => {
      const links = [...item.querySelectorAll('a[href]')];
      for (const a of links) {
        let u;
        try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
        const m = u.pathname.match(/^\/mystory\/([0-9a-f]{24})\/?$/i);
        if (!m) continue;
        const sid = m[1];
        const title = normSpace(a.textContent);
        let score = 10;
        if (a.matches('.text-decoration-none.fw-medium.text-body')) score = 120;
        else if (a.closest('.flex-grow-1')) score = 100;
        else if (title) score = 40;
        if (a.hasAttribute('title') && /sửa truyện|edit/i.test(a.getAttribute('title') || '')) score -= 80;
        put(sid, title, score);
      }
    });

    // Dự phòng nếu giao diện web đổi wrapper nhưng vẫn giữ URL /mystory/{24-hex}/.
    doc.querySelectorAll('a[href]').forEach(a => {
      let u;
      try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { return; }
      const m = u.pathname.match(/^\/mystory\/([0-9a-f]{24})\/?$/i);
      if (!m) return;
      const sid = m[1];
      const title = normSpace(a.textContent);
      let score = title ? 30 : -100;
      if (a.matches('.text-decoration-none.fw-medium.text-body')) score = 120;
      else if (a.closest('.flex-grow-1')) score = 100;
      put(sid, title, score);
    });

    return [...found.entries()].map(([id, value]) => ({ id, title: value.title }));
  }

  async function loadStories() {
    const first = await requestText('/mystory');
    const firstDoc = parseHtml(first.text);
    let stories = parseStories(firstDoc);
    const maxPage = Math.min(50, extractMaxPage(firstDoc));
    if (maxPage > 1) {
      const pages = Array.from({ length: maxPage - 1 }, (_, i) => i + 2);
      const rows = await mapLimit(pages, 3, async p => parseStories(parseHtml((await requestText(urlWithPage('/mystory', p))).text)), (d,t) => setProgress(d,t));
      rows.forEach(r => { if (Array.isArray(r)) stories.push(...r); });
    }
    const byId = new Map();
    stories.forEach(s => { if (!byId.has(s.id) || s.title.length > byId.get(s.id).title.length) byId.set(s.id, s); });
    state.stories = [...byId.values()].sort((a,b) => a.title.localeCompare(b.title, 'vi'));
    if (!state.stories.length) throw new Error('Không lấy được danh sách truyện. Hãy kiểm tra tài khoản đang đăng nhập.');
    const badNames = state.stories.filter(x => !x.title || ID_RE.test(x.title));
    if (badNames.length) log(`${badNames.length} truyện chưa hiển thị được tên. Hãy tải lại danh sách nếu cần.`, 'warn');
    const current = currentStoryIdFromUrl();
    if (current && byId.has(current)) state.storyId = current;
    if (!state.storyId || !byId.has(state.storyId)) state.storyId = state.stories[0].id;
    state.storyTitle = byId.get(state.storyId)?.title || state.storyId;
    renderStorySelect();
    log(`Đã nạp ${state.stories.length} truyện.`, 'success');
  }

  function renderStorySelect() {
    const select = document.querySelector('#tytb-story');
    if (!select) return;
    select.innerHTML = state.stories.map(s => `<option value="${s.id}" title="${escHtml(s.title)}" ${s.id === state.storyId ? 'selected' : ''}>${escHtml(s.title)}</option>`).join('');
    document.querySelector('#tytb-current-story').textContent = state.storyTitle || 'Chưa chọn';
  }

  function parseCountFromPage(doc) {
    const text = normSpace(doc.body.textContent);
    const m = text.match(/([0-9][0-9.,\s]*)\s*chương\b/i);
    return m ? Number(m[1].replace(/[^0-9]/g, '')) || null : null;
  }

  function headerScore(s) {
    const v = normSpace(s).toLocaleLowerCase('vi').replace(/[:.\-]+$/g, '');
    const exact = new Map([['số',120],['stt',118],['số chương',116],['thứ tự',114],['chapter number',112],['number',108],['no',106],['#',104]]);
    if (exact.has(v)) return exact.get(v);
    if (/số chương|chapter number|thứ tự/.test(v)) return 100;
    return -1;
  }

  function plainInt(s) {
    const m = normSpace(s).match(/^(?:#|№)?\s*([0-9]{1,6})\s*[.:\-)]?$/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 && n <= MAX_CHAPTER_NUMBER ? n : null;
  }

  function parseChapterRows(doc, pageNo) {
    const out = [];
    for (const table of doc.querySelectorAll('table')) {
      if (!table.querySelector('a[href*="/chapters/"][href*="/edit"]')) continue;
      let numberIndex = null, best = -1;
      const headRow = table.querySelector('thead tr') || [...table.querySelectorAll('tr')].find(tr => !tr.querySelector('a[href*="/edit"]'));
      if (headRow) [...headRow.children].forEach((c, i) => { const score = headerScore(c.textContent); if (score > best) { best = score; numberIndex = i; } });
      for (const tr of table.querySelectorAll('tbody tr, tr')) {
        let edit = null, editUrlObj = null, match = null;
        for (const a of tr.querySelectorAll('a[href]')) {
          let u;
          try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
          const m = u.pathname.match(EDIT_RE);
          if (!m) continue;
          edit = a; editUrlObj = u; match = m; break;
        }
        if (!edit || !editUrlObj || !match) continue;
        const rowStoryId = match[1];
        const cid = match[2];
        // Không trộn chương của truyện khác nếu trang có widget/bảng phụ.
        if (ID_RE.test(state.storyId) && rowStoryId !== state.storyId) continue;
        const exactEditUrl = `${editUrlObj.pathname}${editUrlObj.search}`;
        const cells = [...tr.children].filter(x => /^(TD|TH)$/.test(x.tagName));
        let number = null, numberSource = '';
        const attrs = ['data-number','data-chapter-number','data-order','data-chapter-order','data-stt'];
        for (const el of [tr, ...cells]) {
          for (const key of attrs) {
            const n = plainInt(el.getAttribute(key));
            if (n != null) { number = n; numberSource = 'row_field'; break; }
          }
          if (number != null) break;
        }
        if (number == null) {
          cells.forEach(cell => {
            if (number != null) return;
            const label = cell.getAttribute('data-title') || cell.getAttribute('data-label') || cell.getAttribute('aria-label') || '';
            if (headerScore(label) >= 70) { const n = plainInt(cell.textContent); if (n != null) { number = n; numberSource = 'labeled_cell'; } }
          });
        }
        if (number == null && numberIndex != null && cells[numberIndex]) {
          const n = plainInt(cells[numberIndex].textContent);
          if (n != null) { number = n; numberSource = 'number_column'; }
        }
        let title = normSpace(edit.textContent);
        if (!title || /^(sửa|edit|cập nhật)$/i.test(title)) {
          const candidates = cells.map(c => normSpace(c.textContent)).filter(x => x && plainInt(x) == null && !/^(sửa|xóa|edit|delete|công khai|nháp)$/i.test(x));
          title = candidates.sort((a,b) => b.length-a.length)[0] || `Chương ${number ?? ''}`;
        }
        out.push({
          storyId: rowStoryId,
          chapterId: cid,
          editUrl: exactEditUrl,
          updateUrl: `/mystory/${rowStoryId}/chapters/${cid}/update`,
          deleteUrl: `/mystory/${rowStoryId}/chapters/${cid}/delete`,
          number, title, numberSource, page: pageNo, selected: false,
          note: number == null ? 'Chưa xác minh số' : numberSource,
        });
      }
    }
    const seen = new Set();
    return out.filter(x => !seen.has(`${x.storyId}:${x.chapterId}`) && seen.add(`${x.storyId}:${x.chapterId}`));
  }

  async function fetchChapterListPage(root, pageNo, expectedMinRows = 1) {
    const url = urlWithPage(root, pageNo);
    let lastError = null;
    for (let pass = 0; pass < 3; pass++) {
      try {
        const { text } = await requestText(url, {
          retries: 4,
          retryStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
          retryBaseMs: 1100,
        });
        const rows = parseChapterRows(parseHtml(text), pageNo);
        if (rows.length < expectedMinRows) {
          const err = new Error(`Trang ${pageNo} chỉ đọc được ${rows.length}/${expectedMinRows} dòng chương.`);
          err.status = 599;
          throw err;
        }
        return rows;
      } catch (err) {
        lastError = err;
        if (pass < 2) await sleep(1800 * (pass + 1) + Math.random() * 900);
      }
    }
    throw new Error(`Trang chương ${pageNo} tải thất bại sau nhiều lần thử: ${lastError?.message || lastError}`);
  }

  async function loadChapters() {
    requireStory();
    state.editCache.clear();
    const root = `/mystory/${state.storyId}/chapters`;
    const first = await requestText(root, {
      retries: 4,
      retryStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
      retryBaseMs: 1100,
    });
    const firstDoc = parseHtml(first.text);
    const expected = parseCountFromPage(firstDoc);
    const detected = extractMaxPage(firstDoc);
    const maxPages = Math.min(detected, clamp(state.cfg.maxPages, 1, 500));
    const firstRows = parseChapterRows(firstDoc, 1);
    if (!firstRows.length) throw new Error('Trang chương đầu tiên không đọc được dòng nào. Không tiếp tục để tránh danh sách thiếu.');
    const pageSize = firstRows.length;
    let all = firstRows.slice();
    const pages = Array.from({ length: Math.max(0, maxPages - 1) }, (_, i) => i + 2);
    const pageErrors = [];
    const loadedPages = new Set([1]);
    if (pages.length) {
      // Tối đa 2 luồng cho trang danh sách. Bản cũ chạy quá nhanh và im lặng bỏ
      // những trang bị nginx trả 404, nên 1618 chương chỉ còn 1268.
      const results = await mapLimit(pages, Math.min(2, state.cfg.readWorkers), async p => {
        const minRows = p < maxPages ? pageSize : 1;
        const rows = await fetchChapterListPage(root, p, minRows);
        return { ok: true, page: p, rows };
      }, (d,t,r,i) => {
        setProgress(d,t);
        setStatus(`Tải trang chương: ${d}/${t}`);
        if (r?.error) {
          const page = pages[i];
          pageErrors.push({ page, error: r.error });
          debugLog(`Không tải được trang danh sách chương ${page}`, r.error, 'error');
        }
      });
      results.forEach(r => {
        if (r?.ok && Array.isArray(r.rows)) {
          loadedPages.add(r.page);
          all.push(...r.rows);
        }
      });
    }
    if (pageErrors.length || loadedPages.size !== maxPages) {
      const missing = pages.filter(p => !loadedPages.has(p));
      throw new Error(`Danh sách chương chưa đủ: thiếu trang ${missing.join(', ') || pageErrors.map(x => x.page).join(', ')}. Script đã dừng, không dùng danh sách thiếu.`);
    }
    const byId = new Map();
    all.forEach(ch => { if (!byId.has(ch.chapterId)) byId.set(ch.chapterId, ch); });
    all = [...byId.values()];
    const maxItems = clamp(state.cfg.maxItems, 1, 20000);
    const truncatedByItems = all.length > maxItems;
    if (truncatedByItems) all = all.slice(0, maxItems);
    all.sort(chapterCompare);
    state.chapters = all;
    state.lastChapterSelectionIndex = null;
    state.chapterViewPage = 1;
    state.chapterMeta = {
      expected,
      detectedPages: detected,
      loadedPages: loadedPages.size,
      complete: loadedPages.size >= detected && !truncatedByItems,
      countMismatch: expected != null && expected !== all.length,
      truncatedByPages: maxPages < detected,
      truncatedByItems,
      pageSize,
    };
    renderChapters();
    let msg = `Đã tải ${all.length} chương / ${loadedPages.size} trang.`;
    if (state.chapterMeta.truncatedByPages || truncatedByItems) msg += ' DANH SÁCH BỊ CẮT DO GIỚI HẠN.';
    else if (state.chapterMeta.countMismatch) msg += ` Bộ đếm web ghi ${expected}; mọi trang đều đã tải đủ nên đây mới chỉ là cảnh báo bộ đếm.`;
    log(msg, state.chapterMeta.truncatedByPages || truncatedByItems ? 'warn' : 'info');
  }

  function chapterCompare(a,b) {
    const an = Number.isFinite(a.number) ? a.number : 1e9;
    const bn = Number.isFinite(b.number) ? b.number : 1e9;
    return an - bn || a.title.localeCompare(b.title, 'vi');
  }

  function chapterViewPageSize() {
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const shortTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (max-height: 600px)').matches;
    if (narrow || shortTouch) return 100;
    if (coarse) return 160;
    return 400;
  }

  function chapterViewMetrics() {
    const total = state.chapters.length;
    const pageSize = chapterViewPageSize();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    state.chapterViewPage = clamp(Math.trunc(Number(state.chapterViewPage) || 1), 1, totalPages);
    const start = total ? (state.chapterViewPage - 1) * pageSize : 0;
    const end = Math.min(total, start + pageSize);
    return { total, pageSize, totalPages, page: state.chapterViewPage, start, end };
  }

  function syncChapterPagerButtons(metrics = chapterViewMetrics()) {
    const prev = document.querySelector('[data-action="chapter-prev"]');
    const next = document.querySelector('[data-action="chapter-next"]');
    if (prev) prev.disabled = state.busy || metrics.page <= 1 || metrics.total === 0;
    if (next) next.disabled = state.busy || metrics.page >= metrics.totalPages || metrics.total === 0;
  }

  function setChapterViewPage(page) {
    const metrics = chapterViewMetrics();
    const next = clamp(Math.trunc(Number(page) || 1), 1, metrics.totalPages);
    if (next === state.chapterViewPage && document.querySelector('#tytb-chapter-body')?.children.length) return;
    state.chapterViewPage = next;
    renderChapters();
    document.querySelector('#tytb-chapter-pager')?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  function renderChapters() {
    const body = document.querySelector('#tytb-chapter-body');
    const info = document.querySelector('#tytb-chapter-info');
    const pager = document.querySelector('#tytb-chapter-pager');
    const pagerText = document.querySelector('#tytb-chapter-page-info');
    if (!body) return;

    const metrics = chapterViewMetrics();
    const visible = state.chapters.slice(metrics.start, metrics.end);
    body.innerHTML = visible.map((ch, offset) => {
      const index = metrics.start + offset;
      const retryJob = state.txtRetryJobs.get(ch.chapterId);
      const retryHtml = retryJob
        ? `<div class="tytb-retry-row"><button type="button" class="tytb-retry-btn" data-action="retry-txt-chapter" data-cid="${ch.chapterId}" title="Chỉ cập nhật lại chương ${ch.number ?? index + 1}">Retry</button><span>lần thử: ${retryJob.attempts || 0}</span></div>`
        : '';
      return `<tr data-cid="${ch.chapterId}" data-index="${index}">
        <td class="check"><input class="tytb-chk" type="checkbox" aria-label="Chọn chương ${ch.number ?? index + 1}" ${ch.selected ? 'checked' : ''}></td>
        <td class="num">${ch.number ?? ''}</td><td class="title">${escHtml(ch.title)}</td>
        <td class="note">${escHtml(ch.note || '')}${retryHtml}</td></tr>`;
    }).join('');

    const selectedCount = state.chapters.reduce((count, ch) => count + (ch.selected ? 1 : 0), 0);
    if (info) {
      const m = state.chapterMeta;
      info.textContent = m
        ? `${metrics.total} chương | đã chọn ${selectedCount} | trang nguồn ${m.loadedPages}/${m.detectedPages}${m.complete ? '' : ' | CHƯA TẢI ĐỦ'}${m.countMismatch ? ` | bộ đếm web: ${m.expected}` : ''}`
        : (metrics.total ? `${metrics.total} chương | đã chọn ${selectedCount}` : 'Chưa tải');
    }

    if (pager) pager.hidden = metrics.total <= metrics.pageSize;
    if (pagerText) {
      pagerText.textContent = metrics.total
        ? `${metrics.start + 1}–${metrics.end} / ${metrics.total} • Trang ${metrics.page}/${metrics.totalPages}`
        : '0 chương';
    }
    syncChapterPagerButtons(metrics);
  }

  function parseFormFields(doc) {
    const payload = {};
    doc.querySelectorAll('input[name], textarea[name], select[name]').forEach(el => {
      const name = el.getAttribute('name');
      if (!name || ['s','captcha'].includes(name)) return;
      if (el.tagName === 'INPUT' && ['submit','button','file','image','reset'].includes((el.type || '').toLowerCase())) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      payload[name] = el.value ?? '';
    });
    return payload;
  }

  function chapterRef(chapterOrId) {
    if (chapterOrId && typeof chapterOrId === 'object') return chapterOrId;
    const id = String(chapterOrId || '');
    return state.chapters.find(ch => ch.chapterId === id) || { storyId: state.storyId, chapterId: id };
  }

  function editCacheKey(ref) {
    return `${ref.storyId || state.storyId}:${ref.chapterId}`;
  }


  function cacheEditState(key, value) {
    state.editCache.delete(key);
    state.editCache.set(key, value);
    while (state.editCache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = state.editCache.keys().next().value;
      state.editCache.delete(oldestKey);
    }
  }

  function readCachedEditState(key) {
    const cached = state.editCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt >= CACHE_TTL) {
      state.editCache.delete(key);
      return null;
    }
    state.editCache.delete(key);
    state.editCache.set(key, cached);
    return structuredClone(cached);
  }

  function extractEditState(html, ref, sourceUrl) {
    const doc = parseHtml(html);
    const fields = parseFormFields(doc);
    const titleEl = doc.querySelector('[name="title"], input[id*="title" i]');
    const numberEl = doc.querySelector('[name="number"], [name="chapter_number"], input[id*="number" i]');
    const contentEl = doc.querySelector('textarea[name="content"], textarea[name="chapter_content"], #richeditor, .richeditor-content');
    const title = normSpace(titleEl?.value || fields.title || '');
    const number = Number(numberEl?.value || fields.number || fields.chapter_number || 0) || null;
    let content = '';
    if (contentEl) content = contentEl.tagName === 'TEXTAREA' ? contentEl.value : contentEl.innerHTML;
    if (!content && fields.content) content = fields.content;
    const pageStoryId = String(fields.story_id || doc.querySelector('[name="story_id"]')?.value || ref.storyId || state.storyId);
    if (ID_RE.test(ref.storyId || '') && ID_RE.test(pageStoryId) && pageStoryId !== ref.storyId) {
      throw new Error(`Trang sửa trả về Story ID ${pageStoryId}, không khớp ${ref.storyId}.`);
    }
    if (!title || number == null || !content) throw new Error(`Không đọc đủ title/number/content của chương ${ref.chapterId}.`);
    return {
      storyId: pageStoryId,
      chapterId: ref.chapterId,
      editUrl: sourceUrl || ref.editUrl || `/mystory/${pageStoryId}/chapters/${ref.chapterId}/edit`,
      updateUrl: ref.updateUrl || `/mystory/${pageStoryId}/chapters/${ref.chapterId}/update`,
      title, number, content,
      published: String(fields.published ?? doc.querySelector('[name="published"]')?.value ?? ''),
      fields, fetchedAt: Date.now(),
    };
  }

  async function refreshChapterRef(ref) {
    const storyId = ref.storyId || state.storyId;
    const root = `/mystory/${storyId}/chapters`;
    const page = Math.max(1, Number(ref.page) || 1);
    const { text } = await requestText(urlWithPage(root, page), {
      retries: 4,
      retryStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
      retryBaseMs: 1100,
    });
    const fresh = parseChapterRows(parseHtml(text), page).find(ch => ch.chapterId === ref.chapterId);
    if (!fresh) return null;
    Object.assign(ref, fresh);
    const current = state.chapters.find(ch => ch.chapterId === ref.chapterId);
    if (current && current !== ref) Object.assign(current, fresh);
    return ref;
  }

  async function getEditState(chapterOrId, force=false) {
    const ref = chapterRef(chapterOrId);
    if (!ID_RE.test(ref.chapterId)) throw new Error(`Chapter ID không hợp lệ: ${ref.chapterId}`);
    if (!ID_RE.test(ref.storyId || state.storyId)) throw new Error(`Story ID không hợp lệ: ${ref.storyId || state.storyId}`);
    ref.storyId = ref.storyId || state.storyId;
    const key = editCacheKey(ref);
    const cached = force ? null : readCachedEditState(key);
    if (cached) return cached;

    const makeCandidates = currentRef => {
      const canonical = `/mystory/${currentRef.storyId}/chapters/${currentRef.chapterId}/edit`;
      return [...new Set([
        currentRef.editUrl,
        canonical,
        `${canonical}/`,
      ].filter(Boolean))];
    };

    let last404 = null;
    let candidates = makeCandidates(ref);
    for (let pass = 0; pass < 2; pass++) {
      for (const url of candidates) {
        try {
          const { text, response } = await requestText(url, {
            retries: 3,
            retryStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
            retryBaseMs: 1000,
          });
          const finalPath = new URL(response.url || url, location.origin);
          const sourceUrl = `${finalPath.pathname}${finalPath.search}`;
          ref.editUrl = sourceUrl;
          const parsed = extractEditState(text, ref, sourceUrl);
          cacheEditState(key, parsed);
          return structuredClone(parsed);
        } catch (err) {
          if (err?.status === 404) { last404 = err; continue; }
          throw err;
        }
      }
      if (pass === 0) {
        const fresh = await refreshChapterRef(ref);
        if (!fresh) {
          throw new Error(`Chương ${ref.number ?? '?'} (${ref.chapterId}) không còn xuất hiện ở trang danh sách. Có thể chương đã bị xóa hoặc danh sách đang cũ. Hãy bấm “Tải danh sách chương” lại.`);
        }
        candidates = makeCandidates(fresh);
      }
    }
    throw new Error(`GET trang sửa vẫn 404 cho chương ${ref.number ?? '?'} (${ref.chapterId}). URL cuối: ${last404?.url || candidates[0]}. Hãy mở URL sửa của chương này trực tiếp trên web để kiểm tra.`);
  }

  async function preloadEditStates(chapters, status='Đang tải dữ liệu chương') {
    // GET hàng nghìn trang sửa quá nhanh khiến TYT trả 404 nginx giả. Giới hạn 2
    // luồng và để requestText tự backoff/retry trước khi kết luận URL hỏng.
    const results = await mapLimit(chapters, Math.min(2, state.cfg.readWorkers), async ch => {
      const edit = await getEditState(ch);
      return { ok: true, ch, edit };
    }, (d,t,r,i) => {
      setProgress(d,t); setStatus(`${status}: ${d}/${t}`);
      if (r?.error) {
        const ch = chapters[i];
        debugLog(`Không tải được dữ liệu chương số ${ch?.number ?? '?'}`, { chapter: ch, error: r.error }, 'error');
      }
    });
    const errors = results.filter(x => x?.ok === false || x?.error);
    if (errors.length) throw new Error(`Không tải được ${errors.length}/${chapters.length} trang sửa. Tác vụ đã dừng trước khi ghi dữ liệu.`);
    return results.map(x => x.edit);
  }

  function comparableChapterText(html) {
    return htmlToPlainText(html).replace(/\s+/g, ' ').trim();
  }

  async function verifyChapterUpdate(ref, expected, changedKeys) {
    const expectedContent = changedKeys.has('content') ? comparableChapterText(expected.content) : '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(500 * attempt);
      state.editCache.delete(editCacheKey(ref));
      const fresh = await getEditState(ref, true);
      const titleOk = !changedKeys.has('title') || fresh.title === expected.title;
      const numberOk = !changedKeys.has('number') || fresh.number === expected.number;
      const contentOk = !changedKeys.has('content') || comparableChapterText(fresh.content) === expectedContent;
      const publishedOk = !changedKeys.has('published') || String(fresh.published) === String(expected.published);
      if (titleOk && numberOk && contentOk && publishedOk) return fresh;
    }
    throw new Error(`Xác minh lại chương ${ref.number ?? '?'} không khớp dữ liệu đã gửi.`);
  }

  function mayHaveCommittedPost(error) {
    const message = String(error?.message || error || '');
    if (/HTTP\s*5\d\d/i.test(message)) return true;
    if (error?.status) return false;
    return /request bị treo|timeout|timed out|failed to fetch|networkerror|load failed|không kết nối/i.test(message);
  }

  async function updateChapter(chapterOrId, changes) {
    const ref = chapterRef(chapterOrId);
    // Không force GET ở đây. Nếu backup/preload vừa lấy edit-state thì dùng cache;
    // nếu chưa có cache, getEditState tự GET đúng một lần.
    const edit = await getEditState(ref);
    const next = { ...edit, ...changes };
    next.title = normSpace(next.title);
    next.number = Number(next.number);
    next.content = String(next.content || '').trim() || BLANK_P;
    if (!next.title || next.title.length > 200) throw new Error('Tiêu đề rỗng hoặc dài quá 200 ký tự.');
    if (!Number.isInteger(next.number) || next.number < 1 || next.number > MAX_CHAPTER_NUMBER) throw new Error(`Số chương không hợp lệ: ${next.number}`);

    const changedKeys = new Set(Object.keys(changes || {}));
    const payload = { ...edit.fields, title: next.title, number: String(next.number), content: next.content };
    if (next.published !== '') payload.published = String(next.published);
    const updateUrl = edit.updateUrl || ref.updateUrl || `/mystory/${edit.storyId}/chapters/${ref.chapterId}/update`;

    let res;
    try {
      res = await postForm(updateUrl, payload, edit.editUrl);
    } catch (postError) {
      // POST không được retry tự động để tránh ghi trùng. Nếu lỗi mạng/timeout/5xx
      // có thể xảy ra sau khi server đã commit, GET xác minh trước khi báo thất bại.
      if (!mayHaveCommittedPost(postError)) throw postError;
      try {
        const fresh = await verifyChapterUpdate(ref, next, changedKeys);
        Object.assign(ref, { title: fresh.title, number: fresh.number });
        cacheEditState(editCacheKey(ref), fresh);
        debugLog(`POST chương ${ref.number ?? '?'} mất phản hồi nhưng dữ liệu trên server đã đúng.`, postError, 'warn');
        return { ok: true, recovered: true, message: 'Dữ liệu đã được ghi dù phản hồi POST bị gián đoạn.' };
      } catch (verifyError) {
        debugLog(`POST chương ${ref.number ?? '?'} lỗi và dữ liệu chưa xác minh được.`, { postError, verifyError }, 'error');
        throw postError;
      }
    }

    const fresh = await verifyChapterUpdate(ref, next, changedKeys);
    Object.assign(ref, { title: fresh.title, number: fresh.number });
    cacheEditState(editCacheKey(ref), fresh);
    return res;
  }

  function titleTail(oldTitle) {
    const s = normSpace(oldTitle);
    const m = s.match(/^\s*(?:chương|chapter|chap)?\s*\d{1,6}\s*[:：.\-–—)]*\s*(.*?)\s*$/i);
    return normSpace(m ? m[1] : s);
  }

  function formatTitle(template, num, old) {
    return String(template || '').replaceAll('{num}', String(num)).replaceAll('{old}', old).replaceAll('{tail}', titleTail(old)).replace(/:\s*$/,'').trim();
  }


  async function backupChoiceModal(actionName, count) {
    return choiceModal(
      'Sao lưu trước khi thao tác',
      `Bạn có muốn sao lưu ${count} chương trước khi ${actionName} không?\n\nSao lưu giúp khôi phục nội dung nếu thao tác nhầm. Bỏ qua sao lưu nghĩa là script sẽ không tạo file dự phòng.`,
      [
        { value: 'cancel', text: 'Hủy', className: '' },
        { value: 'skip', text: 'Bỏ qua sao lưu', className: 'warn' },
        { value: 'backup', text: 'Sao lưu rồi tiếp tục', className: 'primary' },
      ],
    );
  }

  async function createChapterBackup(rows, actionName) {
    const sorted = rows.slice().sort(chapterCompare);
    const results = await mapLimit(sorted, Math.min(2, state.cfg.readWorkers), async ch => {
      const edit = await getEditState(ch, true);
      return {
        ok: true,
        storyId: edit.storyId,
        chapterId: edit.chapterId,
        number: edit.number,
        title: edit.title,
        published: edit.published,
        contentHtml: edit.content,
        contentText: htmlToPlainText(edit.content),
      };
    }, (done, total, result) => {
      setProgress(done, total);
      setStatus(`Sao lưu: ${done}/${total}`);
      if (result?.error) debugLog('Sao lưu chương không thành công', result.error, 'error');
    });
    const failed = results.filter(item => item?.error || !item?.ok);
    if (failed.length) throw new Error(`Sao lưu thất bại ${failed.length}/${rows.length} chương. Tác vụ đã dừng.`);
    const payload = {
      format: 'TYT Bulk Manager Backup',
      version: VERSION,
      action: actionName,
      createdAt: new Date().toISOString(),
      storyId: state.storyId,
      storyTitle: state.storyTitle,
      chapters: results,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${safeName(state.storyTitle)}_${safeName(actionName)}_${stamp}.json`;
    saveBlob(new Blob(['\uFEFF', JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), filename);
    log(`Đã tạo bản sao lưu ${results.length} chương.`, 'success');
  }

  async function prepareBackup(rows, actionName) {
    const choice = await backupChoiceModal(actionName, rows.length);
    if (choice === 'cancel') return false;
    if (choice === 'backup') await createChapterBackup(rows, actionName);
    else log(`Đã bỏ qua sao lưu trước khi ${actionName}.`, 'warn');
    return true;
  }

  async function deleteChapters() {
    requireStory();
    const rows = selectedChapters();
    if (!rows.length) throw new Error('Chưa chọn chương để xóa.');
    const preview = rows.slice(0, 50).map(ch => `${ch.number ?? '?'} — ${ch.title}`).join('\n');
    const ok = await confirmModal('Xóa chương', `Sẽ XÓA VĨNH VIỄN ${rows.length} chương:\n\n${preview}${rows.length > 50 ? '\n...' : ''}\n\nKhông thể hoàn tác.`, 'XÓA VĨNH VIỄN');
    if (!ok) return;
    if (!await prepareBackup(rows, 'xóa chương')) return;
    const successes = new Set();
    const results = await mapLimit(rows, state.cfg.deleteWorkers, async ch => {
      await postForm(ch.deleteUrl || `/mystory/${ch.storyId || state.storyId}/chapters/${ch.chapterId}/delete`, { captcha: 'delete' }, ch.editUrl || `/mystory/${ch.storyId || state.storyId}/chapters/${ch.chapterId}/edit`);
      successes.add(ch.chapterId);
      state.editCache.delete(editCacheKey(ch));
      return { ok: true, ch };
    }, (d,t,r) => {
      setProgress(d,t); setStatus(`Đang xóa: ${d}/${t}`);
      if (r?.error) debugLog('Xóa chương không thành công', r.error, 'error');
    });
    state.chapters = state.chapters.filter(ch => !successes.has(ch.chapterId));
    renderChapters();
    const failed = results.filter(r => r?.error).length;
    if (failed) throw new Error(`Đã xóa ${successes.size}, lỗi ${failed}. Tải lại danh sách trước khi thao tác tiếp.`);
  }

  async function renameChapters() {
    requireStory();
    const rows = targetChapters().filter(ch => ch.number != null);
    if (!rows.length) throw new Error('Không có chương phù hợp để đổi tên.');
    const template = document.querySelector('#tytb-rename-template').value.trim();
    if (!template) throw new Error('Mẫu tên rỗng.');
    state.cfg.renameTemplate = template; saveConfig();
    const plans = rows.map(ch => ({ ch, title: formatTitle(template, ch.number, ch.title) })).filter(x => x.title && x.title !== x.ch.title);
    if (!plans.length) { log('Tất cả chương đã đúng mẫu, không cần cập nhật.'); return; }
    const preview = plans.slice(0, 80).map(x => `${x.ch.number}: ${x.ch.title}\n   → ${x.title}`).join('\n');
    if (!await confirmModal('Đổi tên chương', `${plans.length} chương sẽ đổi tên:\n\n${preview}${plans.length > 80 ? '\n...' : ''}`, 'ĐỔI TÊN')) return;
    if (!await prepareBackup(plans.map(x => x.ch), 'đổi tên chương')) return;
    await preloadEditStates(plans.map(x => x.ch), 'Chuẩn bị đổi tên');
    let okCount = 0;
    const results = await mapLimit(plans, state.cfg.writeWorkers, async p => {
      await updateChapter(p.ch, { title: p.title });
      p.ch.title = p.title; p.ch.note = 'Đã đổi tên'; okCount++;
      return { ok: true, p };
    }, (d,t,r) => {
      setProgress(d,t); setStatus(`Đổi tên: ${d}/${t}`);
      if (r?.error) debugLog('Đổi tên chương không thành công', r.error, 'error');
    });
    renderChapters();
    const failed = results.filter(r => r?.error).length;
    if (failed) throw new Error(`Đổi tên thành công ${okCount}, lỗi ${failed}.`);
  }

  function validateRenumberPlans(rows, start) {
    const sorted = rows.slice().sort(chapterCompare);
    const nums = sorted.map(ch => ch.number);
    if (nums.some(n => !Number.isInteger(n))) throw new Error('Có chương chưa xác minh được số.');
    if (new Set(nums).size !== nums.length) throw new Error('Danh sách hiện tại có số chương trùng; không thể đánh số an toàn.');
    const plans = sorted.map((ch, i) => ({ ch, old: ch.number, target: start + i })).filter(p => p.old !== p.target);
    if (plans.some(p => p.target > MAX_CHAPTER_NUMBER)) throw new Error('Kết quả vượt quá 9999.');
    const selectedIds = new Set(rows.map(ch => ch.chapterId));
    const unselectedNums = new Set(state.chapters.filter(ch => !selectedIds.has(ch.chapterId) && Number.isInteger(ch.number)).map(ch => ch.number));
    const conflicts = plans.filter(p => unselectedNums.has(p.target));
    if (conflicts.length) throw new Error(`Số đích xung đột với chương không nằm trong phạm vi: ${[...new Set(conflicts.map(x => x.target))].slice(0,30).join(', ')}`);
    return plans;
  }

  async function renumberChapters() {
    requireStory();
    if (state.chapterMeta && (state.chapterMeta.truncatedByPages || state.chapterMeta.truncatedByItems) && !state.cfg.selectedOnly) {
      throw new Error('Danh sách bị cắt bởi giới hạn trang/chương. Hãy tải đủ trước khi đánh số toàn bộ. Chênh lệch với bộ đếm web sau khi xóa chương không bị coi là thiếu.');
    }
    const rows = targetChapters();
    if (!rows.length) throw new Error('Không có chương để đánh số.');
    const start = clamp(Number(document.querySelector('#tytb-renumber-start').value), 1, MAX_CHAPTER_NUMBER);
    state.cfg.renumberStart = start; saveConfig();
    const plans = validateRenumberPlans(rows, start);
    if (!plans.length) { log('Tất cả chương đã đúng số, không cần cập nhật.'); return; }
    const preview = plans.slice(0, 100).map(p => `${p.old} → ${p.target} | ${p.ch.title}`).join('\n');
    if (!await confirmModal('Đánh số lại', `${plans.length} chương sẽ đổi số. Script dùng thuật toán phụ thuộc an toàn, không tạo số trùng tạm thời.\n\n${preview}${plans.length > 100 ? '\n...' : ''}`, 'ĐÁNH SỐ LẠI')) return;
    if (!await prepareBackup(plans.map(p => p.ch), 'đánh số lại')) return;
    await preloadEditStates(plans.map(p => p.ch), 'Chuẩn bị đánh số');

    const occupied = new Set(state.chapters.filter(ch => Number.isInteger(ch.number)).map(ch => ch.number));
    const remaining = new Map(plans.map(p => [p.ch.chapterId, { ...p, current: p.old }]));
    let done = 0;
    while (remaining.size) {
      if (state.cancelled) throw new Error('Đã hủy.');
      const sourceNums = new Set([...remaining.values()].map(p => p.current));
      let ready = [...remaining.values()].filter(p => !sourceNums.has(p.target));
      if (!ready.length) {
        const temp = findTempNumber(occupied, new Set([...remaining.values()].map(p => p.target)));
        if (temp == null) throw new Error('Không còn số tạm an toàn dưới 9999 để phá vòng phụ thuộc.');
        const p = [...remaining.values()][0];
        await updateChapter(p.ch, { number: temp });
        occupied.delete(p.current); occupied.add(temp); p.current = temp;
        p.ch.number = temp; p.ch.note = `Số tạm ${temp}`;
        debugLog(`Dùng số tạm ${temp} khi đánh số lại`, p.ch);
        continue;
      }
      ready.sort((a,b) => a.target - b.target);
      // Với chuỗi dồn số, chỉ có một bước thực sự độc lập. Chạy tuần tự để không tạo trùng.
      const p = ready[0];
      await updateChapter(p.ch, { number: p.target });
      occupied.delete(p.current); occupied.add(p.target);
      p.ch.number = p.target; p.ch.note = 'Đã đánh số';
      remaining.delete(p.ch.chapterId);
      done++; setProgress(done, plans.length); setStatus(`Đánh số lại: ${done}/${plans.length}`);
    }
    state.chapters.sort(chapterCompare);
    renderChapters();
  }

  function findTempNumber(occupied, targets) {
    for (let n = MAX_CHAPTER_NUMBER; n >= 1; n--) if (!occupied.has(n) && !targets.has(n)) return n;
    return null;
  }

  function parseNewMultiSchema(doc) {
    const storyId = doc.querySelector('[name="story_id"]')?.value || '';
    const suggested = Number(doc.querySelector('[name="number_from"]')?.value || 0) || null;
    const text = normSpace(doc.body.textContent);
    const maxM = Number((text.match(/Số\s*chương\s*thêm\s*tối\s*đa\s*[:：]?\s*(\d+)/i) || [])[1]) || MAX_MULTI;
    if (!doc.documentElement.innerHTML.includes('chapters/add_multi')) throw new Error('Trang new_multi không còn endpoint add_multi.');
    return { storyId, suggested, maxBatch: Math.min(MAX_MULTI, Math.max(1, maxM)) };
  }

  function filenameNumber(name) {
    const stem = String(name || '').replace(/\.[^.]+$/, '');
    const patterns = [/^(?:chương|chapter|chap)?\s*([0-9]{1,6})(?:\D|$)/i, /(?:^|\D)([0-9]{1,6})(?:\D|$)/];
    for (const rx of patterns) { const m = stem.match(rx); if (m) return Number(m[1]); }
    return null;
  }

  function headingInfo(text) {
    const normalized = normSpace(text);
    let m = normalized.match(CHAPTER_HEADING_RE);
    if (m) return { number: Number(m[1]), tail: normSpace(m[2] || '') };
    m = normalized.match(CN_HEADING_RE);
    if (m) return { number: Number(m[1]), tail: normSpace(m[2] || '') };
    return null;
  }

  function deriveFileTail(fileName) {
    const stem = String(fileName).replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
    const m = stem.match(/^\s*(?:chương|chapter|chap)?\s*\d{1,6}\s*[:\-–—.)]*\s*(.*?)\s*$/i);
    const tail = normSpace(m ? m[1] : stem);
    return /^\d+$/.test(tail) ? '' : tail;
  }

  function isTxtFile(file) {
    return /\.txt$/i.test(String(file?.name || '')) || /^text\//i.test(String(file?.type || ''));
  }

  async function readTxt(file, onStage = null) {
    const report = (pct, text) => { if (onStage) onStage(clamp(pct, 0, 100), text); };
    report(5, 'đang đọc TXT');
    let text;
    try { text = await file.text(); }
    catch (err) { throw new Error(`${file.name}: không đọc được TXT (${err?.message || err}).`); }
    if (state.cancelled) throw new Error('Đã hủy.');
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    report(100, `đã đọc ${text.length.toLocaleString('vi-VN')} ký tự`);
    return text;
  }

  function txtHeadingInfo(line) {
    let text = String(line || '').replace(/^\uFEFF/, '').trim();
    if (!text) return null;
    if (/^={3,}/.test(text) && /={3,}$/.test(text)) {
      text = text.replace(/^={3,}\s*/, '').replace(/\s*={3,}$/, '').trim();
    }
    if (!/^(?:(?:chương|chapter|chap)\s*[0-9]{1,6}\b|第\s*[0-9]{1,6}\s*章)/i.test(text)) return null;
    return headingInfo(text);
  }

  function plainTextToHtml(text) {
    const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return BLANK_P;

    const hasBlankLine = /\n\s*\n+/.test(normalized);
    let blocks = [];

    if (hasBlankLine) {
      blocks = normalized
        .split(/\n\s*\n+/)
        .map(block => block.trim())
        .filter(Boolean);
    } else {
      const nonEmptyLines = normalized
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      blocks = nonEmptyLines.length > 1 ? nonEmptyLines : [normalized];
    }

    return blocks
      .map(block => `<p>${escHtml(block).replace(/\n/g, '<br>')}</p>`)
      .join('') || BLANK_P;
  }

  function htmlToPlainText(html) {
    const doc = parseHtml(`<body>${html || ''}</body>`);
    const blockTags = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','PRE','TR']);
    const parts = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        parts.push('\n');
        return;
      }
      node.childNodes.forEach(walk);
      if (blockTags.has(node.tagName)) parts.push('\n\n');
    }
    walk(doc.body);
    return parts.join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function makeVirtualChapterFile(sourceFile, chapter) {
    const bodyText = htmlToPlainText(chapter.content || '');
    const txt = `${chapter.title}\n\n${bodyText}\n`;
    const virtualFile = new File([txt], `${chapter.number}.txt`, {
      type: 'text/plain;charset=utf-8',
      lastModified: sourceFile.lastModified || Date.now(),
    });
    Object.defineProperties(virtualFile, {
      __tytbChapterNumber: { value: chapter.number, enumerable: false },
      __tytbSourceName: { value: sourceFile.name, enumerable: false },
      __tytbVirtualChapter: { value: true, enumerable: false },
    });
    return virtualFile;
  }

  async function expandTxtForUpload(file, onStage = null) {
    const parsed = await parseTxtBundle(file, onStage);
    if (!parsed.headingCount) return [file];
    const empty = parsed.chapters.filter(ch => ch.visibleChars < 1);
    if (empty.length) throw new Error(`${file.name}: có ${empty.length} chương rỗng.`);
    return parsed.chapters.map(ch => makeVirtualChapterFile(file, ch));
  }

  async function prepareSingleTxt(file, assignedNumber) {
    const text = await readTxt(file, (pct, stage) => setStatus(`Đọc ${file.name}: ${stage} (${pct}%)`));
    const lines = text.split('\n');
    const headingIndexes = [];
    for (let i = 0; i < lines.length; i++) if (txtHeadingInfo(lines[i])) headingIndexes.push(i);
    if (headingIndexes.length > 1) throw new Error(`${file.name}: chưa được tách thành từng chương trong hàng chờ.`);
    const first = lines.findIndex(line => line.trim());
    const info = first >= 0 ? txtHeadingInfo(lines[first]) : null;
    const titleTailText = info?.tail || deriveFileTail(file.name);
    if (info && first >= 0) lines.splice(first, 1);
    const contentText = lines.join('\n').trim();
    const title = `Chương ${assignedNumber}${titleTailText ? `: ${titleTailText}` : ''}`.slice(0, 200);
    const content = plainTextToHtml(contentText);
    return {
      file,
      number: assignedNumber,
      title,
      content,
      multiHtml: `<p>${escHtml(title)}</p>${content}`,
      visibleChars: normSpace(contentText).length,
    };
  }

  function validateUploadNumbers(numbers) {
    if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > MAX_CHAPTER_NUMBER)) throw new Error('Có số chương không hợp lệ hoặc vượt 9999.');
    if (new Set(numbers).size !== numbers.length) throw new Error('Hàng chờ có số chương trùng.');
    const sorted = numbers.slice().sort((a,b) => a-b);
    const gaps = [];
    for (let i=1;i<sorted.length;i++) if (sorted[i] !== sorted[i-1] + 1) gaps.push(`${sorted[i-1]}→${sorted[i]}`);
    if (gaps.length) throw new Error(`Dãy số chương không liên tục: ${gaps.slice(0,20).join(', ')}`);
  }

  async function uploadFiles(allMode) {
    requireStory();
    if (!state.files.length) throw new Error('Hàng chờ rỗng.');
    if (state.files.some(file => !isTxtFile(file))) throw new Error('Hàng chờ chỉ được chứa file TXT.');
    const newMulti = parseHtml((await requestText(`/mystory/${state.storyId}/chapters/new_multi`)).text);
    const schema = parseNewMultiSchema(newMulti);
    if (schema.storyId && schema.storyId !== state.storyId) throw new Error('Story ID của trang new_multi không khớp.');
    let start = clamp(Number(document.querySelector('#tytb-upload-start').value), 1, MAX_CHAPTER_NUMBER);
    const parseName = document.querySelector('#tytb-parse-number').checked;
    const single = document.querySelector('#tytb-single-upload').checked;
    const published = document.querySelector('#tytb-published').value;
    Object.assign(state.cfg, { parseNumberFromFilename: parseName, singleUpload: single, published }); saveConfig();
    const filesToProcess = allMode ? state.files.slice() : state.files.slice(0, schema.maxBatch);
    const assigned = filesToProcess.map((f, i) => {
      const embedded = Number(f.__tytbChapterNumber);
      if (Number.isInteger(embedded)) return embedded;
      return parseName ? filenameNumber(f.name) : start + i;
    });
    if (assigned.some(n => n == null)) throw new Error('Không lấy được số chương từ một hoặc nhiều tên file.');
    validateUploadNumbers(assigned);
    const preparedResults = await mapLimit(filesToProcess, Math.min(state.cfg.readWorkers, 4), async (file, i) => prepareSingleTxt(file, assigned[i]), (d,t) => { setProgress(d,t); setStatus(`Đọc file: ${d}/${t}`); });
    const prepared = preparedResults.map(r => {
      if (r?.error) throw r.error;
      return r;
    }).sort((a,b) => a.number-b.number);
    const short = prepared.filter(x => x.visibleChars < 1);
    if (short.length) throw new Error(`${short.length} chương không có nội dung.`);
    const preview = prepared.slice(0,100).map(x => `${x.number} — ${x.title} — ${x.file.name}`).join('\n');
    if (!await confirmModal('Đăng chương', `${prepared.length} chương sẽ đăng ở chế độ ${single ? 'TỪNG CHƯƠNG' : 'theo nhóm tối đa 10 chương'}; hiển thị: ${published === '1' ? 'Công khai' : 'Chỉ mình tôi'}.\n\n${preview}`, 'ĐĂNG')) return;

    const successFiles = new Set();
    if (single) {
      const results = await mapLimit(prepared, 1, async item => {
        await postForm(`/mystory/${state.storyId}/chapters/add`, { title: item.title, number: item.number, content: item.content, published }, `/mystory/${state.storyId}/chapters/new`);
        successFiles.add(item.file);
        return { ok: true, item };
      }, (d,t,r) => { setProgress(d,t); setStatus(`Đăng từng chương: ${d}/${t}`); if (r?.error) debugLog('Đăng chương không thành công', r.error, 'error'); });
      const failed = results.filter(r => r?.error).length;
      state.files = state.files.filter(f => !successFiles.has(f)); renderQueue();
      if (failed) throw new Error(`Đăng thành công ${successFiles.size} chương, lỗi ${failed} chương.`);
    } else {
      let done = 0;
      for (let offset=0; offset<prepared.length; offset += schema.maxBatch) {
        const batch = prepared.slice(offset, offset + schema.maxBatch);
        const nums = batch.map(x => x.number);
        validateUploadNumbers(nums);
        const content = batch.map(x => x.multiHtml).join(BLANK_P);
        await postForm(`/mystory/${state.storyId}/chapters/add_multi`, {
          story_id: state.storyId,
          number_from: Math.min(...nums),
          number_to: Math.max(...nums),
          chapter_content: content,
          published,
        }, `/mystory/${state.storyId}/chapters/new_multi`);
        batch.forEach(x => successFiles.add(x.file));
        done += batch.length; setProgress(done, prepared.length); setStatus(`Đăng theo nhóm: ${done}/${prepared.length}`);
      }
      state.files = state.files.filter(f => !successFiles.has(f)); renderQueue();
    }
    const nextStart = Math.max(...assigned) + 1;
    document.querySelector('#tytb-upload-start').value = String(Math.min(nextStart, MAX_CHAPTER_NUMBER));
  }

  async function parseTxtBundle(file, onStage = null) {
    const text = await readTxt(file, onStage);
    const lines = text.split('\n');
    const chapters = [];
    let current = null;
    const ignoredLines = [];
    let headingCount = 0;
    const flush = () => {
      if (!current) return;
      const bodyText = current.lines.join('\n').trim();
      current.content = plainTextToHtml(bodyText);
      current.visibleChars = normSpace(bodyText).length;
      delete current.lines;
      chapters.push(current);
      current = null;
    };
    for (const line of lines) {
      const h = txtHeadingInfo(line);
      if (h) {
        headingCount++;
        flush();
        current = {
          number: h.number,
          title: `Chương ${h.number}${h.tail ? `: ${h.tail}` : ''}`.slice(0, 200),
          lines: [],
        };
      } else if (current) {
        current.lines.push(line);
      } else if (line.trim()) {
        ignoredLines.push(line);
      }
    }
    flush();
    if (!chapters.length) {
      const num = filenameNumber(file.name);
      if (num == null) throw new Error(`${file.name}: không thấy tiêu đề “Chương X” và tên file không có số.`);
      const tail = deriveFileTail(file.name);
      chapters.push({
        number: num,
        title: `Chương ${num}${tail ? `: ${tail}` : ''}`.slice(0, 200),
        content: plainTextToHtml(text),
        visibleChars: normSpace(text).length,
      });
    }
    return { chapters, ignored: ignoredLines.length, ignoredLines, headingCount };
  }

  function setTxtRetryJob(plan, sourceLabel, error) {
    const chapterId = plan?.ch?.chapterId;
    if (!chapterId) return;
    const previous = state.txtRetryJobs.get(chapterId);
    state.txtRetryJobs.set(chapterId, {
      storyId: plan.ch.storyId || state.storyId,
      chapterId,
      number: plan.ch.number,
      title: plan.title,
      content: plan.content,
      sourceLabel,
      attempts: previous?.attempts || 0,
      lastError: friendlyError(error),
      updatedAt: Date.now(),
    });
  }

  function clearTxtRetryJob(chapterId) {
    if (chapterId) state.txtRetryJobs.delete(chapterId);
  }

  async function retryTxtChapter(chapterId) {
    const job = state.txtRetryJobs.get(String(chapterId || ''));
    if (!job) throw new Error('Không còn dữ liệu retry cho chương này.');
    if (job.storyId !== state.storyId) {
      throw new Error('Dữ liệu retry thuộc truyện khác. Hãy chọn đúng truyện và cập nhật lại TXT.');
    }

    const ref = state.chapters.find(ch => ch.chapterId === job.chapterId) || {
      storyId: job.storyId,
      chapterId: job.chapterId,
      number: job.number,
      title: job.title,
    };

    job.attempts = (job.attempts || 0) + 1;
    job.updatedAt = Date.now();
    try {
      await updateChapter(ref, { title: job.title, content: job.content });
      ref.title = job.title;
      ref.note = `Đã cập nhật ${job.sourceLabel} sau Retry #${job.attempts}`;
      clearTxtRetryJob(job.chapterId);
      renderChapters();
      log(`Retry chương ${ref.number ?? job.number ?? '?'} thành công.`, 'success');
      return { ok: true };
    } catch (error) {
      job.lastError = friendlyError(error);
      job.updatedAt = Date.now();
      ref.note = `Lỗi cập nhật ${job.sourceLabel}: ${job.lastError}`;
      state.txtRetryJobs.set(job.chapterId, job);
      renderChapters();
      log(`Retry chương ${ref.number ?? job.number ?? '?'} không thành công: ${job.lastError}`, 'error');
      throw error;
    }
  }

  async function applyParsedChapterUpdates(parsed, sourceLabel) {
    const grouped = new Map();
    parsed.forEach(ch => {
      if (!grouped.has(ch.number)) grouped.set(ch.number, []);
      grouped.get(ch.number).push(ch);
    });
    const duplicates = [...grouped].filter(([, value]) => value.length > 1);
    if (duplicates.length) throw new Error(`${sourceLabel} có số chương trùng: ${duplicates.slice(0, 30).map(([n]) => n).join(', ')}`);

    const webByNumber = new Map();
    state.chapters.forEach(ch => {
      if (!Number.isInteger(ch.number)) return;
      if (!webByNumber.has(ch.number)) webByNumber.set(ch.number, []);
      webByNumber.get(ch.number).push(ch);
    });
    const ambiguous = [...webByNumber].filter(([, value]) => value.length > 1).map(([n]) => n);
    if (ambiguous.length) throw new Error(`Danh sách web có số chương trùng: ${ambiguous.slice(0, 30).join(', ')}`);

    const plans = [];
    const missing = [];
    for (const [num, arr] of grouped) {
      const web = webByNumber.get(num)?.[0];
      if (!web) { missing.push(num); continue; }
      const src = arr[0];
      if (src.visibleChars < 1) throw new Error(`Chương ${num} trong ${sourceLabel} rỗng.`);
      plans.push({ ch: web, title: src.title, content: src.content, visibleChars: src.visibleChars });
    }
    if (!plans.length) throw new Error(`Không có số chương nào trong ${sourceLabel} khớp danh sách web.`);

    const preview = plans.slice(0, 100)
      .map(p => `${p.ch.number}: ${p.ch.title}\n   → ${p.title} | ${p.visibleChars} ký tự`)
      .join('\n');
    const missText = missing.length
      ? `\n\nKhông tìm thấy trên web: ${missing.slice(0, 50).join(', ')}${missing.length > 50 ? '...' : ''}`
      : '';
    if (!await confirmModal(`Cập nhật nội dung từ ${sourceLabel}`, `${plans.length} chương sẽ cập nhật theo SỐ CHƯƠNG, không theo vị trí.\n\n${preview}${missText}`, 'CẬP NHẬT')) return;

    if (!await prepareBackup(plans.map(p => p.ch), `cập nhật nội dung từ ${sourceLabel}`)) return;

    // Không preload fail-fast cho TXT. Mỗi chương tự GET/POST/verify độc lập:
    // một chương lỗi không chặn các chương còn lại và payload lỗi được giữ để Retry riêng.
    setProgress(25, 100);
    let okCount = 0;
    const results = await mapLimit(plans, state.cfg.writeWorkers, async p => {
      try {
        await updateChapter(p.ch, { title: p.title, content: p.content });
        p.ch.title = p.title;
        p.ch.note = `Đã cập nhật ${sourceLabel}`;
        clearTxtRetryJob(p.ch.chapterId);
        okCount++;
        return { ok: true, p };
      } catch (error) {
        setTxtRetryJob(p, sourceLabel, error);
        throw error;
      }
    }, (done, total, result, index) => {
      setProgress(25 + Math.round(done * 75 / total), 100);
      setStatus(`Cập nhật ${sourceLabel}: ${done}/${total}`);
      if (result?.error) {
        const failedPlan = plans[index];
        const chapterNumber = failedPlan?.ch?.number ?? '?';
        const chapterTitle = failedPlan?.title || failedPlan?.ch?.title || '';
        const reason = friendlyError(result.error);
        if (failedPlan?.ch) failedPlan.ch.note = `Lỗi cập nhật ${sourceLabel}: ${reason}`;
        log(`Chương ${chapterNumber}${chapterTitle ? ` — ${chapterTitle}` : ''}: ${reason}`, 'error');
        debugLog(`Cập nhật ${sourceLabel} không thành công ở chương ${chapterNumber}`, {
          chapterNumber,
          chapterTitle,
          error: result.error,
        }, 'error');
      }
    });

    renderChapters();
    const failures = results
      .map((result, index) => result?.error ? { plan: plans[index], error: result.error } : null)
      .filter(Boolean);

    if (failures.length) {
      const detail = failures.slice(0, 20).map(({ plan, error }) => {
        const number = plan?.ch?.number ?? '?';
        const title = plan?.title || plan?.ch?.title || '';
        return `Chương ${number}${title ? ` — ${title}` : ''}: ${friendlyError(error)}`;
      }).join('; ');
      const more = failures.length > 20 ? `; và ${failures.length - 20} chương lỗi khác (xem nhật ký)` : '';
      throw new Error(`Cập nhật thành công ${okCount} chương, lỗi ${failures.length} chương. Các chương lỗi có nút Retry riêng trong bảng. ${detail}${more}`);
    }
  }

  async function updateFromTxt(files) {
    requireStory();
    if (!state.chapters.length) throw new Error('Hãy tải danh sách chương trước.');
    const parsed = [];
    let ignoredLines = 0;
    let filesWithIgnoredLines = 0;
    const ignoredPreviews = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const bundle = await parseTxtBundle(file, (pct, stage) => {
        const overall = Math.round(((i + pct / 100) / files.length) * 25);
        setProgress(overall, 100);
        setStatus(`Đọc TXT ${i + 1}/${files.length}: ${stage}`);
      });
      parsed.push(...bundle.chapters);
      if (bundle.ignored) {
        ignoredLines += bundle.ignored;
        filesWithIgnoredLines++;
        ignoredPreviews.push(`${file.name}:\n${bundle.ignoredLines.slice(0, 12).join('\n')}${bundle.ignoredLines.length > 12 ? '\n...' : ''}`);
        debugLog(`${file.name}: phát hiện ${bundle.ignored} dòng ngoài phần chương.`);
      }
      await yieldBrowser();
    }
    if (ignoredLines) {
      const proceed = await confirmModal(
        'Phát hiện nội dung trước tiêu đề chương',
        `Có ${ignoredLines} dòng trong ${filesWithIgnoredLines} file nằm trước tiêu đề “Chương X”.\n\n${ignoredPreviews.join('\n\n')}\n\nChỉ tiếp tục khi bạn xác nhận bỏ qua các dòng này.`,
        'BỎ QUA VÀ TIẾP TỤC',
      );
      if (!proceed) return;
      log(`Đã bỏ qua ${ignoredLines} dòng trước tiêu đề chương theo xác nhận của người dùng.`, 'warn');
    }
    return applyParsedChapterUpdates(parsed, 'TXT');
  }

  async function buildTxt(chapters, onStage = null) {
    const report = (pct, text) => { if (onStage) onStage(clamp(pct, 0, 100), text); };
    const parts = ['\uFEFF'];
    for (let idx = 0; idx < chapters.length; idx++) {
      if (state.cancelled) throw new Error('Đã hủy.');
      const ch = chapters[idx];
      const title = ch.title || `Chương ${ch.number || idx + 1}`;
      const content = htmlToPlainText(ch.content);
      parts.push(`${title}\r\n\r\n${content}\r\n\r\n`);
      if (idx % 50 === 0 || idx === chapters.length - 1) {
        report(Math.round(((idx + 1) / chapters.length) * 100), `đang tạo TXT ${idx + 1}/${chapters.length}`);
        await yieldBrowser();
      }
    }
    return new Blob(parts, { type: 'text/plain;charset=utf-8' });
  }

  async function downloadTxt() {
    requireStory();
    const rows = targetChapters().slice().sort(chapterCompare);
    if (!rows.length) throw new Error('Không có chương để tải.');
    const preview = rows.slice(0, 80).map(ch => `${ch.number ?? '?'} — ${ch.title}`).join('\n');
    if (!await confirmModal('Tải nội dung TXT', `Sẽ tải và gộp ${rows.length} chương, theo số tăng dần. TXT được tạo trực tiếp, không có bước nén.\n\n${preview}${rows.length > 80 ? '\n...' : ''}`, 'TẢI TXT')) return;
    const fetched = [];
    const results = await mapLimit(rows, state.cfg.readWorkers, async ch => {
      const edit = await getEditState(ch);
      return { ok: true, chapterId: ch.chapterId, number: edit.number, title: edit.title, content: edit.content };
    }, (done, total, result) => {
      setProgress(Math.round(done * 90 / total), 100);
      setStatus(`Tải nội dung: ${done}/${total}`);
      if (result?.error) debugLog('Tải nội dung chương không thành công', result.error, 'error');
    });
    results.forEach(result => { if (result?.ok) fetched.push(result); });
    if (!fetched.length) throw new Error('Không tải được chương nào.');
    fetched.sort((a, b) => (a.number || 1e9) - (b.number || 1e9));
    const blob = await buildTxt(fetched, (pct, stage) => {
      setProgress(90 + Math.round(pct * 0.10), 100);
      setStatus(stage);
    });
    const first = fetched[0].number ?? 1;
    const last = fetched.at(-1).number ?? fetched.length;
    saveBlob(blob, `${safeName(state.storyTitle)}_${first}-${last}.txt`);
    setProgress(100, 100);
    setStatus('Đã tạo TXT');
    if (fetched.length !== rows.length) throw new Error(`Đã tạo TXT với ${fetched.length}/${rows.length} chương; có chương tải lỗi.`);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function normalizeKey(s) {
    // NFD không tự chuyển chữ Đ/đ thành D/d. Đây là lý do bản 1.0 không nhận ra
    // các nhãn “Đang Có”, “Đang Rút”, “Đã Thanh Toán”, “Đã Chuyển”.
    return normSpace(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[Đđ]/g, 'd')
      .toLowerCase();
  }

  function parseEarningCards(doc) {
    const out = {};
    const labels = new Map([
      ['dang co','dang_co'], ['dang rut','dang_rut'], ['da thanh toan','da_thanh_toan'],
      ['da chuyen','da_chuyen'], ['tong','tong'], ['boi quang cao','boi_quang_cao'],
      ['boi de cu','boi_de_cu'], ['boi qua tang','boi_qua_tang'],
    ]);
    const moneyRe = /-?[0-9][0-9.,\s]*\s*(?:đ|₫)(?![a-zA-ZÀ-ỹ])/i;

    doc.querySelectorAll('.card-body').forEach(card => {
      const text = normSpace(card.textContent);
      const labelEl = card.querySelector('.text-secondary.small.mb-1, .text-secondary.small, [class*="text-secondary"]');
      const labelText = normalizeKey(labelEl?.textContent || text);
      let key = null;
      for (const [label, mapped] of labels) {
        if (labelText.includes(label)) { key = mapped; break; }
      }
      if (!key) return;

      // Ưu tiên phần tử số tiền; dự phòng mới quét toàn card.
      let money = '';
      for (const el of card.querySelectorAll('.fw-bold, .fw-semibold, .fs-5, .fs-6')) {
        const m = normSpace(el.textContent).match(moneyRe);
        if (m) { money = m[0]; break; }
      }
      if (!money) money = (text.match(moneyRe) || [])[0] || '';
      if (money) out[key] = { text: money.replace(/\s+/g, ' '), int: moneyInt(money) };

      const view = text.match(/([0-9][0-9.,\s]*)\s*lượt/i);
      const gift = text.match(/([0-9][0-9.,\s]*)\s*quà/i);
      if (key === 'boi_quang_cao' && view) out.so_luot_qc = { text: normSpace(view[1]), int: moneyInt(view[1]) };
      if (key === 'boi_de_cu' && view) out.so_luot_de_cu = { text: normSpace(view[1]), int: moneyInt(view[1]) };
      if (key === 'boi_qua_tang' && gift) out.so_qua = { text: normSpace(gift[1]), int: moneyInt(gift[1]) };
    });
    return out;
  }

  async function loadEarnings(all) {
    if (!state.stories.length) throw new Error('Hãy nạp danh sách truyện trước.');
    const stories = all ? state.stories : state.stories.filter(s => s.id === state.storyId);
    const results = await mapLimit(stories, 3, async story => {
      const doc = parseHtml((await requestText(`/mystory/${story.id}/earning`)).text);
      const stats = parseEarningCards(doc);
      const canWithdraw = !!doc.querySelector(`#withdraw_to_owner[data-story-id="${story.id}"], #withdraw_to_owner[data-story-id]`);
      const earningAd = doc.querySelector('#earning_ad')?.value ?? '';
      const hasCore = ['dang_co','dang_rut','da_thanh_toan','tong'].some(k => stats[k]);
      const note = hasCore ? '' : 'Không có thẻ doanh thu (có thể truyện chưa xuất bản hoặc web không cấp trang earning)';
      const item = { storyId: story.id, title: story.title, stats, canWithdraw, earningAd, ok: hasCore, note };
      state.earnings.set(story.id, item);
      return item;
    }, (d,t,r) => { setProgress(d,t); setStatus(`Doanh thu: ${d}/${t}`); if (r?.error) debugLog('Không đọc được doanh thu một truyện', r.error, 'error'); });
    try {
      const walletDoc = parseHtml((await requestText('/mypayments/')).text);
      state.wallet = parseEarningCards(walletDoc);
    } catch (e) { debugLog('Không đọc được số dư tài khoản', e, 'error'); }
    renderEarnings();
    const failed = results.filter(r => r?.error).length;
    const unavailable = results.filter(r => r && !r.error && !r.ok).length;
    log(`Đã đọc doanh thu ${results.length - failed - unavailable}/${results.length} truyện${unavailable ? `; ${unavailable} truyện chưa có dữ liệu` : ''}${failed ? `; ${failed} truyện gặp lỗi` : ''}.`, failed ? 'warn' : 'success');
    if (failed) throw new Error(`Đã tải doanh thu nhưng có ${failed} truyện gặp lỗi. Xem cột Ghi chú và nhật ký.`);
  }

  const earningCols = [
    ['dang_co','Đang có'],['dang_rut','Đang rút'],['da_thanh_toan','Đã TT'],['da_chuyen','Đã chuyển'],['tong','Tổng'],
    ['boi_quang_cao','Quảng cáo'],['so_luot_qc','Lượt QC'],['boi_de_cu','Đề cử'],['so_luot_de_cu','Lượt ĐC'],['boi_qua_tang','Quà'],
  ];

  function renderEarnings() {
    const body = document.querySelector('#tytb-earning-body');
    if (!body) return;
    const rows = [...state.earnings.values()].sort((a,b)=>a.title.localeCompare(b.title,'vi'));
    body.innerHTML = rows.map(item => `<tr data-sid="${item.storyId}"><td>${escHtml(item.title)}</td>${earningCols.map(([k])=>`<td>${escHtml(item.stats?.[k]?.text || '')}</td>`).join('')}<td>${item.canWithdraw?'Có':''}</td><td>${escHtml(item.note || '')}</td></tr>`).join('');
    const sum = rows.reduce((a,x)=>a+(x.stats?.dang_co?.int||0),0);
    const wallet = state.wallet?.dang_co?.int;
    document.querySelector('#tytb-earning-summary').textContent = `Tổng “Đang có” của các truyện đã tải: ${fmtMoney(sum)}${wallet != null ? ` | Tài khoản: ${fmtMoney(wallet)}` : ''}`;
  }

  async function withdrawAll() {
    const rows = [...state.earnings.values()].filter(x => x.canWithdraw && (x.stats?.dang_co?.int || 0) > 0);
    if (!rows.length) throw new Error('Không có truyện đã thống kê nào có nút Chuyển Về Tài Khoản và số dư > 0.');
    const total = rows.reduce((a,x)=>a+(x.stats.dang_co.int||0),0);
    const preview = rows.map(x=>`${x.title}: ${x.stats.dang_co.text}`).join('\n');
    if (!await confirmModal('Chuyển thưởng về tài khoản', `${rows.length} truyện, tổng dự kiến ${fmtMoney(total)}. Mỗi truyện sẽ kiểm tra lại số dư ngay trước khi chuyển.\n\n${preview}`, 'CHUYỂN THƯỞNG')) return;
    let done = 0;
    for (const item of rows) {
      if (state.cancelled) throw new Error('Đã hủy.');
      const doc = parseHtml((await requestText(`/mystory/${item.storyId}/earning`)).text);
      const stats = parseEarningCards(doc);
      const button = doc.querySelector(`#withdraw_to_owner[data-story-id="${item.storyId}"], #withdraw_to_owner[data-story-id]`);
      if (!button || (stats.dang_co?.int || 0) <= 0) { log(`${item.title}: không còn khoản thưởng có thể chuyển.`, 'warn'); done++; continue; }
      await postForm(`/mystory/${item.storyId}/withdraw_to_owner`, {}, `/mystory/${item.storyId}/earning`);
      item.stats.dang_co = { text: '0 đ', int: 0 };
      done++; setProgress(done, rows.length); setStatus(`Chuyển thưởng: ${done}/${rows.length}`); debugLog(`Đã chuyển thưởng của ${item.title}`);
    }
    renderEarnings();
    log(`Đã xử lý chuyển thưởng cho ${done}/${rows.length} truyện.`, 'success');
  }

  async function choiceModal(title, text, choices) {
    return new Promise(resolve => {
      const modal = document.querySelector('#tytb-modal');
      modal.querySelector('.tytb-modal-title').textContent = title;
      modal.querySelector('.tytb-modal-text').textContent = text;
      const actions = modal.querySelector('.tytb-modal-actions');
      actions.replaceChildren();
      const finish = value => {
        modal.classList.remove('show');
        actions.replaceChildren();
        resolve(value);
      };
      choices.forEach(choice => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.text;
        if (choice.className) button.className = choice.className;
        button.onclick = () => finish(choice.value);
        actions.appendChild(button);
      });
      modal.classList.add('show');
    });
  }

  async function confirmModal(title, text, actionText='XÁC NHẬN') {
    return choiceModal(title, text, [
      { value: false, text: 'Hủy', className: '' },
      { value: true, text: actionText, className: 'danger' },
    ]);
  }

  function renderQueue() {
    const list = document.querySelector('#tytb-queue');
    const label = document.querySelector('#tytb-queue-count');
    if (label) label.textContent = `${state.files.length} chương trong hàng chờ`;
    if (list) list.innerHTML = state.files.map((f,i) => {
      const source = f.__tytbSourceName && f.__tytbSourceName !== f.name ? ` <small>← ${escHtml(f.__tytbSourceName)}</small>` : '';
      return `<div><span>${i+1}. ${escHtml(f.name)}${source}</span><button data-remove-file="${i}">×</button></div>`;
    }).join('');
  }

  function readSettingsFromUI() {
    const intVal = (id, fallback, min, max) => clamp(Number(document.querySelector(id)?.value || fallback), min, max);
    state.cfg.maxPages = intVal('#tytb-max-pages', state.cfg.maxPages, 1, 500);
    state.cfg.maxItems = intVal('#tytb-max-items', state.cfg.maxItems, 1, 20000);
    state.cfg.readWorkers = intVal('#tytb-read-workers', state.cfg.readWorkers, 1, 8);
    state.cfg.writeWorkers = intVal('#tytb-write-workers', state.cfg.writeWorkers, 1, 4);
    state.cfg.writeDelay = intVal('#tytb-write-delay', state.cfg.writeDelay, 50, 2000);
    state.cfg.panelWidth = intVal('#tytb-panel-width', state.cfg.panelWidth, 720, 1400);
    state.cfg.selectedOnly = !!document.querySelector('#tytb-selected-only')?.checked;
    const panel = document.querySelector('#tytb-panel');
    if (panel) panel.style.setProperty('--tytb-panel-width', `${state.cfg.panelWidth}px`);
    saveConfig();
  }

  function injectUI() {
    const style = document.createElement('style');
    style.textContent = `
#tytb-launch{position:fixed;right:18px;bottom:18px;z-index:2147483646;border:0;border-radius:999px;background:#0d6efd;color:#fff;padding:10px 15px;font-weight:700;box-shadow:0 4px 18px #0008;cursor:pointer;touch-action:manipulation}
#tytb-panel{--tytb-panel-width:1040px;position:fixed;right:12px;top:7vh;width:min(var(--tytb-panel-width),calc(100vw - 24px));height:86vh;height:86dvh;z-index:2147483647;background:#17191d;color:#e9ecef;border:1px solid #495057;border-radius:12px;box-shadow:0 12px 45px #000c;display:none;flex-direction:column;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;overscroll-behavior:contain}
#tytb-panel.show{display:flex}#tytb-panel *{box-sizing:border-box;min-inline-size:0}.tytb-head{display:flex;align-items:center;gap:9px;padding:9px 11px;background:#212529;border-bottom:1px solid #3b4045;flex:0 0 auto}.tytb-head b{font-size:15px}.tytb-head .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bfc5ca}.tytb-version{flex:0 0 auto}.tytb-update-badge{flex:0 0 auto;border:1px solid #4ea3ff!important;background:#123b66!important;color:#dceeff!important;border-radius:999px!important;padding:3px 8px!important;font-size:10.5px!important;font-weight:800;line-height:1.25;box-shadow:0 0 0 0 rgba(78,163,255,.35);animation:tytb-update-pulse 2.2s ease-in-out infinite}.tytb-update-badge[hidden]{display:none!important}.tytb-update-short{display:none}@keyframes tytb-update-pulse{0%,100%{box-shadow:0 0 0 0 rgba(78,163,255,0)}50%{box-shadow:0 0 0 4px rgba(78,163,255,.12)}}.tytb-close{font-size:21px;background:transparent!important;border:0!important;color:#fff!important;padding:0 5px!important;flex:0 0 auto}
.tytb-session{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"refresh story open";padding:7px 10px;gap:7px;border-bottom:1px solid #343a40;flex:0 0 auto}.tytb-session>[data-action="load-stories"]{grid-area:refresh}.tytb-session #tytb-story{grid-area:story;width:100%;min-width:0}.tytb-session>[data-action="open-story"]{grid-area:open}.tytb-tabs{display:flex;padding:6px 9px;gap:5px;border-bottom:1px solid #343a40;overflow-x:auto;scrollbar-width:none;flex:0 0 auto}.tytb-tabs::-webkit-scrollbar{display:none}.tytb-tabs button{flex:1 0 auto;white-space:nowrap}.tytb-tabs button.active{background:#0d6efd;color:#fff}.tytb-tab-label-short{display:none}
.tytb-main{flex:1;min-height:0;overflow:auto;padding:9px;overscroll-behavior:contain;scroll-padding-bottom:18px}.tytb-tab{display:none}.tytb-tab.active{display:block}.tytb-row{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:6px 0}.tytb-row.compact{margin:4px 0}.tytb-row label{display:flex;gap:5px;align-items:center}.tytb-row .grow{flex:1;min-width:0}.tytb-box{border:1px solid #3d4248;border-radius:8px;padding:9px;margin-bottom:8px;background:#1e2125}.tytb-box h3{font-size:14px;margin:0 0 7px}.tytb-btn,#tytb-panel button{background:#343a40;color:#f8f9fa;border:1px solid #5c636a;border-radius:6px;padding:6px 9px;cursor:pointer;touch-action:manipulation}.tytb-btn.primary,#tytb-panel button.primary{background:#0d6efd;border-color:#0d6efd}.tytb-btn.danger,#tytb-panel button.danger{background:#a52834;border-color:#c63c49}.tytb-btn.warn{background:#806509}.tytb-btn:disabled,#tytb-panel button:disabled,.tytb-btn.disabled{opacity:.45;cursor:not-allowed;pointer-events:none}#tytb-panel input,#tytb-panel select,#tytb-panel textarea{background:#111418;color:#f8f9fa;border:1px solid #555b61;border-radius:5px;padding:5px 7px;max-width:100%}#tytb-panel input[type=number]{width:84px;flex:0 0 auto}#tytb-panel input[type=text]{min-width:0}.tytb-row label.grow input[type=text]{width:100%}.tytb-actions{display:flex;gap:7px;flex-wrap:wrap}.tytb-actions>*{min-width:0}.tytb-actions .primary{min-width:110px}.tytb-file-picker{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}.tytb-upload-picker .tytb-hint{flex:1 1 180px}
.tytb-table-wrap{overflow:auto;max-height:49vh;border:1px solid #343a40;border-radius:6px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.tytb-table{border-collapse:collapse;width:100%;font-size:12px}.tytb-table th,.tytb-table td{border-bottom:1px solid #343a40;border-right:1px solid #2d3135;padding:5px 6px;vertical-align:top}.tytb-table th{position:sticky;top:0;background:#2b3035;z-index:1;white-space:nowrap}.tytb-table .title{min-width:300px;overflow-wrap:anywhere}.tytb-table .note{width:150px;overflow-wrap:anywhere}.tytb-table .num{font-variant-numeric:tabular-nums}.tytb-retry-row{display:flex;align-items:center;gap:6px;margin-top:5px;color:#adb5bd;font-size:10px}.tytb-retry-btn{padding:2px 7px!important;min-height:0!important;background:#806509!important;border-color:#a8840b!important;color:#fff!important;font-weight:700}.tytb-chapter-pager{display:flex;align-items:center;justify-content:center;gap:8px;margin:7px 0}.tytb-chapter-pager[hidden]{display:none}.tytb-chapter-page-info{min-width:180px;text-align:center;color:#adb5bd;font-size:12px;font-variant-numeric:tabular-nums}
.tytb-queue{max-height:230px;overflow:auto;border:1px solid #343a40;border-radius:6px;padding:3px 6px;overscroll-behavior:contain}.tytb-queue:empty{display:none}.tytb-queue>div{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-bottom:1px solid #2d3135;padding:4px 1px}.tytb-queue>div:last-child{border-bottom:0}.tytb-queue>div>span{flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-word}.tytb-queue button{padding:0 7px!important;flex:0 0 auto}.tytb-hint{color:#adb5bd;font-size:12px;overflow-wrap:anywhere}.tytb-muted{color:#8f989f}.tytb-inline-title{font-weight:600}.tytb-details{border:1px solid #343a40;border-radius:7px;margin-top:7px;background:#191c20}.tytb-details>summary{cursor:pointer;padding:7px 9px;color:#cbd0d5;font-weight:600;user-select:none}.tytb-details[open]>summary{border-bottom:1px solid #343a40}.tytb-details-body{padding:7px 9px}
.tytb-foot{border-top:1px solid #495057;background:#212529;padding:7px 10px;flex:0 0 auto}.tytb-statusline{display:flex;gap:9px;align-items:center}.tytb-statusline #tytb-status{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tytb-progress{height:6px;background:#343a40;border-radius:99px;overflow:hidden;margin-top:6px}.tytb-progress>div{height:100%;width:0;background:#0d6efd}.tytb-log-details{margin-top:5px}.tytb-log-details>summary{cursor:pointer;color:#adb5bd;font-size:12px}.tytb-log-head{display:flex;justify-content:flex-end;gap:5px;margin:5px 0}.tytb-log-head button{padding:2px 7px!important;font-size:11px}.tytb-log{height:110px;overflow:auto;background:#111418;border:1px solid #343a40;border-radius:6px;padding:3px 7px;font-size:12px;overscroll-behavior:contain}.tytb-log-entry{display:grid;grid-template-columns:55px 62px minmax(0,1fr);gap:6px;padding:4px 0;border-bottom:1px solid #252a2f}.tytb-log-entry:last-child{border-bottom:0}.tytb-log-time{color:#8d969f;font-variant-numeric:tabular-nums}.tytb-log-badge{font-size:9px;line-height:17px;text-align:center;border-radius:999px;background:#343a40}.tytb-log-message{min-width:0;overflow-wrap:anywhere}.tytb-log-success .tytb-log-badge{background:#1f6f43;color:#d8f3e5}.tytb-log-warn .tytb-log-badge{background:#765c10;color:#fff1b8}.tytb-log-error .tytb-log-badge{background:#842029;color:#ffd7da}.tytb-log-info .tytb-log-badge{background:#244f7a;color:#dbeeff}.tytb-log-error .tytb-log-message{color:#ffb4bb}.tytb-log-warn .tytb-log-message{color:#ffe08a}.tytb-log-success .tytb-log-message{color:#a9e8c5}
.tytb-author-note{margin-top:7px;padding-top:7px;border-top:1px solid #343a40;color:#adb5bd;font-size:11px;line-height:1.45;text-align:center;overflow-wrap:anywhere}.tytb-author-note a{color:#8ab4f8;font-weight:700;text-decoration:none}.tytb-author-note a:hover{text-decoration:underline}.tytb-author-name{position:relative;display:inline-block;isolation:isolate;animation:tytb-glitch-main 5.6s infinite}.tytb-author-name::before,.tytb-author-name::after{content:attr(data-text);position:absolute;inset:0;pointer-events:none;opacity:0}.tytb-author-name::before{color:#ff5f7a}.tytb-author-name::after{color:#66d9ff}@keyframes tytb-glitch-main{0%,90%,95%,100%{transform:none;text-shadow:none;opacity:1}91%{transform:translateX(-1px);text-shadow:1px 0 #ff5f7a,-1px 0 #66d9ff}92%{transform:translateX(1px);opacity:.65}93%{transform:translateX(-1px);text-shadow:-1px 0 #ff5f7a,1px 0 #66d9ff}94%{transform:none;opacity:1}}@keyframes tytb-glitch-before{0%,90%,95%,100%{opacity:0;transform:none}91%{opacity:.75;transform:translate(-1px,-1px);clip-path:inset(0 0 55% 0)}92%{opacity:.2;transform:translate(1px,0);clip-path:inset(45% 0 20% 0)}93%{opacity:.7;transform:translate(-1px,1px);clip-path:inset(70% 0 0 0)}94%{opacity:0}}@keyframes tytb-glitch-after{0%,90%,95%,100%{opacity:0;transform:none}91%{opacity:.45;transform:translate(1px,1px);clip-path:inset(60% 0 0 0)}92%{opacity:.7;transform:translate(-1px,0);clip-path:inset(20% 0 55% 0)}93%{opacity:.25;transform:translate(1px,-1px);clip-path:inset(40% 0 25% 0)}94%{opacity:0}}.tytb-author-name::before{animation:tytb-glitch-before 5.6s infinite}.tytb-author-name::after{animation:tytb-glitch-after 5.6s infinite}
.tytb-modal{position:fixed;inset:0;z-index:2147483647;background:#000b;display:none;align-items:center;justify-content:center;padding:12px}.tytb-modal.show{display:flex}.tytb-modal-card{width:min(720px,94vw);max-height:86vh;max-height:86dvh;background:#1d2024;border:1px solid #6c757d;border-radius:10px;display:flex;flex-direction:column;overflow:hidden}.tytb-modal-title{font-weight:700;font-size:16px;padding:11px;border-bottom:1px solid #495057;flex:0 0 auto}.tytb-modal-text{white-space:pre-wrap;overflow:auto;padding:11px;min-height:90px;min-width:0;flex:1 1 auto;overflow-wrap:anywhere;overscroll-behavior:contain}.tytb-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:9px;border-top:1px solid #495057;flex:0 0 auto}.tytb-modal-actions button{background:#343a40;color:#f8f9fa;border:1px solid #5c636a;border-radius:6px;padding:7px 10px;cursor:pointer}.tytb-modal-actions button.primary{background:#0d6efd;border-color:#0d6efd}.tytb-modal-actions button.danger{background:#a52834;border-color:#c63c49}.tytb-modal-actions button.warn{background:#806509;border-color:#a8840b}
@media(max-width:900px){#tytb-panel{right:8px;top:4vh;width:calc(100vw - 16px);height:92vh;height:92dvh}.tytb-details-body .tytb-row>label{flex:1 1 220px}.tytb-row .grow{min-width:0}.tytb-table .title{min-width:240px}}
@media(max-width:700px),(hover:none) and (pointer:coarse) and (max-height:600px){#tytb-panel{inset:0;width:100%;height:100vh;height:100dvh;border:0;border-radius:0}.tytb-head{padding-top:max(8px,env(safe-area-inset-top));padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}.tytb-foot{padding-bottom:max(8px,env(safe-area-inset-bottom));padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}#tytb-launch{right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom))}}
@media(max-width:700px){.tytb-session{grid-template-columns:1fr 1fr;grid-template-areas:"story story" "refresh open";padding:7px}.tytb-session>[data-action]{width:100%}.tytb-main{padding:7px}.tytb-box{padding:7px}.tytb-row:not(.compact)>label{flex:1 1 100%;justify-content:space-between}.tytb-row:not(.compact)>label.grow{display:grid;grid-template-columns:auto minmax(0,1fr)}.tytb-details-body .tytb-row:not(.compact)>button{flex:1 1 120px}.tytb-actions>*{flex:1 1 calc(50% - 7px)}#tytb-panel input[type=text],#tytb-panel select{min-width:0;max-width:100%}.tytb-upload-picker .tytb-file-picker{flex:1 1 120px}.tytb-upload-picker .tytb-hint{flex:1 1 100%}.tytb-chapter-wrap{max-height:none;overflow:visible;border:0}.tytb-chapter-wrap #tytb-chapter-table,.tytb-chapter-wrap #tytb-chapter-body{display:block;width:100%}.tytb-chapter-wrap #tytb-chapter-table thead{display:none}.tytb-chapter-wrap #tytb-chapter-body{display:grid;gap:7px}.tytb-chapter-wrap #tytb-chapter-body tr{display:grid;grid-template-columns:38px 58px minmax(0,1fr);grid-template-rows:auto auto;width:100%;border:1px solid #343a40;border-radius:8px;background:#1e2125;overflow:hidden}.tytb-chapter-wrap #tytb-chapter-body td{display:block;width:auto;min-width:0;border:0;padding:6px}.tytb-chapter-wrap #tytb-chapter-body td.check{grid-column:1;grid-row:1/3;display:flex;align-items:center;justify-content:center;border-right:1px solid #343a40}.tytb-chapter-wrap #tytb-chapter-body td.num{grid-column:2;grid-row:1;font-weight:700;color:#cbd0d5;white-space:nowrap}.tytb-chapter-wrap #tytb-chapter-body td.num::before{content:'#';color:#747d85}.tytb-chapter-wrap #tytb-chapter-body td.title{grid-column:3;grid-row:1;min-width:0;font-weight:600;overflow-wrap:anywhere}.tytb-chapter-wrap #tytb-chapter-body td.note{grid-column:2/4;grid-row:2;color:#adb5bd;font-size:11px;border-top:1px solid #2d3135;overflow-wrap:anywhere}.tytb-chapter-wrap #tytb-chapter-body td.note:empty{display:none}.tytb-chapter-pager{justify-content:space-between}.tytb-chapter-page-info{min-width:0;flex:1}.tytb-earning-wrap{max-height:58vh;max-height:58dvh}.tytb-earning-wrap #tytb-earning-table{width:max-content;min-width:100%}.tytb-earning-wrap #tytb-earning-table th:first-child,.tytb-earning-wrap #tytb-earning-table td:first-child{position:sticky;left:0;min-width:150px;max-width:220px;overflow-wrap:anywhere}.tytb-earning-wrap #tytb-earning-table th:first-child{z-index:3;background:#2b3035}.tytb-earning-wrap #tytb-earning-table td:first-child{z-index:2;background:#1e2125}.tytb-modal{padding:8px}.tytb-modal-card{width:100%;max-height:calc(100vh - 16px);max-height:calc(100dvh - 16px)}.tytb-modal-actions button{flex:1 1 140px;min-height:42px}.tytb-statusline{display:grid;grid-template-columns:minmax(0,1fr) auto auto}.tytb-log-entry{grid-template-columns:50px 58px minmax(0,1fr);gap:5px}}
@media(max-width:430px){.tytb-tab-label-long{display:none}.tytb-tab-label-short{display:inline}.tytb-update-long{display:none}.tytb-update-short{display:inline}#tytb-panel.tytb-has-update #tytb-version{display:none}.tytb-main{padding:5px}.tytb-box{padding:6px;margin-bottom:6px}.tytb-tabs{padding:5px;gap:4px}.tytb-tabs button{padding-left:6px!important;padding-right:6px!important}.tytb-details-body{padding:6px}.tytb-actions{gap:6px}.tytb-chapter-pager{gap:5px}.tytb-chapter-pager button{padding-left:7px!important;padding-right:7px!important}.tytb-modal-actions{flex-direction:column-reverse}.tytb-modal-actions button{width:100%;flex:none}.tytb-author-note{font-size:10.5px}.tytb-log-entry{grid-template-columns:47px 54px minmax(0,1fr);gap:4px}}
@media(pointer:coarse){#tytb-panel button,.tytb-btn,#tytb-panel select,#tytb-panel input[type=number],.tytb-details>summary{min-height:42px}.tytb-chk{width:20px;height:20px}.tytb-close{min-width:42px}.tytb-file-picker{min-height:42px}}
@media(prefers-reduced-motion:reduce){.tytb-author-name,.tytb-author-name::before,.tytb-author-name::after,.tytb-update-badge{animation:none!important}.tytb-author-name::before,.tytb-author-name::after{display:none}}
`;
    document.head.appendChild(style);

    document.body.insertAdjacentHTML('beforeend', `
<button id="tytb-launch" type="button">TYT Bulk</button>
<div id="tytb-panel" role="dialog" aria-label="TYT Bulk Manager" style="--tytb-panel-width:${clamp(state.cfg.panelWidth, 720, 1400)}px">
  <div class="tytb-head"><b>TYT Bulk</b><span class="grow" id="tytb-current-story">Chưa chọn truyện</span><span class="tytb-muted tytb-version" id="tytb-version">v${VERSION}</span><button class="tytb-update-badge" id="tytb-update-badge" type="button" data-action="install-update" hidden><span class="tytb-update-long">Có bản mới</span><span class="tytb-update-short">Mới</span></button><button class="tytb-close" id="tytb-close" type="button" title="Đóng" aria-label="Đóng">×</button></div>
  <div class="tytb-session"><button type="button" data-action="load-stories">Làm mới</button><select id="tytb-story"><option>Chưa nạp danh sách truyện</option></select><button type="button" data-action="open-story">Mở</button></div>
  <div class="tytb-tabs"><button type="button" class="active" data-tab="upload"><span class="tytb-tab-label-long">Đăng TXT</span><span class="tytb-tab-label-short">Đăng</span></button><button type="button" data-tab="chapters"><span class="tytb-tab-label-long">Quản lý chương</span><span class="tytb-tab-label-short">Chương</span></button><button type="button" data-tab="earning">Doanh thu</button></div>
  <div class="tytb-main">
    <section class="tytb-tab active" data-pane="upload">
      <div class="tytb-box">
        <div class="tytb-row tytb-upload-picker"><label class="tytb-btn primary tytb-file-picker">Chọn TXT<input id="tytb-upload-files" type="file" accept=".txt,text/plain" multiple hidden></label><span class="tytb-hint">Chọn một hoặc nhiều file TXT.</span><button type="button" data-action="clear-queue">Xóa danh sách</button></div>
        <div class="tytb-row"><label>Số bắt đầu <input id="tytb-upload-start" type="number" min="1" max="9999" value="1"></label><label>Hiển thị <select id="tytb-published"><option value="1" ${state.cfg.published==='1'?'selected':''}>Công khai</option><option value="0" ${state.cfg.published==='0'?'selected':''}>Riêng tư</option></select></label><span id="tytb-queue-count" class="tytb-hint">0 chương trong hàng chờ</span></div>
        <div class="tytb-actions"><button type="button" class="primary" data-action="upload-next">Đăng 10 chương</button><button type="button" class="primary" data-action="upload-all">Đăng tất cả</button></div>
        <details class="tytb-details"><summary>Tùy chọn đăng</summary><div class="tytb-details-body"><div class="tytb-row compact"><label><input id="tytb-parse-number" type="checkbox" ${state.cfg.parseNumberFromFilename?'checked':''}> Lấy số từ tên file</label><label><input id="tytb-single-upload" type="checkbox" ${state.cfg.singleUpload?'checked':''}> Đăng từng chương</label></div><div class="tytb-hint">TXT gộp sẽ tự tách theo dòng “Chương X: Tiêu đề”.</div></div></details>
        <div id="tytb-queue" class="tytb-queue"></div>
      </div>
    </section>

    <section class="tytb-tab" data-pane="chapters">
      <div class="tytb-box">
        <div class="tytb-row"><button type="button" class="primary" data-action="load-chapters">Tải danh sách</button><button type="button" data-action="open-chapters">Mở trên web</button><span id="tytb-chapter-info" class="tytb-hint">Chưa tải</span></div>
        <div class="tytb-row compact"><button type="button" data-action="select-all">Chọn tất</button><button type="button" data-action="select-none">Bỏ chọn</button><button type="button" data-action="select-invert">Đảo chọn</button><label><input id="tytb-selected-only" type="checkbox" ${state.cfg.selectedOnly?'checked':''}> Chỉ chương đã chọn</label></div>
        <div class="tytb-actions"><label class="tytb-btn primary tytb-file-picker">Cập nhật từ TXT<input id="tytb-update-txt-files" type="file" accept=".txt,text/plain" multiple hidden></label><button type="button" data-action="download-txt">Tải TXT</button><button type="button" class="danger" data-action="delete">Xóa đã chọn</button></div>
        <details class="tytb-details"><summary>Đổi tên và đánh số</summary><div class="tytb-details-body">
          <div class="tytb-row"><label>Bắt đầu <input id="tytb-renumber-start" type="number" value="${state.cfg.renumberStart}" min="1" max="9999"></label><button type="button" class="primary" data-action="renumber">Đánh số lại</button></div>
          <div class="tytb-row"><label class="grow">Mẫu tên <input id="tytb-rename-template" class="grow" type="text" value="${escHtml(state.cfg.renameTemplate)}"></label><button type="button" data-action="rename-reset">Mặc định</button><button type="button" class="primary" data-action="rename">Đổi tên</button></div>
        </div></details>
        <details class="tytb-details"><summary>Giới hạn tải, tốc độ và giao diện</summary><div class="tytb-details-body">
          <div class="tytb-row"><label>Tối đa trang <input id="tytb-max-pages" type="number" value="${state.cfg.maxPages}" min="1" max="500"></label><label>Tối đa chương <input id="tytb-max-items" type="number" value="${state.cfg.maxItems}" min="1" max="20000"></label></div>
          <div class="tytb-row"><label>Luồng đọc <input id="tytb-read-workers" type="number" value="${state.cfg.readWorkers}" min="1" max="8"></label><label>Luồng ghi <input id="tytb-write-workers" type="number" value="${state.cfg.writeWorkers}" min="1" max="4"></label><label>Nghỉ ghi <input id="tytb-write-delay" type="number" value="${state.cfg.writeDelay}" min="50" max="2000"> ms</label></div>
          <div class="tytb-row"><label>Rộng panel desktop <input id="tytb-panel-width" type="number" value="${clamp(state.cfg.panelWidth,720,1400)}" min="720" max="1400"> px</label><button type="button" data-action="save-settings">Lưu</button><button type="button" data-action="check-update">Kiểm tra cập nhật</button></div><div class="tytb-hint">Tự kiểm tra bản mới khi khởi động; kết quả được lưu 30 phút để tránh gọi GitHub liên tục.</div>
        </div></details>
      </div>
      <div id="tytb-chapter-pager" class="tytb-chapter-pager" hidden><button type="button" data-action="chapter-prev">‹ Trước</button><span id="tytb-chapter-page-info" class="tytb-chapter-page-info"></span><button type="button" data-action="chapter-next">Sau ›</button></div>
      <div class="tytb-table-wrap tytb-chapter-wrap"><table id="tytb-chapter-table" class="tytb-table"><thead><tr><th></th><th>Số</th><th>Tiêu đề</th><th>Trạng thái</th></tr></thead><tbody id="tytb-chapter-body"></tbody></table></div>
    </section>

    <section class="tytb-tab" data-pane="earning">
      <div class="tytb-box"><div class="tytb-actions"><button type="button" data-action="earning-selected">Truyện đang chọn</button><button type="button" class="primary" data-action="earning-all">Tất cả truyện</button><button type="button" class="warn tytb-btn" data-action="withdraw-all">Chuyển thưởng</button><button type="button" data-action="earning-clear">Xóa bảng</button></div><div id="tytb-earning-summary" class="tytb-hint">Chưa có dữ liệu.</div></div>
      <div class="tytb-table-wrap tytb-earning-wrap"><table id="tytb-earning-table" class="tytb-table"><thead><tr><th>Truyện</th>${earningCols.map(([,t])=>`<th>${t}</th>`).join('')}<th>Chuyển</th><th>Ghi chú</th></tr></thead><tbody id="tytb-earning-body"></tbody></table></div>
    </section>
  </div>
  <div class="tytb-foot"><div class="tytb-statusline"><span id="tytb-status">Sẵn sàng.</span><span id="tytb-progress-text">0%</span><button id="tytb-cancel" type="button" disabled>Hủy</button></div><div class="tytb-progress"><div id="tytb-progress-bar"></div></div><details class="tytb-log-details"><summary>Nhật ký hoạt động</summary><div class="tytb-log-head"><button type="button" id="tytb-copy-log">Sao chép</button><button type="button" id="tytb-clear-log">Xóa</button></div><div id="tytb-log" class="tytb-log" aria-live="polite"></div></details><div class="tytb-author-note">Script được viết bởi <a class="tytb-author-name" data-text="${escHtml(SCRIPT_INFO.authorName)}" href="${escHtml(SCRIPT_INFO.authorProfileUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(SCRIPT_INFO.authorName)}</a> - ${escHtml(SCRIPT_INFO.authorMessage)}</div></div>
</div>
<div id="tytb-modal" class="tytb-modal"><div class="tytb-modal-card"><div class="tytb-modal-title"></div><div class="tytb-modal-text"></div><div class="tytb-modal-actions"></div></div></div>`);

    bindUI();
    const current = currentStoryIdFromUrl();
    if (current) { state.storyId = current; state.storyTitle = current; }
    renderChapters();
    log(`TYT Bulk v${VERSION} đã sẵn sàng.`, 'success');
    queueMicrotask(() => { checkForUpdates().catch(error => debugLog('Startup update check', error, 'warn')); });
    document.addEventListener('visibilitychange', () => {
      if (!state.busy) return;
      debugLog(document.hidden ? 'Tab chuyển sang nền.' : 'Tab trở lại tiền cảnh.');
    });
    window.addEventListener('beforeunload', event => {
      if (!state.busy) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function bindUI() {
    const panel = document.querySelector('#tytb-panel');
    document.querySelector('#tytb-launch').onclick = () => { panel.classList.toggle('show'); if (panel.classList.contains('show')) renderChapters(); };
    document.querySelector('#tytb-close').onclick = () => panel.classList.remove('show');
    document.querySelector('#tytb-copy-log').onclick = () => copyActivityLog();
    document.querySelector('#tytb-clear-log').onclick = () => clearActivityLog();
    document.querySelector('#tytb-cancel').onclick = () => {
      state.cancelled = true;
      for (const request of [...state.activeRequests]) {
        try { request.abort(); } catch (_) {}
      }
      log('Đang dừng tác vụ...', 'warn');
    };
    document.querySelectorAll('.tytb-tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tytb-tabs button').forEach(x=>x.classList.toggle('active',x===btn));
        document.querySelectorAll('.tytb-tab').forEach(x=>x.classList.toggle('active',x.dataset.pane===btn.dataset.tab));
        if (btn.dataset.tab === 'chapters') renderChapters();
      };
    });
    document.querySelector('#tytb-story').onchange = e => {
      state.storyId = e.target.value; state.storyTitle = state.stories.find(x=>x.id===state.storyId)?.title || state.storyId;
      state.chapters=[]; state.chapterMeta=null; state.editCache.clear(); state.txtRetryJobs.clear(); state.lastChapterSelectionIndex=null; state.chapterViewPage=1; renderChapters(); renderStorySelect();
    };
    document.querySelector('#tytb-upload-files').onchange = async e => {
      const input = e.target;
      const picked = [...input.files].filter(f => isTxtFile(f));
      input.value = '';
      if (!picked.length) return;

      await runTask('Đọc và tách TXT', async () => {
        const expanded = [];
        for (let i = 0; i < picked.length; i++) {
          if (state.cancelled) throw new Error('Đã hủy.');
          const file = picked[i];
          setStatus(`Đọc và tách TXT: ${i + 1}/${picked.length} — ${file.name}`);
          const items = await expandTxtForUpload(file, (pct, stage) => {
            setProgress(i * 100 + pct, picked.length * 100);
            setStatus(`${file.name}: ${stage} (${pct}%)`);
          });
          expanded.push(...items);
          debugLog(`${file.name}: đã đọc ${items.length} chương.`);
        }

        state.files.push(...expanded);
        const seen = new Set();
        state.files = state.files.filter(f => {
          const source = f.__tytbSourceName || '';
          const number = f.__tytbChapterNumber || '';
          const k = `${f.name}|${f.size}|${f.lastModified}|${source}|${number}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }).sort((a,b) => {
          const an = Number(a.__tytbChapterNumber ?? filenameNumber(a.name));
          const bn = Number(b.__tytbChapterNumber ?? filenameNumber(b.name));
          if (Number.isInteger(an) && Number.isInteger(bn) && an !== bn) return an - bn;
          return naturalCompare(a.name, b.name);
        });
        renderQueue();
        setProgress(1, 1);
        setStatus(`Đã thêm ${expanded.length} chương từ ${picked.length} file TXT.`);
        log(`Đã thêm ${expanded.length} chương vào hàng chờ từ ${picked.length} file TXT.`, 'success');
      });
    };
    document.querySelector('#tytb-queue').onclick = e => { const b=e.target.closest('[data-remove-file]'); if(b){state.files.splice(Number(b.dataset.removeFile),1);renderQueue();} };
    document.querySelector('#tytb-chapter-body').onclick = e => {
      const checkbox = e.target.closest('input.tytb-chk');
      if (!checkbox) return;
      const tr = checkbox.closest('tr[data-cid][data-index]');
      if (!tr) return;
      const currentIndex = Number(tr.dataset.index);
      if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= state.chapters.length) return;
      if (state.chapters[currentIndex]?.chapterId !== tr.dataset.cid) return;

      const checked = checkbox.checked;
      const anchorIndex = state.lastChapterSelectionIndex;
      if (e.shiftKey && Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex < state.chapters.length) {
        const from = Math.min(anchorIndex, currentIndex);
        const to = Math.max(anchorIndex, currentIndex);
        for (let i = from; i <= to; i++) state.chapters[i].selected = checked;
        renderChapters();
        debugLog(`Đã ${checked ? 'chọn' : 'bỏ chọn'} ${to - from + 1} chương bằng Shift.`);
      } else {
        state.chapters[currentIndex].selected = checked;
        const info = document.querySelector('#tytb-chapter-info');
        const m = state.chapterMeta;
        const selectedCount = state.chapters.reduce((count, ch) => count + (ch.selected ? 1 : 0), 0);
        if (info) info.textContent = m
          ? `${state.chapters.length} chương | đã chọn ${selectedCount} | trang nguồn ${m.loadedPages}/${m.detectedPages}${m.complete ? '' : ' | CHƯA TẢI ĐỦ'}${m.countMismatch ? ` | bộ đếm web: ${m.expected}` : ''}`
          : `${state.chapters.length} chương | đã chọn ${selectedCount}`;
      }
      state.lastChapterSelectionIndex = currentIndex;
    };
    document.querySelector('#tytb-update-txt-files').onchange = e => { const files=[...e.target.files]; e.target.value=''; if(files.length) runTask('Cập nhật nội dung từ TXT',()=>updateFromTxt(files)); };
    panel.addEventListener('change', e => { if (['tytb-selected-only','tytb-max-pages','tytb-max-items','tytb-read-workers','tytb-write-workers','tytb-write-delay','tytb-panel-width'].includes(e.target.id)) readSettingsFromUI(); });
    panel.addEventListener('click', e => {
      const btn=e.target.closest('[data-action]'); if(!btn)return;
      const a=btn.dataset.action;
      if (a === 'retry-txt-chapter') {
        const cid = btn.dataset.cid || '';
        const job = state.txtRetryJobs.get(cid);
        const num = job?.number ?? state.chapters.find(ch => ch.chapterId === cid)?.number ?? '?';
        runTask(`Retry chương ${num}`, () => retryTxtChapter(cid));
        return;
      }
      const actions = {
        'load-stories':()=>runTask('Nạp danh sách truyện',loadStories),
        'open-story':()=>{if(state.storyId)window.open(`/mystory/${state.storyId}/`,'_blank');},
        'clear-queue':()=>{state.files=[];renderQueue();},
        'upload-next':()=>runTask('Đăng 10 chương tiếp',()=>uploadFiles(false)),
        'upload-all':()=>runTask('Đăng tất cả',()=>uploadFiles(true)),
        'earning-selected':()=>runTask('Tải doanh thu truyện đang chọn',()=>loadEarnings(false)),
        'earning-all':()=>runTask('Tải doanh thu tất cả',()=>loadEarnings(true)),
        'withdraw-all':()=>runTask('Chuyển thưởng về tài khoản',withdrawAll),
        'earning-clear':()=>{state.earnings.clear();state.wallet=null;renderEarnings();},
        'open-chapters':()=>{if(state.storyId)window.open(`/mystory/${state.storyId}/chapters`,'_blank');},
        'load-chapters':()=>{readSettingsFromUI();runTask('Tải danh sách chương',loadChapters);},
        'chapter-prev':()=>setChapterViewPage(state.chapterViewPage - 1),
        'chapter-next':()=>setChapterViewPage(state.chapterViewPage + 1),
        'check-update':()=>checkForUpdates({ force: true, userInitiated: true }),
        'install-update':()=>openUpdateInstaller(),
        'select-all':()=>{state.chapters.forEach(x=>{x.selected=true;});state.lastChapterSelectionIndex=null;renderChapters();},
        'select-none':()=>{state.chapters.forEach(x=>{x.selected=false;});state.lastChapterSelectionIndex=null;renderChapters();},
        'select-invert':()=>{state.chapters.forEach(x=>{x.selected=!x.selected;});state.lastChapterSelectionIndex=null;renderChapters();},
        'delete':()=>runTask('Xóa chương',deleteChapters),
        'renumber':()=>{readSettingsFromUI();runTask('Đánh số lại',renumberChapters);},
        'rename-reset':()=>{document.querySelector('#tytb-rename-template').value='Chương {num}: {tail}';},
        'rename':()=>{readSettingsFromUI();runTask('Đổi tên chương',renameChapters);},
        'download-txt':()=>{readSettingsFromUI();runTask('Tải nội dung TXT',downloadTxt);},
        'save-settings':()=>{readSettingsFromUI();alert('Đã lưu cài đặt.');},
      };
      actions[a]?.();
    });

    const chapterLayoutQueries = typeof matchMedia === 'function' ? [
      matchMedia('(max-width: 700px)'),
      matchMedia('(pointer: coarse)'),
      matchMedia('(pointer: coarse) and (max-height: 600px)'),
    ] : [];
    const onChapterLayoutChange = () => {
      if (!document.querySelector('#tytb-panel')?.classList.contains('show')) return;
      renderChapters();
    };
    chapterLayoutQueries.forEach(query => {
      if (typeof query.addEventListener === 'function') query.addEventListener('change', onChapterLayoutChange);
      else if (typeof query.addListener === 'function') query.addListener(onChapterLayoutChange);
    });
  }

  injectUI();
})();
