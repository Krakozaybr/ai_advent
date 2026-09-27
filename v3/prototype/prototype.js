// Самостоятельный макет: только локальное состояние интерфейса, без API.
const icon = (name, size = 18) => `<svg class="icon" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const MODEL_CHOICES = {
  Codex: ['GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5'],
  OpenRouter: ['Qwen 3', 'GPT-4o mini', 'DeepSeek V3'],
};
const MIN_LANE_WIDTH = 560;
const SKILLS = ['Работа с файлами', 'Планирование', 'Поиск в сети'];
const MCP_SERVERS = [
  { name: 'Память доски', tools: [{ id: 'read_messages', description: 'Читать сообщения' }, { id: 'search_messages', description: 'Искать в истории' }, { id: 'save_fact', description: 'Сохранять факт' }] },
  { name: 'Задачи', tools: [{ id: 'list_tasks', description: 'Список задач' }, { id: 'create_task', description: 'Создать задачу' }, { id: 'update_task', description: 'Обновить задачу' }] },
  { name: 'Локальные файлы', tools: [{ id: 'list_files', description: 'Список файлов' }, { id: 'read_file', description: 'Читать файл' }, { id: 'write_file', description: 'Изменять файл' }] },
];

const boards = [
  {
    id: 'main', name: 'Рабочая доска', camera: null, selectedLaneId: 'planning',
    lanes: [
      {
        id: 'planning', rootId: 'planning', parentId: null, x: 160, y: 110, width: 560,
        title: 'Планирование', provider: 'Codex', model: 'GPT-6 Sol', context: 42,
        approval: 'Требует подтверждения', effort: 'Высокий', speed: 'Обычная', temperature: 0.7,
        messages: [
          { id: 'p1', role: 'user', text: 'Нужно спроектировать рабочую доску для диалогов с AI. Что должно быть видно сразу?' },
          { id: 'p2', role: 'assistant', text: 'На первом экране я бы оставил сами сессии и вкладки досок. Управление камерой — в небольшой плавающей панели. Настройки конкретной сессии находятся у поля ввода.', duration: '4,8 с', request: '{ "model": "sol", "stream": true }', tools: 'Инструменты не вызывались.' },
        ],
      },
      {
        id: 'branch', rootId: 'planning', parentId: 'planning', sourceMessageId: 'p2',
        sourceText: 'На первом экране я бы оставил сами сессии и вкладки досок.',
        x: 706, y: 260, width: 560, title: 'Вариант с деталями', provider: 'Codex', model: 'GPT-6 Sol', context: 17,
        approval: 'Требует подтверждения', effort: 'Средний', speed: 'Обычная', temperature: 0.7,
        messages: [
          { id: 'b1', role: 'user', text: 'А если детали выполнения раскрывать отдельно у каждого ответа?' },
          { id: 'b2', role: 'assistant', text: 'Да. В свернутом состоянии остаётся строка «Выполнена за 5,1 с». Нажатие открывает запрос и вызовы инструментов именно для этого ответа.', duration: '5,1 с', request: '{ "model": "sol", "stream": true }', tools: 'Инструменты не вызывались.' },
        ],
      },
      {
        id: 'notes', rootId: 'notes', parentId: null, x: 1286, y: 142, width: 560,
        title: 'Отдельная гипотеза', provider: 'OpenRouter', model: 'Qwen 3', context: 23,
        approval: 'Требует подтверждения', effort: '—', speed: '—', temperature: 0.7,
        messages: [
          { id: 'n1', role: 'user', text: 'Предложи альтернативу боковой панели для настроек.' },
          { id: 'n2', role: 'assistant', text: 'Показывать настройки рядом с полем ввода текущей сессии. Тогда доска остаётся свободной, а источник ответа читается там, где пользователь его ожидает.', duration: '2,7 с', request: JSON.stringify({ model: 'qwen', temperature: 0.7, messages: [{ role: 'system', content: 'Предложи компактное размещение настроек без боковой панели.' }, { role: 'user', content: 'Предложи альтернативу боковой панели для настроек.' }], stream: true }), reasoningSummary: 'Сопоставил место настроек с точкой отправки сообщения и оставил доску свободной для сессий.', toolUses: [{ name: 'search_messages', input: { query: 'настройки сессии' }, result: 'Найдено 2 сообщения о панели настроек.' }, { name: 'save_fact', input: { key: 'settings_location', value: 'рядом с полем ввода' }, result: 'Факт сохранён в памяти доски.' }] },
        ],
      },
    ],
  },
  {
    id: 'blank', name: 'Чистая доска', camera: null, selectedLaneId: 'first',
    lanes: [{
      id: 'first', rootId: 'first', parentId: null, x: 190, y: 140, width: 560,
      title: 'Новая сессия', provider: null, model: null, context: 0,
      approval: 'Требует подтверждения', effort: 'Средний', speed: 'Обычная', temperature: 0.7, messages: [],
    }],
  },
  {
    id: 'subagents', name: 'Сабагенты', camera: null, selectedLaneId: 'team-lead', expandedSubagents: { 'team-lead': false },
    lanes: [
      {
        id: 'team-lead', rootId: 'team-lead', parentId: null, x: 160, y: 0, width: 560,
        title: 'Подготовка релиза', provider: 'Codex', model: 'GPT-6 Sol', context: 58,
        approval: 'Требует подтверждения', effort: 'Высокий', speed: 'Обычная', temperature: 0.7,
        messages: [
          { id: 'team-user', role: 'user', text: 'Проверь готовность релиза: тесты, документацию и риски.' },
          { id: 'team-answer', role: 'assistant', text: 'Раздал три независимые проверки сабагентам. Тесты ещё идут; документация проверена, риски собраны.', duration: '12,4 с', request: '{ "model": "gpt-6-sol", "stream": true }', toolUses: [{ name: 'spawn_subagent', input: { task: 'Проверить тесты' }, result: 'Сабагент «Тесты» запущен.' }, { name: 'spawn_subagent', input: { task: 'Проверить документацию' }, result: 'Сабагент «Документация» завершил работу.' }] },
        ],
      },
      {
        id: 'agent-tests', rootId: 'team-lead', parentId: null, subagentOf: 'team-lead', active: true, pinned: false,
        x: 0, y: 0, width: 560, title: 'Тесты', provider: 'Codex', model: 'GPT-6 Luna', context: 35,
        approval: 'Требует подтверждения', effort: 'Средний', speed: 'Быстрая', temperature: 0.7,
        messages: [{ id: 'tests-user', role: 'user', text: 'Проверь тесты перед релизом.' }, { id: 'tests-answer', role: 'assistant', text: 'Запущена проверка: есть один нестабильный сценарий, перепроверяю его.', duration: '8,2 с', request: '{ "model": "gpt-6-luna", "stream": true }' }],
      },
      {
        id: 'agent-docs', rootId: 'team-lead', parentId: null, subagentOf: 'team-lead', active: false, pinned: true,
        x: 0, y: 0, width: 560, title: 'Документация', provider: 'Codex', model: 'GPT-6 Luna', context: 22,
        approval: 'Требует подтверждения', effort: 'Низкий', speed: 'Обычная', temperature: 0.7,
        messages: [{ id: 'docs-user', role: 'user', text: 'Проверь документацию релиза.' }, { id: 'docs-answer', role: 'assistant', text: 'Описание изменений и инструкция обновления готовы.', duration: '6,5 с', request: '{ "model": "gpt-6-luna", "stream": true }' }],
      },
      {
        id: 'agent-risks', rootId: 'team-lead', parentId: null, subagentOf: 'team-lead', active: false, pinned: false,
        x: 0, y: 0, width: 560, title: 'Риски', provider: 'Codex', model: 'GPT-6 Luna', context: 18,
        approval: 'Требует подтверждения', effort: 'Средний', speed: 'Обычная', temperature: 0.7,
        messages: [{ id: 'risks-user', role: 'user', text: 'Собери риски релиза.' }, { id: 'risks-answer', role: 'assistant', text: 'Главный риск — нестабильный тест оплаты; требуется повторный прогон.', duration: '5,3 с', request: '{ "model": "gpt-6-luna", "stream": true }' }],
      },
    ],
  },
];

boards[0].lanes[1].historyPrefix = boards[0].lanes[0].messages.slice(0, 2).map((message) => ({ ...message }));

const state = { activeBoardId: 'main', boardCounter: boards.length, mode: 'free', expanded: new Set(), expandedRequests: new Set(), drafts: new Map(), drag: null, openMenu: null, settingsDraft: null, scrollTarget: null, scrollFrame: null, toastTimer: null };
const app = document.querySelector('#app');
const settingsDialog = document.querySelector('#settings-dialog');
const editDialog = document.querySelector('#edit-dialog');
const archiveDialog = document.querySelector('#archive-dialog');
const subagentsDialog = document.querySelector('#subagents-dialog');
const toastElement = document.querySelector('#toast');
const board = () => boards.find((item) => item.id === state.activeBoardId);
const laneById = (id) => board().lanes.find((lane) => lane.id === id);
const camera = () => board().camera;
function laneVisible(lane) {
  if (!lane || lane.archived) return false;
  if (lane.subagentOf) {
    const parent = laneById(lane.subagentOf);
    return Boolean(parent && laneVisible(parent) && (lane.active || (board().expandedSubagents?.[parent.id] && lane.pinned)));
  }
  if (lane.parentId) {
    const parent = laneById(lane.parentId);
    return Boolean(parent && laneVisible(parent));
  }
  return true;
}
const visibleLanes = () => board().lanes.filter(laneVisible);
const sessionCount = (count) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сессия' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'сессии' : 'сессий'}`;

