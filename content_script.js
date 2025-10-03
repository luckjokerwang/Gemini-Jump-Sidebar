
// content_script.js
(function () {
  if (window.__gj_sidebar_injected) return;
  window.__gj_sidebar_injected = true;

  // ---- 配置 ----
  const MAX_ENTRIES = 200;
  const HIGHLIGHT_DURATION_MS = 2000;

  // ---- 插入侧边栏 DOM ----
  const sidebar = document.createElement('div');
  sidebar.className = 'gj-sidebar';
  sidebar.innerHTML = `
    <h4>问句快速跳转</h4>
    <div class="gj-controls">
      <input class="gj-search" placeholder="搜索/筛选条目" />
      <button class="gj-btn gj-clear">清空</button>
    </div>
    <ul class="gj-list"></ul>
    <div style="font-size:11px;color:#888;margin-top:8px;">已记录的提问会置为可跳转项</div>
  `;
  document.body.appendChild(sidebar);

  const listEl = sidebar.querySelector('.gj-list');
  const searchInput = sidebar.querySelector('.gj-search');
  const clearBtn = sidebar.querySelector('.gj-clear');

  // ---- 存储条目：{id, text, time, nodeSelector?} ----
  let entries = [];

  // 从 storage 恢复（可选）
  chrome.storage && chrome.storage.local && chrome.storage.local.get(['gj_entries'], (res) => {
    if (res && res.gj_entries) {
      entries = res.gj_entries.slice(-MAX_ENTRIES);
      renderList();
    }
  });

  // ---- 工具：保存到 chrome.storage ----
  function persist() {
    try {
      chrome.storage && chrome.storage.local && chrome.storage.local.set({ gj_entries: entries });
    } catch (e) { /* ignore */ }
  }

  // ---- 渲染侧边栏 ----
  function renderList(filter = '') {
    listEl.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const shown = entries.filter(e => !f || e.text.toLowerCase().includes(f));
    for (const e of shown) {
      const li = document.createElement('li');
      li.className = 'gj-item';
      li.dataset.gjId = e.id;
      li.innerHTML = `
        <div style="flex:1">
          <div class="gj-content">${escapeHtml(e.text)}</div>
          <div class="gj-meta">${new Date(e.time).toLocaleString()}</div>
        </div>
      `;
      li.addEventListener('click', () => jumpToEntry(e));
      listEl.appendChild(li);
    }
  }

  // ---- 保护函数：HTML escape ----
  function escapeHtml(s) {
    return (s+'').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---- 查找最可能是「用户输入框」的元素 ----
  function guessComposerElements() {
    // 策略：查找可编辑区域、textarea、input[type=text]，以及具有 role="textbox" 的元素
    const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'));
    // 过滤掉隐藏/不可见的
    return candidates.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10 && window.getComputedStyle(el).visibility !== 'hidden';
    });
  }

  // ---- 给消息节点打 id（如果尚未有） ----
  function ensureNodeId(node) {
    if (!node) return null;
    if (node.dataset && node.dataset.gjId) return node.dataset.gjId;
    // 找到最靠近的容器（可能是 message wrapper）
    let wrapper = node;
    // 限制向上查找的深度
    for (let i=0;i<6;i++) {
      if (!wrapper) break;
      if (wrapper.getAttribute && wrapper.getAttribute('role') === 'article') break;
      if (wrapper.className && /message|msg|bubble|turn|conversation/i.test(wrapper.className)) break;
      wrapper = wrapper.parentElement;
    }
    if (!wrapper) wrapper = node;
    const id = 'gj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
    wrapper.dataset.gjId = id;
    return id;
  }

  // ---- 记录一次提问：node = DOM 节点（选填），text = 提问文本 ----
  function recordEntry(text, node) {
    const time = Date.now();
    const id = ensureNodeId(node) || ('gj_text_' + time.toString(36));
    const entry = { id, text: text.trim(), time };
    // 去重：如果最近一条相同则跳过
    if (entries.length && entries[entries.length-1].text === entry.text) return;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    persist();
    renderList(searchInput.value);
  }

  // ---- 点击侧边栏条目：跳转并高亮 ----
  function jumpToEntry(entry) {
    // 尝试用 dataset.gjId 找到节点
    let target = document.querySelector(`[data-gj-id="${entry.id}"]`);
    if (!target) {
      // 回退：根据文本内容搜索页面上的节点（简化匹配）
      const candidates = Array.from(document.querySelectorAll('div, p, span, article'));
      const lower = entry.text.toLowerCase();
      target = candidates.find(c => c.innerText && c.innerText.toLowerCase().includes(lower));
    }
    if (!target) {
      alert('未能定位到原始消息节点。可能页面已更新或消息被重渲染。');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('gj-highlight');
    setTimeout(() => { target.classList.remove('gj-highlight'); }, HIGHLIGHT_DURATION_MS);
  }

  // ---- 监测发送动作（尽量通用） ----
  // 方法：1) 监听聚焦在 composer 的 Enter 键（非 shift+enter），2) 监听页面中可能的“发送”按钮点击（通过文本或 aria-label）
  function attachComposerListeners() {
    const composers = guessComposerElements();
    composers.forEach(el => {
      if (el.__gj_listening) return;
      el.__gj_listening = true;
      // 处理 Enter 提交（注意区分 shift+enter）
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          // 延迟读取输入框内容以允许页面先把消息渲染
          setTimeout(() => {
            const text = (el.innerText || el.value || '').trim();
            if (text) {
              // 寻找刚生成的新消息节点：用 MutationObserver 也会捕捉到，这里作为快速记录
              recordEntry(text, findClosestRenderedMessageNode(text));
            }
          }, 250);
        }
      });
    });

    // 监听可能的发送按钮
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
    buttons.forEach(btn => {
      if (btn.__gj_btn_attached) return;
      const label = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (/send|发送|submit|reply|ask|enter/i.test(label)) {
        btn.__gj_btn_attached = true;
        btn.addEventListener('click', () => {
          setTimeout(() => {
            const text = findComposerText();
            if (text) recordEntry(text, findClosestRenderedMessageNode(text));
          }, 300);
        });
      }
    });
  }

  // ---- 帮助：查找 composer 当前文本（首个可见 composer） ----
  function findComposerText() {
    const cs = guessComposerElements();
    if (!cs || !cs.length) return '';
    const el = cs[0];
    return (el.innerText || el.value || '').trim();
  }

  // ---- 帮助：基于文本在 DOM 中找到最近渲染出的“消息”节点 ----
  function findClosestRenderedMessageNode(text) {
    if (!text) return null;
    // 优先搜索包含文本且位于页面底部的元素
    const nodes = Array.from(document.querySelectorAll('div, p, span, li, article'));
    // 过滤有意义大小的元素
    const cand = nodes.filter(n => {
      const t = n.innerText || '';
      if (!t) return false;
      if (!t.includes(text.split(/\s+/)[0].slice(0,10))) return false; // 首词快速过滤
      const rect = n.getBoundingClientRect();
      return rect.width > 40 && rect.height > 12;
    });
    // 找最近添加或出现在底部的
    if (cand.length) {
      // 选择包含完整文本或最相似的
      let best = null;
      let bestScore = -1;
      const lower = text.toLowerCase();
      for (const n of cand) {
        const t = (n.innerText||'').toLowerCase();
        const score = t.includes(lower) ? 100 : (t.split(' ').filter(w => lower.includes(w)).length);
        if (score > bestScore) { best = n; bestScore = score; }
      }
      return best;
    }
    return null;
  }

  // ---- MutationObserver 监控页面消息区域（更稳健） ----
  const pageObserver = new MutationObserver((mutations) => {
    // 定位新插入的节点，若看起来像是“用户消息”且包含文本，则记录
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const text = (n.innerText || '').trim();
        if (!text) continue;
        // Heuristic: 若节点非常靠近页面底部或宽度较大，可能是新消息
        const rect = n.getBoundingClientRect();
        if (rect.top > (window.innerHeight * 0.2) && rect.width > 60) {
          // 防止记录太长的系统回复（可按需调整）
          if (text.length > 500) continue;
          // 如果文本包含标点并且长度适中，视为完整消息
          // 但我们只想记录“用户的提问”，尝试判断是否是用户（包含你的用户名、或出现在 composer 之后）
          // 这里尽量简单：如果内容在最近 1 秒内出现在 DOM，且与 composer 最近提交文本相似，则记录
          const composerText = findComposerText();
          if (composerText && text.includes(composerText.slice(0, Math.min(80, composerText.length)))) {
            recordEntry(composerText, n);
          } else {
            // 还可以尝试检测节点类名是否包含 user/you/self 等（不同网站差异大）
            if (/(you|user|self|sender)/i.test(n.className || '')) {
              recordEntry(text, n);
            }
          }
        }
      }
    }
  });
  // 观察 body 的 subtree（广泛但必要）
  pageObserver.observe(document.body, { childList: true, subtree: true });

  // ---- 定期尝试重新 attach listeners（应对 SPA 渲染） ----
  setInterval(attachComposerListeners, 1000);

  // ---- 搜索与清理 ----
  searchInput.addEventListener('input', (e) => renderList(e.target.value));
  clearBtn.addEventListener('click', () => {
    if (!confirm('确认清空侧边栏记录？')) return;
    entries = [];
    persist();
    renderList();
  });

  // ---- 一些 UX：拖拽侧边栏（可移动） ----
  (function makeDraggable(el) {
    let pos = {x:0,y:0,dragging:false,offsetX:0,offsetY:0};
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', (e) => {
      pos.dragging = true; pos.offsetX = e.clientX; pos.offsetY = e.clientY;
      el.style.transition = 'none';
      el.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!pos.dragging) return;
      const dx = e.clientX - pos.offsetX;
      const dy = e.clientY - pos.offsetY;
      const rect = el.getBoundingClientRect();
      el.style.right = 'auto';
      el.style.left = (rect.left + dx) + 'px';
      el.style.top = (rect.top + dy) + 'px';
      pos.offsetX = e.clientX; pos.offsetY = e.clientY;
    });
    window.addEventListener('mouseup', () => { pos.dragging = false; el.style.cursor = 'grab'; el.style.transition = ''; });
  })(sidebar);

  console.log('Gemini Jump Sidebar injected.');
})();
// ---- 页面刷新时清空侧边栏记录 ----
window.addEventListener('beforeunload', () => {
  entries = [];
  try {
    chrome.storage && chrome.storage.local && chrome.storage.local.set({ gj_entries: [] });
  } catch (e) { /* ignore */ }
});
