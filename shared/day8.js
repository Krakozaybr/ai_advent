export const DEFAULT_DAY8_CONTEXT_LIMIT = 262_144;

export const DAY8_SCENARIOS = {
  short: {
    title: "Короткий диалог",
    description: "Два сообщения: сохранить один факт и проверить, помнит ли его модель.",
  },
  long: {
    title: "Длинный диалог",
    description: "Последовательно передать требования проекта и запросить итоговое резюме.",
  },
  overflow: {
    title: "Переполнение",
    description: "Сохранить важный факт, а затем отправить вопрос с очень большим stack trace.",
  },
};

const SHORT_SCRIPT = [
  "Запомни: учебный проект называется AI Advent и запускается локально.",
  "Как называется мой учебный проект и где он запускается? Ответь одним предложением.",
];

const LONG_SCRIPT = [
  "Запомни требование: проект называется AI Advent и запускается локально.",
  "Запомни требование: интерфейс сделан как веб-приложение с десятью вкладками.",
  "Запомни требование: все запросы к моделям выполняются через OpenRouter.",
  "Запомни требование: основная модель проекта относится к семейству Qwen.",
  "Запомни требование: ответы модели отображаются как Markdown.",
  "Запомни требование: история диалога хранится в локальной базе SQLite.",
  "Запомни требование: API-ключ хранится только локально и не возвращается браузеру.",
  "Запомни требование: каждый учебный день должен быть удобен для записи короткого видео.",
  "Составь краткое резюме всех требований к проекту AI Advent. Ничего не пропускай.",
];

export const DAY8_OVERFLOW_FACT =
  "Запомни такой факт: ошибка возникла в сервисе payments-api после смены порта базы данных с 5432 на 6432.";

const STACK_TRACE_GROUPS = 1_000;

function stackTraceGroup(index) {
  const requestId = String(index + 1).padStart(6, "0");
  const minute = String(index % 60).padStart(2, "0");
  const line = 40 + (index % 70);

  return `2026-09-14T12:${minute}:17.421+03:00 ERROR [request-${requestId}] payments-api — payment creation failed
org.springframework.transaction.CannotCreateTransactionException: Could not open JDBC Connection for transaction
    at org.springframework.jdbc.datasource.DataSourceTransactionManager.doBegin(DataSourceTransactionManager.java:${line})
    at org.springframework.transaction.support.AbstractPlatformTransactionManager.startTransaction(AbstractPlatformTransactionManager.java:400)
    at com.aiadvent.payments.service.PaymentService.createPayment(PaymentService.java:${line + 11})
    at com.aiadvent.payments.api.PaymentController.create(PaymentController.java:${line + 23})
Caused by: org.postgresql.util.PSQLException: Connection to inventory-db:5432 refused. Check that the hostname and port are correct.
    at org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:${line + 34})
    at org.postgresql.core.ConnectionFactory.openConnection(ConnectionFactory.java:${line + 45})
Caused by: java.net.ConnectException: Connection refused
    at java.base/sun.nio.ch.Net.pollConnect(Native Method)
Diagnostic: configured-host=inventory-db; configured-port=5432; expected-port=6432; pool=payments-primary; request=request-${requestId}`;
}

export function buildDay8OverflowPrompt() {
  const stackTrace = Array.from({ length: STACK_TRACE_GROUPS }, (_, index) =>
    stackTraceGroup(index),
  ).join("\n\n");

  return `Объясни, в чём ошибка, и предложи исправление. Используй факт, который я просил запомнить. Вот полный stack trace:\n\n${stackTrace}`;
}

export function getDay8ScriptPrompt(scenario, completedUserMessages = 0) {
  if (scenario === "short") {
    return SHORT_SCRIPT[completedUserMessages] ?? "";
  }
  if (scenario === "long") {
    return LONG_SCRIPT[completedUserMessages] ?? "";
  }
  if (scenario === "overflow") {
    if (completedUserMessages === 0) {
      return DAY8_OVERFLOW_FACT;
    }
    if (completedUserMessages === 1) {
      return buildDay8OverflowPrompt();
    }
    return "";
  }

  throw new Error("Неизвестный сценарий Дня 8.");
}