function renderTabs() {
  const openBoards = boards.filter((item) => !item.closed && !item.archived);
  const archivedCount = board()?.lanes.filter((lane) => lane.archived).length ?? 0;
  return `<nav class="board-tabs" aria-label="Доски"><div class="board-tab-list"><button class="board-tab home-tab ${state.activeBoardId === 'home' ? 'active' : ''}" type="button" data-action="show-home">Home</button>${openBoards.map((item) => `<div class="board-tab-item"><button class="board-tab ${item.id === state.activeBoardId ? 'active' : ''}" type="button" data-action="select-board" data-board="${item.id}">${escapeHtml(item.name)}</button><button class="tab-close icon-button" type="button" data-action="close-board" data-board="${item.id}" title="Закрыть доску" aria-label="Закрыть доску ${escapeHtml(item.name)}">${icon('close', 13)}</button></div>`).join('')}
    <button class="board-add icon-button" type="button" data-action="add-board" title="Создать доску" aria-label="Создать доску">${icon('plus', 18)}</button></div>
    <div class="board-toolbar">${state.activeBoardId === 'home' ? '' : `<button class="archive-link" type="button" data-action="show-archive">Архив сессий${archivedCount ? ` · ${archivedCount}` : ''}</button>`}<span class="prototype-badge">Интерактивный макет · без API</span></div>
  </nav>`;
}

function renderBoardCard(item) {
  return `<article class="board-card"><div class="board-card-top"><span class="board-status ${item.archived ? 'archived' : item.closed ? 'closed' : ''}">${item.archived ? 'В архиве' : item.closed ? 'Вкладка закрыта' : 'Открыта'}</span><span>${sessionCount(item.lanes.length)}</span></div><h3>${escapeHtml(item.name)}</h3><div class="board-card-actions">${item.archived ? `<button class="secondary-button" type="button" data-action="restore-board" data-board="${item.id}">Восстановить</button>` : `<button class="secondary-button" type="button" data-action="select-board" data-board="${item.id}">Открыть</button><button class="icon-button" type="button" data-action="archive-board" data-board="${item.id}" title="В архив" aria-label="В архив: ${escapeHtml(item.name)}">${icon('archive', 17)}</button>`}<button class="icon-button" type="button" data-action="delete-board" data-board="${item.id}" title="Удалить доску" aria-label="Удалить доску ${escapeHtml(item.name)}">${icon('trash', 17)}</button></div></article>`;
}

function renderHome() {
  const current = boards.filter((item) => !item.archived);
  const archived = boards.filter((item) => item.archived);
  app.innerHTML = `<div class="prototype-shell">${renderTabs()}<main class="home-screen"><div class="home-content"><div class="home-heading"><div><h1>Доски</h1><p>Открой доску или создай новую. Закрытая вкладка остаётся здесь.</p></div><button class="primary-button" type="button" data-action="add-board">${icon('plus', 16)} Создать доску</button></div>
    <div class="home-grid">${current.map(renderBoardCard).join('') || '<p class="home-empty">Досок пока нет.</p>'}</div>${archived.length ? `<section class="home-archive"><h2>Архив досок</h2><div class="home-grid">${archived.map(renderBoardCard).join('')}</div></section>` : ''}</div></main></div>`;
}

function layoutLanes() {
  let x = 160;
  let previous = null;
  for (const lane of visibleLanes()) {
    if (previous) x += previous.width + (lane.subagentOf && lane.rootId === previous.rootId ? 0 : 66);
    lane.x = x;
    if (!lane.parentId) lane.y = 0;
    previous = lane;
  }
}

function alignBranches() {
  for (const lane of visibleLanes().filter((item) => item.parentId)) {
    const parent = laneById(lane.parentId);
    const source = document.querySelector(`[data-lane-id="${parent.id}"] [data-message-id="${lane.sourceMessageId}"]`);
    const element = document.querySelector(`[data-lane-id="${lane.id}"]`);
    const headerHeight = element?.querySelector('.lane-header')?.offsetHeight ?? 47;
    lane.y = parent.y + (source?.offsetTop ?? lane.sourceOffset ?? 190) - headerHeight - 8;
    lane.sourceOffset = (source?.offsetTop ?? lane.sourceOffset ?? 190);
    if (element) element.style.top = `${lane.y}px`;
  }
}

function configMenu(lane, key, label, values, className = '') {
  const open = state.openMenu === `${lane.id}:${key}`;
  const valueHtml = escapeHtml(lane[key]);
  return `<div class="config-menu ${className}"><span class="config-label">${escapeHtml(label)}</span>
    <button class="config-trigger" type="button" data-action="toggle-config" data-lane="${lane.id}" data-config="${key}" aria-label="${escapeHtml(label)}: ${escapeHtml(lane[key])}" title="${escapeHtml(label)}: ${escapeHtml(lane[key])}" aria-expanded="${open}" aria-haspopup="menu">${valueHtml}</button>
    ${open ? `<div class="config-popover" role="menu" aria-label="${escapeHtml(label)}">${values.map((value) => `<button class="config-option" type="button" role="menuitemradio" aria-checked="${String(lane[key]) === value}" data-action="config-choice" data-lane="${lane.id}" data-config="${key}" data-value="${escapeHtml(value)}"><span>${escapeHtml(value)}</span>${String(lane[key]) === value ? icon('check', 14) : ''}</button>`).join('')}</div>` : ''}
  </div>`;
}

function modelWidget(lane) {
  const open = state.openMenu === `${lane.id}:model-widget`;
  const fast = lane.speed === 'Быстрая';
  return `<div class="model-widget"><button class="model-widget-trigger" type="button" data-action="toggle-model-widget" data-lane="${lane.id}" aria-label="Модель: ${escapeHtml(lane.model)}; уровень рассуждения: ${escapeHtml(lane.effort)}" aria-expanded="${open}" aria-haspopup="menu"><span>${escapeHtml(lane.model)}</span><span class="model-widget-effort">${escapeHtml(lane.effort)}</span>${icon('chevron', 13)}</button>
    <button class="speed-toggle ${fast ? 'active' : ''}" type="button" data-action="toggle-speed" data-lane="${lane.id}" aria-label="Скорость: ${escapeHtml(lane.speed)}" aria-pressed="${fast}" title="${fast ? 'Быстрая скорость' : 'Обычная скорость'}">${icon('bolt', 15)}</button>
    ${open ? `<div class="model-popover" role="menu" aria-label="Модель и уровень рассуждения"><span class="model-popover-label">Модель</span><div class="model-options">${MODEL_CHOICES.Codex.map((value) => `<button type="button" role="menuitemradio" aria-checked="${lane.model === value}" data-action="model-choice" data-lane="${lane.id}" data-value="${escapeHtml(value)}">${escapeHtml(value)}${lane.model === value ? icon('check', 14) : ''}</button>`).join('')}</div><span class="model-popover-label">Уровень рассуждения</span><div class="effort-options">${['Низкий', 'Средний', 'Высокий'].map((value) => `<button type="button" aria-pressed="${lane.effort === value}" data-action="effort-choice" data-lane="${lane.id}" data-value="${value}">${value}</button>`).join('')}</div></div>` : ''}
  </div>`;
}

function toast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 3300);
}

function textContent(value) {
  return escapeHtml(value).split('\n').map((line) => line || '&nbsp;').join('<br>');
}

