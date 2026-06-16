/**
 * ============================================================
 *  Char任务监督陪伴插件 v1.1.0
 *  Roche 全信任 JS 插件
 *
 *  功能：
 *    1. 任务面板 — 创建/管理任务与日程
 *    2. 监督陪跑 — 定时截屏 + AI分析 + 聊天记忆注入
 *    3. AI老师   — 导入文本/文件，AI规划分步讲解
 *    4. 音频保活 — 通过原生 BackgroundAudioService 播放静默音频保持后台运行
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
  var STORAGE_KEY_AUDIO_KEEPALIVE = 'char_monitor_audio_keepalive';

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

  /**
   * 注入用户消息到指定会话
   */
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
    return addMessage(msg).then(function () {
      triggerRefresh();
    });
  }

  /**
   * 注入 char 消息到指定会话
   */
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
    return addMessage(msg).then(function () {
      triggerRefresh();
    });
  }

  /**
   * 注入系统通知到指定会话
   */
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
    return addMessage(msg).then(function () {
      triggerRefresh();
    });
  }

  function triggerRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('roche-data-changed', { detail: { source: 'char-task-monitor' } }));
    } catch (e) { }
  }

  // ============================
  //  存储帮助函数（用 roche.storage）
  // ============================

  function storageGet(roche, key, fallback) {
    try {
      return roche.storage.get(key).then(function (v) {
        return v !== null && v !== undefined ? v : (fallback !== undefined ? fallback : null);
      }).catch(function () {
        return fallback !== undefined ? fallback : null;
      });
    } catch (e) {
      return Promise.resolve(fallback !== undefined ? fallback : null);
    }
  }

  function storageSet(roche, key, value) {
    try {
      return roche.storage.set(key, value);
    } catch (e) {
      return Promise.resolve();
    }
  }

  // ============================
  //  环境检测
  // ============================

  function isAPK() {
    try {
      return !!(window.nativeMonitorBridge && window.nativeMonitorBridge.__ready);
    } catch (e) { return false; }
  }

  function isAudioBridgeAvailable() {
    try {
      return !!(window.nativeAudioBridge && window.nativeAudioBridge.__ready);
    } catch (e) { return false; }
  }

  // ============================
  //  音频保活
  // ============================

  var AudioKeepAlive = {
    _active: false,

    isActive: function () {
      return this._active;
    },

    start: function (roche) {
      var self = this;
      if (!isAudioBridgeAvailable()) {
        return Promise.reject(new Error('音频桥不可用'));
      }
      return window.nativeAudioBridge.replaceQueue([{
        id: 'keepalive',
        title: 'Roche保活',
        artist: '',
        url: 'https://raw.githubusercontent.com/yechen1844/char-task-monitor/main/silence.wav'
      }], 0, 'loop', true).then(function () {
        self._active = true;
        if (roche) storageSet(roche, STORAGE_KEY_AUDIO_KEEPALIVE, true);
        console.log('[CharMonitor] 音频保活已启动');
      });
    },

    stop: function (roche) {
      var self = this;
      if (!isAudioBridgeAvailable()) {
        self._active = false;
        return Promise.resolve();
      }
      return window.nativeAudioBridge.stop().then(function () {
        self._active = false;
        if (roche) storageSet(roche, STORAGE_KEY_AUDIO_KEEPALIVE, false);
        console.log('[CharMonitor] 音频保活已停止');
      }).catch(function () {
        self._active = false;
        if (roche) storageSet(roche, STORAGE_KEY_AUDIO_KEEPALIVE, false);
      });
    },

    restoreState: function (roche) {
      var self = this;
      return storageGet(roche, STORAGE_KEY_AUDIO_KEEPALIVE, false).then(function (saved) {
        if (saved && isAudioBridgeAvailable()) {
          return self.start(roche).catch(function () {});
        }
        self._active = false;
      });
    }
  };

  // ============================
  //  监督引擎（核心）
  // ============================

  var MonitorEngine = {
    _timer: null,
    _running: false,
    _roche: null,
    _currentInterval: 5 * 60 * 1000, // 默认 5 分钟

    /**
     * 启动监督引擎
     * @param {object} roche - scoped roche API
     * @param {object} settings - {conversationId, charId, charName, initialInterval}
     */
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

    isRunning: function () {
      return this._running;
    },

    getInterval: function () {
      return this._currentInterval;
    },

    setInterval: function (ms) {
      this._currentInterval = ms;
    },

    _scheduleNext: function () {
      var self = this;
      if (!this._running) return;
      this._timer = setTimeout(function () {
        self._tick();
      }, this._currentInterval);
    },

    _tick: function () {
      var self = this;
      if (!self._running) return;
      console.log('[CharMonitor] 截屏监督触发 ' + fmtFull(now()));

      self._doCaptureAndAnalyze()
        .then(function (result) {
          // 更新下一次间隔（char 可能建议新间隔）
          if (result.nextInterval && result.nextInterval > 0) {
            self._currentInterval = result.nextInterval;
          }
        })
        .catch(function (err) {
          console.error('[CharMonitor] 监督轮次失败:', err);
        })
        .finally(function () {
          self._scheduleNext();
        });
    },

    _doCaptureAndAnalyze: function () {
      var self = this;
      var roche = self._roche;
      var settings = self._settings;
      var conversationId = settings.conversationId;
      var charId = settings.charId;
      var charName = settings.charName || 'Char';

      // 1. 截图（APK 环境）
      var capturePromise;
      if (isAPK()) {
        capturePromise = window.nativeMonitorBridge.captureScreen()
          .then(function (res) { return res && res.image ? res.image : null; })
          .catch(function () { return null; });
      } else {
        capturePromise = Promise.resolve(null);
      }

      // 2. 获取 App 使用统计（APK 环境）
      var usagePromise;
      if (isAPK()) {
        usagePromise = window.nativeMonitorBridge.getAppUsageStats()
          .then(function (res) { return res && res.data ? res.data : null; })
          .catch(function () { return null; });
      } else {
        usagePromise = Promise.resolve(null);
      }

      // 3. 获取用户任务
      var tasksPromise = storageGet(roche, STORAGE_KEY_TASKS, []);

      // 4. 获取 char 人设
      var personaPromise = Promise.resolve('');
      if (charId) {
        personaPromise = roche.character.get(charId)
          .then(function (c) { return c ? (c.persona || c.bio || '') : ''; })
          .catch(function () { return ''; });
      }

      // 5. 获取世界书
      var worldbookPromise = roche.worldbook.list()
        .then(function (list) { return list || []; })
        .catch(function () { return []; });

      // 6. 获取长期记忆
      var memoryPromise = Promise.resolve('');
      if (conversationId) {
        memoryPromise = roche.memory.getLongTerm({ conversationId: conversationId, limit: 20 })
          .then(function (mem) {
            var parts = [];
            if (mem && mem.core) parts.push(mem.core.summary || '');
            if (mem && mem.facts) {
              for (var i = 0; i < mem.facts.length; i++) {
                parts.push(mem.facts[i].summaryText || mem.facts[i].action || '');
              }
            }
            return parts.filter(Boolean).join('\n');
          })
          .catch(function () { return ''; });
      }

      return Promise.all([capturePromise, usagePromise, tasksPromise, personaPromise, worldbookPromise, memoryPromise])
        .then(function (results) {
          var screenshotBase64 = results[0];
          var usageData = results[1];
          var tasks = results[2];
          var persona = results[3];
          var worldbooks = results[4];
          var longMemory = results[5];

          // 保存使用数据
          if (usageData) {
            return storageGet(roche, STORAGE_KEY_USAGE, []).then(function (prevUsage) {
              prevUsage.push({ timestamp: now(), data: usageData });
              // 只保留最近 200 条
              if (prevUsage.length > 200) prevUsage = prevUsage.slice(-200);
              return storageSet(roche, STORAGE_KEY_USAGE, prevUsage);
            }).then(function () {
              return { screenshotBase64: screenshotBase64, usageData: usageData, tasks: tasks, persona: persona, worldbooks: worldbooks, longMemory: longMemory };
            });
          }
          return { screenshotBase64: screenshotBase64, usageData: usageData, tasks: tasks, persona: persona, worldbooks: worldbooks, longMemory: longMemory };
        })
        .then(function (ctx) {
          // 构建 AI 分析 prompt
          return self._buildPromptAndAnalyze(ctx, roche, settings);
        })
        .then(function (response) {
          // 处理 AI 回复
          return self._handleResponse(response, roche, settings);
        });
    },

    _buildPromptAndAnalyze: function (ctx, roche, settings) {
      var charName = settings.charName || 'Char';
      var conversationId = settings.conversationId;
      var userName = settings.userName || '用户';

      // 构建未完成任务列表文本
      var tasks = ctx.tasks || [];
      var pendingTasks = tasks.filter(function (t) { return t.status !== 'done'; });
      var taskText = '';
      if (pendingTasks.length > 0) {
        taskText = '【用户当前未完成任务】\n';
        pendingTasks.forEach(function (t, i) {
          taskText += (i + 1) + '. ' + t.title + (t.deadline ? ' (截止: ' + fmtDate(t.deadline) + ')' : '') + '\n';
        });
      } else if (tasks.length === 0) {
        taskText = '【用户当前没有创建任何任务】\n';
      } else {
        taskText = '【用户所有任务已完成】\n';
      }

      // 应用使用情况
      var usageText = '';
      if (ctx.usageData) {
        usageText = '【用户当前设备使用情况】\n' + ctx.usageData + '\n';
      }

      // 头像描述
      var screenText = '';
      if (ctx.screenshotBase64) {
        screenText = '【屏幕截图已提供】（base64图片数据在消息中）\n';
      } else {
        screenText = '【注意：当前环境不支持截屏，请根据任务和使用情况给出反馈】\n';
      }

      // 记忆
      var memoryText = ctx.longMemory ? '【与用户的长期记忆】\n' + ctx.longMemory + '\n' : '';

      var systemPrompt = [
        '你是' + charName + '，你的任务是监督和陪伴' + userName + '。',
        '',
        ctx.persona ? '【你的人设】\n' + ctx.persona : '',
        '',
        memoryText,
        '',
        '=== 监督任务说明 ===',
        '你是一位贴心的监督伙伴，负责帮助用户保持专注、完成任务。',
        '请根据用户的屏幕截图和应用使用情况，给出自然、温柔但有立场的反馈。',
        '你可以：鼓励、提醒、夸奖，也可以轻微责备（但要保持友善）。',
        '你的回复应该像聊天一样自然，不要像机器人。',
        '',
        '重要：请以 JSON 格式回复。JSON 包含三个字段：',
        '  "message": 你对用户说的话（自然语言，适合直接发给用户，不要带任何元信息标记）',
        '  "nextInterval": 建议下一次截屏的间隔，单位分钟。根据你对用户当前状态的判断来决定：',
        '    - 如果用户在专注工作/学习：建议 10~30 分钟',
        '    - 如果用户在摸鱼/刷社交媒体：建议 3~5 分钟',
        '    - 如果用户在休息/吃饭：建议 15~30 分钟',
        '    - 默认情况：5~10 分钟',
        '  "mood": 你的情绪态度 (encourage/warn/praise/neutral)',
        '',
        taskText,
        usageText,
        screenText,
        '',
        '请只输出 JSON，不要包含其他文字。JSON 示例：',
        '{"message":"看到你在认真学习，真棒！继续保持~","nextInterval":20,"mood":"praise"}'
      ].join('\n');

      // 构建世界书文本
      var worldbookText = '';
      if (ctx.worldbooks && ctx.worldbooks.length > 0) {
        worldbookText = '【世界书参考】\n' + ctx.worldbooks.map(function (wb) {
          return (wb.title || wb.name || '') + ': ' + (wb.content || wb.description || '');
        }).join('\n');
      }

      var messages = [
        { role: 'system', content: systemPrompt + (worldbookText ? '\n' + worldbookText : '') }
      ];

      if (ctx.screenshotBase64) {
        // 有截屏时，作为 user message 附加描述
        messages.push({
          role: 'user',
          content: '这是我的屏幕截图（base64），请根据截图内容给我反馈。请以 JSON 格式回复。\n' +
            (ctx.usageData ? '使用情况：' + ctx.usageData : '') +
            '\n任务状态：' + taskText
        });
      } else {
        messages.push({
          role: 'user',
          content: '请根据当前任务状态和使用情况给我一些监督反馈。请以 JSON 格式回复。\n' +
            (ctx.usageData ? '使用情况：' + ctx.usageData : '') +
            '\n任务状态：' + taskText
        });
      }

      return roche.ai.chat({
        messages: messages,
        temperature: 0.8
      }).then(function (result) {
        var text = (result && result.text) ? result.text : '';
        // 尝试解析 JSON
        try {
          // 清理可能的 markdown 代码块包装
          var clean = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          var parsed = JSON.parse(clean);
          return {
            message: parsed.message || text,
            nextInterval: (parsed.nextInterval || 5) * 60 * 1000,
            mood: parsed.mood || 'neutral'
          };
        } catch (e) {
          // JSON 解析失败，用全部文本作为消息
          console.warn('[CharMonitor] AI 返回非 JSON 格式，使用原始文本');
          return {
            message: text,
            nextInterval: 5 * 60 * 1000,
            mood: 'neutral'
          };
        }
      }).then(function (parsed) {
        // 存储聊天记录到轮次历史
        return storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (history) {
          history.push({
            timestamp: now(),
            charResponse: parsed.message,
            mood: parsed.mood,
            screenshotBase64: ctx.screenshotBase64,
            usageData: ctx.usageData,
            tasksSnapshot: pendingTasks.map(function (t) { return t.title; })
          });
          if (history.length > 500) history = history.slice(-500);
          return storageSet(roche, STORAGE_KEY_HISTORY, history).then(function () {
            return parsed;
          });
        });
      });
    },

    _handleResponse: function (response, roche, settings) {
      var conversationId = settings.conversationId;
      var charId = settings.charId;
      var charName = settings.charName || 'Char';

      if (!conversationId) {
        // 无会话，仅 toast
        roche.ui.toast(response.message);
        return Promise.resolve({ nextInterval: response.nextInterval });
      }

      // 注入消息到会话
      return injectCharMessage(conversationId, response.message, charName, charId)
        .then(function () {
          roche.ui.toast(response.message.substring(0, 100) + (response.message.length > 100 ? '...' : ''));
          return { nextInterval: response.nextInterval, sent: true };
        });
    }
  };

  // ============================
  //  AI 家教引擎
  // ============================

  var TutorEngine = {
    /**
     * 分割文本为页
     */
    splitText: function (text, charsPerPage) {
      charsPerPage = charsPerPage || 2000;
      var pages = [];
      var current = '';
      var paragraphs = text.split(/\n\n+/);
      for (var i = 0; i < paragraphs.length; i++) {
        if ((current + paragraphs[i]).length > charsPerPage && current.length > 0) {
          pages.push(current.trim());
          current = '';
        }
        current += paragraphs[i] + '\n\n';
      }
      if (current.trim()) pages.push(current.trim());
      return pages;
    },

    /**
     * 调用 AI 生成学习计划
     */
    generatePlan: function (roche, charId, title, pages, userGoal) {
      var personaPromise = Promise.resolve('');
      if (charId) {
        personaPromise = roche.character.get(charId)
          .then(function (c) { return c ? (c.persona || c.bio || '') : ''; })
          .catch(function () { return ''; });
      }

      return personaPromise.then(function (persona) {
        // 取前几页做概览（避免 token 过多）
        var overview = pages.slice(0, Math.min(3, pages.length)).join('\n---\n');
        var totalPages = pages.length;

        var systemPrompt = [
          persona ? '【你的教学人设】\n' + persona + '\n' : '',
          '你是一位耐心、有趣的AI老师。请根据以下学习材料，为用户制定分步学习计划。',
          '',
          '材料标题: ' + (title || '未命名'),
          '总页数: ' + totalPages,
          '用户目标: ' + (userGoal || '掌握全部内容'),
          '',
          '=== 材料预览（前 3 页）===',
          overview,
          '',
          '=== 请以 JSON 格式返回学习计划 ===',
          '格式：',
          '{',
          '  "planTitle": "学习计划标题",',
          '  "summary": "材料概述（1-2句）",',
          '  "steps": [',
          '    {',
          '      "stepNumber": 1,',
          '      "title": "第1步标题",',
          '      "description": "这一步学什么",',
          '      "pages": "第1-3页",',
          '      "exercise": "这一步的练习题或思考题"',
          '    }',
          '  ],',
          '  "estimatedTotalTime": "预计总学习时间",',
          '  "keyTakeaways": ["关键要点1", "关键要点2"]',
          '}',
          '',
          '请只返回 JSON。'
        ].join('\n');

        return roche.ai.chat({
          messages: [{ role: 'system', content: systemPrompt }],
          temperature: 0.5
        }).then(function (result) {
          var text = (result && result.text) ? result.text : '{}';
          try {
            text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
            return JSON.parse(text);
          } catch (e) {
            console.warn('[CharTutor] AI 计划 JSON 解析失败');
            return {
              planTitle: '学习计划',
              summary: '请查看材料内容',
              steps: pages.map(function (p, i) {
                return {
                  stepNumber: i + 1,
                  title: '第' + (i + 1) + '部分',
                  description: '阅读并理解本页内容',
                  pages: '第' + (i + 1) + '页'
                };
              }),
              estimatedTotalTime: '视个人进度而定'
            };
          }
        });
      });
    },

    /**
     * 调用 AI 讲解当前页
     */
    explainPage: function (roche, charId, planTitle, step, pageContent, userQuestion) {
      var personaPromise = Promise.resolve('');
      if (charId) {
        personaPromise = roche.character.get(charId)
          .then(function (c) { return c ? (c.persona || c.bio || '') : ''; })
          .catch(function () { return ''; });
      }

      return personaPromise.then(function (persona) {
        var systemPrompt = [
          persona ? '【你的教学人设】\n' + persona + '\n' : '',
          '你是 ' + (persona ? '上述角色扮演的' : '一位') + 'AI老师，正在讲解课程"' + planTitle + '"',
          '当前步骤: ' + (step ? step.title : '未指定'),
          step ? '步骤说明: ' + (step.description || '') : '',
          '',
          '=== 当前要讲解的内容 ===',
          pageContent,
          '',
          '用户提问: ' + (userQuestion || '请讲解这部分内容'),
          '',
          '请用老师的方式，生动、有趣、易懂地讲解。如果人设中有特定说话风格，请保持一致。'
        ].join('\n');

        return roche.ai.chat({
          messages: [{ role: 'system', content: systemPrompt }],
          temperature: 0.7
        }).then(function (result) {
          return (result && result.text) ? result.text : '抱歉，讲解生成失败，请重试。';
        });
      });
    }
  };

  // ============================
  //  UI 渲染 - 通用组件
  // ============================

  /**
   * renderHeader - 生成头部 HTML
   * @param {string} title - 标题
   * @param {boolean} showClose - 是否显示关闭按钮（主页面用）
   * @param {boolean} showBack - 是否显示返回按钮（子页面用）
   */
  function renderHeader(title, showClose, showBack) {
    var html = '<div class="cm-header">';
    if (showBack) {
      html += '<button class="cm-back-btn" id="cm-back">&#8592; 返回</button>';
    }
    html += '<h2 class="cm-title">' + esc(title) + '</h2>';
    if (showClose) {
      html += '<button class="cm-close-btn" id="cm-close">&#10005;</button>';
    }
    html += '</div>';
    return html;
  }

  function renderButton(text, id, cls, extra) {
    return '<button class="cm-btn ' + (cls || '') + '" id="' + id + '" ' + (extra || '') + '>' + esc(text) + '</button>';
  }

  function renderCard(cls, content) {
    return '<div class="cm-card ' + (cls || '') + '">' + content + '</div>';
  }

  function renderBadge(text, cls) {
    return '<span class="cm-badge ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  /**
   * 绑定关闭按钮事件（每个页面通用）
   */
  function bindCloseBtn(roche) {
    var closeBtn = $id('cm-close');
    if (closeBtn) {
      closeBtn.onclick = function () { roche.ui.closeApp(); };
    }
  }

  // ============================
  //  App 1: 任务面板
  // ============================

  function mountTaskHome(container, roche) {
    renderTaskHome(container, roche);

    // 恢复音频保活状态
    AudioKeepAlive.restoreState(roche);

    return function unmount() {
      container.replaceChildren();
    };
  }

  function renderTaskHome(container, roche) {
    storageGet(roche, STORAGE_KEY_TASKS, []).then(function (tasks) {
      storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
        var monitorRunning = MonitorEngine.isRunning();
        var audioKeepAliveActive = AudioKeepAlive.isActive();
        var audioBridgeAvailable = isAudioBridgeAvailable();
        var pending = tasks.filter(function (t) { return t.status !== 'done'; });
        var done = tasks.filter(function (t) { return t.status === 'done'; });

        var html = '<div class="roche-plugin-char-monitor">';
        // CSS 内联到 innerHTML 中
        html += '<style>' + getCSS() + '</style>';

        // Header - 主页面显示关闭按钮
        html += renderHeader('任务面板', true, false);

        // 状态栏
        html += '<div class="cm-status-bar">';
        html += '<div class="cm-status-item">';
        html += '<span class="cm-status-label">监督状态</span>';
        html += '<span class="cm-status-value ' + (monitorRunning ? 'cm-status-active' : '') + '">' +
          (monitorRunning ? '运行中 (间隔' + (MonitorEngine.getInterval() / 60000).toFixed(0) + '分钟)' : '未启动') +
          '</span>';
        html += '</div>';
        html += '<div class="cm-status-item">';
        html += '<span class="cm-status-label">待完成任务</span>';
        html += '<span class="cm-status-value">' + pending.length + ' 项</span>';
        html += '</div>';
        html += '<div class="cm-status-item">';
        html += '<span class="cm-status-label">环境</span>';
        html += '<span class="cm-status-value">' + (isAPK() ? 'APK' : 'Web') + '</span>';
        html += '</div>';
        html += '</div>';

        // 音频保活开关（仅在音频桥可用时显示）
        if (audioBridgeAvailable) {
          html += '<div class="cm-keepalive-bar">';
          html += '<span class="cm-keepalive-label">音频保活</span>';
          html += '<label class="cm-switch">';
          html += '<input type="checkbox" id="cm-audio-keepalive" ' + (audioKeepAliveActive ? 'checked' : '') + '>';
          html += '<span class="cm-switch-slider"></span>';
          html += '</label>';
          html += '<span class="cm-keepalive-status ' + (audioKeepAliveActive ? 'cm-status-active' : '') + '">' +
            (audioKeepAliveActive ? '运行中' : '已关闭') + '</span>';
          html += '</div>';
        }

        // 快速操作按钮
        html += '<div class="cm-actions">';
        html += renderButton('+ 新建任务', 'cm-new-task', 'cm-btn-primary');
        if (!monitorRunning) {
          html += renderButton('启动监督', 'cm-start-monitor', 'cm-btn-success');
        } else {
          html += renderButton('停止监督', 'cm-stop-monitor', 'cm-btn-danger');
        }
        html += renderButton('监督记录', 'cm-view-history', 'cm-btn-outline');
        html += renderButton('设置', 'cm-goto-settings', 'cm-btn-outline');
        html += '</div>';

        // 任务列表
        html += '<div class="cm-section"><h3 class="cm-section-title">待完成 (' + pending.length + ')</h3>';
        if (pending.length === 0) {
          html += '<div class="cm-empty">暂无任务，点击上方按钮创建</div>';
        } else {
          pending.forEach(function (t) {
            html += renderTaskItem(t);
          });
        }
        html += '</div>';

        if (done.length > 0) {
          html += '<div class="cm-section"><h3 class="cm-section-title">已完成 (' + done.length + ')</h3>';
          done.forEach(function (t) {
            html += renderTaskItem(t);
          });
          html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;

        // 绑定事件
        bindTaskHomeEvents(container, roche, tasks);
      });
    });
  }

  function renderTaskItem(t) {
    var isDone = t.status === 'done';
    var priorityBadge = '';
    if (t.priority === 'high') priorityBadge = renderBadge('高优先', 'cm-badge-danger');
    else if (t.priority === 'medium') priorityBadge = renderBadge('中', 'cm-badge-warning');
    else priorityBadge = renderBadge('低', 'cm-badge-info');

    var deadlineText = t.deadline ? '截止: ' + fmtDate(t.deadline) : '';
    var overDue = t.deadline && t.deadline < now() && !isDone;

    return '<div class="cm-task-item ' + (isDone ? 'cm-task-done' : '') + (overDue ? 'cm-task-overdue' : '') + '" data-id="' + t.id + '">' +
      '<div class="cm-task-check">' +
      '<input type="checkbox" class="cm-task-checkbox" data-id="' + t.id + '" ' + (isDone ? 'checked' : '') + '>' +
      '</div>' +
      '<div class="cm-task-body">' +
      '<div class="cm-task-title">' + esc(t.title) + ' ' + priorityBadge + '</div>' +
      (t.description ? '<div class="cm-task-desc">' + esc(t.description) + '</div>' : '') +
      '<div class="cm-task-meta">' +
      (deadlineText ? '<span class="' + (overDue ? 'cm-text-danger' : '') + '">' + deadlineText + '</span>' : '') +
      (t.category ? '<span>' + esc(t.category) + '</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="cm-task-actions">' +
      '<button class="cm-btn-small cm-btn-edit" data-id="' + t.id + '">编辑</button>' +
      '<button class="cm-btn-small cm-btn-delete" data-id="' + t.id + '">删除</button>' +
      '</div>' +
      '</div>';
  }

  function bindTaskHomeEvents(container, roche, tasks) {
    // 关闭按钮
    bindCloseBtn(roche);

    // 新建任务
    var newBtn = $id('cm-new-task');
    if (newBtn) {
      newBtn.onclick = function () {
        showTaskEditor(container, roche, null, function () {
          renderTaskHome(container, roche);
        });
      };
    }

    // 启动/停止监督
    var startBtn = $id('cm-start-monitor');
    var stopBtn = $id('cm-stop-monitor');
    if (startBtn) {
      startBtn.onclick = function () {
        startMonitoring(container, roche);
      };
    }
    if (stopBtn) {
      stopBtn.onclick = function () {
        MonitorEngine.stop();
        roche.ui.toast('监督已停止');
        renderTaskHome(container, roche);
      };
    }

    // 查看历史
    var histBtn = $id('cm-view-history');
    if (histBtn) {
      histBtn.onclick = function () {
        renderHistoryView(container, roche);
      };
    }

    // 设置按钮
    var settingsBtn = $id('cm-goto-settings');
    if (settingsBtn) {
      settingsBtn.onclick = function () {
        showSettings(container, roche);
      };
    }

    // 音频保活开关
    var audioToggle = $id('cm-audio-keepalive');
    if (audioToggle) {
      audioToggle.onchange = function () {
        if (audioToggle.checked) {
          AudioKeepAlive.start(roche).then(function () {
            roche.ui.toast('音频保活已启动');
            renderTaskHome(container, roche);
          }).catch(function (err) {
            roche.ui.toast('音频保活启动失败: ' + (err.message || '未知错误'));
            audioToggle.checked = false;
          });
        } else {
          AudioKeepAlive.stop(roche).then(function () {
            roche.ui.toast('音频保活已停止');
            renderTaskHome(container, roche);
          });
        }
      };
    }

    // 任务复选框
    $qa('.cm-task-checkbox', container).forEach(function (cb) {
      cb.onchange = function () {
        var id = cb.getAttribute('data-id');
        storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) {
          for (var i = 0; i < ts.length; i++) {
            if (ts[i].id === id) {
              ts[i].status = cb.checked ? 'done' : 'pending';
              ts[i].completedAt = cb.checked ? now() : null;
              break;
            }
          }
          return storageSet(roche, STORAGE_KEY_TASKS, ts);
        }).then(function () {
          renderTaskHome(container, roche);
        });
      };
    });

    // 编辑按钮
    $qa('.cm-btn-edit', container).forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-id');
        storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) {
          var task = null;
          for (var i = 0; i < ts.length; i++) {
            if (ts[i].id === id) { task = ts[i]; break; }
          }
          if (task) {
            showTaskEditor(container, roche, task, function () {
              renderTaskHome(container, roche);
            });
          }
        });
      };
    });

    // 删除按钮
    $qa('.cm-btn-delete', container).forEach(function (btn) {
      btn.onclick = function () {
        roche.ui.confirm({ title: '确认删除', message: '确定要删除这个任务吗？' }).then(function (ok) {
          if (!ok) return;
          var id = btn.getAttribute('data-id');
          storageGet(roche, STORAGE_KEY_TASKS, []).then(function (ts) {
            ts = ts.filter(function (t) { return t.id !== id; });
            return storageSet(roche, STORAGE_KEY_TASKS, ts);
          }).then(function () {
            renderTaskHome(container, roche);
          });
        });
      };
    });
  }

  function showTaskEditor(container, roche, existingTask, onSave) {
    var isEdit = !!existingTask;
    var titleVal = existingTask ? existingTask.title : '';
    var descVal = existingTask ? (existingTask.description || '') : '';
    var deadlineVal = existingTask ? (existingTask.deadline ? fmtDate(existingTask.deadline) : '') : '';
    var priorityVal = existingTask ? (existingTask.priority || 'medium') : 'medium';
    var categoryVal = existingTask ? (existingTask.category || '') : '';

    var html = '<div class="roche-plugin-char-monitor">';
    html += '<style>' + getCSS() + '</style>';
    // 子页面：显示返回按钮和关闭按钮
    html += renderHeader(isEdit ? '编辑任务' : '新建任务', true, true);
    html += '<div class="cm-form">';
    html += '<label class="cm-label">任务标题</label>';
    html += '<input class="cm-input" id="cm-task-title" value="' + esc(titleVal) + '" placeholder="输入任务标题...">';
    html += '<label class="cm-label">任务描述</label>';
    html += '<textarea class="cm-textarea" id="cm-task-desc" placeholder="输入任务描述..." rows="3">' + esc(descVal) + '</textarea>';
    html += '<label class="cm-label">截止日期</label>';
    html += '<input class="cm-input" type="date" id="cm-task-deadline" value="' + deadlineVal + '">';
    html += '<label class="cm-label">优先级</label>';
    html += '<select class="cm-select" id="cm-task-priority">';
    html += '<option value="high"' + (priorityVal === 'high' ? ' selected' : '') + '>高</option>';
    html += '<option value="medium"' + (priorityVal === 'medium' ? ' selected' : '') + '>中</option>';
    html += '<option value="low"' + (priorityVal === 'low' ? ' selected' : '') + '>低</option>';
    html += '</select>';
    html += '<label class="cm-label">分类</label>';
    html += '<input class="cm-input" id="cm-task-category" value="' + esc(categoryVal) + '" placeholder="如：学习、工作、生活...">';
    html += '<div class="cm-form-actions">';
    html += renderButton(isEdit ? '保存修改' : '创建任务', 'cm-save-task', 'cm-btn-primary');
    html += '</div>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;

    // 绑定关闭按钮
    bindCloseBtn(roche);

    // 绑定返回按钮
    var backBtn = $id('cm-back');
    if (backBtn) { backBtn.onclick = function () { renderTaskHome(container, roche); }; }

    var saveBtn = $id('cm-save-task');
    if (saveBtn) {
      saveBtn.onclick = function () {
        var title = ($id('cm-task-title') && $id('cm-task-title').value || '').trim();
        if (!title) { roche.ui.toast('请输入任务标题'); return; }

        var desc = ($id('cm-task-desc') && $id('cm-task-desc').value || '').trim();
        var deadlineStr = $id('cm-task-deadline') && $id('cm-task-deadline').value || '';
        var priority = $id('cm-task-priority') && $id('cm-task-priority').value || 'medium';
        var category = ($id('cm-task-category') && $id('cm-task-category').value || '').trim();

        storageGet(roche, STORAGE_KEY_TASKS, []).then(function (tasks) {
          if (isEdit) {
            for (var i = 0; i < tasks.length; i++) {
              if (tasks[i].id === existingTask.id) {
                tasks[i].title = title;
                tasks[i].description = desc;
                tasks[i].deadline = deadlineStr ? new Date(deadlineStr + 'T23:59:59').getTime() : null;
                tasks[i].priority = priority;
                tasks[i].category = category;
                tasks[i].updatedAt = now();
                break;
              }
            }
          } else {
            tasks.push({
              id: uid(),
              title: title,
              description: desc,
              deadline: deadlineStr ? new Date(deadlineStr + 'T23:59:59').getTime() : null,
              priority: priority,
              category: category,
              status: 'pending',
              createdAt: now(),
              updatedAt: now()
            });
          }
          return storageSet(roche, STORAGE_KEY_TASKS, tasks);
        }).then(function () {
          roche.ui.toast(isEdit ? '任务已更新' : '任务已创建');
          if (onSave) onSave();
        });
      };
    }
  }

  function startMonitoring(container, roche) {
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
      var conversationId = settings.conversationId;
      var charId = settings.charId;
      var charName = settings.charName || 'Char';

      if (!charId && !conversationId) {
        // 未配置，跳到设置
        roche.ui.toast('请先配置监督角色');
        showSettings(container, roche);
        return;
      }

      MonitorEngine.start(roche, {
        conversationId: conversationId,
        charId: charId,
        charName: charName,
        initialInterval: settings.screenshotInterval || 5 * 60 * 1000
      });

      // APK 环境启动原生监控
      if (isAPK()) {
        window.nativeMonitorBridge.showFloatingBall().catch(function () { });
      }

      roche.ui.toast('监督已启动！Char 会定时检查你的进度');
      renderTaskHome(container, roche);
    });
  }

  // ============================
  //  监督历史视图
  // ============================

  function renderHistoryView(container, roche) {
    storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (history) {
      var html = '<div class="roche-plugin-char-monitor">';
      html += '<style>' + getCSS() + '</style>';
      // 子页面：返回按钮 + 关闭按钮
      html += renderHeader('监督记录', true, true);
      html += '<div class="cm-section">';
      if (history.length === 0) {
        html += '<div class="cm-empty">暂无监督记录</div>';
      } else {
        // 倒序显示最新在前
        var reversed = history.slice().reverse();
        reversed.forEach(function (h) {
          html += '<div class="cm-history-item">';
          html += '<div class="cm-history-time">' + fmtFull(h.timestamp) + '</div>';
          html += '<div class="cm-history-mood">' + renderBadge(h.mood, 'cm-badge-' + (h.mood === 'praise' ? 'success' : h.mood === 'warn' ? 'danger' : 'info')) + '</div>';
          html += '<div class="cm-history-text">' + esc(h.message || h.charResponse || '') + '</div>';
          if (h.tasksSnapshot && h.tasksSnapshot.length > 0) {
            html += '<div class="cm-history-tasks">当时任务: ' + esc(h.tasksSnapshot.join(', ')) + '</div>';
          }
          html += '</div>';
        });
      }
      html += '</div>';
      html += '<div class="cm-actions">';
      html += renderButton('清空记录', 'cm-clear-history', 'cm-btn-danger');
      html += '</div>';
      html += '</div>';

      container.innerHTML = html;

      // 绑定关闭按钮
      bindCloseBtn(roche);

      // 绑定返回按钮
      var backBtn = $id('cm-back');
      if (backBtn) { backBtn.onclick = function () { renderTaskHome(container, roche); }; };

      var clearBtn = $id('cm-clear-history');
      if (clearBtn) {
        clearBtn.onclick = function () {
          roche.ui.confirm({ title: '确认清空', message: '确定清空所有监督记录吗？' }).then(function (ok) {
            if (!ok) return;
            storageSet(roche, STORAGE_KEY_HISTORY, []).then(function () {
              renderHistoryView(container, roche);
            });
          });
        };
      }
    });
  }

  // ============================
  //  设置页面
  // ============================

  function showSettings(container, roche) {
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
      roche.character.list().then(function (chars) {
        var html = '<div class="roche-plugin-char-monitor">';
        html += '<style>' + getCSS() + '</style>';
        // 子页面：返回按钮 + 关闭按钮
        html += renderHeader('监督设置', true, true);

        html += '<div class="cm-form">';

        // 选择角色
        html += '<label class="cm-label">选择监督角色 (Char)</label>';
        html += '<select class="cm-select" id="cm-char-select">';
        html += '<option value="">-- 选择角色 --</option>';
        (chars || []).forEach(function (c) {
          var sel = c.id === settings.charId ? ' selected' : '';
          html += '<option value="' + c.id + '"' + sel + '>' + esc(c.handle || c.name || c.id) + '</option>';
        });
        html += '</select>';

        // 截图间隔
        html += '<label class="cm-label">默认截图间隔 (分钟)</label>';
        html += '<select class="cm-select" id="cm-interval-select">';
        [1, 3, 5, 10, 15, 20, 30].forEach(function (min) {
          var cur = settings.screenshotInterval ? settings.screenshotInterval / 60000 : 5;
          html += '<option value="' + min + '"' + (min === cur ? ' selected' : '') + '>' + min + ' 分钟</option>';
        });
        html += '</select>';

        // 自适应计时
        html += '<label class="cm-check-label">';
        html += '<input type="checkbox" id="cm-adaptive" ' + (settings.adaptiveTiming !== false ? 'checked' : '') + '>';
        html += ' 启用自适应计时（Char 根据情况自动调整下次截屏间隔）';
        html += '</label>';

        // 环境提示
        if (!isAPK()) {
          html += '<div class="cm-notice">';
          html += '当前为 Web 环境，无法进行屏幕截图和应用使用统计。';
          html += '监督功能将仅基于任务状态和已有记忆进行反馈。';
          html += '<br>安装 APK 版本可获得完整的截屏监督体验。';
          html += '</div>';
        }

        html += '<div class="cm-form-actions">';
        html += renderButton('保存设置', 'cm-save-settings', 'cm-btn-primary');
        html += '</div>';
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;

        // 绑定关闭按钮
        bindCloseBtn(roche);

        // 绑定返回按钮
        var backBtn = $id('cm-back');
        if (backBtn) { backBtn.onclick = function () { renderTaskHome(container, roche); }; };

        var saveBtn = $id('cm-save-settings');
        if (saveBtn) {
          saveBtn.onclick = function () {
            var charId = $id('cm-char-select') && $id('cm-char-select').value || '';
            var interval = parseInt(($id('cm-interval-select') && $id('cm-interval-select').value) || '5', 10);
            var adaptive = ($id('cm-adaptive') && $id('cm-adaptive').checked);

            var charName = '';
            (chars || []).forEach(function (c) {
              if (c.id === charId) charName = c.handle || c.name || '';
            });

            // 获取该角色的 conversationId
            var convPromise = Promise.resolve('');
            if (charId) {
              convPromise = roche.character.get(charId).then(function (c) {
                return c ? (c.conversationId || '') : '';
              }).catch(function () { return ''; });
            }

            convPromise.then(function (conversationId) {
              var newSettings = {
                charId: charId,
                charName: charName,
                conversationId: conversationId,
                screenshotInterval: interval * 60 * 1000,
                adaptiveTiming: adaptive
              };
              return storageSet(roche, STORAGE_KEY_SETTINGS, newSettings);
            }).then(function () {
              // APK 环境同步配置
              if (isAPK()) {
                window.nativeMonitorBridge.saveAIConfig({
                  charPersona: '', // 已通过 roche API 读取
                  charName: charName,
                  charAvatar: ''
                }).catch(function () { });
              }
              roche.ui.toast('设置已保存');
              renderTaskHome(container, roche);
            });
          };
        }
      }).catch(function () {
        // roche.character.list() 不可用的情况
        var html = '<div class="roche-plugin-char-monitor">';
        html += '<style>' + getCSS() + '</style>';
        html += renderHeader('监督设置', true, true);
        html += '<div class="cm-notice">无法读取角色列表，请确保已安装角色。</div>';
        html += '</div>';
        container.innerHTML = html;

        // 绑定关闭按钮
        bindCloseBtn(roche);

        // 绑定返回按钮
        var backBtn = $id('cm-back');
        if (backBtn) { backBtn.onclick = function () { renderTaskHome(container, roche); }; };
      });
    });
  }

  // ============================
  //  App 2: AI 老师
  // ============================

  function mountTutor(container, roche) {
    renderTutorHome(container, roche);

    return function unmount() {
      container.replaceChildren();
    };
  }

  function renderTutorHome(container, roche) {
    storageGet(roche, STORAGE_KEY_PLANS, []).then(function (plans) {
      storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
        var html = '<div class="roche-plugin-char-monitor">';
        html += '<style>' + getCSS() + '</style>';
        // 主页面：关闭按钮
        html += renderHeader('AI老师', true, false);

        // 功能说明
        html += '<div class="cm-card cm-card-info">';
        html += '<p>导入文本、PDF内容或图片文字，AI老师会为你制定分步学习计划，并用角色特有的方式讲解每一页。</p>';
        html += '</div>';

        // 新建学习
        html += '<div class="cm-actions">';
        html += renderButton('+ 新建学习计划', 'cm-new-plan', 'cm-btn-primary');
        html += '</div>';

        // 已有计划
        html += '<div class="cm-section"><h3 class="cm-section-title">学习计划 (' + plans.length + ')</h3>';
        if (plans.length === 0) {
          html += '<div class="cm-empty">暂未创建学习计划</div>';
        } else {
          plans.forEach(function (p) {
            html += '<div class="cm-plan-item" data-id="' + p.id + '">';
            html += '<div class="cm-plan-title">' + esc(p.title || '未命名计划') + '</div>';
            html += '<div class="cm-plan-meta">';
            html += p.totalPages ? (p.totalPages + ' 页 · ') : '';
            html += '进度: ' + (p.currentStep || 0) + '/' + ((p.steps && p.steps.length) || '?');
            html += ' · 创建于 ' + fmtDate(p.createdAt);
            html += '</div>';
            html += '<div class="cm-task-actions">';
            html += '<button class="cm-btn-small cm-btn-primary-lt" data-id="' + p.id + '" data-action="open">开始学习</button>';
            html += '<button class="cm-btn-small cm-btn-delete" data-id="' + p.id + '" data-action="delete">删除</button>';
            html += '</div>';
            html += '</div>';
          });
        }
        html += '</div>';

        html += '</div>';
        container.innerHTML = html;

        // 绑定关闭按钮
        bindCloseBtn(roche);

        var newBtn = $id('cm-new-plan');
        if (newBtn) {
          newBtn.onclick = function () {
            showTutorImport(container, roche);
          };
        }

        // 绑定计划操作
        $qa('.cm-btn-small', container).forEach(function (btn) {
          btn.onclick = function () {
            var id = btn.getAttribute('data-id');
            var action = btn.getAttribute('data-action');
            if (action === 'open') {
              storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) {
                var plan = null;
                for (var i = 0; i < ps.length; i++) {
                  if (ps[i].id === id) { plan = ps[i]; break; }
                }
                if (plan) showTutorLearn(container, roche, plan);
              });
            } else if (action === 'delete') {
              roche.ui.confirm({ title: '确认删除', message: '确定删除这个学习计划吗？' }).then(function (ok) {
                if (!ok) return;
                storageGet(roche, STORAGE_KEY_PLANS, []).then(function (ps) {
                  ps = ps.filter(function (p) { return p.id !== id; });
                  return storageSet(roche, STORAGE_KEY_PLANS, ps);
                }).then(function () {
                  renderTutorHome(container, roche);
                });
              });
            }
          };
        });
      });
    });
  }

  function showTutorImport(container, roche) {
    var html = '<div class="roche-plugin-char-monitor">';
    html += '<style>' + getCSS() + '</style>';
    // 子页面：返回按钮 + 关闭按钮
    html += renderHeader('导入学习材料', true, true);
    html += '<div class="cm-form">';
    html += '<label class="cm-label">计划标题</label>';
    html += '<input class="cm-input" id="cm-plan-title" placeholder="如：高等数学第三章">';
    html += '<label class="cm-label">学习目标（可选）</label>';
    html += '<input class="cm-input" id="cm-plan-goal" placeholder="如：掌握微积分基本概念">';
    html += '<label class="cm-label">粘贴文本内容</label>';
    html += '<textarea class="cm-textarea" id="cm-plan-text" placeholder="在此粘贴要学习的内容（文字、PDF提取文本等）..." rows="10"></textarea>';
    html += '<div class="cm-form-actions">';
    html += renderButton('生成学习计划', 'cm-gen-plan', 'cm-btn-primary');
    html += '</div>';
    html += '<div id="cm-gen-status" class="cm-status-msg" style="display:none;"></div>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;

    // 绑定关闭按钮
    bindCloseBtn(roche);

    // 绑定返回按钮
    var backBtn = $id('cm-back');
    if (backBtn) { backBtn.onclick = function () { renderTutorHome(container, roche); }; };

    var genBtn = $id('cm-gen-plan');
    if (genBtn) {
      genBtn.onclick = function () {
        var title = ($id('cm-plan-title') && $id('cm-plan-title').value || '').trim();
        var goal = ($id('cm-plan-goal') && $id('cm-plan-goal').value || '').trim();
        var text = ($id('cm-plan-text') && $id('cm-plan-text').value || '').trim();

        if (!text) { roche.ui.toast('请输入学习内容'); return; }
        if (!title) title = '未命名计划';

        var statusEl = $id('cm-gen-status');
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.textContent = '正在生成学习计划...';
        }
        if (genBtn) genBtn.disabled = true;

        // 分割文本
        var pages = TutorEngine.splitText(text, 2000);

        // 获取 char 设置
        storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
          return TutorEngine.generatePlan(roche, settings.charId, title, pages, goal)
            .then(function (plan) {
              var newPlan = {
                id: uid(),
                title: title,
                sourceText: text,
                pages: pages,
                totalPages: pages.length,
                planData: plan,
                steps: plan.steps || [],
                currentStep: 0,
                createdAt: now()
              };
              return storageGet(roche, STORAGE_KEY_PLANS, []).then(function (plans) {
                plans.push(newPlan);
                return storageSet(roche, STORAGE_KEY_PLANS, plans).then(function () {
                  return newPlan;
                });
              });
            });
        }).then(function (newPlan) {
          roche.ui.toast('学习计划已生成！');
          showTutorLearn(container, roche, newPlan);
        }).catch(function (err) {
          console.error('[CharTutor] 生成计划失败:', err);
          roche.ui.toast('生成失败，请重试');
          if (statusEl) statusEl.style.display = 'none';
          if (genBtn) genBtn.disabled = false;
        });
      };
    }
  }

  function showTutorLearn(container, roche, plan) {
    var steps = plan.steps || [];
    var curIdx = plan.currentStep || 0;
    var curStep = steps[curIdx];
    var curPage = curIdx >= 0 && curIdx < (plan.pages || []).length ? (plan.pages || [])[curIdx] : '';

    var html = '<div class="roche-plugin-char-monitor">';
    html += '<style>' + getCSS() + '</style>';
    // 子页面：返回按钮 + 关闭按钮
    html += renderHeader(plan.title || '学习', true, true);

    // 进度条
    html += '<div class="cm-progress-bar">';
    html += '<div class="cm-progress-fill" style="width:' + (steps.length > 0 ? ((curIdx / steps.length) * 100) : 0) + '%"></div>';
    html += '</div>';
    html += '<div class="cm-progress-text">步骤 ' + (curIdx + 1) + ' / ' + (steps.length || '?') + '</div>';

    // 当前步骤
    if (curStep) {
      html += '<div class="cm-card cm-card-step">';
      html += '<h4>' + esc(curStep.title || '步骤 ' + (curIdx + 1)) + '</h4>';
      html += '<p>' + esc(curStep.description || '') + '</p>';
      html += '</div>';
    }

    // 内容区
    if (curPage) {
      html += '<div class="cm-card cm-card-content"><pre class="cm-content-text">' + esc(curPage) + '</pre></div>';
    }

    // 提问区
    html += '<div class="cm-form">';
    html += '<label class="cm-label">向AI老师提问</label>';
    html += '<textarea class="cm-textarea" id="cm-tutor-question" placeholder="对当前内容有疑问？问AI老师..." rows="2"></textarea>';
    html += '</div>';

    // AI 回答区
    html += '<div id="cm-tutor-answer" class="cm-card cm-card-answer" style="display:none;">';
    html += '<div class="cm-answer-content"></div>';
    html += '</div>';

    // 操作区
    html += '<div class="cm-actions">';
    html += renderButton('问老师', 'cm-ask-teacher', 'cm-btn-primary');
    if (curIdx > 0) {
      html += renderButton('上一步', 'cm-prev-step', 'cm-btn-outline');
    }
    if (curIdx < steps.length - 1) {
      html += renderButton('下一步', 'cm-next-step', 'cm-btn-success');
    } else {
      html += renderButton('完成学习', 'cm-finish-plan', 'cm-btn-success');
    }
    html += '</div>';

    // 步骤列表
    html += '<div class="cm-section"><h3 class="cm-section-title">全部步骤</h3>';
    steps.forEach(function (s, i) {
      html += '<div class="cm-step-item ' + (i === curIdx ? 'cm-step-active' : i < curIdx ? 'cm-step-done' : '') + '">';
      html += '<span class="cm-step-num">' + (i + 1) + '</span>';
      html += '<span class="cm-step-name">' + esc(s.title || '步骤 ' + (i + 1)) + '</span>';
      if (i < curIdx) html += '<span class="cm-step-check">&#10003;</span>';
      html += '</div>';
    });
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;

    // 绑定关闭按钮
    bindCloseBtn(roche);

    // 绑定返回按钮
    var backBtn = $id('cm-back');
    if (backBtn) { backBtn.onclick = function () { renderTutorHome(container, roche); }; };

    // 提问
    var askBtn = $id('cm-ask-teacher');
    if (askBtn) {
      askBtn.onclick = function () {
        var question = ($id('cm-tutor-question') && $id('cm-tutor-question').value || '').trim();
        if (!question) { roche.ui.toast('请输入问题'); return; }

        var answerEl = $id('cm-tutor-answer');
        var answerContent = answerEl ? $q('.cm-answer-content', answerEl) : null;
        if (answerEl) answerEl.style.display = 'block';
        if (answerContent) answerContent.textContent = '老师正在思考...';
        if (askBtn) askBtn.disabled = true;

        storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
          return TutorEngine.explainPage(roche, settings.charId, plan.title, curStep, curPage, question);
        }).then(function (reply) {
          if (answerContent) answerContent.textContent = reply;
          if (askBtn) askBtn.disabled = false;
        }).catch(function () {
          if (answerContent) answerContent.textContent = '讲解生成失败，请重试';
          if (askBtn) askBtn.disabled = false;
        });
      };
    }

    // 导航
    var savePlanState = function (newIdx) {
      return storageGet(roche, STORAGE_KEY_PLANS, []).then(function (plans) {
        for (var i = 0; i < plans.length; i++) {
          if (plans[i].id === plan.id) {
            plans[i].currentStep = newIdx;
            break;
          }
        }
        return storageSet(roche, STORAGE_KEY_PLANS, plans);
      });
    };

    var prevBtn = $id('cm-prev-step');
    if (prevBtn) {
      prevBtn.onclick = function () {
        savePlanState(curIdx - 1).then(function () {
          plan.currentStep = curIdx - 1;
          showTutorLearn(container, roche, plan);
        });
      };
    }

    var nextBtn = $id('cm-next-step');
    if (nextBtn) {
      nextBtn.onclick = function () {
        savePlanState(curIdx + 1).then(function () {
          plan.currentStep = curIdx + 1;
          showTutorLearn(container, roche, plan);
        });
      };
    }

    var finBtn = $id('cm-finish-plan');
    if (finBtn) {
      finBtn.onclick = function () {
        roche.ui.confirm({ title: '完成学习', message: '恭喜完成全部步骤！是否标记此计划为已完成？' }).then(function (ok) {
          if (ok) {
            storageGet(roche, STORAGE_KEY_PLANS, []).then(function (plans) {
              for (var i = 0; i < plans.length; i++) {
                if (plans[i].id === plan.id) {
                  plans[i].currentStep = steps.length;
                  plans[i].completedAt = now();
                  break;
                }
              }
              return storageSet(roche, STORAGE_KEY_PLANS, plans);
            }).then(function () {
              roche.ui.toast('学习完成！');
              renderTutorHome(container, roche);
            });
          }
        });
      };
    }

    // 点击步骤跳转
    $qa('.cm-step-item', container).forEach(function (item, i) {
      item.onclick = function () {
        savePlanState(i).then(function () {
          plan.currentStep = i;
          showTutorLearn(container, roche, plan);
        });
      };
      item.style.cursor = 'pointer';
    });
  }

  // ============================
  //  App 3: 监督陪跑（精简控制面板 + 使用统计）
  // ============================

  function mountMonitor(container, roche) {
    storageGet(roche, STORAGE_KEY_SETTINGS, {}).then(function (settings) {
      storageGet(roche, STORAGE_KEY_HISTORY, []).then(function (history) {
        storageGet(roche, STORAGE_KEY_USAGE, []).then(function (usageHistory) {
          var running = MonitorEngine.isRunning();
          var interval = MonitorEngine.getInterval();

          var html = '<div class="roche-plugin-char-monitor">';
          html += '<style>' + getCSS() + '</style>';
          // 主页面：关闭按钮
          html += renderHeader('监督陪跑', true, false);

          // 状态卡片
          html += '<div class="cm-card cm-card-status ' + (running ? 'cm-card-active' : '') + '">';
          html += '<div class="cm-status-icon">' + (running ? '&#128065;' : '&#128564;') + '</div>';
          html += '<div class="cm-status-big">' + (running ? '监督运行中' : '监督未启动') + '</div>';
          html += '<div class="cm-status-detail">';
          if (running) {
            html += '截图间隔: ' + (interval / 60000).toFixed(0) + ' 分钟 · ';
            html += '角色: ' + esc(settings.charName || '未设置') + ' · ';
            html += '监督次数: ' + history.length;
          } else {
            html += '前往任务面板启动监督';
          }
          html += '</div>';
          html += '</div>';

          // 最近使用情况
          if (usageHistory.length > 0) {
            var latest = usageHistory[usageHistory.length - 1];
            html += '<div class="cm-section"><h3 class="cm-section-title">最近使用统计</h3>';
            html += '<div class="cm-card"><pre class="cm-content-text">' + esc(latest.data || '无数据') + '</pre></div>';
            html += '<div class="cm-meta">获取时间: ' + fmtFull(latest.timestamp) + '</div>';
            html += '</div>';
          } else if (isAPK()) {
            html += '<div class="cm-notice">尚无使用统计数据，启动监督后将自动收集。</div>';
          } else {
            html += '<div class="cm-notice">Web 环境暂不支持使用统计，请使用 APK 版本。</div>';
          }

          // 快捷操作
          html += '<div class="cm-actions">';
          if (running) {
            html += renderButton('停止监督', 'cm-mon-stop', 'cm-btn-danger');
          }
          html += renderButton('打开任务面板', 'cm-mon-goto-home', 'cm-btn-outline');
          html += '</div>';

          html += '</div>';
          container.innerHTML = html;

          // 绑定关闭按钮
          bindCloseBtn(roche);

          var stopBtn = $id('cm-mon-stop');
          if (stopBtn) {
            stopBtn.onclick = function () {
              MonitorEngine.stop();
              roche.ui.toast('监督已停止');
              mountMonitor(container, roche);
            };
          }

          var gotoBtn = $id('cm-mon-goto-home');
          if (gotoBtn) {
            gotoBtn.onclick = function () {
              renderTaskHome(container, roche);
            };
          }
        });
      });
    });

    return function unmount() {
      container.replaceChildren();
    };
  }

  // ============================
  //  CSS 样式
  // ============================

  function getCSS() {
    return [
      '.roche-plugin-char-monitor {',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  color: #e0e0e0;',
      '  background: #1a1a2e;',
      '  min-height: 100vh;',
      '  padding: 0;',
      '  box-sizing: border-box;',
      '}',
      '.roche-plugin-char-monitor *, .roche-plugin-char-monitor *::before, .roche-plugin-char-monitor *::after {',
      '  box-sizing: border-box;',
      '}',
      /* Header */
      '.cm-header {',
      '  display: flex; align-items: center; padding: 16px;',
      '  background: #16213e; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-back-btn {',
      '  background: none; border: 1px solid #0f3460; color: #e0e0e0;',
      '  padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 14px;',
      '  margin-right: 12px;',
      '}',
      '.cm-back-btn:hover { background: #0f3460; }',
      '.cm-title {',
      '  margin: 0; font-size: 18px; font-weight: 600; flex: 1;',
      '}',
      '.cm-close-btn {',
      '  background: none; border: 1px solid #0f3460; color: #e0e0e0;',
      '  width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 16px;',
      '  display: flex; align-items: center; justify-content: center;',
      '  margin-left: auto; flex-shrink: 0;',
      '}',
      '.cm-close-btn:hover { background: #0f3460; }',
      /* Audio KeepAlive */
      '.cm-keepalive-bar {',
      '  display: flex; align-items: center; padding: 10px 16px; gap: 12px;',
      '  background: #16213e; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-keepalive-label {',
      '  font-size: 13px; color: #aaa;',
      '}',
      '.cm-keepalive-status {',
      '  font-size: 12px; color: #888;',
      '}',
      '.cm-switch {',
      '  position: relative; display: inline-block; width: 44px; height: 24px;',
      '}',
      '.cm-switch input { opacity: 0; width: 0; height: 0; }',
      '.cm-switch-slider {',
      '  position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;',
      '  background-color: #0f3460; transition: .3s; border-radius: 24px;',
      '}',
      '.cm-switch-slider:before {',
      '  position: absolute; content: ""; height: 18px; width: 18px;',
      '  left: 3px; bottom: 3px; background-color: #e0e0e0;',
      '  transition: .3s; border-radius: 50%;',
      '}',
      '.cm-switch input:checked + .cm-switch-slider {',
      '  background-color: #4ecca3;',
      '}',
      '.cm-switch input:checked + .cm-switch-slider:before {',
      '  transform: translateX(20px);',
      '}',
      /* Status */
      '.cm-status-bar {',
      '  display: flex; padding: 12px 16px; gap: 12px;',
      '  background: #16213e; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-status-item { flex: 1; text-align: center; }',
      '.cm-status-label { display: block; font-size: 11px; color: #888; margin-bottom: 4px; }',
      '.cm-status-value { font-size: 14px; font-weight: 600; }',
      '.cm-status-active { color: #4ecca3; }',
      /* Card */
      '.cm-card {',
      '  background: #16213e; border-radius: 12px; padding: 16px; margin: 12px 16px;',
      '  border: 1px solid #0f3460;',
      '}',
      '.cm-card-info { background: #1a1a3e; border-color: #0f3460; }',
      '.cm-card-info p { margin: 0; font-size: 13px; color: #aaa; line-height: 1.6; }',
      '.cm-card-status { text-align: center; }',
      '.cm-card-active { border-color: #4ecca3; }',
      '.cm-card-step { background: #1a2744; }',
      '.cm-card-step h4 { margin: 0 0 8px 0; color: #4ecca3; }',
      '.cm-card-step p { margin: 0; color: #ccc; }',
      '.cm-card-content { }',
      '.cm-card-answer { background: #1a2744; border-color: #4ecca3; }',
      '.cm-status-icon { font-size: 32px; margin-bottom: 8px; }',
      '.cm-status-big { font-size: 18px; font-weight: 600; margin-bottom: 4px; }',
      '.cm-status-detail { font-size: 12px; color: #888; }',
      /* Actions */
      '.cm-actions {',
      '  display: flex; gap: 8px; padding: 12px 16px; flex-wrap: wrap;',
      '}',
      /* Buttons */
      '.cm-btn {',
      '  padding: 10px 16px; border-radius: 8px; border: none;',
      '  cursor: pointer; font-size: 14px; font-weight: 500;',
      '  transition: background 0.2s;',
      '}',
      '.cm-btn-primary { background: #4ecca3; color: #1a1a2e; }',
      '.cm-btn-primary:hover { background: #3db88d; }',
      '.cm-btn-success { background: #2d6a4f; color: #e0e0e0; }',
      '.cm-btn-success:hover { background: #358560; }',
      '.cm-btn-danger { background: #c0392b; color: #e0e0e0; }',
      '.cm-btn-danger:hover { background: #a93226; }',
      '.cm-btn-outline { background: transparent; color: #4ecca3; border: 1px solid #4ecca3; }',
      '.cm-btn-outline:hover { background: rgba(78,204,163,0.1); }',
      '.cm-btn-small {',
      '  padding: 4px 10px; border-radius: 6px; border: none;',
      '  cursor: pointer; font-size: 12px;',
      '}',
      '.cm-btn-edit { background: #2c3e50; color: #e0e0e0; }',
      '.cm-btn-delete { background: #3d201d; color: #e74c3c; }',
      '.cm-btn-primary-lt { background: #4ecca3; color: #1a1a2e; }',
      /* Form */
      '.cm-form { padding: 16px; }',
      '.cm-label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; margin-top: 12px; }',
      '.cm-input, .cm-textarea, .cm-select {',
      '  width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #0f3460;',
      '  background: #16213e; color: #e0e0e0; font-size: 14px;',
      '}',
      '.cm-input:focus, .cm-textarea:focus, .cm-select:focus {',
      '  outline: none; border-color: #4ecca3;',
      '}',
      '.cm-textarea { resize: vertical; }',
      '.cm-check-label {',
      '  display: flex; align-items: center; gap: 8px;',
      '  font-size: 13px; color: #aaa; margin-top: 12px; cursor: pointer;',
      '}',
      '.cm-form-actions { margin-top: 16px; }',
      '.cm-meta { font-size: 11px; color: #666; padding: 4px 16px; }',
      /* Task */
      '.cm-task-item {',
      '  display: flex; align-items: flex-start; gap: 10px;',
      '  padding: 12px 16px; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-task-item:last-child { border-bottom: none; }',
      '.cm-task-done { opacity: 0.5; }',
      '.cm-task-done .cm-task-title { text-decoration: line-through; }',
      '.cm-task-overdue { border-left: 3px solid #e74c3c; }',
      '.cm-task-check { padding-top: 2px; }',
      '.cm-task-checkbox { width: 18px; height: 18px; accent-color: #4ecca3; cursor: pointer; }',
      '.cm-task-body { flex: 1; min-width: 0; }',
      '.cm-task-title { font-size: 15px; font-weight: 500; margin-bottom: 4px; }',
      '.cm-task-desc { font-size: 12px; color: #888; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.cm-task-meta { font-size: 11px; color: #666; display: flex; gap: 8px; }',
      '.cm-task-actions { display: flex; gap: 4px; flex-shrink: 0; }',
      '.cm-text-danger { color: #e74c3c; }',
      /* Badge */
      '.cm-badge {',
      '  display: inline-block; padding: 2px 8px; border-radius: 4px;',
      '  font-size: 11px; font-weight: 500;',
      '}',
      '.cm-badge-danger { background: #3d201d; color: #e74c3c; }',
      '.cm-badge-warning { background: #3d3420; color: #f39c12; }',
      '.cm-badge-info { background: #1a2a3d; color: #3498db; }',
      '.cm-badge-success { background: #1d3d2c; color: #4ecca3; }',
      /* Progress */
      '.cm-progress-bar {',
      '  height: 4px; background: #0f3460; margin: 0 16px; border-radius: 2px; overflow: hidden;',
      '}',
      '.cm-progress-fill {',
      '  height: 100%; background: linear-gradient(90deg, #4ecca3, #2d6a4f);',
      '  transition: width 0.3s;',
      '}',
      '.cm-progress-text {',
      '  text-align: center; font-size: 12px; color: #888; padding: 4px 0 12px 0;',
      '}',
      /* Section */
      '.cm-section { padding: 0 16px 12px 16px; }',
      '.cm-section-title {',
      '  font-size: 14px; color: #888; margin: 12px 0 8px 0;',
      '  text-transform: uppercase; letter-spacing: 0.5px;',
      '}',
      '.cm-empty {',
      '  text-align: center; color: #555; padding: 32px 16px; font-size: 14px;',
      '}',
      '.cm-notice {',
      '  background: #2c3e20; border: 1px solid #4ecca3; border-radius: 8px;',
      '  padding: 12px; margin: 12px 16px; font-size: 12px; color: #aaa;',
      '}',
      '.cm-content-text {',
      '  color: #ccc; font-size: 13px; line-height: 1.7;',
      '  white-space: pre-wrap; word-break: break-word;',
      '  margin: 0; font-family: inherit;',
      '}',
      '.cm-status-msg {',
      '  text-align: center; padding: 12px; color: #4ecca3; font-size: 13px;',
      '}',
      /* History */
      '.cm-history-item {',
      '  padding: 12px 0; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-history-item:last-child { border-bottom: none; }',
      '.cm-history-time { font-size: 11px; color: #555; margin-bottom: 4px; }',
      '.cm-history-mood { margin-bottom: 4px; }',
      '.cm-history-text { font-size: 13px; color: #ccc; line-height: 1.6; }',
      '.cm-history-tasks { font-size: 11px; color: #555; margin-top: 4px; }',
      /* Plan */
      '.cm-plan-item {',
      '  padding: 12px 0; border-bottom: 1px solid #0f3460;',
      '}',
      '.cm-plan-item:last-child { border-bottom: none; }',
      '.cm-plan-title { font-size: 15px; font-weight: 500; margin-bottom: 4px; }',
      '.cm-plan-meta { font-size: 12px; color: #666; margin-bottom: 8px; }',
      /* Steps */
      '.cm-step-item {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 8px 12px; border-radius: 8px; margin-bottom: 4px;',
      '  border: 1px solid transparent;',
      '}',
      '.cm-step-active { background: #1a2744; border-color: #4ecca3; }',
      '.cm-step-done { color: #888; }',
      '.cm-step-num {',
      '  width: 24px; height: 24px; border-radius: 50%;',
      '  background: #0f3460; display: flex; align-items: center; justify-content: center;',
      '  font-size: 12px; flex-shrink: 0;',
      '}',
      '.cm-step-active .cm-step-num { background: #4ecca3; color: #1a1a2e; }',
      '.cm-step-name { font-size: 13px; flex: 1; }',
      '.cm-step-check { color: #4ecca3; }',
    ].join('\n');
  }

  // ============================
  //  插件注册
  // ============================

  window.RochePlugin.register({
    id: 'char-task-monitor',
    name: 'Char任务监督陪伴',
    version: '1.1.0',
    apps: [
      {
        id: 'char-task-monitor-home',
        name: '任务面板',
        icon: 'task_alt',
        iconImage: '',
        async mount(container, roche) {
          return mountTaskHome(container, roche);
        },
        async unmount(container, roche) {
          container.replaceChildren();
        }
      },
      {
        id: 'char-task-monitor-tutor',
        name: 'AI老师',
        icon: 'school',
        iconImage: '',
        async mount(container, roche) {
          return mountTutor(container, roche);
        },
        async unmount(container, roche) {
          container.replaceChildren();
        }
      },
      {
        id: 'char-task-monitor-monitor',
        name: '监督陪跑',
        icon: 'visibility',
        iconImage: '',
        async mount(container, roche) {
          return mountMonitor(container, roche);
        },
        async unmount(container, roche) {
          container.replaceChildren();
        }
      }
    ]
  });

  console.log('[CharTaskMonitor] 插件已注册 v1.1.0');
  console.log('  - 任务面板 (char-task-monitor-home)');
  console.log('  - AI老师 (char-task-monitor-tutor)');
  console.log('  - 监督陪跑 (char-task-monitor-monitor)');
  console.log('  - 音频保活: ' + (isAudioBridgeAvailable() ? '可用' : '不可用'));
  console.log('  环境: ' + (isAPK() ? 'APK (支持截屏+使用统计)' : 'Web (仅任务+记忆反馈)'));

})();
