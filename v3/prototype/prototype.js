// Самостоятельный макет: только локальное состояние интерфейса, без API.
const icon = (name, size = 18) => `<svg class="icon" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const boards = [
  {
    id: 'main', name: 'Рабочая доска', camera: null, selectedLaneId: 'planning',
    lanes: [
      {
        id: 'planning', rootId: 'planning', parentId: null, x: 160, y: 110, width: 476,
        title: 'Планирование', provider: 'Codex', model: 'Sol', context: 42,
        approval: 'Ручное', effort: 'Высокий', speed: 'Обычная', temperature: 0.7,
        messages: [
          { id: 'p1', role: 'user', text: 'Нужно спроектировать рабочую доску для диалогов с AI. Что должно быть видно сразу?' },
          { id: 'p2', role: 'assistant', text: 'На первом экране я бы оставил сами ленты и вкладки досок. Управление камерой — в небольшой плавающей панели. Настройки конкретной сессии находятся у поля ввода.', duration: '4,8 с', request: '{ "model": "sol", "stream": true }', tools: 'Инструменты не вызывались.' },
        ],
      },
      {
        id: 'branch', rootId: 'planning', parentId: 'planning', sourceMessageId: 'p2',
        sourceText: 'На первом экране я бы оставил сами ленты и вкладки досок.',
        x: 706, y: 260, width: 458, title: 'Вариант с деталями', provider: 'Codex', model: 'Sol', context: 17,
        approval: 'Ручное', effort: 'Средний', speed: 'Обычная', temperature: 0.7,
        messages: [
          { id: 'b1', role: 'user', text: 'А если детали выполнения раскрывать отдельно у каждого ответа?' },
          { id: 'b2', role: 'assistant', text: 'Да. В свернутом состоянии остаётся строка «Выполнена за 5,1 с». Нажатие открывает запрос и вызовы инструментов именно для этого ответа.', duration: '5,1 с', request: '{ "model": "sol", "stream": true }', tools: 'Инструменты не вызывались.' },
        ],
      },
      {
        id: 'notes', rootId: 'notes', parentId: null, x: 1286, y: 142, width: 450,
        title: 'Отдельная гипотеза', provider: 'OpenRouter', model: 'Qwen 3', context: 23,
        approval: 'Ручное', effort: '—', speed: '—', temperature: 0.7,
        messages: [
          { id: 'n1', role: 'user', text: 'Предложи альтернативу боковой панели для настроек.' },
          { id: 'n2', role: 'assistant', text: 'Показывать настройки рядом с полем ввода текущей ленты. Тогда доска остаётся свободной, а источник ответа читается там, где пользователь его ожидает.', duration: '2,7 с', request: '{ "model": "qwen", "temperature": 0.7 }', tools: 'Инструменты не вызывались.' },
        ],
      },
    ],
  },
  {
    id: 'blank', name: 'Чистая доска', camera: null, selectedLaneId: 'first',
    lanes: [{
      id: 'first', rootId: 'first', parentId: null, x: 190, y: 140, width: 476,
      title: 'Новая лента', provider: 'Codex', model: 'Sol', context: 0,
      approval: 'Ручное', effort: 'Средний', speed: 'Обычная', temperature: 0.7, messages: [],
    }],
  },
];

boards[0].lanes[1].historyPrefix = boards[0].lanes[0].messages.slice(0, 2).map((message) => ({ ...message }));

const state = { activeBoardId: 'main', mode: 'free', expanded: new Set(), drafts: new Map(), drag: null, toastTimer: null };
const app = document.querySelector('#app');
const settingsDialog = document.querySelector('#settings-dialog');
const editDialog = document.querySelector('#edit-dialog');
const toastElement = document.querySelector('#toast');
const board = () => boards.find((item) => item.id === state.activeBoardId);
const laneById = (id) => board().lanes.find((lane) => lane.id === id);
const camera = () => board().camera;

function toast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 3300);
}

function textContent(value) {
  return escapeHtml(value).split('\n').map((line) => line || '&nbsp;').join('<br>');
}

function renderMessage(lane, message) {
  const common = `data-message-id="${escapeHtml(message.id)}"`;
  if (message.role === 'settings') {
    return `<div class="settings-event" ${common}>${icon('settings', 15)}<span>${escapeHtml(message.text)}</span></div>`;
  }
  if (message.role === 'queue') {
    return `<div class="queue-event" ${common}><span class="queue-dot"></span><span><strong>В очереди</strong> · ${textContent(message.text)}</span></div>`;
  }
  if (message.role === 'demo') {
    return `<div class="demo-note" ${common}>${escapeHtml(message.text)}</div>`;
  }
  const actions = `<div class="message-actions">
    <button class="icon-button" type="button" data-action="copy-message" data-lane="${lane.id}" data-message="${message.id}" title="Копировать текст" aria-label="Копировать текст">${icon('copy', 15)}</button>
    <button class="icon-button" type="button" data-action="branch" data-lane="${lane.id}" data-message="${message.id}" title="Создать ветку отсюда" aria-label="Создать ветку отсюда">${icon('branch', 15)}</button>
    <button class="icon-button" type="button" data-action="edit-message" data-lane="${lane.id}" data-message="${message.id}" title="Изменить сообщение" aria-label="Изменить сообщение">${icon('edit', 15)}</button>
    <button class="icon-button" type="button" data-action="delete-message" data-lane="${lane.id}" data-message="${message.id}" title="Удалить сообщение" aria-label="Удалить сообщение">${icon('trash', 15)}</button>
  </div>`;
  if (message.role === 'user') {
    return `<article class="message user-message" ${common}><div class="user-bubble">${textContent(message.text)}${actions}</div></article>`;
  }
  const expanded = state.expanded.has(message.id);
  return `<article class="message assistant-message" ${common}>
    <div class="assistant-copy">${textContent(message.text)}</div>
    <button class="run-toggle" type="button" data-action="toggle-details" data-message="${message.id}" aria-expanded="${expanded}">
      <span class="run-duration">Выполнена за ${escapeHtml(message.duration || '3,0 с')}</span>
      <span class="run-open-hint">${expanded ? 'Скрыть детали' : 'Показать детали'}</span>${icon('chevron', 14)}
    </button>
    ${expanded ? `<div class="run-details"><div class="detail-line"><span>Запрос к LLM</span><code>${escapeHtml(message.request || '{ "stream": true }')}</code></div><div class="detail-line"><span>Использование инструментов</span><p>${escapeHtml(message.tools || 'Инструменты не вызывались.')}</p></div></div>` : ''}
    ${actions}
  </article>`;
}

function renderLane(lane) {
  const selected = board().selectedLaneId === lane.id;
  const independent = !lane.parentId;
  const providerMeta = lane.provider === 'Codex'
    ? `<span>Подтверждение: ${escapeHtml(lane.approval)}</span><span>Effort: ${escapeHtml(lane.effort)}</span><span>Скорость: ${escapeHtml(lane.speed)}</span>`
    : `<span>Подтверждение: ${escapeHtml(lane.approval)}</span><span>Температура: ${escapeHtml(lane.temperature)}</span>`;
  return `<section class="lane ${selected ? 'selected' : ''} ${independent ? 'independent' : 'linked'}" data-lane-id="${lane.id}" style="left:${lane.x}px;top:${lane.y}px;width:${lane.width}px">
    <header class="lane-header" data-drag-lane="${independent ? lane.id : ''}">
      <div class="lane-header-main">${independent ? `<span class="drag-grip" title="Перетащить независимую ленту и её ветки">${icon('grip', 15)}</span>` : ''}<span class="lane-title" data-title-lane="${lane.id}" title="Двойной щелчок — изменить название">${escapeHtml(lane.title)}</span>
        <div class="lane-header-actions"><button class="icon-button" type="button" data-action="clone" data-lane="${lane.id}" title="Клонировать ленту" aria-label="Клонировать ленту">${icon('copy', 16)}</button></div>
      </div>
      ${lane.parentId ? `<div class="lane-subtitle">${icon('branch', 13)} Ветка · история до точки ветвления сохранена</div>` : ''}
    </header>
    <div class="lane-body">
      ${lane.parentId ? `<div class="branch-context"><span>Ответвление от сообщения</span><p>${escapeHtml(lane.sourceText || '')}</p></div>` : ''}
      <div class="messages">${lane.messages.length ? lane.messages.map((message) => renderMessage(lane, message)).join('') : '<p class="empty-lane">Лента пуста. Начни с сообщения внизу.</p>'}</div>
      <div class="composer"><label class="sr-only" for="composer-${lane.id}">Сообщение в ленту ${escapeHtml(lane.title)}</label>
        <textarea id="composer-${lane.id}" data-composer="${lane.id}" rows="1" placeholder="Написать сообщение…" spellcheck="true">${escapeHtml(state.drafts.get(lane.id) || '')}</textarea>
        <div class="composer-bottom"><span>Enter — корректировка <i></i> Shift+Enter — в очередь</span>
          <button class="send-button" type="button" data-action="send" data-lane="${lane.id}" title="Отправить корректировку" aria-label="Отправить корректировку">${icon('send', 17)}</button>
        </div>
      </div>
      <footer class="lane-footer"><div class="footer-first"><span class="provider-name">${escapeHtml(lane.provider)} <span class="provider-sep">·</span> ${escapeHtml(lane.model)}</span>
        <span class="context-label">Контекст ${lane.context}%</span></div>
        <div class="context-track"><span style="width:${Math.min(100, lane.context)}%"></span></div>
        <div class="footer-second">${providerMeta}<button class="icon-button settings-button" type="button" data-action="settings" data-lane="${lane.id}" title="Настройки сессии" aria-label="Настройки сессии">${icon('settings', 17)}</button></div>
      </footer>
    </div><div class="resize-handle" data-resize-lane="${lane.id}" title="Изменить ширину ленты"></div>
  </section>`;
}

function render() {
  app.innerHTML = `<div class="prototype-shell">
    <nav class="board-tabs" aria-label="Доски"><div class="board-tab-list">${boards.map((item) => `<button class="board-tab ${item.id === state.activeBoardId ? 'active' : ''}" type="button" data-action="select-board" data-board="${item.id}">${escapeHtml(item.name)}</button>`).join('')}
      <button class="board-add icon-button" type="button" data-action="add-board" title="Создать доску" aria-label="Создать доску">${icon('plus', 18)}</button></div>
      <span class="prototype-badge">Интерактивный макет · без API</span>
    </nav>
    <main class="board-viewport" id="board-viewport" aria-label="Доска с лентами">
      <div class="board-stage" id="board-stage"><svg class="connection-layer" id="connections" aria-hidden="true"></svg>${board().lanes.map(renderLane).join('')}</div>
      <div class="canvas-controls"><button class="mode-button" type="button" data-action="toggle-mode" title="Переключить режим перемещения">${icon(state.mode === 'free' ? 'free' : 'focus', 18)}<span>${state.mode === 'free' ? 'Свободный' : 'Фиксированный'}</span></button>
        <span class="control-divider"></span><button class="icon-button" type="button" data-action="zoom-out" title="Уменьшить" aria-label="Уменьшить">${icon('zoom-out', 18)}</button>
        <span class="zoom-level">${Math.round((board().camera?.zoom ?? 0.9) * 100)}%</span>
        <button class="icon-button" type="button" data-action="zoom-in" title="Увеличить" aria-label="Увеличить">${icon('zoom-in', 18)}</button></div>
    </main>
  </div>`;
  if (!board().camera) {
    const viewport = document.querySelector('#board-viewport');
    const lane = laneById(board().selectedLaneId);
    const zoom = 1;
    board().camera = { zoom, x: board().id === 'main' ? 36 - lane.x * zoom : viewport.clientWidth / 2 - (lane.x + lane.width / 2) * zoom, y: 46 - lane.y * zoom };
  }
  applyCamera();
  renderConnections();
  document.querySelectorAll('textarea[data-composer]').forEach(autoGrow);
}

function applyCamera() {
  const viewport = document.querySelector('#board-viewport');
  const stage = document.querySelector('#board-stage');
  if (!viewport || !stage) return;
  const { x, y, zoom } = camera();
  stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  viewport.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  document.querySelector('.zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  updateStickyHeaders();
}

function updateStickyHeaders() {
  const viewport = document.querySelector('#board-viewport');
  if (!viewport) return;
  for (const element of document.querySelectorAll('.lane')) {
    const lane = laneById(element.dataset.laneId);
    const header = element.querySelector('.lane-header');
    const composer = element.querySelector('.composer');
    const visualTop = lane.y * camera().zoom + camera().y;
    const needed = Math.max(0, (14 - visualTop) / camera().zoom);
    const limit = Math.max(0, composer.offsetTop - header.offsetHeight - 12);
    header.style.transform = `translateY(${Math.min(needed, limit)}px)`;
  }
}

function renderConnections() {
  const svg = document.querySelector('#connections');
  if (!svg) return;
  svg.innerHTML = board().lanes.filter((lane) => lane.parentId).map((lane) => {
    const parent = laneById(lane.parentId);
    const source = document.querySelector(`[data-lane-id="${parent.id}"] [data-message-id="${lane.sourceMessageId}"]`);
    const y1 = parent.y + (source?.offsetTop ?? 170) + (source?.offsetHeight ?? 40) / 2;
    const x1 = parent.x + parent.width;
    const x2 = lane.x;
    const y2 = lane.y + 54;
    const curve = Math.max(34, (x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}" />`;
  }).join('');
}

