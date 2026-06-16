/**
 * ============================================================
 *  Char任务监督陪伴插件 v1.0.0
 *  Roche 全信任 JS 插件
 *
 *  功能：
 *    1. 任务面板 — 创建/管理任务与日程
 *    2. 监督陪跑 — 定时截屏 + AI分析 + 聊天记忆注入
 *    3. AI老师   — 导入文本/文件，AI规划分步讲解
 *
 *  架构：
 *    - 使用 roche.* 公开 API（persona/character/memory/ai/storage/ui）
 *    - APK 环境下通过 nativeMonitorBridge 调用原生截屏/使用统计
 *    - 消息注入走 IndexedDB 直接写入（同 RocheToolkit 方式）
 *    - 自适应截图间隔：char 根据人设决定下次截屏时间
 * ============================================================
 */

(function () {
  'use strict';

  // ============================
  //  全局常量
  // ============================
  var DB_NAME = 'Roche_db';
  var STORE_MESSAGES = 'messages';
  var STORE_CONVERSATIONS = 'conversations';
  var STORAGE_KEY_TASKS = 'char_monitor_tasks';
  var STORAGE_KEY_SETTINGS = 'char_monitor_settings';
  var STORAGE_KEY_HISTORY = 'char_monitor_history';
  var STORAGE_KEY_USAGE = 'char_monitor_usage';
  var STORAGE_KEY_PLANS = 'char_monitor_tutor_plans';

  // ============================
  //  工具函数
  // ============================

  function $id(id) { return document.getElementById(id); }
  function $q(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $qa(sel, ctx) { return (ctx || document).querySelectorAll(sel); }
  function uid() { return 'cm_' + Date.now() + '_' + Math.floor(Math.random() * 10000); }
  function now() { return Date.now(); }
  function fmtTime(ts) {
    var d = new Date(ts);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1).toString().padStart(2, '0') + '-' + d.getDate().toString().padStart(2, '0');
  }
  function fmtFull(ts) { return fmtDate(ts) + ' ' + fmtTime(ts); }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================
  //  IndexedDB 消息注入（同 RocheToolkit 方式）
  // ============================

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function addMessage(msg) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_MESSAGES, 'readwrite');
        var store = tx.objectStore(STORE_MESSAGES);
        var req = store.add(msg);
        req.onsuccess = function () { resolve(req.result); db.close(); };
        req.onerror = function () { reject(req.error); db.close(); };
      });
    });
  }

  function injectUserMessage(conversationId, text) {
    var msg = {
      id: now() + Math.floor(Math.random() * 1000),
      isMe: true,
      text: text,
      type: 'text',
      timestamp: now(),
      conversationId: conversationId,
      sendFailed: false,
      isGenerating: false,
      isStreaming: false
    };
    return addMessage(msg).then(function () { triggerRefresh(); });
  }

  function injectCharMessage(conversationId, text, senderName, senderId) {
    var msg = {
      id: now() + Math.floor(Math.random() * 1000),
      isMe: false,
      text: text,
      type: 'text',
      timestamp: now(),
      conversationId: conversationId,
      senderId: senderId || '',
      senderName: senderName || 'Char',
      isGenerating: false,
      isStreaming: false,
      sendFailed: false
    };
    return addMessage(msg).then(function () { triggerRefresh(); });
  }

  function injectSystemNotice(conversationId, text, kind) {
    var msg = {
      id: now() + Math.floor(Math.random() * 1000),
      isMe: false,
      text: text,
      type: 'system_notice',
      timestamp: now(),
      conversationId: conversationId,
      systemNoticeKind: kind || 'info',
      senderName: 'System',
      senderId: '__system__',
      isGenerating: false,
      isStreaming: false
    };
    return addMessage(msg).then(function () { triggerRefresh(); });
  }

  function triggerRefresh() {
    try { window.dispatchEvent(new CustomEvent('roche-data-changed', { detail: { source: 'char-task-monitor' } })); } catch (e) {}
  }

  // ============================
  //  存储帮助函数（用 roche.storage）
  // ============================

  function storageGet(roche, key, fallback) {
    try {
      return roche.storage.get(key).then(function (v) {
        return v !== null && v !== undefined ? v : (fallback !== undefined ? fallback : null);
      }).catch(function () { return fallback !== undefined ? fallback : null; });
    } catch (e) { return Promise.resolve(fallback !== undefined ? fallback : null); }
  }

  function storageSet(roche, key, value) {
    try { return roche.storage.set(key, value); } catch (e) { return Promise.resolve(); }
  }

  // ============================
  //  环境检测
  // ============================

  function isAPK() {
    try { return !!(window.nativeMonitorBridge && window.nativeMonitorBridge.__ready); } catch (e) { return false; }
  }

  // ============================
  //  监督引擎（核心）
  // ============================

  var MonitorEngine = {
    _timer: null,
    _running: false,
    _roche: null,
    _currentInterval: 5 * 60 * 1000,

    start: function (roche, settings) {
      if (this._running) return;
      this._roche = roche;
      this._settings = settings || {};
      this._currentInterval = settings.initialInterval || 5 * 60 * 1000;
      this._running = true;
      console.log('[CharMonitor] 监督引擎启动，初始间隔: ' + (this._currentInterval / 60000) + ' 分钟');
      this._scheduleNext();
    },

    stop: function () {
      this._running = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      console.log('[CharMonitor] 监督引擎已停止');
    },

    isRunning: function () { return this._running; },
    getInterval: function () { return this._currentInterval; },
    setInterval: function (ms) { this._currentInterval = ms; },

    _scheduleNext: function () {
      var self = this;
      if (!this._running) return;
      this._timer = setTimeout(function () { self._tick(); }, this._currentInterval);
    },

    _tick: function () {
      var self = this;
      if (!self._running) return;
      console.log('[CharMonitor] 截屏监督触发 ' + fmtFull(now()));
      self._doCaptureAndAnalyze()
        .then(function (result) { if (result.nextInterval > 0) self._currentInterval = result.nextInterval; })
        .catch(function (err) { console.error('[CharMonitor] 监督轮次失败:', err); })
        .finally(function () { self._scheduleNext(); });
    },

    _doCaptureAndAnalyze: function () {
      var self = this, roche = self._roche, settings = self._settings;
      var conversationId = settings.conversationId, charId = settings.charId, charName = settings.charName || 'Char';

      var capturePromise = isAPK()
        ? window.nativeMonitorBridge.captureScreen().then(function (r) { return r && r.image ? r.image : null; }).catch(function () { return null; })
        : Promise.resolve(null);

      var usagePromise = isAPK()
        ? window.nativeMonitorBridge.getAppUsageStats().then(function (r) { return r && r.data ? r.data : null; }).catch(function () { return null; })
        : Promise.resolve(null);

      var tasksPromise = storageGet(roche, STORAGE_KEY_TASKS, []);

      var personaPromise = charId
        ? roche.character.get(charId).then(function (c) { return c ? (c.persona || c.bio || '') : ''; }).catch(function () { return ''; })
        : Promise.resolve('');

      var worldbookPromise = roche.worldbook.list().then(function (l) { return l || []; }).catch(function () { return []; });

      var memoryPromise = conversationId
        ? roche.memory.getLongTerm({ conversationId: conversationId, limit: 20 }).then(function (mem) {
            var parts = [];
            if (mem && mem.core) parts.push(mem.core.summary || '');
            if (mem && mem.facts) for (var i = 0; i < mem.facts.length; i++) parts.push(mem.facts[i].summaryText || mem.facts[i].action || '');
            return parts.filter(function (x) { return !!x; }).join('\n');
          }).catch(function () { return ''; })
        : Promise.resolve('');

      return Promise.all([capturePromise, usagePromise, tasksPromise, personaPromise, worldbookPromise, memoryPromise])
        .then(function (r) {
          var screenshotBase64 = r[0], usageData = r[1], tasks = r[2], persona = r[3], worldbooks = r[4], longMemory = r[5];
          var p = Promise.resolve({ screenshotBase64: screenshotBase64, usageData: usageData, tasks: tasks, persona: persona, worldbooks: worldbooks, longMemory: longMemory });
          if (usageData) {
            p = storageGet(roche, STORAGE_KEY_USAGE, []).then(function (prev) {
              prev.push({ timestamp: now(), data: usageData });
              if (prev.length > 200) prev = prev.slice(-200);
              return storageSet(roche, STORAGE_KEY_USAGE, prev);
            }).then(function () { return { screenshotBase64: screenshotBase64, usageData: usageData, tasks: tasks, persona: persona, worldbooks: worldbooks, longMemory: longMemory }; });
          }
          return p;
        })
        .then(function (ctx) { return self._buildPromptAndAnalyze(ctx, roche, settings); })
        .then(function (resp) { return self._handleResponse(resp, roche, settings); });
    },

    _buildPromptAndAnalyze: function (ctx, roche, settings) {
      var charName = settings.charName || 'Char', userName = settings.userName || '用户';
      var tasks = ctx.tasks || [], pendingTasks = tasks.filter(function (t) { return t.status !== 'done'; });
      var taskText = '';
      if (pendingTasks.length > 0) {
        taskText = '【用户当前未完成任务】\n';
        pendingTasks.forEach(function (t, i) { taskText += (i + 1) + '. ' + t.title + (t.deadline ? ' (截止: ' + fmtDate(t.deadline) + ')' : '') + '\n'; });
      } else if (tasks.length === 0) taskText = '【用户当前没有创建任何任务】\n';
      else taskText = '【用户所有任务已完成】\n';

      var usageText = ctx.usageData ? '【用户当前设备使用情况】\n' + ctx.usageData + '\n' : '';
      var screenText = ctx.screenshotBase64 ? '【屏幕截图已提供】\n' : '【注意：当前环境不支持截屏，请根据任务和使用情况给出反馈】\n';
      var memoryText = ctx.longMemory ? '【与用户的长期记忆】\n' + ctx.longMemory + '\n' : '';

      var systemPrompt = [
        '你是' + charName + '，你的任务是监督和陪伴' + userName + '。',
        '', ctx.persona ? '【你的人设】\n' + ctx.persona : '', '', memoryText, '',
        '=== 监督任务说明 ===',
        '你是一位贴心的监督伙伴，负责帮助用户保持专注、完成任务。',
        '请根据用户的屏幕截图和应用使用情况，给出自然、温柔但有立场的反馈。',
        '你可以：鼓励、提醒、夸奖，也可以轻微责备（但要保持友善）。',
        '你的回复应该像聊天一样自然，不要像机器人。',
        '',
        '重要：请以 JSON 格式回复。JSON 包含三个字段：',
        '  "message": 你对用户说的话（自然语言，适合直接发给用户）',
        '  "nextInterval": 建议下一次截屏的间隔，单位分钟。专注工作 10~30 分钟，摸鱼 3~5 分钟，休息 15~30 分钟，默认 5~10 分钟',
        '  "mood": 你的情绪态度 (encourage/warn/praise/neutral)',
        '', taskText, usageText, screenText, '',
        '请只输出 JSON，不要包含其他文字。JSON 示例：',
        '{"message":"看到你在认真学习，真棒！继续保持~","nextInterval":20,"mood":"praise"}'
      ].join('\n');

      var worldbookText = '';
      if (ctx.worldbooks && ctx.worldbooks.length > 0) {
        worldbookText = '【世界书参考】\n' + ctx.worldbooks.map(function (wb) { return (wb.title || wb.name || '') + ': ' + (wb.content || wb.description || ''); }).join('\n');
      }

      var messages = [{ role: 'system', content: systemPrompt + (worldbookText ? '\n' + worldbookText : '') }];
      messages.push({
        role: 'user',
        content: (ctx.screenshotBase64 ? '这是我的屏幕截图，请根据截图内容给我反馈。' : '请根据当前任务状态和使用情况给我一些监督反馈。') +
          '\n请以 JSON 格式回复。\n' + (ctx.usageData ? '使用情况：' + ctx.usageData : '') + '\n任务状态：' + taskText
      });

      return roche.ai.chat({ messages: messages, temperature: 0.8 }).then(function (result) {
        var text = (result && result.text) ? result.text : '';
        try {
          var clean = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          var parsed = JSON.parse(clean);
          return { message: parsed.message || text, nextInterval: (parsed.nextInterval || 5) * 60 * 1000, mood: parsed.mood || 'neutral' };
        } catch (e) {
          console.warn('[CharMonitor] AI 返回非 JSON 格式，使用原始文本');
          return { message: text, nextInterval: 5 * 60 * 1000, mood: 'neutral' };
        }
      }).then(function (parsed) {
        return storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (history) {
          history.push({ timestamp: now(), charResponse: parsed.message, mood: parsed.mood, screenshotBase64: ctx.screenshotBase64, usageData: ctx.usageData, tasksSnapshot: pendingTasks.map(function (t) { return t.title; }) });
          if (history.length > 500) history = history.slice(-500);
          return storageSet(roche, STORAGE_KEY_HISTORY, history).then(function () { return parsed; });
        });
      });
    },

    _handleResponse: function (response, roche, settings) {
      var conversationId = settings.conversationId, charId = settings.charId, charName = settings.charName || 'Char';
      if (!conversationId) { roche.ui.toast(response.message); return Promise.resolve({ nextInterval: response.nextInterval }); }
      return injectCharMessage(conversationId, response.message, charName, charId).then(function () {
        roche.ui.toast(response.message.substring(0, 100) + (response.message.length > 100 ? '...' : ''));
        return { nextInterval: response.nextInterval, sent: true };
      });
    }
  };

  // ============================
  //  AI 家教引擎
  // ============================

  var TutorEngine = {
    splitText: function (text, charsPerPage) {
      charsPerPage = charsPerPage || 2000;
      var pages = [], current = '', paragraphs = text.split(/\n\n+/);
      for (var i = 0; i < paragraphs.length; i++) {
        if ((current + paragraphs[i]).length > charsPerPage && current.length > 0) { pages.push(current.trim()); current = ''; }
        current += paragraphs[i] + '\n\n';
      }
      if (current.trim()) pages.push(current.trim());
      return pages;
    },

    generatePlan: function (roche, charId, title, pages, userGoal) {
      var personaPromise = charId
        ? roche.character.get(charId).then(function (c) { return c ? (c.persona || c.bio || '') : ''; }).catch(function () { return ''; })
        : Promise.resolve('');

      return personaPromise.then(function (persona) {
        var overview = pages.slice(0, Math.min(3, pages.length)).join('\n---\n'), totalPages = pages.length;
        var systemPrompt = [
          persona ? '【你的教学人设】\n' + persona + '\n' : '',
          '你是一位耐心、有趣的AI老师。请根据以下学习材料，为用户制定分步学习计划。',
          '', '材料标题: ' + (title || '未命名'), '总页数: ' + totalPages, '用户目标: ' + (userGoal || '掌握全部内容'),
          '', '=== 材料预览（前 3 页）===', overview, '',
          '=== 请以 JSON 格式返回学习计划 ===',
          '{ "planTitle": "学习计划标题", "summary": "材料概述（1-2句）",',
          '  "steps": [{ "stepNumber": 1, "title": "第1步标题", "description": "这一步学什么", "pages": "第1-3页", "exercise": "这一步的练习题或思考题" }],',
          '  "estimatedTotalTime": "预计总学习时间", "keyTakeaways": ["关键要点1", "关键要点2"] }',
          '', '请只返回 JSON。'
        ].join('\n');

        return roche.ai.chat({ messages: [{ role: 'system', content: systemPrompt }], temperature: 0.5 }).then(function (result) {
          var text = (result && result.text) ? result.text : '{}';
          try {
            text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
            return JSON.parse(text);
          } catch (e) {
            console.warn('[CharTutor] AI 计划 JSON 解析失败');
            return { planTitle: '学习计划', summary: '请查看材料内容', steps: pages.map(function (p, i) { return { stepNumber: i + 1, title: '第' + (i + 1) + '部分', description: '阅读并理解本页内容', pages: '第' + (i + 1) + '页' }; }), estimatedTotalTime: '视个人进度而定' };
          }
        });
      });
    },

    explainPage: function (roche, charId, planTitle, step, pageContent, userQuestion) {
      var personaPromise = charId
        ? roche.character.get(charId).then(function (c) { return c ? (c.persona || c.bio || '') : ''; }).catch(function () { return ''; })
        : Promise.resolve('');

      return personaPromise.then(function (persona) {
        var systemPrompt = [
          persona ? '【你的教学人设】\n' + persona + '\n' : '',
          '你是 ' + (persona ? '上述角色扮演的' : '一位') + 'AI老师，正在讲解课程"' + planTitle + '"',
          '当前步骤: ' + (step ? step.title : '未指定'),
          step ? '步骤说明: ' + (step.description || '') : '',
          '', '=== 当前要讲解的内容 ===', pageContent, '',
          '用户提问: ' + (userQuestion || '请讲解这部分内容'), '',
          '请用老师的方式，生动、有趣、易懂地讲解。如果人设中有特定说话风格，请保持一致。'
        ].join('\n');

        return roche.ai.chat({ messages: [{ role: 'system', content: systemPrompt }], temperature: 0.7 }).then(function (result) {
          return (result && result.text) ? result.text : '抱歉，讲解生成失败，请重试。';
        });
      });
    }
  };

  // ============================
  //  UI 渲染 - 通用组件
  // ============================

  function renderHeader(title, hasBack) {
    return '<div class="cm-header">' + (hasBack ? '<button class="cm-back-btn" id="cm-back">← 返回</button>' : '') + '<h2 class="cm-title">' + esc(title) + '</h2></div>';
  }
  function renderButton(text, id, cls) {
    return '<button class="cm-btn ' + (cls || '') + '" id="' + id + '">' + esc(text) + '</button>';
  }
  function renderBadge(text, cls) {
    return '<span class="cm-badge ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  // ============================
  //  App 1: 任务面板
  // ============================

  function mountTaskHome(container, roche) {
    var style = document.createElement('style'); style.textContent = getCSS(); container.appendChild(style);
    renderTaskHome(container, roche);
    return function () { container.replaceChildren(); };
  }

  function renderTaskHome(container, roche) {
    storageGet(roche, STORAGE_KEY_TASKS, []).then(function (tasks) {
      storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
        var running = MonitorEngine.isRunning(), pending = tasks.filter(function (t) { return t.status !== 'done'; }), done = tasks.filter(function (t) { return t.status === 'done'; });
        var h = '<div class="roche-plugin-char-monitor">';
        h += renderHeader('任务面板');
        h += '<div class="cm-status-bar"><div class="cm-status-item"><span class="cm-status-label">监督状态</span><span class="cm-status-value' + (running ? ' cm-status-active' : '') + '">' + (running ? '运行中(' + (MonitorEngine.getInterval() / 60000).toFixed(0) + '分钟)' : '未启动') + '</span></div><div class="cm-status-item"><span class="cm-status-label">待完成</span><span class="cm-status-value">' + pending.length + ' 项</span></div><div class="cm-status-item"><span class="cm-status-label">环境</span><span class="cm-status-value">' + (isAPK() ? 'APK' : 'Web') + '</span></div></div>';
        h += '<div class="cm-actions">' + renderButton('+ 新建任务', 'cm-new-task', 'cm-btn-primary');
        h += running ? renderButton('停止监督', 'cm-stop-monitor', 'cm-btn-danger') : renderButton('启动监督', 'cm-start-monitor', 'cm-btn-success');
        h += renderButton('监督记录', 'cm-view-history', 'cm-btn-outline') + '</div>';
        h += '<div class="cm-section"><h3 class="cm-section-title">待完成 (' + pending.length + ')</h3>';
        if (pending.length === 0) h += '<div class="cm-empty">暂无任务</div>';
        else pending.forEach(function (t) { h += renderTaskItem(t); });
        h += '</div>';
        if (done.length > 0) { h += '<div class="cm-section"><h3 class="cm-section-title">已完成 (' + done.length + ')</h3>'; done.forEach(function (t) { h += renderTaskItem(t); }); h += '</div>'; }
        h += '</div>';
        container.innerHTML = h;
        bindTaskHomeEvents(container, roche, tasks);
      });
    });
  }

  function renderTaskItem(t) {
    var isDone = t.status === 'done', pb = '';
    if (t.priority === 'high') pb = renderBadge('高', 'cm-badge-danger');
    else if (t.priority === 'medium') pb = renderBadge('中', 'cm-badge-warning');
    else pb = renderBadge('低', 'cm-badge-info');
    var dt = t.deadline ? '截止: ' + fmtDate(t.deadline) : '', od = t.deadline && t.deadline < now() && !isDone;
    return '<div class="cm-task-item' + (isDone ? ' cm-task-done' : '') + (od ? ' cm-task-overdue' : '') + '" data-id="' + t.id + '">' +
      '<div class="cm-task-check"><input type="checkbox" class="cm-task-checkbox" data-id="' + t.id + '"' + (isDone ? ' checked' : '') + '></div>' +
      '<div class="cm-task-body"><div class="cm-task-title">' + esc(t.title) + ' ' + pb + '</div>' + (t.description ? '<div class="cm-task-desc">' + esc(t.description) + '</div>' : '') +
      '<div class="cm-task-meta">' + (dt ? '<span class="' + (od ? 'cm-text-danger' : '') + '">' + dt + '</span>' : '') + (t.category ? '<span>' + esc(t.category) + '</span>' : '') + '</div></div>' +
      '<div class="cm-task-actions"><button class="cm-btn-small cm-btn-edit" data-id="' + t.id + '">编辑</button><button class="cm-btn-small cm-btn-delete" data-id="' + t.id + '">删除</button></div></div>';
  }

  function bindTaskHomeEvents(container, roche, tasks) {
    var nb = $id('cm-new-task'); if (nb) nb.onclick = function () { showTaskEditor(container, roche, null, function () { renderTaskHome(container, roche); }); };
    var sb = $id('cm-start-monitor'); if (sb) sb.onclick = function () { startMonitoring(container, roche); };
    var tb = $id('cm-stop-monitor'); if (tb) tb.onclick = function () { MonitorEngine.stop(); roche.ui.toast('监督已停止'); renderTaskHome(container, roche); };
    var hb = $id('cm-view-history'); if (hb) hb.onclick = function () { renderHistoryView(container, roche); };
    $qa('.cm-task-checkbox', container).forEach(function (cb) {
      cb.onchange = function () {
        var id = cb.getAttribute('data-id');
        storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) {
          for (var i = 0; i < ts.length; i++) { if (ts[i].id === id) { ts[i].status = cb.checked ? 'done' : 'pending'; ts[i].completedAt = cb.checked ? now() : null; break; } }
          return storageSet(roche, STORAGE_KEY_TASKS, ts);
        }).then(function () { renderTaskHome(container, roche); });
      };
    });
    $qa('.cm-btn-edit', container).forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id');
        storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) { var t = null; for (var i = 0; i < ts.length; i++) { if (ts[i].id === id) { t = ts[i]; break; } } if (t) showTaskEditor(container, roche, t, function () { renderTaskHome(container, roche); }); });
      };
    });
    $qa('.cm-btn-delete', container).forEach(function (b) {
      b.onclick = function () {
        roche.ui.confirm({ title: '确认删除', message: '确定删除这个任务吗？' }).then(function (ok) {
          if (!ok) return;
          var id = b.getAttribute('data-id');
          storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) { ts = ts.filter(function (t) { return t.id !== id; }); return storageSet(roche, STORAGE_KEY_TASKS, ts); }).then(function () { renderTaskHome(container, roche); });
        });
      };
    });
  }

  function showTaskEditor(container, roche, existingTask, onSave) {
    var ie = !!existingTask;
    var h = '<div class="roche-plugin-char-monitor">' + renderHeader(ie ? '编辑任务' : '新建任务') + '<div class="cm-form">';
    h += '<label class="cm-label">任务标题</label><input class="cm-input" id="cm-task-title" value="' + esc(existingTask ? existingTask.title : '') + '" placeholder="输入任务标题...">';
    h += '<label class="cm-label">描述</label><textarea class="cm-textarea" id="cm-task-desc" rows="3">' + esc(existingTask ? (existingTask.description || '') : '') + '</textarea>';
    h += '<label class="cm-label">截止日期</label><input class="cm-input" type="date" id="cm-task-deadline" value="' + (existingTask && existingTask.deadline ? fmtDate(existingTask.deadline) : '') + '">';
    var pv = existingTask ? (existingTask.priority || 'medium') : 'medium';
    h += '<label class="cm-label">优先级</label><select class="cm-select" id="cm-task-priority"><option value="high"' + (pv === 'high' ? ' selected' : '') + '>高</option><option value="medium"' + (pv === 'medium' ? ' selected' : '') + '>中</option><option value="low"' + (pv === 'low' ? ' selected' : '') + '>低</option></select>';
    h += '<label class="cm-label">分类</label><input class="cm-input" id="cm-task-category" value="' + esc(existingTask ? (existingTask.category || '') : '') + '" placeholder="学习、工作、生活...">';
    h += '<div class="cm-form-actions">' + renderButton(ie ? '保存修改' : '创建任务', 'cm-save-task', 'cm-btn-primary') + '</div></div></div>';
    container.innerHTML = h;
    $id('cm-save-task').onclick = function () {
      var title = ($id('cm-task-title').value || '').trim(); if (!title) { roche.ui.toast('请输入任务标题'); return; }
      var desc = ($id('cm-task-desc').value || '').trim(), ds = $id('cm-task-deadline').value || '', priority = $id('cm-task-priority').value || 'medium', cat = ($id('cm-task-category').value || '').trim();
      storageGet(roche, STORAGE_KEY_TASKS, []).then(function (tasks) {
        if (ie) { for (var i = 0; i < tasks.length; i++) { if (tasks[i].id === existingTask.id) { tasks[i].title = title; tasks[i].description = desc; tasks[i].deadline = ds ? new Date(ds + 'T23:59:59').getTime() : null; tasks[i].priority = priority; tasks[i].category = cat; tasks[i].updatedAt = now(); break; } } }
        else tasks.push({ id: uid(), title: title, description: desc, deadline: ds ? new Date(ds + 'T23:59:59').getTime() : null, priority: priority, category: cat, status: 'pending', createdAt: now(), updatedAt: now() });
        return storageSet(roche, STORAGE_KEY_TASKS, tasks);
      }).then(function () { roche.ui.toast(ie ? '任务已更新' : '任务已创建'); if (onSave) onSave(); });
    };
  }

  function startMonitoring(container, roche) {
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (s) {
      if (!s.charId && !s.conversationId) { roche.ui.toast('请先配置监督角色'); showSettings(container, roche); return; }
      MonitorEngine.start(roche, { conversationId: s.conversationId, charId: s.charId, charName: s.charName || 'Char', initialInterval: s.screenshotInterval || 5 * 60 * 1000 });
      if (isAPK()) window.nativeMonitorBridge.showFloatingBall().catch(function () {});
      roche.ui.toast('监督已启动！'); renderTaskHome(container, roche);
    });
  }

  function renderHistoryView(container, roche) {
    storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (history) {
      var h = '<div class="roche-plugin-char-monitor">' + renderHeader('监督记录') + '<div class="cm-section">';
      if (!history.length) h += '<div class="cm-empty">暂无监督记录</div>';
      else history.slice().reverse().forEach(function (r) {
        h += '<div class="cm-history-item"><div class="cm-history-time">' + fmtFull(r.timestamp) + '</div><div class="cm-history-mood">' + renderBadge(r.mood, 'cm-badge-' + (r.mood === 'praise' ? 'success' : r.mood === 'warn' ? 'danger' : 'info')) + '</div><div class="cm-history-text">' + esc(r.charResponse || r.message || '') + '</div>' + (r.tasksSnapshot && r.tasksSnapshot.length ? '<div class="cm-history-tasks">任务: ' + esc(r.tasksSnapshot.join(', ')) + '</div>' : '') + '</div>';
      });
      h += '</div><div class="cm-actions">' + renderButton('清空记录', 'cm-clear-history', 'cm-btn-danger') + '</div></div>';
      container.innerHTML = h;
      var cb = $id('cm-clear-history'); if (cb) cb.onclick = function () { roche.ui.confirm({ title: '确认清空', message: '确定清空所有监督记录吗？' }).then(function (ok) { if (ok) storageSet(roche, STORAGE_KEY_HISTORY, []).then(function () { renderHistoryView(container, roche); }); }); };
    });
  }

  function showSettings(container, roche) {
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (s) {
      roche.character.list().then(function (chars) {
        var h = '<div class="roche-plugin-char-monitor">' + renderHeader('监督设置') + '<div class="cm-form">';
        h += '<label class="cm-label">选择监督角色</label><select class="cm-select" id="cm-char-select"><option value="">-- 选择角色 --</option>';
        (chars || []).forEach(function (c) { h += '<option value="' + c.id + '"' + (c.id === s.charId ? ' selected' : '') + '>' + esc(c.handle || c.name || c.id) + '</option>'; });
        h += '</select><label class="cm-label">默认截图间隔(分钟)</label><select class="cm-select" id="cm-interval-select">';
        [1,3,5,10,15,20,30].forEach(function (m) { var cur = s.screenshotInterval ? s.screenshotInterval / 60000 : 5; h += '<option value="' + m + '"' + (m === cur ? ' selected' : '') + '>' + m + ' 分钟</option>'; });
        h += '</select><label class="cm-check-label"><input type="checkbox" id="cm-adaptive"' + (s.adaptiveTiming !== false ? ' checked' : '') + '> 启用自适应计时</label>';
        if (!isAPK()) h += '<div class="cm-notice">Web 环境不支持截屏和应用统计。安装 APK 版本可获得完整监督体验。</div>';
        h += '<div class="cm-form-actions">' + renderButton('保存设置', 'cm-save-settings', 'cm-btn-primary') + '</div></div></div>';
        container.innerHTML = h;
        $id('cm-save-settings').onclick = function () {
          var charId = $id('cm-char-select').value || '', interval = parseInt($id('cm-interval-select').value || '5', 10);
          var charName = ''; (chars || []).forEach(function (c) { if (c.id === charId) charName = c.handle || c.name || ''; });
          (charId ? roche.character.get(charId).then(function (c) { return c ? (c.conversationId || '') : ''; }).catch(function () { return ''; }) : Promise.resolve('')).then(function (convId) {
            return storageSet(roche, STORAGE_KEY_SETTINGS, { charId: charId, charName: charName, conversationId: convId, screenshotInterval: interval * 60 * 1000, adaptiveTiming: $id('cm-adaptive').checked });
          }).then(function () { if (isAPK()) window.nativeMonitorBridge.saveAIConfig({ charName: charName, charPersona: '', charAvatar: '', endpoint: '', key: '', model: '' }).catch(function () {}); roche.ui.toast('设置已保存'); renderTaskHome(container, roche); });
        };
      }).catch(function () { container.innerHTML = '<div class="roche-plugin-char-monitor">' + renderHeader('监督设置') + '<div class="cm-notice">无法读取角色列表</div></div>'; });
    });
  }

  // ============================
  //  App 2: AI 老师
  // ============================

  function mountTutor(container, roche) {
    var style = document.createElement('style'); style.textContent = getCSS(); container.appendChild(style);
    renderTutorHome(container, roche);
    return function () { container.replaceChildren(); };
  }

  function renderTutorHome(container, roche) {
    storageGet(roche, STORAGE_KEY_PLANS, []).then(function (plans) {
      var h = '<div class="roche-plugin-char-monitor">' + renderHeader('AI老师') + '<div class="cm-card cm-card-info"><p>导入文本内容，AI老师制定学习计划并逐页讲解。</p></div>';
      h += '<div class="cm-actions">' + renderButton('+ 新建学习计划', 'cm-new-plan', 'cm-btn-primary') + '</div>';
      h += '<div class="cm-section"><h3 class="cm-section-title">学习计划 (' + plans.length + ')</h3>';
      if (!plans.length) h += '<div class="cm-empty">暂未创建学习计划</div>';
      else plans.forEach(function (p) {
        h += '<div class="cm-plan-item"><div class="cm-plan-title">' + esc(p.title || '未命名') + '</div><div class="cm-plan-meta">' + (p.totalPages ? p.totalPages + ' 页 · ' : '') + '进度: ' + (p.currentStep || 0) + '/' + ((p.steps && p.steps.length) || '?') + ' · ' + fmtDate(p.createdAt) + '</div><div class="cm-task-actions"><button class="cm-btn-small cm-btn-primary-lt" data-id="' + p.id + '" data-action="open">开始学习</button><button class="cm-btn-small cm-btn-delete" data-id="' + p.id + '" data-action="delete">删除</button></div></div>';
      });
      h += '</div></div>';
      container.innerHTML = h;
      $id('cm-new-plan').onclick = function () { showTutorImport(container, roche); };
      $qa('.cm-btn-small', container).forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-id'), action = b.getAttribute('data-action');
          if (action === 'open') storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) { var p = null; for (var i = 0; i < ps.length; i++) { if (ps[i].id === id) { p = ps[i]; break; } } if (p) showTutorLearn(container, roche, p); });
          else roche.ui.confirm({ title: '确认删除', message: '确定删除吗？' }).then(function (ok) { if (ok) storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) { ps = ps.filter(function (x) { return x.id !== id; }); return storageSet(roche, STORAGE_KEY_PLANS, ps); }).then(function () { renderTutorHome(container, roche); }); });
        };
      });
    });
  }

  function showTutorImport(container, roche) {
    container.innerHTML = '<div class="roche-plugin-char-monitor">' + renderHeader('导入学习材料') + '<div class="cm-form"><label class="cm-label">标题</label><input class="cm-input" id="cm-plan-title" placeholder="如：高数第三章"><label class="cm-label">学习目标(可选)</label><input class="cm-input" id="cm-plan-goal" placeholder="如：掌握微积分基本概念"><label class="cm-label">粘贴文本内容</label><textarea class="cm-textarea" id="cm-plan-text" rows="10" placeholder="粘贴学习内容..."></textarea><div class="cm-form-actions">' + renderButton('生成学习计划', 'cm-gen-plan', 'cm-btn-primary') + '</div><div id="cm-gen-status" class="cm-status-msg" style="display:none"></div></div></div>';
    $id('cm-gen-plan').onclick = function () {
      var title = ($id('cm-plan-title').value || '').trim() || '未命名', goal = ($id('cm-plan-goal').value || '').trim(), text = ($id('cm-plan-text').value || '').trim();
      if (!text) { roche.ui.toast('请输入学习内容'); return; }
      $id('cm-gen-status').style.display = 'block'; $id('cm-gen-status').textContent = '正在生成学习计划...'; $id('cm-gen-plan').disabled = true;
      var pages = TutorEngine.splitText(text, 2000);
      storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (s) { return TutorEngine.generatePlan(roche, s.charId, title, pages, goal).then(function (plan) {
        var np = { id: uid(), title: title, sourceText: text, pages: pages, totalPages: pages.length, planData: plan, steps: plan.steps || [], currentStep: 0, createdAt: now() };
        return storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) { ps.push(np); return storageSet(roche, STORAGE_KEY_PLANS, ps).then(function () { return np; }); });
      }); }).then(function (np) { roche.ui.toast('学习计划已生成！'); showTutorLearn(container, roche, np); }).catch(function (e) { console.error(e); roche.ui.toast('生成失败'); $id('cm-gen-status').style.display = 'none'; $id('cm-gen-plan').disabled = false; });
    };
  }

  function showTutorLearn(container, roche, plan) {
    var steps = plan.steps || [], ci = plan.currentStep || 0, cs = steps[ci], cp = ci >= 0 && ci < (plan.pages || []).length ? (plan.pages || [])[ci] : '';
    var h = '<div class="roche-plugin-char-monitor">' + renderHeader(plan.title || '学习') + '<div class="cm-progress-bar"><div class="cm-progress-fill" style="width:' + (steps.length ? (ci / steps.length * 100) : 0) + '%"></div></div>';
    h += '<div class="cm-progress-text">步骤 ' + (ci + 1) + ' / ' + (steps.length || '?') + '</div>';
    if (cs) h += '<div class="cm-card cm-card-step"><h4>' + esc(cs.title || '步骤' + (ci + 1)) + '</h4><p>' + esc(cs.description || '') + '</p></div>';
    if (cp) h += '<div class="cm-card cm-card-content"><pre class="cm-content-text">' + esc(cp) + '</pre></div>';
    h += '<div class="cm-form"><label class="cm-label">向AI老师提问</label><textarea class="cm-textarea" id="cm-tutor-question" rows="2" placeholder="有疑问？问老师..."></textarea></div>';
    h += '<div id="cm-tutor-answer" class="cm-card cm-card-answer" style="display:none"><div class="cm-answer-content"></div></div>';
    h += '<div class="cm-actions">' + renderButton('问老师', 'cm-ask-teacher', 'cm-btn-primary');
    if (ci > 0) h += renderButton('上一步', 'cm-prev-step', 'cm-btn-outline');
    h += ci < steps.length - 1 ? renderButton('下一步', 'cm-next-step', 'cm-btn-success') : renderButton('完成学习', 'cm-finish-plan', 'cm-btn-success');
    h += '</div><div class="cm-section"><h3 class="cm-section-title">全部步骤</h3>';
    steps.forEach(function (s, i) { h += '<div class="cm-step-item' + (i === ci ? ' cm-step-active' : i < ci ? ' cm-step-done' : '') + '"><span class="cm-step-num">' + (i + 1) + '</span><span class="cm-step-name">' + esc(s.title || '步骤' + (i + 1)) + '</span>' + (i < ci ? '<span class="cm-step-check">✓</span>' : '') + '</div>'; });
    h += '</div></div>';
    container.innerHTML = h;

    $id('cm-ask-teacher').onclick = function () {
      var q = ($id('cm-tutor-question').value || '').trim(); if (!q) { roche.ui.toast('请输入问题'); return; }
      var ae = $id('cm-tutor-answer'), ac = $q('.cm-answer-content', ae); ae.style.display = 'block'; ac.textContent = '思考中...'; $id('cm-ask-teacher').disabled = true;
      storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (s) { return TutorEngine.explainPage(roche, s.charId, plan.title, cs, cp, q); }).then(function (r) { ac.textContent = r; $id('cm-ask-teacher').disabled = false; }).catch(function () { ac.textContent = '讲解失败，请重试'; $id('cm-ask-teacher').disabled = false; });
    };

    var saveStep = function (n) { return storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) { for (var i = 0; i < ps.length; i++) { if (ps[i].id === plan.id) { ps[i].currentStep = n; break; } } return storageSet(roche, STORAGE_KEY_PLANS, ps); }); };
    var prev = $id('cm-prev-step'); if (prev) prev.onclick = function () { saveStep(ci - 1).then(function () { plan.currentStep = ci - 1; showTutorLearn(container, roche, plan); }); };
    var next = $id('cm-next-step'); if (next) next.onclick = function () { saveStep(ci + 1).then(function () { plan.currentStep = ci + 1; showTutorLearn(container, roche, plan); }); };
    var fin = $id('cm-finish-plan'); if (fin) fin.onclick = function () { roche.ui.confirm({ title: '完成学习', message: '恭喜！标记为已完成？' }).then(function (ok) { if (ok) { plan.currentStep = steps.length; plan.completedAt = now(); saveStep(steps.length).then(function () { roche.ui.toast('学习完成！'); renderTutorHome(container, roche); }); } }); };
    $qa('.cm-step-item', container).forEach(function (el, i) { el.onclick = function () { saveStep(i).then(function () { plan.currentStep = i; showTutorLearn(container, roche, plan); }); }; el.style.cursor = 'pointer'; });
  }

  // ============================
  //  App 3: 监督陪跑
  // ============================

  function mountMonitor(container, roche) {
    var style = document.createElement('style'); style.textContent = getCSS(); container.appendChild(style);
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (s) {
      storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (hist) {
        storageGet(roche, STORAGE_KEY_USAGE, []).then(function (usageHist) {
          var running = MonitorEngine.isRunning(), intv = MonitorEngine.getInterval();
          var h = '<div class="roche-plugin-char-monitor">' + renderHeader('监督陪跑');
          h += '<div class="cm-card cm-card-status' + (running ? ' cm-card-active' : '') + '"><div class="cm-status-icon">' + (running ? '👁' : '😴') + '</div><div class="cm-status-big">' + (running ? '监督运行中' : '监督未启动') + '</div><div class="cm-status-detail">';
          h += running ? ('截图间隔: ' + (intv / 60000).toFixed(0) + '分钟 · 角色: ' + esc(s.charName || '未设置') + ' · 监督次数: ' + hist.length) : '前往任务面板启动监督';
          h += '</div></div>';
          if (usageHist.length > 0) { var latest = usageHist[usageHist.length - 1]; h += '<div class="cm-section"><h3 class="cm-section-title">最近使用统计</h3><div class="cm-card"><pre class="cm-content-text">' + esc(latest.data || '无') + '</pre></div><div class="cm-meta">获取时间: ' + fmtFull(latest.timestamp) + '</div></div>'; }
          else h += '<div class="cm-notice">' + (isAPK() ? '尚无统计数据，启动监督后自动收集' : 'Web 环境暂不支持使用统计') + '</div>';
          h += '<div class="cm-actions">' + (running ? renderButton('停止监督', 'cm-mon-stop', 'cm-btn-danger') : '') + renderButton('打开任务面板', 'cm-mon-goto-home', 'cm-btn-outline') + '</div></div>';
          container.innerHTML = h;
          var st = $id('cm-mon-stop'); if (st) st.onclick = function () { MonitorEngine.stop(); roche.ui.toast('监督已停止'); mountMonitor(container, roche); };
          var gh = $id('cm-mon-goto-home'); if (gh) gh.onclick = function () { renderTaskHome(container, roche); };
        });
      });
    });
    return function () { container.replaceChildren(); };
  }

  // ============================
  //  CSS 样式
  // ============================

  function getCSS() {
    return '.roche-plugin-char-monitor{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e0e0e0;background:#1a1a2e;min-height:100vh;padding:0;box-sizing:border-box}.roche-plugin-char-monitor *,.roche-plugin-char-monitor *::before,.roche-plugin-char-monitor *::after{box-sizing:border-box}.cm-header{display:flex;align-items:center;padding:16px;background:#16213e;border-bottom:1px solid #0f3460}.cm-back-btn{background:none;border:1px solid #0f3460;color:#e0e0e0;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:14px;margin-right:12px}.cm-back-btn:hover{background:#0f3460}.cm-title{margin:0;font-size:18px;font-weight:600}.cm-status-bar{display:flex;padding:12px 16px;gap:12px;background:#16213e;border-bottom:1px solid #0f3460}.cm-status-item{flex:1;text-align:center}.cm-status-label{display:block;font-size:11px;color:#888;margin-bottom:4px}.cm-status-value{font-size:14px;font-weight:600}.cm-status-active{color:#4ecca3}.cm-card{background:#16213e;border-radius:12px;padding:16px;margin:12px 16px;border:1px solid #0f3460}.cm-card-info{background:#1a1a3e}.cm-card-info p{margin:0;font-size:13px;color:#aaa;line-height:1.6}.cm-card-status{text-align:center}.cm-card-active{border-color:#4ecca3}.cm-card-step{background:#1a2744}.cm-card-step h4{margin:0 0 8px;color:#4ecca3}.cm-card-step p{margin:0;color:#ccc}.cm-card-answer{background:#1a2744;border-color:#4ecca3}.cm-status-icon{font-size:32px;margin-bottom:8px}.cm-status-big{font-size:18px;font-weight:600;margin-bottom:4px}.cm-status-detail{font-size:12px;color:#888}.cm-actions{display:flex;gap:8px;padding:12px 16px;flex-wrap:wrap}.cm-btn{padding:10px 16px;border-radius:8px;border:none;cursor:pointer;font-size:14px;font-weight:500}.cm-btn-primary{background:#4ecca3;color:#1a1a2e}.cm-btn-success{background:#2d6a4f;color:#e0e0e0}.cm-btn-danger{background:#c0392b;color:#e0e0e0}.cm-btn-outline{background:transparent;color:#4ecca3;border:1px solid #4ecca3}.cm-btn-small{padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px}.cm-btn-edit{background:#2c3e50;color:#e0e0e0}.cm-btn-delete{background:#3d201d;color:#e74c3c}.cm-btn-primary-lt{background:#4ecca3;color:#1a1a2e}.cm-form{padding:16px}.cm-label{display:block;font-size:13px;color:#aaa;margin-bottom:6px;margin-top:12px}.cm-input,.cm-textarea,.cm-select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #0f3460;background:#16213e;color:#e0e0e0;font-size:14px}.cm-input:focus,.cm-textarea:focus,.cm-select:focus{outline:none;border-color:#4ecca3}.cm-textarea{resize:vertical}.cm-check-label{display:flex;align-items:center;gap:8px;font-size:13px;color:#aaa;margin-top:12px;cursor:pointer}.cm-form-actions{margin-top:16px}.cm-meta{font-size:11px;color:#666;padding:4px 16px}.cm-task-item{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-bottom:1px solid #0f3460}.cm-task-item:last-child{border-bottom:none}.cm-task-done{opacity:.5}.cm-task-done .cm-task-title{text-decoration:line-through}.cm-task-overdue{border-left:3px solid #e74c3c}.cm-task-check{padding-top:2px}.cm-task-checkbox{width:18px;height:18px;accent-color:#4ecca3;cursor:pointer}.cm-task-body{flex:1;min-width:0}.cm-task-title{font-size:15px;font-weight:500;margin-bottom:4px}.cm-task-desc{font-size:12px;color:#888;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cm-task-meta{font-size:11px;color:#666;display:flex;gap:8px}.cm-task-actions{display:flex;gap:4px;flex-shrink:0}.cm-text-danger{color:#e74c3c}.cm-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}.cm-badge-danger{background:#3d201d;color:#e74c3c}.cm-badge-warning{background:#3d3420;color:#f39c12}.cm-badge-info{background:#1a2a3d;color:#3498db}.cm-badge-success{background:#1d3d2c;color:#4ecca3}.cm-progress-bar{height:4px;background:#0f3460;margin:0 16px;border-radius:2px;overflow:hidden}.cm-progress-fill{height:100%;background:linear-gradient(90deg,#4ecca3,#2d6a4f);transition:width .3s}.cm-progress-text{text-align:center;font-size:12px;color:#888;padding:4px 0 12px}.cm-section{padding:0 16px 12px}.cm-section-title{font-size:14px;color:#888;margin:12px 0 8px;text-transform:uppercase;letter-spacing:.5px}.cm-empty{text-align:center;color:#555;padding:32px 16px;font-size:14px}.cm-notice{background:#2c3e20;border:1px solid #4ecca3;border-radius:8px;padding:12px;margin:12px 16px;font-size:12px;color:#aaa}.cm-content-text{color:#ccc;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit}.cm-status-msg{text-align:center;padding:12px;color:#4ecca3;font-size:13px}.cm-history-item{padding:12px 0;border-bottom:1px solid #0f3460}.cm-history-item:last-child{border-bottom:none}.cm-history-time{font-size:11px;color:#555;margin-bottom:4px}.cm-history-mood{margin-bottom:4px}.cm-history-text{font-size:13px;color:#ccc;line-height:1.6}.cm-history-tasks{font-size:11px;color:#555;margin-top:4px}.cm-plan-item{padding:12px 0;border-bottom:1px solid #0f3460}.cm-plan-item:last-child{border-bottom:none}.cm-plan-title{font-size:15px;font-weight:500;margin-bottom:4px}.cm-plan-meta{font-size:12px;color:#666;margin-bottom:8px}.cm-step-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;margin-bottom:4px;border:1px solid transparent}.cm-step-active{background:#1a2744;border-color:#4ecca3}.cm-step-done{color:#888}.cm-step-num{width:24px;height:24px;border-radius:50%;background:#0f3460;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}.cm-step-active .cm-step-num{background:#4ecca3;color:#1a1a2e}.cm-step-name{font-size:13px;flex:1}.cm-step-check{color:#4ecca3}';
  }

  // ============================
  //  插件注册
  // ============================

  window.RochePlugin.register({
    id: 'char-task-monitor',
    name: 'Char任务监督陪伴',
    version: '1.0.0',
    apps: [
      {
        id: 'char-task-monitor-home',
        name: '任务面板',
        icon: 'task_alt',
        iconImage: '',
        async mount(container, roche) { return mountTaskHome(container, roche); },
        async unmount(container, roche) { container.replaceChildren(); }
      },
      {
        id: 'char-task-monitor-tutor',
        name: 'AI老师',
        icon: 'school',
        iconImage: '',
        async mount(container, roche) { return mountTutor(container, roche); },
        async unmount(container, roche) { container.replaceChildren(); }
      },
      {
        id: 'char-task-monitor-monitor',
        name: '监督陪跑',
        icon: 'visibility',
        iconImage: '',
        async mount(container, roche) { return mountMonitor(container, roche); },
        async unmount(container, roche) { container.replaceChildren(); }
      }
    ]
  });

  console.log('[CharTaskMonitor] 插件已注册 v1.0.0');
  console.log('  - 任务面板 (char-task-monitor-home)');
  console.log('  - AI老师 (char-task-monitor-tutor)');
  console.log('  - 监督陪跑 (char-task-monitor-monitor)');
  console.log('  环境: ' + (isAPK() ? 'APK (支持截屏+使用统计)' : 'Web (仅任务+记忆反馈)'));

})();