function formatRequest(request) {
  try { return JSON.stringify(JSON.parse(request), null, 2); }
  catch { return request; }
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
    return `<article class="message user-message" ${common}><div class="user-bubble">${textContent(message.text)}</div>${actions}</article>`;
  }
  const expanded = state.expanded.has(message.id);
  const request = formatRequest(message.request || '{ "stream": true }');
  const longRequest = request.length > 180 || request.split('\n').length > 8;
  const requestExpanded = state.expandedRequests.has(message.id);
  const detailHtml = `<div class="run-details"><div class="detail-line"><div class="detail-heading"><span>Запрос к LLM</span><button class="icon-button" type="button" data-action="copy-request" data-lane="${lane.id}" data-message="${message.id}" title="Копировать запрос" aria-label="Копировать запрос">${icon('copy', 15)}</button></div>
    <pre class="request-code ${longRequest && !requestExpanded ? 'collapsed' : ''}"><code>${escapeHtml(request)}</code></pre>
    ${longRequest ? `<button class="request-expand" type="button" data-action="toggle-request" data-message="${message.id}" aria-expanded="${requestExpanded}">${requestExpanded ? 'Свернуть запрос' : 'Показать весь запрос'}${icon('chevron', 13)}</button>` : ''}</div>
    ${message.reasoningSummary ? `<div class="detail-line"><span>Ход работы · краткое публичное описание</span><p>${escapeHtml(message.reasoningSummary)}</p></div>` : ''}
    ${message.toolUses?.length ? `<div class="detail-line"><span>Использование инструментов</span>${message.toolUses.map((tool) => `<div class="tool-use"><strong>${escapeHtml(tool.name)}</strong><div><small>Вход</small><code>${escapeHtml(JSON.stringify(tool.input, null, 2))}</code></div><div><small>Результат</small><p>${escapeHtml(tool.result)}</p></div></div>`).join('')}</div>` : message.tools && message.tools !== 'Инструменты не вызывались.' ? `<div class="detail-line"><span>Использование инструментов</span><p>${escapeHtml(message.tools)}</p></div>` : ''}</div>`;
  return `<article class="message assistant-message" ${common}>
    <button class="run-toggle" type="button" data-action="toggle-details" data-message="${message.id}" aria-expanded="${expanded}">
      <span class="run-duration">Выполнена за ${escapeHtml(message.duration || '3,0 с')}</span>${icon('chevron', 14)}
    </button>
    ${expanded ? detailHtml : ''}
    <div class="assistant-copy">${textContent(message.text)}</div>
    ${actions}
  </article>`;
}

function renderLane(lane) {
  const selected = board().selectedLaneId === lane.id;
  const independent = !lane.parentId && !lane.subagentOf;
  const modelControls = lane.provider === 'Codex' ? modelWidget(lane) : configMenu(lane, 'model', 'Модель', MODEL_CHOICES.OpenRouter, 'model-menu');
  return `<section class="lane ${selected ? 'selected' : ''} ${independent ? 'independent' : 'linked'} ${lane.subagentOf ? 'subagent-lane' : ''}" data-lane-id="${lane.id}" style="left:${lane.x}px;top:${lane.y}px;width:${lane.width}px">
    <header class="lane-header" ${independent ? `data-drop-root="${lane.id}"` : ''}>
      <div class="lane-header-main">${independent ? `<span class="drag-grip" data-drag-root="${lane.id}" title="Перетащить сессию вместе с ветками" aria-label="Перетащить сессию вместе с ветками">${icon('grip', 16)}</span>` : ''}<span class="lane-title" data-title-lane="${lane.id}" title="Двойной щелчок — изменить название">${escapeHtml(lane.title)}</span>
        <div class="lane-header-actions"><button class="icon-button" type="button" data-action="clone" data-lane="${lane.id}" title="Клонировать сессию" aria-label="Клонировать сессию">${icon('copy', 16)}</button><button class="icon-button" type="button" data-action="archive" data-lane="${lane.id}" title="В архив" aria-label="В архив">${icon('archive', 16)}</button><button class="icon-button" type="button" data-action="delete-session" data-lane="${lane.id}" title="Удалить сессию" aria-label="Удалить сессию">${icon('trash', 16)}</button></div>
      </div>
      ${lane.parentId ? `<div class="lane-subtitle">${icon('branch', 13)} Ветка · история до точки ветвления сохранена</div>` : lane.subagentOf ? `<div class="lane-subtitle">${icon('branch', 13)} Сабагент · ${lane.active ? 'активен' : 'завершён'}${lane.pinned ? ' · закреплён' : ''}</div>` : ''}
    </header>
    <div class="lane-body">
      ${lane.parentId ? `<div class="branch-context"><span>Ответвление от сообщения</span><p>${escapeHtml(lane.sourceText || '')}</p></div>` : ''}
      <div class="messages">${lane.messages.length ? lane.messages.map((message) => renderMessage(lane, message)).join('') : lane.provider ? '<p class="empty-lane">Сессия пуста. Начни с сообщения внизу.</p>' : `<div class="provider-choice"><strong>С чего начнём?</strong><p>Выбери провайдера для новой сессии.</p><div><button type="button" data-action="choose-provider" data-lane="${lane.id}" data-provider="Codex">Codex</button><button type="button" data-action="choose-provider" data-lane="${lane.id}" data-provider="OpenRouter">OpenRouter</button></div></div>`}</div>
      ${lane.provider ? `<div class="provider-label">${escapeHtml(lane.provider)}</div>
      <div class="composer"><label class="sr-only" for="composer-${lane.id}">Сообщение в сессию ${escapeHtml(lane.title)}</label>
        <textarea id="composer-${lane.id}" data-composer="${lane.id}" rows="1" placeholder="Написать сообщение…" spellcheck="true">${escapeHtml(state.drafts.get(lane.id) || '')}</textarea>
        <footer class="lane-footer"><div class="composer-controls">${modelControls}${configMenu(lane, 'approval', 'Подтверждение', ['Требует подтверждения', 'Автоподтверждение'], 'approval-menu')}
          <span class="context-meter" role="img" aria-label="Контекст заполнен на ${lane.context}%" data-tooltip="Контекст ${lane.context}%" style="--context:${Math.min(100, lane.context)}%"></span>
          <button class="icon-button settings-button" type="button" data-action="settings" data-lane="${lane.id}" title="Настройки сессии" aria-label="Настройки сессии">${icon('settings', 17)}</button>
          <button class="send-button" type="button" data-action="send" data-lane="${lane.id}" title="Отправить корректировку" aria-label="Отправить корректировку">${icon('send', 17)}</button>
        </div></footer>
      </div>` : ''}
    </div>
  </section>`;
}