function focusLane(laneId, smooth = true) {
  const lane = laneById(laneId);
  if (!lane) return;
  board().selectedLaneId = laneId;
  const viewport = document.querySelector('#board-viewport');
  if (!viewport) return;
  camera().x = viewport.clientWidth / 2 - (lane.x + lane.width / 2) * camera().zoom;
  if (state.mode === 'fixed') camera().y = Math.min(62 - lane.y * camera().zoom, camera().y);
  const stage = document.querySelector('#board-stage');
  stage.style.transition = smooth ? 'transform 240ms ease' : 'none';
  applyCamera();
  setTimeout(() => { if (stage.isConnected) stage.style.transition = 'none'; }, 250);
  document.querySelectorAll('.lane').forEach((node) => node.classList.toggle('selected', node.dataset.laneId === laneId));
}

function zoomAt(factor, clientX, clientY) {
  const rect = document.querySelector('#board-viewport').getBoundingClientRect();
  const pointX = clientX - rect.left;
  const pointY = clientY - rect.top;
  const before = camera().zoom;
  const after = Math.max(0.55, Math.min(1.55, before * factor));
  camera().x = pointX - (pointX - camera().x) * after / before;
  camera().y = pointY - (pointY - camera().y) * after / before;
  camera().zoom = after;
  if (state.mode === 'fixed') {
    const lane = laneById(board().selectedLaneId);
    camera().x = rect.width / 2 - (lane.x + lane.width / 2) * after;
  }
  applyCamera();
}

