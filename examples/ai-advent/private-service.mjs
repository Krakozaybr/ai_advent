import { randomBytes, X509Certificate } from "node:crypto";
import { readFile, writeFile, mkdir, access, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import https from "node:https";
import { createPrivateService } from "../../server/private-llm.mjs";

const execute = promisify(execFile);
const directory = fileURLToPath(new URL("../../data/private-service/", import.meta.url));
const configPath = resolve(directory, "config.json");

export async function setupService(host) {
  const parts = host?.split(".").map(Number) ?? [];
  if (parts.length !== 4 || !/^\d+\.\d+\.\d+\.\d+$/u.test(host) || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || !(host === "127.0.0.1" || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))) throw new Error("Укажи домашний IPv4 ноутбука, например: npm run private -- setup 192.168.1.20");
  try { await access(configPath); throw new Error("Сервис уже настроен. Существующие ключи не перезаписываются."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await execute("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`]);
  const passphrase = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const env = { ...process.env, PRIVATE_SERVICE_IP: host, PRIVATE_SERVICE_DIR: directory, PRIVATE_SERVICE_PASSWORD: passphrase };
  if (process.platform === "win32") {
    const script = '$ErrorActionPreference="Stop"; $cert=New-SelfSignedCertificate -Type SSLServerAuthentication -Subject "CN=AI Advent private chat" -KeyAlgorithm RSA -KeyLength 2048 -CertStoreLocation "Cert:\\CurrentUser\\My" -KeyExportPolicy Exportable -NotAfter (Get-Date).AddMonths(6) -TextExtension @("2.5.29.17={text}IPAddress=$env:PRIVATE_SERVICE_IP&DNS=localhost"); try { $password=ConvertTo-SecureString $env:PRIVATE_SERVICE_PASSWORD -AsPlainText -Force; Export-PfxCertificate -Cert $cert -FilePath (Join-Path $env:PRIVATE_SERVICE_DIR "server.pfx") -Password $password -CryptoAlgorithmOption AES256_SHA256 | Out-Null; Export-Certificate -Cert $cert -FilePath (Join-Path $env:PRIVATE_SERVICE_DIR "server.cer") | Out-Null } finally { Remove-Item -LiteralPath $cert.PSPath }';
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env });
    const der = await readFile(resolve(directory, "server.cer"));
    await writeFile(resolve(directory, "server.pem"), `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/gu).join("\n")}\n-----END CERTIFICATE-----\n`, { mode: 0o600 });
  } else {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", resolve(directory, "server.key"), "-out", resolve(directory, "server.pem"), "-days", "180", "-subj", "/CN=AI Advent private chat", "-addext", `subjectAltName=IP:${host},DNS:localhost`], { env });
    await execute("openssl", ["pkcs12", "-export", "-out", resolve(directory, "server.pfx"), "-inkey", resolve(directory, "server.key"), "-in", resolve(directory, "server.pem"), "-passout", "env:PRIVATE_SERVICE_PASSWORD"], { env });
    await chmod(resolve(directory, "server.key"), 0o600);
  }
  await chmod(resolve(directory, "server.pfx"), 0o600);
  const certificate = new X509Certificate(await readFile(resolve(directory, "server.pem")));
  if (!certificate.checkIP(host)) throw new Error("Сертификат не содержит IP сервера.");
  await writeFile(configPath, JSON.stringify({ host, port: 3443, passphrase, token }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Готово: https://${host}:3443\nSHA-256 сертификата: ${certificate.fingerprint256}\nПубличный сертификат для клиента: data/private-service/server.pem\nКлюч для браузера: npm run --silent private -- token\nЗапуск: npm run private -- serve\nПорт и Firewall автоматически не открываются.`);
}

export function serviceRequest(url, { token, ca, body } = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password) throw new Error("Нужен HTTPS-адрес без ключа в URL.");
  return new Promise((resolve, reject) => {
    const request = https.request(target, { method: body ? "POST" : "GET", ca, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, timeout: 180000 }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; if (text.length > 100000) request.destroy(new Error("Ответ слишком большой.")); });
      response.on("end", () => { try { resolve({ status: response.statusCode, ...JSON.parse(text) }); } catch { reject(new Error("Сервис вернул некорректный JSON.")); } });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Сервис не ответил за 180 секунд.")));
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function checkService(url, certificatePath, { token = process.env.PRIVATE_SERVICE_TOKEN } = {}) {
  if (!token) throw new Error("Задай PRIVATE_SERVICE_TOKEN в локальном .env; ключ не передавай в командной строке.");
  if (!certificatePath) throw new Error("Укажи публичный сертификат: npm run private -- check https://IP:3443 server.pem");
  const ca = await readFile(certificatePath);
  const endpoint = new URL(url);
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Укажи только адрес сервиса, без пути или параметров.");
  const request = (path, input, secret = token) => serviceRequest(new URL(path, endpoint), { token: secret, ca, body: input });
  const status = await request("/api/status");
  if (status.status !== 200) throw new Error(`Не удалось подключиться: HTTP ${status.status}`);
  console.log(`Подключение: ${status.model}, ${status.transport}`);
  const rows = [];
  const record = async (name, expected, run) => { const started = performance.now(); const result = await run(); const passed = result.status === expected; rows.push({ name, expected, status: result.status, passed, elapsedMs: Math.round(performance.now() - started), answer: result.answer }); console.log(`${passed ? "OK" : "FAIL"} · ${name}: HTTP ${result.status}${result.answer ? ` · ${result.answer}` : ""}`); };
  await record("неверный ключ", 401, () => request("/api/status", undefined, "wrong"));
  await record("слишком большой контекст", 413, () => request("/api/chat", { question: "а", history: [{ role: "user", content: "а".repeat(1200) }, { role: "assistant", content: "Ответ" }] }));
  let history = [];
  for (const question of ["Запомни: меня зовут Ярослав. Ответь кратко.", "Как меня зовут?"]) {
    let result;
    await record(`чат: ${question}`, 200, async () => { result = await request("/api/chat", { question, history }); return result; });
    if (result.status === 200) history.push({ role: "user", content: question }, { role: "assistant", content: result.answer });
  }
  await Promise.all([1, 2].map((i) => record(`одновременный запрос ${i}`, 200, () => request("/api/chat", { question: "Сколько будет 2 + 2? Только число." }))));
  let limited = false;
  for (let i = 0; i < 12; i++) { const result = await request("/api/chat", { question: "Ответь одним словом: да." }); if (result.status === 429) { limited = result.code === "rate_limited"; break; } if (result.status !== 200) break; }
  rows.push({ name: "rate limit", passed: limited });
  console.log(`${limited ? "OK" : "FAIL"} · превышение лимита возвращает HTTP 429`);
  const { writeJsonAtomic } = await import("./rag.mjs");
  await writeJsonAtomic(resolve(directory, "day30-check.json"), { createdAt: new Date().toISOString(), endpoint: endpoint.origin, rows });
  if (rows.some((row) => !row.passed)) throw new Error("Не все проверки прошли; смотри data/private-service/day30-check.json.");
}

export async function privateCommand(command, args = []) {
  if (command === "setup") return setupService(args[0]);
  if (command === "check") return checkService(args[0], args[1]);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (command === "check-local") return checkService(`https://${config.host}:${config.port}`, resolve(directory, "server.pem"), { token: config.token });
  if (command === "token") { console.log(config.token); return; }
  if (command !== "serve") throw new Error("Команды: setup IP | serve | token | check https://IP:3443 server.pem");
  const server = createPrivateService({ ...config, tls: { pfx: await readFile(resolve(directory, "server.pfx")), passphrase: config.passphrase } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  console.log(`Приватный чат: https://${config.host}:${config.port}. Ollama остаётся на loopback; облака нет.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await privateCommand(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(`Error: ${error.code === "ENOENT" ? "Сначала настрой сервис: npm run private -- setup IP" : error.message}`); process.exitCode = 1; }
}