function render() {
  if (state.activeBoardId === 'home' || !board()) { state.activeBoardId = 'home'; renderHome(); return; }
  layoutLanes();
  const columns = visibleLanes();
  const rails = columns.filter((lane) => !lane.parentId && !lane.subagentOf && board().lanes.some((item) => item.subagentOf === lane.id)).map((lane) => {
    const expanded = Boolean(board().expandedSubagents?.[lane.id]);
    return `<div class="subagent-rail" style="left:${lane.x + lane.width}px" data-subagent-rail="${lane.id}"><span class="subagent-rail-line"></span><div class="subagent-rail-actions"><button type="button" data-action="toggle-subagents" data-lane="${lane.id}" title="${expanded ? 'Скрыть закреплённых сабагентов' : 'Показать закреплённых сабагентов'}" aria-label="${expanded ? 'Скрыть' : 'Показать'} закреплённых сабагентов" aria-expanded="${expanded}">${icon('chevron', 18)}</button><button type="button" data-action="subagent-settings" data-lane="${lane.id}" title="Настроить сабагентов" aria-label="Настроить сабагентов">${icon('settings', 17)}</button></div></div>`;
  }).join('');
  const boundaries = columns.slice(0, -1).map((lane, index) => {
    const next = columns[index + 1];
    const grouped = lane.rootId === next.rootId;
    const compact = Boolean(next.subagentOf && grouped);
    return `<div class="column-boundary ${grouped ? 'group-boundary' : ''} ${compact ? 'compact-boundary' : ''} ${compact && !lane.subagentOf ? 'rail-boundary' : ''}" style="left:${lane.x + lane.width - (compact ? 33 : 0)}px" data-boundary-after="${lane.id}">
      <div class="boundary-line"></div><div class="boundary-resize" data-resize-boundary="${lane.id}" title="Изменить ширину сессии"></div>
      ${grouped ? '' : `<div class="boundary-actions"><button class="boundary-add" type="button" data-action="insert-session" data-insert-after="${lane.id}" title="Добавить сессию слева от границы" aria-label="Добавить сессию слева от границы">${icon('plus', 16)}</button><button class="boundary-add" type="button" data-action="insert-session" data-insert-before="${next.id}" title="Добавить сессию справа от границы" aria-label="Добавить сессию справа от границы">${icon('plus', 16)}</button></div>`}
    </div>`;
  }).join('');
  const first = columns[0];
  const last = columns.at(-1);
  const rightOffset = last?.subagentOf ? 0 : 33;
  const outerZones = columns.length ? `<div class="outer-add-zone left-zone" style="left:${first.x - 99}px"><span class="outer-line"></span><button type="button" data-action="insert-session" data-insert-before="${first.id}" title="Добавить сессию слева" aria-label="Добавить сессию слева">${icon('plus', 19)}</button></div>
    <div class="outer-add-zone right-zone" style="left:${last.x + last.width + rightOffset}px"><span class="outer-line"></span><button type="button" data-action="insert-session" data-insert-after="${last.id}" title="Добавить сессию справа" aria-label="Добавить сессию справа">${icon('plus', 19)}</button></div>` : '';
  app.innerHTML = `<div class="prototype-shell">
    ${renderTabs()}
    <main class="board-viewport" id="board-viewport" aria-label="Доска с сессиями">
      <div class="board-stage" id="board-stage"><svg class="connection-layer" id="connections" aria-hidden="true"></svg>${outerZones}${boundaries}${rails}${columns.map(renderLane).join('')}</div>
      <div class="canvas-controls"><button class="mode-button" type="button" data-action="toggle-mode" title="Переключить режим перемещения">${icon(state.mode === 'free' ? 'free' : 'focus', 18)}<span>${state.mode === 'free' ? 'Свободный' : 'Фиксированный'}</span></button>
        <span class="control-divider"></span><button class="icon-button" type="button" data-action="zoom-out" title="Уменьшить" aria-label="Уменьшить">${icon('zoom-out', 18)}</button>
        <span class="zoom-level">${Math.round((board().camera?.zoom ?? 0.9) * 100)}%</span>
        <button class="icon-button" type="button" data-action="zoom-in" title="Увеличить" aria-label="Увеличить">${icon('zoom-in', 18)}</button></div>
    </main>
  </div>`;
  if (!board().camera) {
    const viewport = document.querySelector('#board-viewport');
    const lane = laneById(board().selectedLaneId);
    const zoom = board().id === 'subagents' ? 0.85 : 1;
    const x = board().id === 'main' ? 105 - lane.x * zoom : board().id === 'subagents' ? 55 - lane.x * zoom : viewport.clientWidth / 2 - (lane.x + lane.width / 2) * zoom;
    board().camera = { zoom, x, y: -lane.y * zoom };
  }
  alignBranches();
  applyCamera();
  renderConnections();
  document.querySelectorAll('textarea[data-composer]').forEach(autoGrow);
}