function autoGrow(textarea) {
  textarea.style.height = '0px';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  updateStickyHeaders();
}

function showSettings(lane) {
  const codex = lane.provider === 'Codex';
  settingsDialog.innerHTML = `<form method="dialog" id="settings-form" data-lane="${lane.id}">
    <div class="dialog-heading"><div><span class="eyebrow">Сессия</span><h2>Настройки ленты</h2></div><button type="button" class="icon-button" data-action="close-settings" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <p class="dialog-note">Провайдер выбран при создании ленты. Изменения добавятся отдельным блоком в диалог.</p>
    <label>Провайдер<input value="${escapeHtml(lane.provider)}" disabled></label>
    <label>Модель<input name="model" value="${escapeHtml(lane.model)}" required maxlength="60"></label>
    <label>Режим подтверждения<select name="approval"><option value="Ручное" ${lane.approval === 'Ручное' ? 'selected' : ''}>Ручное</option><option value="Авто" ${lane.approval === 'Авто' ? 'selected' : ''}>Авто</option></select></label>
    ${codex ? `<label>Effort<select name="effort"><option ${lane.effort === 'Низкий' ? 'selected' : ''}>Низкий</option><option ${lane.effort === 'Средний' ? 'selected' : ''}>Средний</option><option ${lane.effort === 'Высокий' ? 'selected' : ''}>Высокий</option></select></label>
      <label>Скоростной режим<select name="speed"><option ${lane.speed === 'Обычная' ? 'selected' : ''}>Обычная</option><option ${lane.speed === 'Быстрая' ? 'selected' : ''}>Быстрая</option></select></label>`
      : `<label>Температура<input name="temperature" type="number" min="0" max="2" step="0.1" value="${escapeHtml(lane.temperature)}"></label>`}
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-settings">Отмена</button><button type="submit" class="primary-button">Сохранить</button></div>
  </form>`;
  settingsDialog.showModal();
}

