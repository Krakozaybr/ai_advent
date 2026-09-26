# AI Advent v3 — первый срез

Изолированное приложение: Ktor хранит историю одной ленты в `v3/data/board.sqlite`,
а React-интерфейс получает изменения через SSE. v2 продолжает запускаться из корня.

## Запуск

В первом терминале:

```sh
cd v3/backend
./gradlew run
```

Во втором:

```sh
cd v3/frontend
npm install
npm run dev
```

Открой `http://127.0.0.1:5173`. Backend использует установленный `codex` из `PATH`
и существующий вход Codex через ChatGPT. Кнопка входа запускает штатную страницу
ChatGPT; API-ключ OpenAI не нужен.

## Проверки

```sh
cd v3/backend && ./gradlew test
cd v3/frontend && npm test && npm run build
cd ../.. && npm test && npm run build && git diff --check
```

Проверки app-server используют подменённый транспорт; ручной проход с настоящим
Codex — открыть страницу, отправить текст и перезагрузить её после завершения.
