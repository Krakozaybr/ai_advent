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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.time.Duration

interface OpenRouterGateway : Closeable {
    suspend fun stream(apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String, onText: suspend (String) -> Unit): JsonObject
}

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
    ): JsonObject {
        val started = System.nanoTime()
        val requestBody = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("stream_options", buildJsonObject { put("include_usage", true) })
            put("messages", buildJsonArray {
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
                config.temperature?.let { put("temperature", it) }
                config.maxTokens?.let { put("max_tokens", it) }
                config.stop?.let { put("stop", it) }
            })
        }
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