function showMessageDialog(lane, message, kind) {
  const edit = kind === 'edit';
  editDialog.innerHTML = `<form method="dialog" id="message-form" data-lane="${lane.id}" data-message="${message.id}" data-kind="${kind}">
    <div class="dialog-heading"><div><span class="eyebrow">История ленты</span><h2>${edit ? 'Изменить сообщение' : 'Удалить сообщение'}</h2></div><button type="button" class="icon-button" data-action="close-edit" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <p class="dialog-note">Это сообщение и все следующие в этой ленте будут удалены. Уже созданные ветки не изменятся.</p>
    ${edit ? `<label>Новый текст<textarea name="text" rows="5" required>${escapeHtml(message.text)}</textarea></label>` : `<blockquote>${escapeHtml(message.text)}</blockquote>`}
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-edit">Отмена</button><button type="submit" class="primary-button ${edit ? '' : 'danger'}">${edit ? 'Сохранить' : 'Удалить'}</button></div>
  </form>`;
  editDialog.showModal();
}

function addBoard() {
  const number = boards.length + 1;
  const laneId = uid();
  const id = uid();
  boards.push({ id, name: `Доска ${number}`, camera: null, selectedLaneId: laneId, lanes: [{
    id: laneId, rootId: laneId, parentId: null, x: 190, y: 140, width: 476,
    title: 'Новая лента', provider: 'Codex', model: 'Sol', context: 0,
    approval: 'Ручное', effort: 'Средний', speed: 'Обычная', temperature: 0.7, messages: [],
  }] });
  state.activeBoardId = id;
  render();
}

