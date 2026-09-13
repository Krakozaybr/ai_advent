import { useState } from "react";
import { DEFAULT_DAY3_TASK } from "../shared/day3.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Возьмите одну логическую, алгоритмическую или аналитическую задачу и решите её через API четырьмя способами:

- 👉 получите прямой ответ без дополнительных инструкций
- 👉 добавьте в prompt инструкцию «решай пошагово»
- 👉 попросите модель сначала составить prompt для решения задачи, а затем используйте его
- 👉 создайте в prompt группу экспертов и получите решение от каждого

Сравните ответы и определите, какой способ дал наиболее точный результат.

**Результат:** несколько решений одной задачи и их сравнение.`;

const METHODS = {
  direct: {
    title: "Прямой ответ",
    description: "Минимальная инструкция без требования показывать ход решения.",
    instruction: "Дай прямой ответ. Заверши строкой «Итоговый ответ: <число>».",
    maxTokens: 500,
  },
  step: {
    title: "Пошагово",
    description: "К исходной задаче добавлена явная инструкция рассуждать по шагам.",
    instruction: "Решай пошагово. Заверши строкой «Итоговый ответ: <число>».",
    maxTokens: 700,
  },
  meta: {
    title: "Сначала prompt",
    description: "Первый вызов создаёт prompt, второй вызов решает задачу по нему.",
    instruction:
      "Составь короткий и точный prompt для другой модели, чтобы она решила задачу. Не решай задачу сам.",
    maxTokens: 500,
  },
  experts: {
    title: "Группа экспертов",
    description: "Аналитик, инженер и критик дают решения и проверяют общий вывод.",
    instruction: `Дай три независимых мини-решения с заголовками «Аналитик», «Инженер» и «Критик».
Каждому эксперту разрешено не более четырёх коротких пунктов, без полного перебора вариантов.
Критик обязан проверить выводы остальных. В конце добавь строку «Итоговый ответ: <число>».`,
    maxTokens: 800,
  },
};

const DEFAULT_FORMS = Object.fromEntries(
  Object.entries(METHODS).map(([id, method]) => [
    id,
    { instruction: method.instruction, model: DEFAULT_MODEL, maxTokens: method.maxTokens },
  ]),
);

const EMPTY_RESULTS = { direct: null, step: null, meta: null, experts: null };
const EMPTY_ERRORS = { direct: "", step: "", meta: "", experts: "" };
const EMPTY_LOADING = { direct: false, step: false, meta: false, experts: false };

function downloadResult(method, task, form, result) {
  const payload = { task, method, settings: form, result };
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day3-${method}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function buildComparison(results) {
  const rows = Object.entries(METHODS).map(([id, method]) => {
    const result = results[id];
    const accuracy = result.correct == null ? "не проверяется" : result.correct ? "точно" : "ошибка";
    return `| ${method.title} | ${accuracy} | ${result.wordCount} | ${result.usage?.total_tokens ?? "н/д"} | ${result.latencyMs} мс | $${Number(result.cost || 0).toFixed(6)} |`;
  });
  const checkedResults = Object.entries(results).filter(([, result]) => result.correct != null);
  const correctMethods = checkedResults
    .filter(([, result]) => result.correct)
    .map(([id]) => METHODS[id].title);
  const conclusion = checkedResults.length
    ? correctMethods.length
      ? `По правильности наиболее точные способы: **${correctMethods.join(", ")}**.`
      : "Ни один способ не дал ожидаемый ответ."
    : "Для изменённой задачи автоматическая проверка точности отключена.";

  return `${conclusion}

