package ai.advent.v3

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.util.concurrent.ConcurrentHashMap

class StaleSummarySnapshotException : IllegalStateException("История изменилась во время создания сводки. Результат не сохранён; создай сводку заново.")

class RunCoordinator(
    private val store: WorkspaceStore,
    private val codex: CodexGateway,
    private val openRouter: OpenRouterGateway,
    private val openRouterKeys: OpenRouterKeyStore,
    private val mcpRegistry: McpRegistry = McpRegistry(),
    private val mcpClient: McpClient = McpClient(),
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val laneLocks = ConcurrentHashMap<String, Mutex>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val threadIds = ConcurrentHashMap<String, String>()
    private val providers = ConcurrentHashMap<String, String>()

    suspend fun generateSummary(laneId: String): JsonObject {
        val laneLock = laneLocks.computeIfAbsent(laneId) { Mutex() }
        if (!laneLock.tryLock()) throw ActiveRunException()
        try {
            return generateSummaryLocked(laneId)
        } finally {
            laneLock.unlock()
        }
    }

    private suspend fun generateSummaryLocked(laneId: String): JsonObject {
        val snapshot = store.contextSnapshot(laneId)
        val lane = store.laneSnapshot(laneId)
        require(lane["activeRun"] == kotlinx.serialization.json.JsonNull) { "Дождись завершения ответа перед созданием сводки." }
        val provider = lane["provider"]?.jsonPrimitive?.content ?: "codex"
        val model = lane["model"]?.jsonPrimitive?.content.orEmpty()
        val requestPrompt = "Составь краткую фактическую сводку диалога для продолжения разговора. Сохрани цели, решения, факты и открытые вопросы; не добавляй предположений. Верни только сводку."
        val summary = StringBuilder()
        val usage: JsonObject?
        if (provider == "openrouter") {
            val details = openRouter.stream(openRouterKeys.get(), LaneConfig("openrouter", model, 0.2, 2048, null), snapshot.messages, requestPrompt) { summary.append(it) }
            usage = details["usage"] as? JsonObject
        } else {
            var actualUsage: JsonObject? = null
            codex.stream(
                threadId = null,
                prompt = requestPrompt,
                contextToSeed = snapshot.messages,
                shouldSeedContext = true,
                model = model,
                onThreadId = {},
                onContextSeeded = {},
                onContextSeedFailed = {},
                onText = { summary.append(it) },
                ephemeral = true,
                onUsage = { actualUsage = it },
            )
            usage = actualUsage
        }
        require(summary.isNotBlank()) { "Провайдер вернул пустую сводку." }
        val usageSource = if (usage == null) "unavailable" else if (provider == "codex") "codex-app-server" else "openrouter"
        val saved = store.saveContextSummary(laneId, summary.toString().trim(), snapshot.watermark, usageSource, usage, snapshot.fingerprint)
        if (!saved) throw StaleSummarySnapshotException()
        return buildJsonObject {
            put("summary", summary.toString().trim())
            snapshot.watermark?.let { put("watermark", it) }
            put("provider", provider)
            put("usageSource", usageSource)
            usage?.let { put("usage", it) }
        }
    }

    suspend fun submit(laneId: String, prompt: String, overrides: RequestOverrides = RequestOverrides()): String {
        val laneLock = laneLocks.computeIfAbsent(laneId) { Mutex() }
        if (!laneLock.tryLock()) throw ActiveRunException()
        var jobStarted = false
        try {
            val apiKey = openRouterKeys.get()
            val run = store.startRun(laneId, prompt, overrides)
            providers[run.runId] = run.config.provider
            run.threadId?.let { threadIds[run.runId] = it }
            val job = scope.launch {
                val startedAt = System.nanoTime()
                try {
                    val details = if (run.config.provider == "openrouter") {
                        val details = if (run.mcpTools.isEmpty()) {
                            openRouter.stream(apiKey, run.config, run.contextPlan.messages, prompt) { store.appendText(run.runId, it) }
                        } else {
                            runOpenRouterWithTools(run, apiKey, prompt)
                        }
                        kotlinx.serialization.json.buildJsonObject {
                            details.forEach { (key, value) -> put(key, value) }
                            put("contextPlan", run.contextPlan.toJson())
                        }
                    } else {
                        var actualUsage: kotlinx.serialization.json.JsonObject? = null
                        codex.stream(
                            threadId = run.threadId,
                            prompt = prompt,
                            contextToSeed = run.contextToSeed,
                            shouldSeedContext = run.shouldSeedContext,
                            model = run.config.model,
                            ephemeral = run.contextStrategy != ContextStrategy.FULL,
                            onThreadId = {
                                threadIds[run.runId] = it
                                if (run.contextStrategy == ContextStrategy.FULL) store.saveThread(laneId, it)
                            },
                            onContextSeeded = { store.markContextSeeded(laneId) },
                            onContextSeedFailed = { store.markContextSeedFailed(laneId) },
                            onText = { store.appendText(run.runId, it) },
                            onUsage = { actualUsage = it },
                        )
                        kotlinx.serialization.json.buildJsonObject {
                            put("provider", "codex")
                            put("model", run.config.model.ifBlank { "Codex configured default" })
                            put("durationMs", (System.nanoTime() - startedAt) / 1_000_000)
                            put("contextPlan", run.contextPlan.toJson())
                            put("tokenUsageSource", if (actualUsage == null) "unavailable" else "codex-app-server")
                            actualUsage?.let { put("usage", it) }
                        }
                    }
                    store.saveTechnicalDetails(run.runId, details)
                    store.completeRun(run.runId)
                } catch (error: CancellationException) {
                    store.cancelRun(run.runId)
                    throw error
                } catch (error: Exception) {
                    val message = error.message ?: "Ошибка запроса ${run.config.provider}"
                    val safeMessage = if (apiKey.isNotBlank()) message.replace(apiKey, "[скрытый ключ]") else message
                    store.failRun(run.runId, safeMessage)
                } finally {
                    jobs.remove(run.runId)
                    threadIds.remove(run.runId)
                    providers.remove(run.runId)
                    laneLock.unlock()
                }
            }
            jobs[run.runId] = job
            job.invokeOnCompletion { jobs.remove(run.runId, job) }
            jobStarted = true
            return run.runId
        } finally {
            if (!jobStarted) laneLock.unlock()
        }
    }

    private suspend fun runOpenRouterWithTools(run: StartedRun, apiKey: String, prompt: String): JsonObject {
        val definitions = run.mcpTools.mapIndexed { index, selected ->
            val server = mcpRegistry.server(selected.serverId)
            val tool = mcpClient.listTools(server).firstOrNull { it.name == selected.toolName }
                ?: error("Разрешённый инструмент ${selected.serverId}/${selected.toolName} больше не зарегистрирован.")
            Triple(selected, tool, buildJsonObject {
                put("type", "function")
                put("function", buildJsonObject {
                    put("name", "mcp_tool_$index")
                    put("description", "${selected.serverId}/${tool.name}: ${tool.description}")
                    put("parameters", tool.inputSchema)
                })
            })
        }
        require(definitions.size <= MAX_TOOL_CALLS) { "В ленте выбрано слишком много инструментов." }
        val byWireName = definitions.mapIndexed { index, definition -> "mcp_tool_$index" to definition }.toMap()
        val messages = (run.contextPlan.messages + ContextMessage("user", prompt)).map { item ->
            buildJsonObject { put("role", item.role); put("content", item.content) }
        }.toMutableList()
        val wireTools = definitions.map { it.third }
        val toolEvents = mutableListOf<JsonObject>()
        val rounds = mutableListOf<JsonObject>()
        var lastDetails = buildJsonObject {}
        var callCount = 0
        repeat(MAX_TOOL_ROUNDS) {
            val turn = openRouter.toolRound(apiKey, run.config, messages, wireTools) { store.appendText(run.runId, it) }
            rounds += turn.details
            lastDetails = buildJsonObject {
                turn.details.forEach { (key, value) -> put(key, value) }
                put("toolCalls", JsonArray(toolEvents.toList()))
                put("rounds", JsonArray(rounds.toList()))
            }
            messages += turn.message
            val calls = turn.message["tool_calls"]?.jsonArray ?: return lastDetails
            if (calls.isEmpty()) return lastDetails
            for (callElement in calls) {
                if (++callCount > MAX_TOOL_CALLS) error("Превышен предел вызовов инструмента ($MAX_TOOL_CALLS).")
                val call = callElement.jsonObject
                val callId = call["id"]?.jsonPrimitive?.contentOrNull ?: ""
                val function = call["function"]?.jsonObject ?: buildJsonObject {}
                val wireName = function["name"]?.jsonPrimitive?.contentOrNull.orEmpty()
                val rawArgs = function["arguments"]?.jsonPrimitive?.contentOrNull ?: "{}"
                val selectedDefinition = byWireName[wireName]
                val parsedArgs = runCatching { Json.parseToJsonElement(rawArgs) as? JsonObject }.getOrNull()
                val eventData = buildJsonObject {
                    put("toolName", selectedDefinition?.second?.name ?: wireName)
                    put("serverId", selectedDefinition?.first?.serverId ?: "")
                    put("modelToolName", wireName)
                    put("arguments", parsedArgs ?: JsonNull)
                }
                store.appendRunEvent(run.runId, "tool.started", eventData)
                toolEvents += buildJsonObject { eventData.forEach { (key, value) -> put(key, value) }; put("status", "running") }
                val outcome = runCatching {
                    require(selectedDefinition != null) { "Модель запросила неизвестный или неразрешённый инструмент." }
                    require(rawArgs.length <= MAX_TOOL_ARGUMENT_LENGTH) { "Аргументы инструмента слишком велики." }
                    require(parsedArgs != null) { "Аргументы инструмента должны быть JSON-объектом." }
                    McpClient.validateSchema(parsedArgs, selectedDefinition.second.inputSchema)
                    mcpClient.call(mcpRegistry.server(selectedDefinition.first.serverId), selectedDefinition.second.name, parsedArgs).also {
                        require(it.toString().length <= MAX_TOOL_RESULT_LENGTH) { "Результат инструмента слишком велик." }
                    }
                }
                val resultMessage = if (outcome.isSuccess) {
                    val result = outcome.getOrThrow()
                    store.appendRunEvent(run.runId, "tool.completed", buildJsonObject {
                        eventData.forEach { (key, value) -> put(key, value) }
                        put("result", result); put("ok", true)
                    })
                    toolEvents[toolEvents.lastIndex] = buildJsonObject {
                        eventData.forEach { (key, value) -> put(key, value) }; put("ok", true); put("result", result)
                    }
                    result.toString()
                } else {
                    val failure = outcome.exceptionOrNull()?.message ?: "Инструмент завершился ошибкой."
                    store.appendRunEvent(run.runId, "tool.completed", buildJsonObject {
                        eventData.forEach { (key, value) -> put(key, value) }
                        put("error", failure); put("ok", false)
                    })
                    toolEvents[toolEvents.lastIndex] = buildJsonObject {
                        eventData.forEach { (key, value) -> put(key, value) }; put("ok", false); put("error", failure)
                    }
                    "Tool error: $failure"
                }
                messages += buildJsonObject {
                    put("role", "tool"); put("tool_call_id", callId); put("content", resultMessage)
                }
            }
        }
        error("Превышен предел раундов вызова инструментов ($MAX_TOOL_ROUNDS).")
    }

    suspend fun cancel(runId: String): Boolean {
        val job = jobs[runId] ?: return false
        if (job.isCompleted || job.isCancelled) return false
        if (providers[runId] == "codex") {
            threadIds[runId]?.let { threadId -> runCatching { codex.interrupt(threadId) } }
        }
        job.cancel(CancellationException("Cancelled by user"))
        return true
    }

    override fun close() {
        scope.cancel()
        jobs.values.forEach { it.cancel() }
        codex.close()
        openRouter.close()
        store.close()
    }
}

private const val MAX_TOOL_ROUNDS = 3
private const val MAX_TOOL_CALLS = 5
private const val MAX_TOOL_ARGUMENT_LENGTH = 64_000
private const val MAX_TOOL_RESULT_LENGTH = 100_000
