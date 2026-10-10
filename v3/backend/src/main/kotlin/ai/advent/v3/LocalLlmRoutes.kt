package ai.advent.v3

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.nio.file.Path
import java.util.concurrent.TimeUnit

private val localJson = Json { ignoreUnknownKeys = true }
private val localSlots = Semaphore(1)

class LocalLlmGateway(
    private val root: Path = Path.of(System.getenv("AI_ADVENT_V3_CWD") ?: "../..").toAbsolutePath(),
    private val node: String = System.getenv("AI_ADVENT_NODE") ?: "node",
) {
    suspend fun request(command: String, input: String = ""): JsonObject = localSlots.withPermit {
        withTimeout(150_000) {
            withContext(Dispatchers.IO) {
                val process = ProcessBuilder(node, root.resolve("examples/ai-advent/local-llm.mjs").toString(), command)
                    .directory(root.toFile())
                    .start()
                try {
                    coroutineScope {
                        val output = async { process.inputStream.bufferedReader().use { it.readText() } }
                        val errors = async { process.errorStream.bufferedReader().use { it.readText() } }
                        process.outputStream.bufferedWriter().use { it.write(input) }
                        if (!process.waitFor(145, TimeUnit.SECONDS)) {
                            process.destroyForcibly()
                            error("Локальная модель не ответила за 145 секунд.")
                        }
                        val result = output.await()
                        val diagnostics = errors.await()
                        check(process.waitFor() == 0) { diagnostics.lineSequence().firstOrNull { it.startsWith("Error:") } ?: "Локальная модель недоступна. Проверь npm run local -- status и наличие локального индекса." }
                        localJson.parseToJsonElement(result).jsonObject
                    }
                } finally {
                    if (process.isAlive) process.destroyForcibly()
                }
            }
        }
    }
}

fun Route.localLlmRoutes(request: suspend (String, String) -> JsonObject = LocalLlmGateway()::request) {
    get("/api/local-llm/status") {
        try {
            call.respond(request("status", ""))
        } catch (error: Exception) {
            call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject { put("error", error.message ?: "Ollama недоступен.") })
        }
    }
    post("/api/local-llm/chat") {
        val text = call.receiveText()
        val body = runCatching { localJson.parseToJsonElement(text).jsonObject }.getOrNull()
        val questionValue = body?.get("question") as? JsonPrimitive
        val question = questionValue?.contentOrNull
        val rag = body?.get("rag") as? JsonPrimitive
        if (text.length > 130_000 || questionValue?.isString != true || question.isNullOrBlank() || question.length > 6000 || (body?.containsKey("rag") == true && (rag?.isString != false || rag.booleanOrNull == null))) {
            call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Нужен вопрос до 6000 символов и логическое значение rag.") })
            return@post
        }
        try {
            call.respond(request("request", text))
        } catch (error: Exception) {
            call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject { put("error", error.message ?: "Запрос к локальной модели не выполнен.") })
        }
    }
}