function branchFrom(lane, message) {
  const source = document.querySelector(`[data-lane-id="${lane.id}"] [data-message-id="${message.id}"]`);
  const rightmost = Math.max(...board().lanes.filter((item) => item.rootId === lane.rootId).map((item) => item.x + item.width));
  const x = rightmost + 66;
  const shift = lane.width + 96;
  const otherRoots = new Set(board().lanes.filter((item) => item.rootId !== lane.rootId && item.x >= x).map((item) => item.rootId));
  board().lanes.forEach((item) => { if (otherRoots.has(item.rootId)) item.x += shift; });
  const id = uid();
  board().lanes.push({
    ...lane, id, rootId: lane.rootId, parentId: lane.id, sourceMessageId: message.id,
    sourceText: message.text.slice(0, 120), x,
    y: lane.y + (source?.offsetTop ?? 160) - 54, title: `${lane.title} · ветка`, context: Math.max(0, lane.context - 8),
    historyPrefix: [...(lane.historyPrefix || []), ...lane.messages.slice(0, lane.messages.indexOf(message) + 1)].map((item) => ({ ...item })), messages: [],
  });
  board().selectedLaneId = id;
  render();
  focusLane(id);
  toast('Ветка создана. Прошлая история сохранена.');
}

function cloneLane(lane) {
  const id = uid();
  const rightmost = Math.max(...board().lanes.map((item) => item.x + item.width));
  board().lanes.push({ ...lane, id, rootId: id, parentId: null, sourceMessageId: null, historyPrefix: [],
    x: rightmost + 90, y: lane.y, title: `${lane.title} · копия`,
    messages: [...(lane.historyPrefix || []), ...lane.messages].map((message) => ({ ...message, id: uid() })) });
  board().selectedLaneId = id;
  render();
  focusLane(id);
  toast('Клон создан как независимая лента.');
}

