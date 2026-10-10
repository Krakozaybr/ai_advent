import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createPrivateService, validateServiceInput, serviceLimits } from "../server/private-llm.mjs";

const token = "a".repeat(43);
const client = { model: "fake-local", status: async () => ({ model: "fake-local", localOnly: true }), complete: async () => "4" };
async function service(t, options = {}) {
  const server = createPrivateService({ token, client, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path = "/api/chat", body = { question: "2+2" }, extra = {}) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("сетевой HTTP, публичный IP и короткий ключ запрещены", () => {
  for (const host of ["192.168.1.20", "0.0.0.0", "8.8.8.8"]) assert.throws(() => createPrivateService({ token, host, client }), /HTTPS/);
  assert.throws(() => createPrivateService({ token: "short", client }), /ключ доступа/);
});
test("контекст ограничен в UTF-8, пользователь не подменяет системный промпт", () => {
  assert.throws(() => validateServiceInput({ question: "Вопрос", history: [{ role: "system", content: "Подмена" }] }), /История/);
  assert.throws(() => validateServiceInput({ question: "я".repeat(513) }), /1024 байт/);
  assert.throws(() => validateServiceInput({ question: "Вопрос", history: [{ role: "user", content: "я".repeat(1200) }, { role: "assistant", content: "Ответ" }] }), /2048 байт/);
  assert.equal(validateServiceInput({ question: "Вопрос", system: "Подмена" })[0].role, "system");
});
test("неавторизованный и cross-origin запросы не вызывают модель", async (t) => {
  let calls = 0;
  const request = await service(t, { client: { ...client, complete: async () => { calls++; return "4"; } } });
  assert.equal((await request("/api/chat", { question: "2+2" }, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await request("/api/chat", { question: "2+2" }, { Origin: "https://attacker.example" })).status, 403);
  assert.equal(calls, 0);
});
test("чат учитывает историю, не принимает произвольную модель; HTML не содержит ключ", async (t) => {
  let messages;
  const request = await service(t, { client: { ...client, complete: async (input) => { messages = input; return "Ярослав"; } } });
  const result = await request("/api/chat", { question: "Как меня зовут?", model: "cloud", history: [{ role: "user", content: "Я Ярослав" }, { role: "assistant", content: "Привет" }] });
  assert.equal(result.status, 200); assert.equal((await result.json()).model, "fake-local");
  assert.equal(messages[1].content, "Я Ярослав");
  const page = await (await request("/", null)).text();
  assert.ok(page.includes("Приватный чат")); assert.ok(!page.includes(token)); assert.ok(!page.includes("localStorage"));
});
test("после десяти запросов действует rate limit; ошибка модели не раскрывает диагностику", async (t) => {
  const request = await service(t, { client: { ...client, complete: async () => { throw new Error("secret/path/token"); } } });
  for (let i = 0; i < serviceLimits.requestsPerMinute; i++) { const response = await request(); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("secret")); }
  const limited = await request(); assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "60");
});
test("две заявки выполняются последовательно, третья получает 429", async (t) => {
  let release, calls = 0, active = 0, peak = 0;
  const started = new Promise((resolve) => { release = resolve; });
  const request = await service(t, { client: { ...client, complete: async () => { calls++; active++; peak = Math.max(peak, active); await started; active--; return "4"; } } });
  const first = request();
  while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = request();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const third = await request(); assert.equal(third.status, 429);
  release(); assert.equal((await first).status, 200); assert.equal((await second).status, 200); assert.equal(peak, 1);
});
test("слишком большой JSON и неверный тип тела отклоняются до генерации", async (t) => {
  const request = await service(t);
  assert.equal((await request("/api/chat", { question: "x".repeat(17000) })).status, 413);
  assert.equal((await request("/api/chat", { question: "Вопрос" }, { "Content-Type": "text/plain" })).status, 415);
  const status = await (await request("/api/status", null)).json();
  assert.equal(status.limits.contextWindow, 4096);
});
