package ai.advent.v3

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.post
import io.ktor.client.request.header
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.utils.io.readUTF8Line
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.time.Duration

interface OpenRouterGateway : Closeable {
    suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit, instructions: String = ""): JsonObject
    suspend fun toolRound(apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>, onText: suspend (String) -> Unit, instructions: String = ""): OpenRouterToolRound
}

data class OpenRouterToolRound(val message: JsonObject, val details: JsonObject)

class OpenRouterHttpGateway(
    private val endpoint: String = System.getenv("AI_ADVENT_OPENROUTER_URL") ?: "https://openrouter.ai/api/v1/chat/completions",
    private val client: HttpClient = HttpClient(CIO) { install(HttpTimeout) { requestTimeoutMillis = 120_000 } },
) : OpenRouterGateway {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun stream(
        apiKey: String,
        config: LaneConfig,
        history: List<ContextMessage>,
        prompt: String,
        onText: suspend (String) -> Unit,
        instructions: String,
    ): JsonObject {
        val started = System.nanoTime()
        val requestBody = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("stream_options", buildJsonObject { put("include_usage", true) })
            put("messages", buildJsonArray {
                if (instructions.isNotBlank()) add(buildJsonObject { put("role", "system"); put("content", instructions) })
                (history + ContextMessage("user", prompt)).forEach { item ->
                    add(buildJsonObject { put("role", item.role); put("content", item.content) })
                }
            })
            config.temperature?.let { put("temperature", it) }
            config.maxTokens?.let { put("max_tokens", it) }
            config.stop?.takeIf(String::isNotBlank)?.let { put("stop", buildJsonArray { add(JsonPrimitive(it)) }) }
        }
        val response = client.post(endpoint) {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Authorization, "Bearer $apiKey")
            header("X-Title", "Local Workspace v3")
            setBody(json.encodeToString(JsonObject.serializer(), requestBody))
        }
        if (response.status.value !in 200..299) {
            val body = response.bodyAsText()
            val detail = runCatching { json.parseToJsonElement(body).jsonObject["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content }.getOrNull()
            error(detail ?: "OpenRouter вернул HTTP ${response.status.value}.")
        }
        var returnedModel = config.model
        var finishReason: String? = null
        var usage: JsonObject? = null
        val channel = response.bodyAsChannel()
        while (!channel.isClosedForRead) {
            val line = channel.readUTF8Line() ?: break
            if (!line.startsWith("data:")) continue
            val payload = line.removePrefix("data:").trim()
            if (payload == "[DONE]") break
            val event = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: continue
            event["model"]?.jsonPrimitive?.contentOrNull?.let { returnedModel = it }
            event["usage"]?.jsonObject?.let { usage = it }
            val choice = event["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: continue
            choice["finish_reason"]?.jsonPrimitive?.contentOrNull?.let { finishReason = it }
            val delta = choice["delta"]?.jsonObject?.get("content")?.jsonPrimitive?.contentOrNull
            if (!delta.isNullOrEmpty()) onText(delta)
        }
        return buildJsonObject {
            put("provider", "openrouter")
            put("model", returnedModel)
            put("endpoint", safeEndpoint())
            put("httpStatus", response.status.value)
            put("durationMs", Duration.ofNanos(System.nanoTime() - started).toMillis())
            finishReason?.let { put("finishReason", it) }
            put("usageSource", if (usage == null) "unavailable" else "openrouter")
            usage?.let { put("usage", it) }
            put("request", buildJsonObject {
                put("model", config.model)
                put("stream", true)
                put("stream_options", buildJsonObject { put("include_usage", true) })
                put("effectiveInstructions", instructions)
                config.temperature?.let { put("temperature", it) }
                config.maxTokens?.let { put("max_tokens", it) }
                config.stop?.let { put("stop", it) }
            })
        }
    }

    override suspend fun toolRound(
        apiKey: String,
        config: LaneConfig,
        messages: List<JsonObject>,
        tools: List<JsonObject>,
        onText: suspend (String) -> Unit,
        instructions: String,
    ): OpenRouterToolRound {
        val started = System.nanoTime()
        val requestBody = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("stream_options", buildJsonObject { put("include_usage", true) })
            put("messages", buildJsonArray { messages.forEach { add(it) } })
            put("tools", buildJsonArray { tools.forEach { add(it) } })
            put("tool_choice", "auto")
            put("parallel_tool_calls", false)
            config.temperature?.let { put("temperature", it) }
            config.maxTokens?.let { put("max_tokens", it) }
            config.stop?.takeIf(String::isNotBlank)?.let { put("stop", buildJsonArray { add(JsonPrimitive(it)) }) }
        }
        val response = client.post(endpoint) {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Authorization, "Bearer $apiKey")
            header("X-Title", "Local Workspace v3")
            setBody(json.encodeToString(JsonObject.serializer(), requestBody))
        }
        if (response.status.value !in 200..299) {
            val body = response.bodyAsText()
            val detail = runCatching { json.parseToJsonElement(body).jsonObject["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content }.getOrNull()
            error(detail ?: "OpenRouter вернул HTTP ${response.status.value}.")
        }
        var returnedModel = config.model
        var finishReason: String? = null
        var usage: JsonObject? = null
        val toolCalls = sortedMapOf<Int, MutableMap<String, String>>()
        val content = StringBuilder()
        val channel = response.bodyAsChannel()
        while (!channel.isClosedForRead) {
            val line = channel.readUTF8Line() ?: break
            if (!line.startsWith("data:")) continue
            val payload = line.removePrefix("data:").trim()
            if (payload == "[DONE]") break
            val event = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: continue
            event["model"]?.jsonPrimitive?.contentOrNull?.let { returnedModel = it }
            event["usage"]?.jsonObject?.let { usage = it }
            val choice = event["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: continue
            choice["finish_reason"]?.jsonPrimitive?.contentOrNull?.let { finishReason = it }
            val delta = choice["delta"]?.jsonObject ?: continue
            delta["content"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotEmpty)?.let { content.append(it); onText(it) }
            delta["tool_calls"]?.jsonArray?.forEach { element ->
                val call = element.jsonObject
                val index = call["index"]?.jsonPrimitive?.intOrNull ?: 0
                val parts = toolCalls.getOrPut(index) { mutableMapOf("arguments" to "") }
                call["id"]?.jsonPrimitive?.contentOrNull?.let { parts["id"] = it }
                call["type"]?.jsonPrimitive?.contentOrNull?.let { parts["type"] = it }
                call["function"]?.jsonObject?.let { function ->
                    function["name"]?.jsonPrimitive?.contentOrNull?.let { parts["name"] = (parts["name"] ?: "") + it }
                    function["arguments"]?.jsonPrimitive?.contentOrNull?.let { parts["arguments"] = parts.getValue("arguments") + it }
                }
            }
        }
        val assistant = buildJsonObject {
            put("role", "assistant")
            if (content.isNotEmpty()) put("content", content.toString()) else put("content", kotlinx.serialization.json.JsonNull)
            if (toolCalls.isNotEmpty()) put("tool_calls", buildJsonArray {
                toolCalls.values.forEach { call -> add(buildJsonObject {
                    put("id", call["id"] ?: "")
                    put("type", call["type"] ?: "function")
                    put("function", buildJsonObject { put("name", call["name"] ?: ""); put("arguments", call["arguments"] ?: "{}") })
                }) }
            })
        }
        val details = buildJsonObject {
            put("provider", "openrouter"); put("model", returnedModel); put("endpoint", safeEndpoint())
            put("httpStatus", response.status.value); put("durationMs", Duration.ofNanos(System.nanoTime() - started).toMillis())
            finishReason?.let { put("finishReason", it) }; put("usageSource", if (usage == null) "unavailable" else "openrouter")
            usage?.let { put("usage", it) }
            put("request", buildJsonObject {
                put("model", config.model); put("stream", true); put("toolChoice", "auto"); put("parallelToolCalls", false)
                put("effectiveInstructions", instructions)
                put("tools", buildJsonArray { tools.forEach { add(it) } })
            })
        }
        return OpenRouterToolRound(assistant, details)
    }

    private fun safeEndpoint(): String = runCatching {
        java.net.URI(endpoint).let { uri ->
            val authority = uri.host ?: return@runCatching "OpenRouter endpoint"
            "${uri.scheme}://$authority${uri.path.orEmpty()}"
        }
    }.getOrDefault("OpenRouter endpoint")

    override fun close() = client.close()
}

class OpenRouterKeyStore(private val file: java.nio.file.Path) {
    @Synchronized
    fun isConfigured(): Boolean = readKey().isNotEmpty()

    @Synchronized
    fun get(): String = readKey()

    @Synchronized
    fun save(key: String) {
        require(key.isNotBlank() && key.length <= 500) { "Укажи корректный API-ключ OpenRouter." }
        java.nio.file.Files.createDirectories(file.toAbsolutePath().parent)
        if (!java.nio.file.Files.exists(file)) {
            runCatching {
                java.nio.file.Files.createFile(
                    file,
                    java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                        java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"),
                    ),
                )
            }.recoverCatching { java.nio.file.Files.createFile(file) }
        }
        runCatching { java.nio.file.Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")) }
        java.nio.file.Files.writeString(file, key.trim())
    }

    private fun readKey(): String = runCatching { java.nio.file.Files.readString(file).trim() }.getOrDefault("")
}
