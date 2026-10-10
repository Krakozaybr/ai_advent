import http from "node:http";
import https from "node:https";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createOllamaClient } from "./ollama.mjs";

export const serviceLimits = { requestsPerMinute: 10, maxBodyBytes: 16384, maxContextBytes: 2048, maxQuestionBytes: 1024, maxHistoryMessages: 8, maxInFlight: 2, contextWindow: 4096, maxTokens: 1536 };
export const servicePrompt = "Отвечай по-русски, кратко и по существу. Учитывай историю диалога. Не выдумывай факты; если не знаешь, скажи об этом. Не показывай скрытые рассуждения.";
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
export function validateServiceInput(input) {
  if (!input || typeof input.question !== "string" || !input.question.trim() || Buffer.byteLength(input.question) > serviceLimits.maxQuestionBytes) throw failure(400, "Нужен вопрос от 1 до 1024 байт UTF-8.");
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > serviceLimits.maxHistoryMessages || history.length % 2 || history.some((message, i) => message?.role !== (i % 2 ? "assistant" : "user") || typeof message.content !== "string")) throw failure(400, "История: максимум четыре пары user/assistant.");
  const messages = [{ role: "system", content: servicePrompt }, ...history.map(({ role, content }) => ({ role, content })), { role: "user", content: input.question.trim() }];
  if (messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) > serviceLimits.maxContextBytes) throw failure(413, "История и вопрос превышают лимит 2048 байт UTF-8. Сократи вопрос или начни новый диалог.");
  return messages;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0, overflow = false;
    const chunks = [];
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > serviceLimits.maxBodyBytes) { if (!overflow) reject(failure(413, "Запрос больше 16 KiB.")); overflow = true; return; }
      if (!overflow) chunks.push(chunk);
    });
    request.on("end", () => {
      if (overflow) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(failure(400, "Нужен корректный JSON.")); }
    });
    request.on("error", reject);
    request.on("aborted", () => reject(failure(400, "Запрос прерван.")));
  });
}

export function createPrivateService({ token, host = "127.0.0.1", tls, client = createOllamaClient({ temperature: 0.1, contextWindow: serviceLimits.contextWindow, maxTokens: serviceLimits.maxTokens }) }) {
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/u.test(token)) throw new Error("Нужен случайный ключ доступа длиной 32–128 символов.");
  const local = host === "127.0.0.1";
  const parts = host.split(".").map(Number);
  const privateIp = /^\d+\.\d+\.\d+\.\d+$/u.test(host) && parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (!local && (!privateIp || !tls)) throw new Error("Доступ по сети требует конкретный домашний IPv4-адрес и HTTPS-сертификат. 0.0.0.0 и публичные адреса запрещены.");
  const digest = (value) => createHash("sha256").update(value).digest();
  const tokenHash = digest(`Bearer ${token}`), attempts = new Map();
  let inFlight = 0, queue = Promise.resolve(), windowStart = Date.now(), requests = 0;
  const html = readFile(new URL("./private-chat.html", import.meta.url), "utf8");
  const send = (response, status, value) => { if (!response.destroyed) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(status === 429 ? { "Retry-After": "60" } : {}) }); response.end(JSON.stringify(value)); } };
  const handler = async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const authority = `${host}:${server.address().port}`;
    const origin = `${tls ? "https" : "http"}://${authority}`;
    if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== origin)) return send(response, 403, { error: "Неверный Host или Origin." });
    if (request.url === "/" && request.method === "GET") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(await html); return; }
    if (!((request.url === "/api/chat" && request.method === "POST") || (request.url === "/api/status" && request.method === "GET"))) return send(response, 404, { error: "Маршрут не найден." });
    const now = Date.now();
    for (const [key, item] of attempts) if (now - item.start >= 60000) attempts.delete(key);
    const address = request.socket.remoteAddress;
    if (!attempts.has(address) && attempts.size >= 256) return send(response, 429, { error: "Слишком много клиентов." });
    const attempt = attempts.get(address) ?? { start: now, count: 0 };
    attempts.set(address, attempt);
    if (++attempt.count > 30) return send(response, 429, { error: "Слишком много обращений с этого адреса." });
    const auth = request.headers.authorization ?? "";
    if (!timingSafeEqual(digest(auth), tokenHash)) return send(response, 401, { error: "Нужен ключ доступа." });
    // Ключ, вопросы и ответы не пишутся в журналы и на диск.
    try {
      if (request.url === "/api/status") return send(response, 200, { ...(await client.status()), limits: serviceLimits, transport: tls ? "HTTPS" : "HTTP, только loopback" });
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) throw failure(415, "Нужен Content-Type: application/json.");
      if (Number(request.headers["content-length"]) > serviceLimits.maxBodyBytes) throw failure(413, "Запрос больше 16 KiB.");
      const messages = validateServiceInput(await readBody(request));
      if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
      if (requests >= serviceLimits.requestsPerMinute) throw failure(429, "Лимит: 10 запросов в минуту. Подожди минуту.", "rate_limited");
      if (inFlight >= serviceLimits.maxInFlight) throw failure(429, "Очередь заполнена. Дождись завершения текущего запроса.", "queue_full");
      requests++; inFlight++;
      const previous = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      const started = performance.now();
      try {
        await previous;
        if (response.destroyed) return;
        const answer = await client.complete(messages);
        send(response, 200, { answer, model: client.model, elapsedMs: Math.round(performance.now() - started), localOnly: true });
      } finally { inFlight--; release(); }
    } catch (error) { send(response, error.status ?? 503, { error: error.status ? error.message : "Локальная модель недоступна или не завершила ответ. Проверь Ollama на сервере.", ...(error.status && error.code ? { code: error.code } : {}) }); }
  };
  const guardedHandler = (request, response) => { void handler(request, response).catch(() => send(response, 500, { error: "Ошибка сервиса." })); };
  const server = tls ? https.createServer(tls, guardedHandler) : http.createServer(guardedHandler);
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  server.maxConnections = 32;
  return server;
}