function sendMessage(laneId, queued) {
  const textarea = document.querySelector(`[data-composer="${laneId}"]`);
  const value = textarea?.value.trim();
  if (!value) return;
  const lane = laneById(laneId);
  state.drafts.delete(laneId);
  lane.messages.push({ id: uid(), role: queued ? 'queue' : 'user', text: value });
  if (!queued) lane.messages.push({ id: uid(), role: 'demo', text: 'Макет: запрос не отправлен, ответ модели здесь не генерируется.' });
  board().selectedLaneId = laneId;
  render();
  const composer = document.querySelector(`[data-composer="${laneId}"]`);
  const composerTop = lane.y + composer.closest('.composer').offsetTop;
  const viewport = document.querySelector('#board-viewport');
  const screenY = composerTop * camera().zoom + camera().y;
  if (screenY > viewport.clientHeight - 130) camera().y -= screenY - (viewport.clientHeight - 130);
  applyCamera();
  composer.focus();
  toast(queued ? 'Задача добавлена в очередь макета.' : 'Корректировка показана в макете.');
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (button) {
    const action = button.dataset.action;
    const lane = button.dataset.lane ? laneById(button.dataset.lane) : null;
    const message = lane?.messages.find((item) => item.id === button.dataset.message);
    if (action === 'select-board') { state.activeBoardId = button.dataset.board; render(); return; }
    if (action === 'add-board') { addBoard(); return; }
    if (action === 'toggle-mode') { state.mode = state.mode === 'free' ? 'fixed' : 'free'; render(); if (state.mode === 'fixed') focusLane(board().selectedLaneId); return; }
    if (action === 'zoom-in' || action === 'zoom-out') {
      const rect = document.querySelector('#board-viewport').getBoundingClientRect();
      zoomAt(action === 'zoom-in' ? 1.12 : 1 / 1.12, rect.left + rect.width / 2, rect.top + rect.height / 2); return;
    }
    if (action === 'toggle-details') { state.expanded.has(button.dataset.message) ? state.expanded.delete(button.dataset.message) : state.expanded.add(button.dataset.message); render(); return; }
    if (action === 'settings') { showSettings(lane); return; }
    if (action === 'clone') { cloneLane(lane); return; }
    if (action === 'branch' && message) { branchFrom(lane, message); return; }
    if (action === 'edit-message' && message) { showMessageDialog(lane, message, 'edit'); return; }
    if (action === 'delete-message' && message) { showMessageDialog(lane, message, 'delete'); return; }
    if (action === 'send') { sendMessage(lane.id, false); return; }
    if (action === 'copy-message' && message) {
      try { await navigator.clipboard.writeText(message.text); toast('Текст скопирован.'); }
      catch { toast('Браузер не разрешил копирование. Открой макет через localhost.'); }
      return;
    }
  }
  const laneElement = event.target.closest('.lane');
  if (laneElement && state.mode === 'fixed' && !event.target.closest('textarea,button,input')) focusLane(laneElement.dataset.laneId);
});

app.addEventListener('dblclick', (event) => {
  const title = event.target.closest('[data-title-lane]');
  if (!title) return;
  const lane = laneById(title.dataset.titleLane);
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = lane.title;
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) lane.title = input.value.trim();
    render();
  };
  input.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key === 'Enter') commit(true);
    if (keyEvent.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
});

app.addEventListener('input', (event) => {
  if (event.target.matches('textarea[data-composer]')) {
    state.drafts.set(event.target.dataset.composer, event.target.value);
    autoGrow(event.target);
  }
});

app.addEventListener('keydown', (event) => {
  const textarea = event.target.closest('textarea[data-composer]');
  if (!textarea || event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  sendMessage(textarea.dataset.composer, event.shiftKey);
});

app.addEventListener('wheel', (event) => {
  if (!event.target.closest('#board-viewport')) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) {
    zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
  } else {
    camera().y -= event.deltaY;
    if (state.mode === 'free' && event.shiftKey) camera().x -= event.deltaY;
    applyCamera();
  }
}, { passive: false });

