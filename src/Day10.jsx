import { useEffect, useMemo, useRef, useState } from "react";
import {
  DAY10_STRATEGIES,
  DEFAULT_DAY10_FACTS_MAX_TOKENS,
  DEFAULT_DAY10_KEEP_LAST,
  DEFAULT_DAY10_SYSTEM_PROMPT,
  getDay10BranchPrompt,
  getDay10ScriptPrompt,
} from "../shared/day10.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { estimateMessagesTokens } from "../shared/token-counter.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Реализуйте в агенте минимум три стратегии управления контекстом и переключатель между ними:

1. **Sliding Window:** отправляйте только последние N сообщений.
2. **Sticky Facts:** автоматически обновляйте отдельный блок facts и отправляйте facts + последние N сообщений.
3. **Branching:** создайте checkpoint, две независимые ветки и переключение между ними.

Протестируйте стратегии на одном сценарии и сравните качество, стабильность, расход токенов и удобство.

**Результат:** агент с тремя стратегиями управления контекстом и сравнением результатов.`;

const EXPECTED_FACTS = [
  /AI Advent/iu,
  /начинающ/iu,
  /50/iu,
  /пятниц/iu,
  /OpenRouter/iu,
  /Qwen/iu,
  /10|десят/iu,
  /SQLite/iu,
  /русск/iu,
];

function createBranches() {
  return {
    main: {
      id: "main",
      title: "Main",
      parentId: null,
      checkpointMessageCount: 0,
      checkpointUserCount: 0,
      history: [],
    },
  };
}

function createDrafts() {
  return {
    sliding: getDay10ScriptPrompt("sliding", 0),
    facts: getDay10ScriptPrompt("facts", 0),
    branching: { main: getDay10ScriptPrompt("branching", 0) },
  };
}

function createResults() {
  return { sliding: null, facts: null, branching: {} };
}

function countFacts(answer = "") {
  return EXPECTED_FACTS.filter((pattern) => pattern.test(answer)).length;
}

function formatTokens(value) {
  return value == null ? "—" : value.toLocaleString("ru-RU");
}

function parseFacts(text) {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return { value: null, error: "Facts должны быть JSON-объектом." };
    }
    const entries = Object.entries(value);
    if (
      entries.length > 30 ||
      entries.some(
        ([key, fact]) =>
          !key.trim() || !["string", "number", "boolean"].includes(typeof fact),
      )
    ) {
      return { value: null, error: "Допустимо до 30 простых значений string/number/boolean." };
    }
    return { value, error: "" };
  } catch {
    return { value: null, error: "Исправь JSON перед отправкой." };
  }
}

function downloadResult(strategy, result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day10-${strategy}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function ChatMessage({ item }) {
  return (
    <div className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}>
      <span className="chat-role">{item.role === "user" ? "User" : "Assistant"}</span>
      {item.role === "assistant" ? (
        <div className="markdown-body"><MarkdownContent>{item.content}</MarkdownContent></div>
      ) : (
        <p>{item.content}</p>
      )}
    </div>
  );
}

export function Day10({ hasApiKey, onOpenSettings }) {
  const [activeStrategy, setActiveStrategy] = useState("sliding");
  const [histories, setHistories] = useState({ sliding: [], facts: [] });
  const [branches, setBranches] = useState(createBranches);
  const [activeBranchId, setActiveBranchId] = useState("main");
  const [drafts, setDrafts] = useState(createDrafts);
  const [factsText, setFactsText] = useState("{}");
  const [results, setResults] = useState(createResults);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY10_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [keepLast, setKeepLast] = useState(DEFAULT_DAY10_KEEP_LAST);
  const [maxTokens, setMaxTokens] = useState(320);
  const [factsMaxTokens, setFactsMaxTokens] = useState(DEFAULT_DAY10_FACTS_MAX_TOKENS);
  const [temperature, setTemperature] = useState(0.2);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const chatEndRef = useRef(null);

  const factsState = useMemo(() => parseFacts(factsText), [factsText]);
  const activeHistory =
    activeStrategy === "branching"
      ? branches[activeBranchId]?.history ?? []
      : histories[activeStrategy];
  const draft =
    activeStrategy === "branching"
      ? drafts.branching[activeBranchId] ?? ""
      : drafts[activeStrategy];
  const activeResult =
    activeStrategy === "branching"
      ? results.branching[activeBranchId]
      : results[activeStrategy];

  const previewCounts = useMemo(() => {
    const fullMessages = [
      { role: "system", content: systemPrompt },
      ...activeHistory,
      { role: "user", content: draft },
    ];
    const recent = activeHistory.slice(-Number(keepLast || 0));
    const sentMessages = [
      { role: "system", content: systemPrompt },
      ...(activeStrategy === "facts" && factsState.value && Object.keys(factsState.value).length
        ? [{ role: "system", content: `Sticky Facts:\n${JSON.stringify(factsState.value, null, 2)}` }]
        : []),
      ...(activeStrategy === "branching" ? activeHistory : recent),
      { role: "user", content: draft },
    ];
    const full = estimateMessagesTokens(fullMessages);
    const sent = estimateMessagesTokens(sentMessages);
    return { full, sent, saved: Math.max(0, full - sent) };
  }, [activeHistory, activeStrategy, draft, factsState.value, keepLast, systemPrompt]);

  const canSend = Boolean(
    hasApiKey &&
      !isSending &&
      draft.trim() &&
      model.trim() &&
      systemPrompt.trim() &&
      temperature !== "" &&
      (activeStrategy !== "facts" || factsState.value),
  );

  useEffect(() => {
    if (activeHistory.length === 0 && !isSending) {
      return undefined;
    }
    const animationFrame = requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [activeBranchId, activeHistory.length, activeStrategy, isSending]);

  function updateDraft(value) {
    if (activeStrategy === "branching") {
      setDrafts((current) => ({
        ...current,
        branching: { ...current.branching, [activeBranchId]: value },
      }));
      return;
    }
    setDrafts((current) => ({ ...current, [activeStrategy]: value }));
  }

  function advanceDraft(strategy, branchId, previousHistory) {
    const completedUsers = previousHistory.filter((item) => item.role === "user").length + 1;
    if (strategy !== "branching" || branchId === "main") {
      return getDay10ScriptPrompt(strategy, completedUsers, branchId);
    }
    const branch = branches[branchId];
    return getDay10BranchPrompt(branchId, completedUsers - branch.checkpointUserCount);
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const userMessage = draft.trim();
    if (!canSend || !userMessage) {
      return;
    }

    setIsSending(true);
    setError("");
    try {
      const result = await apiRequest("/api/day10/chat", {
        method: "POST",
        body: JSON.stringify({
          strategy: activeStrategy,
          branchId: activeBranchId,
          systemPrompt,
          message: userMessage,
          model,
          keepLast: Number(keepLast),
          maxTokens: Number(maxTokens),
          factsMaxTokens: Number(factsMaxTokens),
          temperature: Number(temperature),
          history: activeHistory,
          facts: activeStrategy === "facts" ? factsState.value : {},
        }),
      });
      const nextHistory = [
        ...activeHistory,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.response.answer || "Модель не вернула текст." },
      ];

      if (activeStrategy === "branching") {
        setBranches((current) => ({
          ...current,
          [activeBranchId]: { ...current[activeBranchId], history: nextHistory },
        }));
        setResults((current) => ({
          ...current,
          branching: { ...current.branching, [activeBranchId]: result },
        }));
      } else {
        setHistories((current) => ({ ...current, [activeStrategy]: nextHistory }));
        setResults((current) => ({ ...current, [activeStrategy]: result }));
      }

      if (activeStrategy === "facts") {
        setFactsText(JSON.stringify(result.facts, null, 2));
      }
      updateDraft(advanceDraft(activeStrategy, activeBranchId, activeHistory));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSending(false);
    }
  }

  function createTwoBranches() {
    if (Object.keys(branches).length > 1 || activeBranchId !== "main") {
      return;
    }
    const source = branches.main;
    const userCount = source.history.filter((item) => item.role === "user").length;
    const child = (id, title) => ({
      id,
      title,
      parentId: "main",
      checkpointMessageCount: source.history.length,
      checkpointUserCount: userCount,
      history: source.history.map((item) => ({ ...item })),
    });
    setBranches({
      main: { ...source, checkpointMessageCount: source.history.length },
      "branch-a": child("branch-a", "Ветка A"),
      "branch-b": child("branch-b", "Ветка B"),
    });
    setDrafts((current) => ({
      ...current,
      branching: {
        ...current.branching,
        "branch-a": getDay10BranchPrompt("branch-a", 0),
        "branch-b": getDay10BranchPrompt("branch-b", 0),
      },
    }));
    setActiveBranchId("branch-a");
  }

  function resetAll() {
    setHistories({ sliding: [], facts: [] });
    setBranches(createBranches());
    setActiveBranchId("main");
    setDrafts(createDrafts());
    setFactsText("{}");
    setResults(createResults());
    setError("");
  }

  function resetSettings() {
    setSystemPrompt(DEFAULT_DAY10_SYSTEM_PROMPT);
    setModel(DEFAULT_MODEL);
    setKeepLast(DEFAULT_DAY10_KEEP_LAST);
    setMaxTokens(320);
    setFactsMaxTokens(DEFAULT_DAY10_FACTS_MAX_TOKENS);
    setTemperature(0.2);
  }

  const branchResult =
    results.branching[activeBranchId] ?? Object.values(results.branching).find(Boolean) ?? null;
  const comparisonResults = {
    sliding: results.sliding,
    facts: results.facts,
    branching: branchResult,
  };
  const comparisonReady = Object.values(comparisonResults).every(Boolean);

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 10</p>
          <h2>Стратегии управления контекстом</h2>
          <p className="muted">Sliding Window, редактируемые Sticky Facts и дерево веток.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Для эксперимента нужен ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">Открыть настройки</button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture" open>
        <summary>Короткий сценарий для видео</summary>
        <ol>
          <li>В Sliding Window отправляй подставленные сообщения до итогового ТЗ.</li>
          <li>Повтори тот же сценарий в Sticky Facts и покажи автоматически заполненный JSON.</li>
          <li>В Branching отправь три общих сообщения, создай две ветки и продолжи каждую.</li>
          <li>Сравни таблицу токенов, стабильность фактов и дерево веток.</li>
        </ol>
      </details>

      <div className="experiment-form agent-settings">
        <label>
          Системная инструкция
          <textarea disabled={isSending} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" value={systemPrompt} />
        </label>
        <div className="day10-settings-grid">
          <label>Модель OpenRouter<input disabled={isSending} onChange={(event) => setModel(event.target.value)} value={model} /></label>
          <label>Последние N<input disabled={isSending} max="40" min="1" onChange={(event) => setKeepLast(event.target.value)} type="number" value={keepLast} /></label>
          <label>Максимум ответа<input disabled={isSending} max="8192" min="1" onChange={(event) => setMaxTokens(event.target.value)} type="number" value={maxTokens} /></label>
          <label>Максимум facts<input disabled={isSending} max="2048" min="1" onChange={(event) => setFactsMaxTokens(event.target.value)} type="number" value={factsMaxTokens} /></label>
          <label>Temperature<input disabled={isSending} max="2" min="0" onChange={(event) => setTemperature(event.target.value)} step="0.1" type="number" value={temperature} /></label>
        </div>
        <div className="button-row memory-actions">
          <button className="secondary-button" disabled={isSending} onClick={resetSettings} type="button">Сбросить настройки</button>
          <button className="secondary-button" disabled={isSending} onClick={resetAll} type="button">Очистить День 10</button>
        </div>
      </div>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Стратегии контекста">
        {Object.entries(DAY10_STRATEGIES).map(([id, strategy]) => (
          <button
            aria-controls="day10-strategy-panel"
            aria-selected={activeStrategy === id}
            className={activeStrategy === id ? "variant-tab active" : "variant-tab"}
            disabled={isSending}
            key={id}
            onClick={() => setActiveStrategy(id)}
            role="tab"
            type="button"
          >
            {strategy.title}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day10-strategy-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{DAY10_STRATEGIES[activeStrategy].title}</h3>
          <p className="muted">{DAY10_STRATEGIES[activeStrategy].description}</p>
        </div>

        {activeStrategy === "facts" && (
          <section className="day10-facts-panel">
            <div className="token-panel-heading"><strong>Sticky Facts · редактируемый JSON</strong><span>{factsState.value ? Object.keys(factsState.value).length : 0} фактов</span></div>
            <textarea disabled={isSending} onChange={(event) => setFactsText(event.target.value)} rows="8" spellCheck="false" value={factsText} />
            {factsState.error && <p className="error-message">{factsState.error}</p>}
            {activeResult?.extraction.warning && <p className="notice">{activeResult.extraction.warning}</p>}
          </section>
        )}

        {activeStrategy === "branching" && (
          <section className="day10-branch-panel">
            <div className="token-panel-heading"><strong>Дерево веток</strong><span>checkpoint: {branches.main.checkpointMessageCount} сообщ.</span></div>
            <div className="branch-tree">
              <button className={activeBranchId === "main" ? "branch-node active" : "branch-node"} disabled={isSending} onClick={() => setActiveBranchId("main")} type="button">Main · {branches.main.history.length}</button>
              {Object.keys(branches).length > 1 && (
                <div className="branch-children">
                  {["branch-a", "branch-b"].map((id) => (
                    <button className={activeBranchId === id ? "branch-node active" : "branch-node"} disabled={isSending} key={id} onClick={() => setActiveBranchId(id)} type="button">{branches[id].title} · {branches[id].history.length}</button>
                  ))}
                </div>
              )}
            </div>
            <button className="secondary-button" disabled={isSending || activeBranchId !== "main" || branches.main.history.length === 0 || Object.keys(branches).length > 1} onClick={createTwoBranches} type="button">Создать checkpoint и две ветки</button>
          </section>
        )}

        <section className="chat-shell">
          <div className="chat-list" aria-live="polite">
            {activeHistory.length === 0 && !isSending && <p className="chat-empty">Диалог пока пуст. Первое сообщение находится в поле ввода.</p>}
            {activeHistory.map((item, index) => <ChatMessage item={item} key={`${activeStrategy}-${activeBranchId}-${index}`} />)}
            {isSending && (
              <>
                <div className="chat-message user-message"><span className="chat-role">User</span><p>{draft.trim()}</p></div>
                <div className="chat-message assistant-message"><span className="chat-role">Assistant</span><p className="muted">Агент формирует контекст по выбранной стратегии…</p></div>
              </>
            )}
            <div ref={chatEndRef} />
          </div>

          <form className="chat-composer" onSubmit={sendMessage}>
            <label>
              Сообщение агенту
              <textarea
                disabled={isSending}
                onChange={(event) => updateDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (canSend) sendMessage();
                }}
                placeholder="Напиши сообщение…"
                rows="4"
                value={draft}
              />
            </label>

            <div className="token-live-panel">
              <div className="token-panel-heading"><strong>Контекст следующего запроса</strong><span>экономия ≈ {formatTokens(previewCounts.saved)}</span></div>
              <div className="token-grid">
                <div><span>Полная история</span><strong>≈ {formatTokens(previewCounts.full)}</strong></div>
                <div><span>Будет отправлено</span><strong>≈ {formatTokens(previewCounts.sent)}</strong></div>
                <div><span>Сообщений накоплено</span><strong>{activeHistory.length}</strong></div>
                <div><span>Сообщений отправится</span><strong>{activeStrategy === "branching" ? activeHistory.length : Math.min(activeHistory.length, Number(keepLast || 0))}</strong></div>
              </div>
            </div>

            <div className="button-row">
              <span className="field-hint">Enter — отправить · Shift+Enter — новая строка.</span>
              <button className="primary-button" disabled={!canSend} type="submit">{isSending ? "Отправляю…" : "Отправить агенту"}</button>
            </div>
          </form>
        </section>
      </section>

      {error && <p className="error-message result-message">{error}</p>}

      {activeResult && (
        <section className="result-card">
          <div className="result-heading">
            <div><p className="eyebrow">Последний запрос</p><h3>{DAY10_STRATEGIES[activeStrategy].title}</h3></div>
            <div className="result-actions"><span className="status ready">Вход: {formatTokens(activeResult.tokenCounts.actualInput)}</span><button className="secondary-button" onClick={() => downloadResult(activeStrategy, activeResult)} type="button">Скачать JSON</button></div>
          </div>
          <div className="token-grid">
            <div><span>Вся история</span><strong>≈ {formatTokens(activeResult.tokenCounts.estimatedFullInput)}</strong></div>
            <div><span>Отправлено</span><strong>≈ {formatTokens(activeResult.tokenCounts.estimatedSentInput)}</strong></div>
            <div><span>Сэкономлено</span><strong>≈ {formatTokens(activeResult.tokenCounts.estimatedSaved)}</strong></div>
            <div><span>Фактов в ответе</span><strong>{countFacts(activeResult.response.answer)}/{EXPECTED_FACTS.length}</strong></div>
          </div>
          <ResultMetrics result={activeResult.response} />
          <RequestDetails request={activeResult.response.httpRequest} title="Технические детали запроса агента" />
          {activeResult.extraction.response && <RequestDetails request={activeResult.extraction.response.httpRequest} title="Технические детали извлечения facts" />}
        </section>
      )}

      {comparisonReady && (
        <section className="result-card final-comparison">
          <p className="eyebrow">Сравнение стратегий</p>
          <div className="markdown-body">
            <MarkdownContent>{`| Стратегия | История | Отправлено | Экономия | Факты | Удобство |
|---|---:|---:|---:|---:|---|
${Object.entries(comparisonResults).map(([id, result]) => `| ${DAY10_STRATEGIES[id].title} | ${result.context.totalHistoryMessages} | ${result.context.sentHistoryMessages} | ≈ ${result.tokenCounts.estimatedSaved} | ${countFacts(result.response.answer)}/${EXPECTED_FACTS.length} | ${id === "sliding" ? "просто" : id === "facts" ? "факты можно править" : "независимые варианты"} |`).join("\n")}`}</MarkdownContent>
          </div>
          <p className="field-hint">Сравни факты после итогового вопроса: Sliding Window может забыть начало, Sticky Facts сохраняет ключевые данные, Branching изолирует решения веток.</p>
        </section>
      )}
    </section>
  );
}
