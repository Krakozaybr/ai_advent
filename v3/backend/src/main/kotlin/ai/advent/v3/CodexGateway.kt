package ai.advent.v3

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.future.await
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

data class CodexStatus(val authenticated: Boolean, val planType: String?) {
    override fun toString(): String = super.toString()
}

data class CodexLogin(val authUrl: String) {
    override fun toString(): String = super.toString()
}

interface CodexGateway : Closeable {
    suspend fun status(): CodexStatus

    suspend fun beginLogin(): CodexLogin

    suspend fun stream(
        threadId: String?,
        prompt: String,
        onThreadId: suspend (String) -> Unit,
        onText: suspend (String) -> Unit,
    )
}

class CodexAppServer(
    private val executable: String = System.getenv("CODEX_BIN") ?: "codex",
    private val workingDirectory: String = System.getenv("AI_ADVENT_V3_CWD") ?: System.getProperty("user.dir"),
) : CodexGateway {
    private val json = Json { ignoreUnknownKeys = true }
    private val ids = AtomicLong()
    private val pending = ConcurrentHashMap<Long, CompletableFuture<JsonObject>>()
    private val listeners = ConcurrentHashMap<String, Channel<JsonObject>>()
    private val writeLock = Any()
    private val startLock = Mutex()
    private lateinit var process: Process
    private lateinit var writer: BufferedWriter
    private var initialized = false

    override suspend fun status(): CodexStatus {
        ensureStarted()
        val response = request("account/read", buildJsonObject {})
        val account = response["account"]?.jsonObject
        return CodexStatus(
            authenticated = account?.get("type")?.jsonPrimitive?.content == "chatgpt",
            planType = account?.get("planType")?.jsonPrimitive?.contentOrNull,
        )
    }

    override suspend fun beginLogin(): CodexLogin {
        ensureStarted()
        val response = request(
            "account/login/start",
            buildJsonObject {
                put("type", "chatgpt")
                put("useHostedLoginSuccessPage", true)
                put("appBrand", "chatgpt")
            },
        )
        val authUrl = response["authUrl"]?.jsonPrimitive?.content
            ?: error("Codex did not return a ChatGPT login URL")
        return CodexLogin(authUrl)
    }

    override suspend fun stream(
        threadId: String?,
        prompt: String,
        onThreadId: suspend (String) -> Unit,
        onText: suspend (String) -> Unit,
    ) {
        ensureStarted()
        val threadMethod = if (threadId == null) "thread/start" else "thread/resume"
        val threadParams = buildJsonObject {
            if (threadId != null) put("threadId", threadId)
            put("cwd", workingDirectory)
            put("approvalPolicy", "on-request")
            put("sandbox", "read-only")
            put("serviceName", "ai-advent-v3")
        }
        val thread = request(threadMethod, threadParams)
            .getValue("thread").jsonObject.getValue("id").jsonPrimitive.content
        onThreadId(thread)

        val events = Channel<JsonObject>(Channel.UNLIMITED)
        check(listeners.putIfAbsent(thread, events) == null) { "Codex thread already has an active run" }
        try {
            request(
                "turn/start",
                buildJsonObject {
                    put("threadId", thread)
                    put("cwd", workingDirectory)
                    put("approvalPolicy", "on-request")
                    put("sandboxPolicy", buildJsonObject { put("type", "readOnly") })
                    put("input", kotlinx.serialization.json.buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", prompt)
                        })
                    })
                },
            )

            for (event in events) {
                when (event["method"]?.jsonPrimitive?.content) {
                    "item/agentMessage/delta" -> {
                        val delta = event["params"]?.jsonObject?.get("delta")?.jsonPrimitive?.content
                        if (!delta.isNullOrEmpty()) onText(delta)
                    }
                    "turn/completed" -> {
                        val status = event["params"]?.jsonObject?.get("turn")?.jsonObject
                            ?.get("status")?.jsonPrimitive?.content
                        check(status == "completed") { "Codex turn did not complete successfully" }
                        return
                    }
                }
            }
            error("Codex event stream closed before the turn completed")
        } finally {
            listeners.remove(thread, events)
            events.close()
        }
    }

    private suspend fun ensureStarted() {
        startLock.withLock {
            if (initialized && ::process.isInitialized && process.isAlive) return
            process = ProcessBuilder(executable, "app-server", "--stdio")
                .directory(java.io.File(workingDirectory))
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            writer = BufferedWriter(OutputStreamWriter(process.outputStream, Charsets.UTF_8))
            val reader = BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8))
            thread(name = "codex-app-server-reader", isDaemon = true) {
                try {
                    while (true) {
                        val line = reader.readLine() ?: break
                        val message = json.parseToJsonElement(line).jsonObject
                        val id = message["id"]?.jsonPrimitive?.longOrNull
                        val method = message["method"]?.jsonPrimitive?.contentOrNull
                        if (method != null && id != null) {
                            rejectServerRequest(id, method)
                        } else if (id != null) {
                            pending.remove(id)?.complete(message)
                        } else {
                            dispatchNotification(message)
                        }
                    }
                } catch (_: Exception) {
                    // A closed process completes pending RPCs through their timeouts.
                } finally {
                    pending.values.forEach { it.completeExceptionally(IllegalStateException("Codex app-server stopped")) }
                    pending.clear()
                }
            }
        }
        request(
            "initialize",
            buildJsonObject {
                put("clientInfo", buildJsonObject {
                    put("name", "local_workspace_v3")
                    put("title", "Local Workspace v3")
                    put("version", "0.1.0")
                })
            },
        )
        notify("initialized", buildJsonObject {})
        initialized = true
    }

    private suspend fun request(method: String, params: JsonObject): JsonObject {
        val id = ids.incrementAndGet()
        val result = CompletableFuture<JsonObject>()
        pending[id] = result
        write(buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        })
        val response = withTimeout(30_000) { result.await() }
        response["error"]?.jsonObject?.let { throw IllegalStateException("Codex app-server request failed") }
        return response["result"]?.jsonObject ?: buildJsonObject {}
    }

    private fun notify(method: String, params: JsonObject) {
        write(buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", method)
            put("params", params)
        })
    }

    private fun write(message: JsonObject) {
        synchronized(writeLock) {
            writer.write(json.encodeToString(JsonObject.serializer(), message))
            writer.newLine()
            writer.flush()
        }
    }

    private fun dispatchNotification(message: JsonObject) {
        val method = message["method"]?.jsonPrimitive?.content ?: return
        if (method.startsWith("item/") && method.endsWith("requestApproval")) {
            val id = message["id"]
            if (id != null) {
                write(buildJsonObject {
                    put("jsonrpc", "2.0")
                    put("id", id)
                    put("result", buildJsonObject { put("decision", "decline") })
                })
            }
            return
        }
        val threadId = message["params"]?.jsonObject?.get("threadId")?.jsonPrimitive?.content
        if (threadId != null) listeners[threadId]?.trySendBlocking(message)
    }

    private fun rejectServerRequest(id: Long, method: String) {
        val response = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            when {
                method == "item/permissions/requestApproval" -> put("result", buildJsonObject {
                    put("permissions", kotlinx.serialization.json.buildJsonArray {})
                })
                method == "mcpServer/elicitation/request" -> put("result", buildJsonObject {
                    put("action", "decline")
                    put("content", kotlinx.serialization.json.JsonNull)
                })
                method.startsWith("item/") && method.endsWith("requestApproval") -> put("result", buildJsonObject {
                    put("decision", "decline")
                })
                else -> put("error", buildJsonObject {
                    put("code", -32000)
                    put("message", "Local workspace does not execute Codex side effects")
                })
            }
        }
        write(response)
    }

    override fun close() {
        if (::process.isInitialized) process.destroy()
    }
}