app.addEventListener('pointerdown', (event) => {
  const viewport = event.target.closest('#board-viewport');
  if (!viewport) return;
  if (event.button === 1) {
    event.preventDefault();
    state.drag = { kind: 'camera', x: event.clientX, y: event.clientY, initialX: camera().x, initialY: camera().y };
    return;
  }
  if (event.button !== 0 || event.target.closest('button,input,textarea,.lane-title')) return;
  const resize = event.target.closest('[data-resize-lane]');
  if (resize) {
    event.preventDefault();
    const lane = laneById(resize.dataset.resizeLane);
    state.drag = { kind: 'resize', x: event.clientX, laneId: lane.id, width: lane.width };
    return;
  }
  const handle = event.target.closest('[data-drag-lane]');
  if (handle?.dataset.dragLane) {
    event.preventDefault();
    const lane = laneById(handle.dataset.dragLane);
    state.drag = { kind: 'lane', x: event.clientX, y: event.clientY, rootId: lane.rootId,
      positions: board().lanes.filter((item) => item.rootId === lane.rootId).map((item) => ({ id: item.id, x: item.x, y: item.y })) };
  }
});

window.addEventListener('pointermove', (event) => {
  const drag = state.drag;
  if (!drag) return;
  if (drag.kind === 'camera') {
    camera().x = drag.initialX + event.clientX - drag.x;
    camera().y = drag.initialY + event.clientY - drag.y;
    if (state.mode === 'fixed') {
      const lane = laneById(board().selectedLaneId);
      camera().x = document.querySelector('#board-viewport').clientWidth / 2 - (lane.x + lane.width / 2) * camera().zoom;
    }
    applyCamera();
  } else if (drag.kind === 'lane') {
    const dx = (event.clientX - drag.x) / camera().zoom;
    const dy = (event.clientY - drag.y) / camera().zoom;
    for (const initial of drag.positions) {
      const lane = laneById(initial.id);
      lane.x = Math.round(initial.x + dx);
      lane.y = Math.round(initial.y + dy);
      const element = document.querySelector(`[data-lane-id="${lane.id}"]`);
      element.style.left = `${lane.x}px`;
      element.style.top = `${lane.y}px`;
    }
    renderConnections();
    updateStickyHeaders();
  } else if (drag.kind === 'resize') {
    const lane = laneById(drag.laneId);
    lane.width = Math.max(360, Math.min(640, Math.round(drag.width + (event.clientX - drag.x) / camera().zoom)));
    document.querySelector(`[data-lane-id="${lane.id}"]`).style.width = `${lane.width}px`;
    renderConnections();
    updateStickyHeaders();
  }
});

window.addEventListener('pointerup', () => { state.drag = null; });
window.addEventListener('resize', () => { if (state.mode === 'fixed') focusLane(board().selectedLaneId, false); });
app.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); });

settingsDialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-settings"]')) settingsDialog.close();
});
settingsDialog.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const lane = laneById(form.dataset.lane);
  const data = new FormData(form);
  const changes = [];
  const labels = { model: 'модель', approval: 'подтверждение', effort: 'effort', speed: 'скорость', temperature: 'температура' };
  for (const key of ['model', 'approval', 'effort', 'speed', 'temperature']) {
    if (!data.has(key)) continue;
    const value = key === 'temperature' ? Number(data.get(key)) : String(data.get(key)).trim();
    if (!value && key !== 'temperature') continue;
    if (lane[key] !== value) { lane[key] = value; changes.push(`${labels[key]} — ${value}`); }
  }
  settingsDialog.close();
  if (changes.length) {
    lane.messages.push({ id: uid(), role: 'settings', text: `Изменены настройки ленты: ${changes.join(', ')}` });
    render();
    toast('Настройки сохранены в макете.');
  }
});
editDialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-edit"]')) editDialog.close();
});
editDialog.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const lane = laneById(form.dataset.lane);
  const index = lane.messages.findIndex((item) => item.id === form.dataset.message);
  if (index < 0) { editDialog.close(); return; }
  const old = lane.messages[index];
  lane.messages = lane.messages.slice(0, index);
  if (form.dataset.kind === 'edit') lane.messages.push({ ...old, text: String(new FormData(form).get('text')).trim() });
  editDialog.close();
  render();
  toast('Хвост этой ленты изменён. Ветки остались прежними.');
});

render();