| Способ | Точность | Слов | Токенов | Время | Стоимость |
|---|---:|---:|---:|---:|---:|
${rows.join("\n")}`;
}

export function Day3({ hasApiKey, onOpenSettings }) {
  const [task, setTask] = useState(DEFAULT_DAY3_TASK);
  const [activeMethod, setActiveMethod] = useState("direct");
  const [forms, setForms] = useState(DEFAULT_FORMS);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [errors, setErrors] = useState(EMPTY_ERRORS);
  const [loadingMethods, setLoadingMethods] = useState(EMPTY_LOADING);

  const method = METHODS[activeMethod];
  const form = forms[activeMethod];
  const result = results[activeMethod];
  const allReady = Object.values(results).every(Boolean);

  function updateTask(value) {
    setTask(value);
    setResults(EMPTY_RESULTS);
    setErrors(EMPTY_ERRORS);
  }

  function update(name, value) {
    setForms((current) => ({
      ...current,
      [activeMethod]: { ...current[activeMethod], [name]: value },
    }));
  }

  async function runMethod(event) {
    event.preventDefault();
    const requestedMethod = activeMethod;
    const requestedForm = forms[requestedMethod];
    setLoadingMethods((current) => ({ ...current, [requestedMethod]: true }));
    setErrors((current) => ({ ...current, [requestedMethod]: "" }));

    try {
      const nextResult = await apiRequest("/api/day3/run", {
        method: "POST",
        body: JSON.stringify({
          ...requestedForm,
          method: requestedMethod,
          maxTokens: Number(requestedForm.maxTokens),
          task,
        }),
      });
      setResults((current) => ({ ...current, [requestedMethod]: nextResult }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [requestedMethod]: requestError.message }));
    } finally {
      setLoadingMethods((current) => ({ ...current, [requestedMethod]: false }));
    }
  }

  function resetMethod() {
    setForms((current) => ({ ...current, [activeMethod]: DEFAULT_FORMS[activeMethod] }));
    setResults((current) => ({ ...current, [activeMethod]: null }));
    setErrors((current) => ({ ...current, [activeMethod]: "" }));
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 3</p>
          <h2>Разные способы рассуждения</h2>
          <p className="muted">Реши одну задачу четырьмя способами и сравни результат.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Перед первым запросом добавь ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">
            Открыть настройки
          </button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <label className="shared-task">
        Одна задача для всех способов
        <textarea onChange={(event) => updateTask(event.target.value)} rows="5" value={task} />
        <span className="field-hint">
          Для дефолтной задачи ожидается число 453. После изменения задачи автопроверка отключится.
        </span>
      </label>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Способы рассуждения">
        {Object.entries(METHODS).map(([id, item]) => (
          <button
            aria-controls="day3-method-panel"
            aria-selected={activeMethod === id}
            className={activeMethod === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveMethod(id)}
            role="tab"
            type="button"
          >
            {item.title} {loadingMethods[id] ? "…" : results[id] ? "✓" : ""}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day3-method-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{method.title}</h3>
          <p className="muted">{method.description}</p>
        </div>

        <form className="experiment-form" onSubmit={runMethod}>
          <label>
            Инструкция способа
            <textarea
              onChange={(event) => update("instruction", event.target.value)}
              rows="5"
              value={form.instruction}
            />
          </label>
          <div className="field-grid">
            <label>
              Модель OpenRouter
              <input onChange={(event) => update("model", event.target.value)} value={form.model} />
            </label>
            <label>
              Максимум токенов
              <input
                max="8192"
                min="1"
                onChange={(event) => update("maxTokens", event.target.value)}
                type="number"
                value={form.maxTokens}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={resetMethod} type="button">
              Сбросить способ
            </button>
            <button
              className="primary-button"
              disabled={loadingMethods[activeMethod] || !hasApiKey}
              type="submit"
            >
              {loadingMethods[activeMethod] ? "Ждём ответ…" : `Запустить: ${method.title}`}
            </button>
          </div>
        </form>

        {errors[activeMethod] && (
          <p className="error-message result-message">{errors[activeMethod]}</p>
        )}

        {result && (
          <section className="result-card" aria-live="polite">
            <div className="result-heading">
              <div>
                <p className="eyebrow">Решение</p>
                <h3>{result.model}</h3>
              </div>
              <div className="result-actions">
                <span
                  className={`accuracy-badge ${
                    result.correct == null ? "unknown" : result.correct ? "correct" : "incorrect"
                  }`}
                >
                  {result.correct == null
                    ? "Без автопроверки"
                    : result.correct
                      ? "Ответ точный"
                      : "Ответ не совпал"}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => downloadResult(activeMethod, task, form, result)}
                  type="button"
                >
                  Скачать JSON
                </button>
              </div>
            </div>

            {result.generatedPrompt && (
              <details className="generated-prompt">
                <summary>Prompt, созданный моделью</summary>
                <pre>{result.generatedPrompt}</pre>
              </details>
            )}

            <div className="answer markdown-body">
              <MarkdownContent>
                {result.answer || "Модель не вернула текст. Попробуй увеличить лимит токенов."}
              </MarkdownContent>
            </div>
            <ResultMetrics result={result} />
            {result.calls.map((call, index) => (
              <RequestDetails
                key={`${call.label}-${index}`}
                request={call.httpRequest}
                title={`Технические детали запроса ${index + 1}: ${call.label}`}
              />
            ))}
          </section>
        )}
      </section>

      {allReady && (
        <section className="result-card final-comparison" aria-live="polite">
          <p className="eyebrow">Итоговое сравнение</p>
          <div className="markdown-body">
            <MarkdownContent>{buildComparison(results)}</MarkdownContent>
          </div>
        </section>
      )}
    </section>
  );
}