function applyCamera() {
  const viewport = document.querySelector('#board-viewport');
  const stage = document.querySelector('#board-stage');
  if (!viewport || !stage) return;
  camera().x = clampCameraX(camera().x);
  if (state.scrollTarget) state.scrollTarget.x = clampCameraX(state.scrollTarget.x);
  const { x, y, zoom } = camera();
  stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  stage.style.setProperty('--board-center-y', `${50000 + (viewport.clientHeight / 2 - y) / zoom}px`);
  const columns = visibleLanes();
  const first = columns[0];
  const last = columns.at(-1);
  const leftZone = stage.querySelector('.left-zone');
  const rightZone = stage.querySelector('.right-zone');
  if (first && leftZone && rightZone) {
    const viewportLeft = -x / zoom;
    const viewportRight = (viewport.clientWidth - x) / zoom;
    const leftBorder = first.x - 33;
    const rightBorder = last.x + last.width + (last.subagentOf ? 0 : 33);
    leftZone.style.left = `${viewportLeft}px`;
    leftZone.style.width = `${Math.max(0, leftBorder - viewportLeft)}px`;
    rightZone.style.left = `${rightBorder}px`;
    rightZone.style.width = `${Math.max(0, viewportRight - rightBorder)}px`;
  }
  viewport.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  document.querySelector('.zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  updateStickyHeaders();
  positionMenu();
}

function clampCameraX(value) {
  const columns = visibleLanes();
  if (!columns.length) return value;
  const viewport = document.querySelector('#board-viewport');
  const half = viewport.clientWidth / 2;
  const zoom = camera().zoom;
  const last = columns.at(-1);
  const min = half - (last.x + last.width + (last.subagentOf ? 0 : 33)) * zoom;
  const max = half - (columns[0].x - 33) * zoom;
  return Math.max(min, Math.min(max, value));
}

function positionMenu() {
  const menu = document.querySelector('.config-popover, .model-popover');
  if (!menu) return;
  const viewport = document.querySelector('#board-viewport').getBoundingClientRect();
  const trigger = menu.closest('.config-menu, .model-widget').querySelector('.config-trigger, .model-widget-trigger').getBoundingClientRect();
  menu.classList.toggle('opens-down', trigger.top - menu.offsetHeight - 7 < viewport.top + 8);
}

function updateStickyHeaders() {
  const viewport = document.querySelector('#board-viewport');
  if (!viewport) return;
  for (const element of document.querySelectorAll('.lane')) {
    const lane = laneById(element.dataset.laneId);
    const header = element.querySelector('.lane-header');
    const composer = element.querySelector('.composer');
    const visualTop = lane.y * camera().zoom + camera().y;
    const needed = Math.max(0, -visualTop / camera().zoom);
    const limit = Math.max(0, composer.offsetTop - header.offsetHeight - 12);
    header.style.transform = `translateY(${Math.min(needed, limit)}px)`;
  }
}

function renderConnections() {
  const svg = document.querySelector('#connections');
  if (!svg) return;
  svg.innerHTML = visibleLanes().filter((lane) => lane.parentId).map((lane) => {
    const parent = laneById(lane.parentId);
    const source = document.querySelector(`[data-lane-id="${parent.id}"] [data-message-id="${lane.sourceMessageId}"]`);
    const y1 = parent.y + (source?.offsetTop ?? lane.sourceOffset ?? 190) - 8.5;
    const x1 = parent.x + 1;
    const x2 = lane.x;
    return `<path d="M ${x1} ${y1} H ${x2}" />`;
  }).join('');
}

function focusLane(laneId, smooth = true) {
  cancelSmoothScroll();
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
  cancelSmoothScroll();
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

function cancelSmoothScroll() {
  if (state.scrollFrame) cancelAnimationFrame(state.scrollFrame);
  state.scrollFrame = null;
  state.scrollTarget = null;
}

function smoothScrollBy(deltaX, deltaY) {
  state.scrollTarget ??= { x: camera().x, y: camera().y };
  state.scrollTarget.x -= deltaX;
  state.scrollTarget.y -= deltaY;
  if (state.scrollFrame) return;
  const step = () => {
    const target = state.scrollTarget;
    if (!target) return;
    camera().x += (target.x - camera().x) * 0.28;
    camera().y += (target.y - camera().y) * 0.28;
    const settled = Math.abs(target.x - camera().x) < 0.35 && Math.abs(target.y - camera().y) < 0.35;
    if (settled) { camera().x = target.x; camera().y = target.y; }
    applyCamera();
    state.scrollFrame = settled ? null : requestAnimationFrame(step);
    if (settled) state.scrollTarget = null;
  };
  state.scrollFrame = requestAnimationFrame(step);
}

function autoGrow(textarea) {
  textarea.style.height = '0px';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  updateStickyHeaders();
}

function renderSettingsPanel() {
  const draft = state.settingsDraft;
  const panel = settingsDialog.querySelector('#settings-panel');
  if (draft.tab === 'agents') {
    panel.innerHTML = `<label class="settings-agents-label">AGENTS.md<textarea name="agentsMd" rows="8" placeholder="Инструкции для этой сессии">${escapeHtml(draft.agentsMd)}</textarea></label>`;
  } else if (draft.tab === 'system') {
    panel.innerHTML = `<label class="settings-agents-label">Системный промпт<textarea name="systemPrompt" rows="8" placeholder="Инструкции для модели OpenRouter">${escapeHtml(draft.systemPrompt)}</textarea></label>`;
  } else if (draft.tab === 'parameters') {
    panel.innerHTML = `<label class="parameter-label">Температура<input type="number" name="temperature" min="0" max="2" step="0.1" value="${draft.temperature}"></label><p class="dialog-note">Чем выше значение, тем разнообразнее ответы модели.</p>`;
  } else if (draft.tab === 'skills') {
    panel.innerHTML = `<label class="search-label">Поиск скиллов<input type="search" data-search="skills" placeholder="Найти скилл…" value="${escapeHtml(draft.skillSearch)}"></label>
      <div class="settings-list">${SKILLS.map((item) => `<label class="check-option" data-filter-item><input type="checkbox" data-setting="skill" value="${escapeHtml(item)}" ${draft.skills.includes(item) ? 'checked' : ''}><span>${escapeHtml(item)}</span></label>`).join('')}</div>
      <p class="search-empty" hidden>Ничего не найдено.</p>`;
    filterSettingsList(draft.skillSearch);
  } else {
    panel.innerHTML = `<label class="search-label">Поиск MCP<input type="search" data-search="mcp" placeholder="Найти сервер или инструмент…" value="${escapeHtml(draft.mcpSearch)}"></label>
      <div class="settings-list mcp-list">${MCP_SERVERS.map((server) => {
        const expanded = draft.expandedMcp.has(server.name);
        const tools = draft.mcpTools[server.name];
        return `<section class="mcp-server ${expanded ? 'expanded' : ''}" data-filter-item>
          <div class="mcp-server-main"><label class="mcp-enable" title="Включить MCP"><input type="checkbox" data-setting="mcp" value="${escapeHtml(server.name)}" aria-label="Включить ${escapeHtml(server.name)}" ${draft.mcp.includes(server.name) ? 'checked' : ''}></label>
            <button class="mcp-server-toggle" type="button" data-action="toggle-mcp-tools" data-server="${escapeHtml(server.name)}" aria-label="Инструменты: ${escapeHtml(server.name)}" aria-expanded="${expanded}" aria-controls="mcp-tools-${MCP_SERVERS.indexOf(server)}"><span>${escapeHtml(server.name)}</span><span class="tool-count">${tools.length}/${server.tools.length} инструментов</span>${icon('chevron', 16)}</button></div>
          <div class="mcp-tools" id="mcp-tools-${MCP_SERVERS.indexOf(server)}" aria-hidden="${!expanded}" ${expanded ? '' : 'inert'}><div class="mcp-tools-inner">${server.tools.map((tool) => `<label class="check-option tool-option"><input type="checkbox" data-setting="mcp-tool" data-server="${escapeHtml(server.name)}" value="${escapeHtml(tool.id)}" ${tools.includes(tool.id) ? 'checked' : ''}><span><strong>${escapeHtml(tool.id)}</strong><small>${escapeHtml(tool.description)}</small></span></label>`).join('')}</div></div>
        </section>`;
      }).join('')}</div><p class="search-empty" hidden>Ничего не найдено.</p>`;
    filterSettingsList(draft.mcpSearch);
  }
}

function filterSettingsList(query) {
  const normalized = query.trim().toLocaleLowerCase('ru');
  const items = settingsDialog.querySelectorAll('#settings-panel [data-filter-item]');
  let visible = 0;
  items.forEach((item) => {
    item.hidden = !item.textContent.toLocaleLowerCase('ru').includes(normalized);
    if (!item.hidden) visible += 1;
  });
  const empty = settingsDialog.querySelector('#settings-panel .search-empty');
  if (empty) empty.hidden = visible > 0;
}

function showSettings(lane) {
  state.settingsDraft = {
    laneId: lane.id, tab: lane.provider === 'OpenRouter' ? 'system' : 'agents', agentsMd: lane.agentsMd ?? '', systemPrompt: lane.systemPrompt ?? '', temperature: lane.temperature,
    skills: [...(lane.skills ?? ['Работа с файлами'])], mcp: [...(lane.mcp ?? [])],
    mcpTools: Object.fromEntries(MCP_SERVERS.map((server) => [server.name, [...(lane.mcpTools?.[server.name] ?? server.tools.map((tool) => tool.id))]])),
    skillSearch: '', mcpSearch: '', expandedMcp: new Set(),
  };
  settingsDialog.innerHTML = `<form method="dialog" id="settings-form" data-lane="${lane.id}">
    <div class="dialog-heading"><h2>Настройки сессии</h2><button type="button" class="icon-button" data-action="close-settings" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <div class="settings-tabs" role="tablist" aria-label="Раздел настроек">${[...(lane.provider === 'OpenRouter' ? [['system', 'Системный промпт'], ['parameters', 'Параметры']] : [['agents', 'AGENTS.md']]), ['skills', 'Скиллы'], ['mcp', 'MCP']].map(([key, label]) => `<button class="settings-tab ${key === state.settingsDraft.tab ? 'active' : ''}" type="button" role="tab" data-action="settings-tab" data-tab="${key}" aria-selected="${key === state.settingsDraft.tab}">${label}</button>`).join('')}</div>
    <div id="settings-panel" class="settings-panel" role="tabpanel"></div>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-settings">Отмена</button><button type="submit" class="primary-button">Сохранить</button></div>
  </form>`;
  renderSettingsPanel();
  settingsDialog.showModal();
}

function showMessageDialog(lane, message, kind) {
  const edit = kind === 'edit';
  editDialog.innerHTML = `<form method="dialog" id="message-form" data-lane="${lane.id}" data-message="${message.id}" data-kind="${kind}">
    <div class="dialog-heading"><div><span class="eyebrow">История сессии</span><h2>${edit ? 'Изменить сообщение' : 'Удалить сообщение'}</h2></div><button type="button" class="icon-button" data-action="close-edit" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <p class="dialog-note">Это сообщение и все следующие в этой сессии будут удалены. Уже созданные ветки не изменятся.</p>
    ${edit ? `<label>Новый текст<textarea name="text" rows="5" required>${escapeHtml(message.text)}</textarea></label>` : `<blockquote>${escapeHtml(message.text)}</blockquote>`}
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-edit">Отмена</button><button type="submit" class="primary-button ${edit ? '' : 'danger'}">${edit ? 'Сохранить' : 'Удалить'}</button></div>
  </form>`;
  editDialog.showModal();
}

function addBoard() {
  const number = ++state.boardCounter;
  const laneId = uid();
  const id = uid();
  boards.push({ id, name: `Доска ${number}`, camera: null, selectedLaneId: laneId, lanes: [{
    id: laneId, rootId: laneId, parentId: null, x: 190, y: 140, width: MIN_LANE_WIDTH,
    title: 'Новая сессия', provider: null, model: null, context: 0,
    approval: 'Требует подтверждения', effort: 'Средний', speed: 'Обычная', temperature: 0.7, messages: [],
  }] });
  state.activeBoardId = id;
  render();
}

function closeBoard(id) {
  const item = boards.find((candidate) => candidate.id === id);
  if (!item) return;
  item.closed = true;
  if (state.activeBoardId === id) state.activeBoardId = boards.find((candidate) => !candidate.closed && !candidate.archived)?.id ?? 'home';
  render();
}

function archiveBoard(id) {
  const item = boards.find((candidate) => candidate.id === id);
  if (!item) return;
  item.archived = true;
  item.closed = true;
  if (state.activeBoardId === id) state.activeBoardId = 'home';
  render();
}

function showDeleteBoard(id) {
  const item = boards.find((candidate) => candidate.id === id);
  if (!item) return;
  editDialog.innerHTML = `<form method="dialog" id="delete-board-form" data-board="${item.id}"><div class="dialog-heading"><h2>Удалить доску?</h2><button type="button" class="icon-button" data-action="close-edit" aria-label="Закрыть">${icon('close', 19)}</button></div><p class="dialog-note">«${escapeHtml(item.name)}» и все её сессии будут удалены из макета. Закрытие вкладки или архивирование сохраняет доску.</p><div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-edit">Отмена</button><button type="submit" class="primary-button danger">Удалить</button></div></form>`;
  editDialog.showModal();
}

function showSubagentSettings(parent) {
  const agents = board().lanes.filter((lane) => lane.subagentOf === parent.id).sort((a, b) => Number(b.active) - Number(a.active) || Number(b.pinned) - Number(a.pinned));
  subagentsDialog.innerHTML = `<form method="dialog" id="subagent-form" data-parent="${parent.id}"><div class="dialog-heading"><h2>Сабагенты · ${escapeHtml(parent.title)}</h2><button type="button" class="icon-button" data-action="close-subagents" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <p class="dialog-note">Активные сессии видны всегда. Завершённые появляются на доске, если закрепить их и раскрыть список.</p>
    <div class="subagent-list">${agents.map((lane) => `<label class="subagent-item" data-active="${Boolean(lane.active)}"><span><strong>${escapeHtml(lane.title)}</strong><small class="agent-status ${lane.active ? 'active' : ''}">${lane.active ? 'Активен' : 'Завершён'}</small></span><span class="subagent-pin"><input type="checkbox" name="pinned" value="${lane.id}" aria-label="Закрепить ${escapeHtml(lane.title)}" ${lane.pinned ? 'checked' : ''}>${icon('pin', 18)}</span></label>`).join('')}</div>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-subagents">Отмена</button><button type="submit" class="primary-button">Сохранить</button></div></form>`;
  subagentsDialog.showModal();
}

function insertSession(referenceId, before) {
  const reference = laneById(referenceId);
  if (!reference) return;
  const id = uid();
  const index = board().lanes.findIndex((lane) => lane.id === referenceId) + (before ? 0 : 1);
  board().lanes.splice(index, 0, {
    id, rootId: id, parentId: null, x: 0, y: 0, width: MIN_LANE_WIDTH,
    title: 'Новая сессия', provider: null,
    model: null, context: 0,
    approval: 'Требует подтверждения', effort: 'Средний', speed: 'Обычная', temperature: 0.7, messages: [],
  });
  board().selectedLaneId = id;
  render();
  focusLane(id);
  toast('Сессия добавлена.');
}

function branchFrom(lane, message) {
  const id = uid();
  const branch = {
    ...lane, id, rootId: lane.rootId, parentId: lane.id, subagentOf: null, sourceMessageId: message.id,
    sourceText: message.text.slice(0, 120), sourceOffset: document.querySelector(`[data-lane-id="${lane.id}"] [data-message-id="${message.id}"]`)?.offsetTop ?? 140,
    title: `${lane.title} · ветка`, context: Math.max(0, lane.context - 8),
    historyPrefix: [...(lane.historyPrefix || []), ...lane.messages.slice(0, lane.messages.indexOf(message) + 1)].map((item) => ({ ...item })), messages: [],
  };
  const lastIndex = board().lanes.findLastIndex((item) => item.rootId === lane.rootId);
  board().lanes.splice(lastIndex + 1, 0, branch);
  board().selectedLaneId = id;
  render();
  focusLane(id);
  toast('Ветка создана. Прошлая история сохранена.');
}

function cloneLane(lane) {
  const id = uid();
  board().lanes.push({ ...lane, id, rootId: id, parentId: null, subagentOf: null, active: false, pinned: false, sourceMessageId: null, historyPrefix: [],
    archived: false, title: `${lane.title} · копия`,
    messages: [...(lane.historyPrefix || []), ...lane.messages].map((message) => ({ ...message, id: uid() })) });
  board().selectedLaneId = id;
  render();
  focusLane(id);
  toast('Клон создан как независимая сессия.');
}

function isDescendant(item, ancestorId) {
  let current = item;
  while (current?.parentId || current?.subagentOf) {
    const parentId = current.parentId || current.subagentOf;
    if (parentId === ancestorId) return true;
    current = laneById(parentId);
  }
  return false;
}

function subtreeIds(lane) {
  return new Set(board().lanes.filter((item) => item.id === lane.id || isDescendant(item, lane.id)).map((item) => item.id));
}

function moveRootGroup(lane, target) {
  if (lane.id === target.id || lane.parentId || lane.subagentOf || target.parentId || target.subagentOf) return;
  const moveAfter = lane.x < target.x;
  const ids = subtreeIds(lane);
  const moved = board().lanes.filter((item) => ids.has(item.id));
  board().lanes = board().lanes.filter((item) => !ids.has(item.id));
  const targetIds = subtreeIds(target);
  const position = !moveAfter
    ? board().lanes.findIndex((item) => item.id === target.id)
    : board().lanes.findLastIndex((item) => targetIds.has(item.id)) + 1;
  board().lanes.splice(position, 0, ...moved);
  render();
  if (state.mode === 'fixed') focusLane(board().selectedLaneId, false);
}

function archiveLane(lane) {
  const ids = subtreeIds(lane);
  if (visibleLanes().filter((item) => !ids.has(item.id)).length === 0) { toast('На доске должна остаться хотя бы одна сессия.'); return; }
  board().lanes.forEach((item) => { if (ids.has(item.id)) item.archived = true; });
  if (ids.has(board().selectedLaneId)) board().selectedLaneId = visibleLanes()[0].id;
  render();
  toast(ids.size > 1 ? 'Сессия и её ветки перенесены в архив.' : 'Сессия перенесена в архив.');
}

function showArchive() {
  const archived = board().lanes.filter((lane) => lane.archived);
  archiveDialog.innerHTML = `<div class="dialog-heading"><h2>Архив сессий</h2><button type="button" class="icon-button" data-action="close-archive" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <label class="search-label">Поиск сессии<input type="search" data-search="archive" placeholder="Найти в архиве…"></label>
    <div class="archive-list">${archived.length ? archived.map((lane) => `<div class="archive-item" data-archive-item><span>${escapeHtml(lane.title)}</span><button type="button" class="secondary-button" data-action="restore" data-lane="${lane.id}">Восстановить</button></div>`).join('') : '<p>Архив пуст.</p>'}</div><p class="search-empty archive-empty" hidden>Ничего не найдено.</p>`;
  archiveDialog.showModal();
}

function showDeleteSession(lane) {
  editDialog.innerHTML = `<form method="dialog" id="delete-session-form" data-lane="${lane.id}">
    <div class="dialog-heading"><h2>Удалить сессию?</h2><button type="button" class="icon-button" data-action="close-edit" aria-label="Закрыть">${icon('close', 19)}</button></div>
    <p class="dialog-note">${escapeHtml(lane.title)}${subtreeIds(lane).size > 1 ? ' и связанные с ней ветки' : ''} будут удалены из макета.</p>
    <div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-edit">Отмена</button><button type="submit" class="primary-button danger">Удалить</button></div>
  </form>`;
  editDialog.showModal();
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
    if (action === 'show-home') { cancelSmoothScroll(); state.activeBoardId = 'home'; render(); return; }
    if (action === 'select-board') { cancelSmoothScroll(); const item = boards.find((candidate) => candidate.id === button.dataset.board); if (!item) return; item.closed = false; state.activeBoardId = item.id; render(); return; }
    if (action === 'close-board') { closeBoard(button.dataset.board); return; }
    if (action === 'archive-board') { archiveBoard(button.dataset.board); return; }
    if (action === 'restore-board') { const item = boards.find((candidate) => candidate.id === button.dataset.board); if (item) { item.archived = false; item.closed = false; render(); } return; }
    if (action === 'delete-board') { showDeleteBoard(button.dataset.board); return; }
    if (action === 'add-board') { addBoard(); return; }
    const lane = button.dataset.lane ? laneById(button.dataset.lane) : null;
    const message = lane?.messages.find((item) => item.id === button.dataset.message);
    if (action === 'insert-session') { insertSession(button.dataset.insertBefore ?? button.dataset.insertAfter, Boolean(button.dataset.insertBefore)); return; }
    if (action === 'toggle-mode') { state.mode = state.mode === 'free' ? 'fixed' : 'free'; render(); if (state.mode === 'fixed') focusLane(board().selectedLaneId); return; }
    if (action === 'zoom-in' || action === 'zoom-out') {
      const rect = document.querySelector('#board-viewport').getBoundingClientRect();
      zoomAt(action === 'zoom-in' ? 1.12 : 1 / 1.12, rect.left + rect.width / 2, rect.top + rect.height / 2); return;
    }
    if (action === 'toggle-details') { state.expanded.has(button.dataset.message) ? state.expanded.delete(button.dataset.message) : state.expanded.add(button.dataset.message); render(); return; }
    if (action === 'toggle-request') { state.expandedRequests.has(button.dataset.message) ? state.expandedRequests.delete(button.dataset.message) : state.expandedRequests.add(button.dataset.message); render(); return; }
    if (action === 'choose-provider') {
      lane.provider = button.dataset.provider;
      lane.model = MODEL_CHOICES[lane.provider][lane.provider === 'Codex' ? 1 : 0];
      lane.effort = lane.provider === 'Codex' ? 'Средний' : '—';
      lane.speed = lane.provider === 'Codex' ? 'Обычная' : '—';
      render();
      document.querySelector(`[data-composer="${lane.id}"]`)?.focus();
      return;
    }
    if (action === 'settings') { showSettings(lane); return; }
    if (action === 'toggle-subagents') {
      board().expandedSubagents ??= {};
      board().expandedSubagents[lane.id] = !board().expandedSubagents[lane.id];
      if (!laneVisible(laneById(board().selectedLaneId))) board().selectedLaneId = lane.id;
      render();
      return;
    }
    if (action === 'subagent-settings') { showSubagentSettings(lane); return; }
    if (action === 'show-archive') { showArchive(); return; }
    if (action === 'toggle-model-widget') {
      const key = `${lane.id}:model-widget`;
      state.openMenu = state.openMenu === key ? null : key;
      render();
      if (state.openMenu) document.querySelector('.model-options button')?.focus();
      return;
    }
    if (action === 'model-choice' || action === 'effort-choice') {
      const key = action === 'model-choice' ? 'model' : 'effort';
      if (lane[key] !== button.dataset.value) {
        lane[key] = button.dataset.value;
        lane.messages.push({ id: uid(), role: 'settings', text: `Изменены настройки сессии: ${key === 'model' ? 'модель' : 'уровень рассуждения'} — ${lane[key]}` });
      }
      render();
      return;
    }
    if (action === 'toggle-speed') {
      lane.speed = lane.speed === 'Быстрая' ? 'Обычная' : 'Быстрая';
      lane.messages.push({ id: uid(), role: 'settings', text: `Изменены настройки сессии: скорость — ${lane.speed}` });
      render();
      return;
    }
    if (action === 'toggle-config') {
      const key = `${lane.id}:${button.dataset.config}`;
      state.openMenu = state.openMenu === key ? null : key;
      render();
      if (state.openMenu) document.querySelector('.config-popover .config-option')?.focus();
      return;
    }
    if (action === 'config-choice') {
      const key = button.dataset.config;
      const value = key === 'temperature' ? Number(button.dataset.value) : button.dataset.value;
      state.openMenu = null;
      if (lane[key] !== value) {
        lane[key] = value;
        const labels = { model: 'модель', approval: 'подтверждение', effort: 'effort', speed: 'скорость', temperature: 'температура' };
        lane.messages.push({ id: uid(), role: 'settings', text: `Изменены настройки сессии: ${labels[key]} — ${value}` });
      }
      render();
      return;
    }
    if (action === 'clone') { cloneLane(lane); return; }
    if (action === 'archive') { archiveLane(lane); return; }
    if (action === 'delete-session') { showDeleteSession(lane); return; }
    if (action === 'branch' && message) { branchFrom(lane, message); return; }
    if (action === 'edit-message' && message) { showMessageDialog(lane, message, 'edit'); return; }
    if (action === 'delete-message' && message) { showMessageDialog(lane, message, 'delete'); return; }
    if (action === 'send') { sendMessage(lane.id, false); return; }
    if (action === 'copy-message' && message) {
      try { await navigator.clipboard.writeText(message.text); toast('Текст скопирован.'); }
      catch { toast('Браузер не разрешил копирование. Открой макет через localhost.'); }
      return;
    }
    if (action === 'copy-request' && message) {
      try { await navigator.clipboard.writeText(formatRequest(message.request || '{ "stream": true }')); toast('Запрос скопирован.'); }
      catch { toast('Браузер не разрешил копирование.'); }
      return;
    }
  }
  const laneElement = event.target.closest('.lane');
  if (laneElement && state.mode === 'fixed' && !event.target.closest('textarea,button,input')) focusLane(laneElement.dataset.laneId);
  if (state.openMenu && !event.target.closest('.config-menu, .model-widget')) { state.openMenu = null; render(); }
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
  if (event.key === 'Escape' && state.openMenu) { state.openMenu = null; render(); return; }
  const textarea = event.target.closest('textarea[data-composer]');
  if (!textarea || event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  sendMessage(textarea.dataset.composer, event.shiftKey);
});

app.addEventListener('wheel', (event) => {
  if (!event.target.closest('#board-viewport')) return;
  if (event.target.closest('textarea,.config-popover')) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) {
    zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
  } else {
    const viewport = document.querySelector('#board-viewport');
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const horizontal = state.mode === 'free' ? (event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit : 0;
    const vertical = event.shiftKey && !event.deltaX && state.mode === 'free' ? 0 : event.deltaY * unit;
    smoothScrollBy(horizontal, vertical);
  }
}, { passive: false });

app.addEventListener('pointerdown', (event) => {
  const viewport = event.target.closest('#board-viewport');
  if (!viewport) return;
  if (event.button === 1) {
    event.preventDefault();
    cancelSmoothScroll();
    state.drag = { kind: 'camera', x: event.clientX, y: event.clientY, initialX: camera().x, initialY: camera().y };
    return;
  }
  const boundary = event.target.closest('[data-resize-boundary]');
  if (event.button === 0 && boundary) {
    event.preventDefault();
    cancelSmoothScroll();
    const lane = laneById(boundary.dataset.resizeBoundary);
    state.drag = { kind: 'resize-boundary', x: event.clientX, laneId: lane.id, width: lane.width };
    document.body.classList.add('is-resizing');
    return;
  }
  const reorder = event.target.closest('[data-drop-root]');
  if (event.button === 0 && reorder && !event.target.closest('button,input,textarea')) {
    state.drag = { kind: 'reorder', laneId: reorder.dataset.dropRoot, x: event.clientX, y: event.clientY, active: false, targetId: null, preview: null };
    return;
  }
});

window.addEventListener('pointermove', (event) => {
  const drag = state.drag;
  if (!drag) return;
  if (drag.kind === 'reorder') {
    const descendants = subtreeIds(laneById(drag.laneId)).size - 1;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    if (!drag.active) {
      drag.active = true;
      document.body.classList.add('is-reordering');
      document.querySelector(`[data-lane-id="${drag.laneId}"]`)?.classList.add('lane-dragging');
      drag.preview = document.createElement('div');
      drag.preview.className = 'drag-preview';
      const title = document.createElement('strong');
      title.textContent = laneById(drag.laneId).title;
      const detail = document.createElement('small');
      detail.textContent = descendants ? `Перемещается вместе с ${sessionCount(descendants)}` : 'Перемещается одна сессия';
      drag.preview.append(title, detail);
      drag.previewDetail = detail;
      document.body.append(drag.preview);
    }
    drag.preview.style.left = `${event.clientX + 12}px`;
    drag.preview.style.top = `${event.clientY + 12}px`;
    document.querySelectorAll('.drop-before,.drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    const source = laneById(drag.laneId);
    const target = visibleLanes().filter((item) => !item.parentId && !item.subagentOf && item.id !== source.id).find((item) => {
      const rect = document.querySelector(`[data-lane-id="${item.id}"] .lane-header`).getBoundingClientRect();
      return event.clientX >= rect.left - 33 * camera().zoom && event.clientX <= rect.right + 33 * camera().zoom;
    });
    drag.targetId = target?.id ?? null;
    if (target) {
      const header = document.querySelector(`[data-lane-id="${target.id}"] .lane-header`);
      header.classList.add(source.x < target.x ? 'drop-after' : 'drop-before');
      drag.previewDetail.textContent = `${source.x < target.x ? 'После' : 'Перед'} «${target.title}»`;
    } else {
      drag.previewDetail.textContent = descendants ? `Перемещается вместе с ${sessionCount(descendants)}` : 'Перемещается одна сессия';
    }
  } else if (drag.kind === 'camera') {
    camera().x = drag.initialX + event.clientX - drag.x;
    camera().y = drag.initialY + event.clientY - drag.y;
    if (state.mode === 'fixed') {
      const lane = laneById(board().selectedLaneId);
      camera().x = document.querySelector('#board-viewport').clientWidth / 2 - (lane.x + lane.width / 2) * camera().zoom;
    }
    applyCamera();
  } else if (drag.kind === 'resize-boundary') {
    const lane = laneById(drag.laneId);
    const width = Math.max(MIN_LANE_WIDTH, Math.min(900, Math.round(drag.width + (event.clientX - drag.x) / camera().zoom)));
    if (width === lane.width) return;
    lane.width = width;
    render();
    if (state.mode === 'fixed') focusLane(board().selectedLaneId, false);
  }
});

window.addEventListener('pointerup', () => {
  const drag = state.drag;
  state.drag = null;
  document.body.classList.remove('is-resizing');
  if (drag?.kind !== 'reorder') return;
  document.body.classList.remove('is-reordering');
  drag.preview?.remove();
  document.querySelectorAll('.lane-dragging,.drop-before,.drop-after').forEach((item) => item.classList.remove('lane-dragging', 'drop-before', 'drop-after'));
  if (drag.active && drag.targetId) moveRootGroup(laneById(drag.laneId), laneById(drag.targetId));
});
window.addEventListener('resize', () => { if (state.mode === 'fixed') focusLane(board().selectedLaneId, false); });
app.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); });

settingsDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'close-settings') { settingsDialog.close(); return; }
  if (button.dataset.action === 'settings-tab') {
    state.settingsDraft.tab = button.dataset.tab;
    settingsDialog.querySelectorAll('.settings-tab').forEach((tab) => {
      const active = tab.dataset.tab === button.dataset.tab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    renderSettingsPanel();
  }
  if (button.dataset.action === 'toggle-mcp-tools') {
    const expanded = state.settingsDraft.expandedMcp;
    expanded.has(button.dataset.server) ? expanded.delete(button.dataset.server) : expanded.add(button.dataset.server);
    const isExpanded = expanded.has(button.dataset.server);
    button.setAttribute('aria-expanded', String(isExpanded));
    const server = button.closest('.mcp-server');
    server.classList.toggle('expanded', isExpanded);
    const tools = server.querySelector('.mcp-tools');
    tools.setAttribute('aria-hidden', String(!isExpanded));
    tools.inert = !isExpanded;
  }
});
settingsDialog.addEventListener('input', (event) => {
  if (!state.settingsDraft) return;
  if (event.target.name === 'agentsMd') state.settingsDraft.agentsMd = event.target.value;
  if (event.target.name === 'systemPrompt') state.settingsDraft.systemPrompt = event.target.value;
  if (event.target.name === 'temperature') state.settingsDraft.temperature = event.target.value;
  if (event.target.dataset.search) {
    state.settingsDraft[event.target.dataset.search === 'skills' ? 'skillSearch' : 'mcpSearch'] = event.target.value;
    filterSettingsList(event.target.value);
  }
});
settingsDialog.addEventListener('change', (event) => {
  const input = event.target;
  if (!state.settingsDraft || !input.dataset.setting) return;
  const draft = state.settingsDraft;
  const key = input.dataset.setting;
  const values = key === 'skill' ? draft.skills : key === 'mcp' ? draft.mcp : draft.mcpTools[input.dataset.server];
  const next = new Set(values);
  input.checked ? next.add(input.value) : next.delete(input.value);
  if (key === 'skill') draft.skills = SKILLS.filter((item) => next.has(item));
  else if (key === 'mcp') draft.mcp = MCP_SERVERS.map((item) => item.name).filter((item) => next.has(item));
  else {
    const server = MCP_SERVERS.find((item) => item.name === input.dataset.server);
    draft.mcpTools[input.dataset.server] = server.tools.map((item) => item.id).filter((item) => next.has(item));
    input.closest('.mcp-server').querySelector('.tool-count').textContent = `${draft.mcpTools[input.dataset.server].length}/${server.tools.length} инструментов`;
  }
});
settingsDialog.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const lane = laneById(form.dataset.lane);
  const draft = state.settingsDraft;
  const changes = [];
  const agentsMd = draft.agentsMd.trim();
  if ((lane.agentsMd ?? '') !== agentsMd) { lane.agentsMd = agentsMd; changes.push('AGENTS.md'); }
  const systemPrompt = draft.systemPrompt.trim();
  if (lane.provider === 'OpenRouter' && (lane.systemPrompt ?? '') !== systemPrompt) { lane.systemPrompt = systemPrompt; changes.push('системный промпт'); }
  if (lane.provider === 'OpenRouter') {
    const temperature = Number(draft.temperature);
    if (draft.temperature === '' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) { toast('Температура должна быть от 0 до 2.'); return; }
    if (lane.temperature !== temperature) { lane.temperature = temperature; changes.push('температура'); }
  }
  for (const key of ['skills', 'mcp']) {
    const values = draft[key];
    const original = lane[key] ?? (key === 'skills' ? ['Работа с файлами'] : []);
    if (JSON.stringify(original) !== JSON.stringify(values)) {
      lane[key] = [...values];
      changes.push(key === 'skills' ? 'скиллы' : 'MCP');
    }
  }
  const originalTools = Object.fromEntries(MCP_SERVERS.map((server) => [server.name, lane.mcpTools?.[server.name] ?? server.tools.map((tool) => tool.id)]));
  if (JSON.stringify(originalTools) !== JSON.stringify(draft.mcpTools)) {
    lane.mcpTools = Object.fromEntries(Object.entries(draft.mcpTools).map(([name, values]) => [name, [...values]]));
    changes.push('инструменты MCP');
  }
  settingsDialog.close();
  if (changes.length) {
    lane.messages.push({ id: uid(), role: 'settings', text: `Изменены настройки сессии: ${changes.join(', ')}` });
    render();
    toast('Настройки сохранены в макете.');
  }
});
settingsDialog.addEventListener('close', () => { state.settingsDraft = null; });
editDialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-edit"]')) editDialog.close();
});
editDialog.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'delete-board-form') {
    const index = boards.findIndex((item) => item.id === form.dataset.board);
    if (index >= 0) boards.splice(index, 1);
    if (state.activeBoardId === form.dataset.board) state.activeBoardId = 'home';
    editDialog.close();
    render();
    toast('Доска удалена из макета.');
    return;
  }
  if (form.id === 'delete-session-form') {
    const lane = laneById(form.dataset.lane);
    const ids = subtreeIds(lane);
    if (visibleLanes().filter((item) => !ids.has(item.id)).length === 0) { editDialog.close(); toast('На доске должна остаться хотя бы одна сессия.'); return; }
    board().lanes = board().lanes.filter((item) => !ids.has(item.id));
    if (ids.has(board().selectedLaneId)) board().selectedLaneId = visibleLanes()[0].id;
    editDialog.close();
    render();
    toast('Сессия удалена из макета.');
    return;
  }
  const lane = laneById(form.dataset.lane);
  const index = lane.messages.findIndex((item) => item.id === form.dataset.message);
  if (index < 0) { editDialog.close(); return; }
  const old = lane.messages[index];
  lane.messages = lane.messages.slice(0, index);
  if (form.dataset.kind === 'edit') lane.messages.push({ ...old, text: String(new FormData(form).get('text')).trim() });
  editDialog.close();
  render();
  toast('Хвост этой сессии изменён. Ветки остались прежними.');
});

archiveDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'close-archive') { archiveDialog.close(); return; }
  if (button.dataset.action === 'restore') {
    const lane = laneById(button.dataset.lane);
    const ids = subtreeIds(lane);
    board().lanes.forEach((item) => { if (ids.has(item.id)) item.archived = false; });
    let current = lane;
    while (current) {
      current.archived = false;
      current = current.parentId ? laneById(current.parentId) : null;
    }
    archiveDialog.close();
    render();
    toast('Сессия восстановлена.');
  }
});
archiveDialog.addEventListener('input', (event) => {
  if (event.target.dataset.search !== 'archive') return;
  const query = event.target.value.trim().toLocaleLowerCase('ru');
  let visible = 0;
  archiveDialog.querySelectorAll('[data-archive-item]').forEach((item) => {
    item.hidden = !item.querySelector('span').textContent.toLocaleLowerCase('ru').includes(query);
    if (!item.hidden) visible += 1;
  });
  archiveDialog.querySelector('.archive-empty').hidden = visible > 0 || archiveDialog.querySelectorAll('[data-archive-item]').length === 0;
});
subagentsDialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-subagents"]')) subagentsDialog.close();
});
subagentsDialog.addEventListener('change', (event) => {
  if (!event.target.matches('input[name="pinned"]')) return;
  const list = subagentsDialog.querySelector('.subagent-list');
  const items = [...list.children].sort((a, b) => Number(b.dataset.active === 'true') - Number(a.dataset.active === 'true') || Number(b.querySelector('input').checked) - Number(a.querySelector('input').checked));
  list.append(...items);
});
subagentsDialog.addEventListener('submit', (event) => {
  event.preventDefault();
  const parentId = event.target.dataset.parent;
  const pinned = new Set(new FormData(event.target).getAll('pinned'));
  board().lanes.filter((lane) => lane.subagentOf === parentId).forEach((lane) => { lane.pinned = pinned.has(lane.id); });
  const parent = laneById(parentId);
  if (!laneVisible(laneById(board().selectedLaneId))) board().selectedLaneId = parent.id;
  subagentsDialog.close();
  render();
  toast('Закреплённые сабагенты обновлены.');
});

render();
