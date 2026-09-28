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
    private val memoryStore: MemoryStore? = null,
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val laneLocks = ConcurrentHashMap<String, Mutex>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val threadIds = ConcurrentHashMap<String, String>()
    private val codexRunByThread = ConcurrentHashMap<String, String>()
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
        val windowSize = lane["contextWindowSize"]?.jsonPrimitive?.intOrNull ?: 10
        val summarizedMessages = snapshot.messages.dropLast(windowSize)
        require(summarizedMessages.isNotEmpty()) { "Недостаточно истории: сводка должна покрывать сообщения до последних $windowSize." }
        val summaryWatermark = summarizedMessages.last().id
        val provider = lane["provider"]?.jsonPrimitive?.content ?: "codex"
        val model = lane["model"]?.jsonPrimitive?.content.orEmpty()
        val instructions = lane["effectiveInstructions"]?.jsonPrimitive?.content.orEmpty()
        val requestPrompt = "Составь краткую фактическую сводку диалога для продолжения разговора. Сохрани цели, решения, факты и открытые вопросы; не добавляй предположений. Верни только сводку."
        val summary = StringBuilder()
        val usage: JsonObject?
        if (provider == "openrouter") {
            val details = openRouter.stream(openRouterKeys.get(), LaneConfig("openrouter", model, 0.2, 2048, null), summarizedMessages, requestPrompt, { summary.append(it) }, instructions)
            usage = details["usage"] as? JsonObject
        } else {
            var actualUsage: JsonObject? = null
            codex.stream(
                threadId = null,
                prompt = requestPrompt,
                contextToSeed = summarizedMessages,
                shouldSeedContext = true,
                model = model,
                onThreadId = {},
                onContextSeeded = {},
                onContextSeedFailed = {},
                onText = { summary.append(it) },
                ephemeral = true,
                onUsage = { actualUsage = it },
                developerInstructions = instructions,
            )
            usage = actualUsage
        }
        require(summary.isNotBlank()) { "Провайдер вернул пустую сводку." }
        val usageSource = if (usage == null) "unavailable" else if (provider == "codex") "codex-app-server" else "openrouter"
        val saved = store.saveContextSummary(laneId, summary.toString().trim(), summaryWatermark, usageSource, usage, snapshot.fingerprint)
        if (!saved) throw StaleSummarySnapshotException()
        return buildJsonObject {
            put("summary", summary.toString().trim())
            summaryWatermark?.let { put("watermark", it) }
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
            launchRun(run, apiKey, laneLock)
            jobStarted = true
            return run.runId
        } finally {
            if (!jobStarted) laneLock.unlock()
        }
    }

    fun enqueue(laneId: String, prompt: String, overrides: RequestOverrides): String {
        val queuedId = store.enqueueMessage(laneId, prompt, overrides)
        scope.launch { drainQueue(laneId) }
        return queuedId
    }

    suspend fun spawnSubagent(parentRunId: String, title: String, task: String): JsonObject {
        val child = store.createSubagentLane(parentRunId, title, task)
        val runId = submit(child.laneId, task)
        return buildJsonObject {
            put("ok", true)
            put("laneId", child.laneId)
            put("title", child.title)
            put("launchOrder", child.launchOrder)
            put("runId", runId)
            put("status", "active")
        }
    }

    suspend fun spawnSubagentFromCodex(threadId: String, title: String, task: String): JsonObject {
        val parentRunId = codexRunByThread[threadId] ?: error("Не найден активный запуск Codex для вызова spawn_subagent.")
        val eventData = buildJsonObject {
            put("toolName", "spawn_subagent")
            put("serverId", "ai-advent-subagents")
            put("arguments", buildJsonObject { put("title", title); put("task", task) })
        }
        store.appendRunEvent(parentRunId, "tool.started", eventData)
        return try {
            val result = spawnSubagent(parentRunId, title, task)
            store.appendRunEvent(parentRunId, "tool.completed", buildJsonObject {
                eventData.forEach { (key, value) -> put(key, value) }
                put("result", result); put("ok", true)
            })
            result
        } catch (error: Exception) {
            store.appendRunEvent(parentRunId, "tool.completed", buildJsonObject {
                eventData.forEach { (key, value) -> put(key, value) }
                put("error", error.message ?: "Не удалось запустить сабагента."); put("ok", false)
            })
            throw error
        }
    }

    fun resumeQueuedMessages() {
        store.queuedLaneIds().forEach { laneId -> scope.launch { drainQueue(laneId) } }
    }

    private suspend fun drainQueue(laneId: String) {
        val laneLock = laneLocks.computeIfAbsent(laneId) { Mutex() }
        if (!laneLock.tryLock()) return
        var jobStarted = false
        try {
            var run: StartedRun? = null
            while (run == null) {
                try {
                    run = store.startNextQueuedRun(laneId)
                    if (run == null) return
                } catch (_: ActiveRunException) {
                    return
                } catch (error: Exception) {
                    if (!store.failNextQueuedMessage(laneId, error.message ?: "Не удалось запустить запрос из очереди.")) return
                }
            }
            launchRun(run, openRouterKeys.get(), laneLock)
            jobStarted = true
        } finally {
            if (!jobStarted) laneLock.unlock()
        }
    }

    private fun launchRun(run: StartedRun, apiKey: String, laneLock: Mutex) {
        val laneId = run.laneId
        providers[run.runId] = run.config.provider
        run.threadId?.let { threadIds[run.runId] = it }
        val job = scope.launch {
                val startedAt = System.nanoTime()
                try {
                    val details = if (run.config.provider == "openrouter") {
                        val details = if (run.mcpTools.isEmpty() && !store.canSpawnSubagents(run.laneId)) {
                            openRouter.stream(apiKey, run.config, run.contextPlan.messages, run.prompt, { store.appendText(run.runId, it) }, run.effectiveInstructions)
                        } else {
                            runOpenRouterWithTools(run, apiKey, run.prompt)
                        }
                        kotlinx.serialization.json.buildJsonObject {
                            details.forEach { (key, value) -> put(key, value) }
                            put("contextPlan", run.contextPlan.toJson())
                        }
                    } else {
                        var actualUsage: kotlinx.serialization.json.JsonObject? = null
                        codex.stream(
                            threadId = run.threadId,
                            prompt = run.prompt,
                            contextToSeed = run.contextToSeed,
                            shouldSeedContext = run.shouldSeedContext,
                            model = run.config.model,
                            effort = run.config.effort,
                            serviceTier = run.config.serviceTier,
                            ephemeral = run.contextStrategy != ContextStrategy.FULL,
                            onThreadId = {
                                threadIds[run.runId] = it
                                codexRunByThread[it] = run.runId
                                if (run.contextStrategy == ContextStrategy.FULL) store.saveThread(laneId, it)
                            },
                            onContextSeeded = { store.markContextSeeded(laneId) },
                            onContextSeedFailed = { store.markContextSeedFailed(laneId) },
                            onText = { store.appendText(run.runId, it) },
                            onUsage = { actualUsage = it },
                            developerInstructions = run.effectiveInstructions,
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
                    val technicalDetails = buildJsonObject {
                        details.forEach { (key, value) -> put(key, value) }
                        put("instructionPlan", buildJsonObject {
                            put("effectiveInstructions", run.effectiveInstructions)
                            put("priority", "Доска задаёт общий контекст; агент уточняет роль; инструкции ленты имеют приоритет. Режим override заменяет инструкции доски, но не назначенного агента.")
                        })
                    }
                    store.saveTechnicalDetails(run.runId, technicalDetails)
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
                    threadIds.remove(run.runId)?.let { codexRunByThread.remove(it, run.runId) }
                    providers.remove(run.runId)
                    laneLock.unlock()
                    scope.launch { drainQueue(laneId) }
                }
            }
        jobs[run.runId] = job
        job.invokeOnCompletion { jobs.remove(run.runId, job) }
    }

    private suspend fun runOpenRouterWithTools(run: StartedRun, apiKey: String, prompt: String): JsonObject {
        val definitions = run.mcpTools.mapIndexed { index, selected ->
            val server = scopedServer(selected.serverId, run.laneId)
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
        val spawnDefinition = if (store.canSpawnSubagents(run.laneId)) buildJsonObject {
            put("type", "function")
            put("function", buildJsonObject {
                put("name", "spawn_subagent")
                put("description", "Запустить отдельную дочернюю сессию для независимой параллельной работы. Сабагент получит только указанную задачу и общие инструкции доски. Вызов сразу возвращает id активной сессии, не ожидая её завершения. Не делегируй несвязанные или дублирующие задачи.")
                put("parameters", buildJsonObject {
                    put("type", "object")
                    put("properties", buildJsonObject {
                        put("task", buildJsonObject { put("type", "string"); put("description", "Самостоятельная задача для сабагента, до 6000 символов.") })
                        put("title", buildJsonObject { put("type", "string"); put("description", "Короткое название дочерней сессии.") })
                    })
                    put("required", JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("task"))))
                    put("additionalProperties", false)
                })
            })
        } else null
        val messages = (listOfNotNull(run.effectiveInstructions.takeIf(String::isNotBlank)?.let { ContextMessage("system", it) }) + run.contextPlan.messages + ContextMessage("user", prompt)).map { item ->
            buildJsonObject { put("role", item.role); put("content", item.content) }
        }.toMutableList()
        val wireTools = definitions.map { it.third } + listOfNotNull(spawnDefinition)
        val toolEvents = mutableListOf<JsonObject>()
        val rounds = mutableListOf<JsonObject>()
        var lastDetails = buildJsonObject {}
        var callCount = 0
        var pendingApprovalCreated = false
        var activeTools = wireTools
        repeat(MAX_TOOL_ROUNDS) {
            val turn = openRouter.toolRound(apiKey, run.config, messages, activeTools, { store.appendText(run.runId, it) }, run.effectiveInstructions)
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
                val isSpawnSubagent = wireName == "spawn_subagent" && spawnDefinition != null
                val parsedArgs = runCatching { Json.parseToJsonElement(rawArgs) as? JsonObject }.getOrNull()
                val eventData = buildJsonObject {
                    put("toolName", if (isSpawnSubagent) "spawn_subagent" else selectedDefinition?.second?.name ?: wireName)
                    put("serverId", if (isSpawnSubagent) "ai-advent-subagents" else selectedDefinition?.first?.serverId ?: "")
                    put("modelToolName", wireName)
                    put("arguments", parsedArgs ?: JsonNull)
                }
                store.appendRunEvent(run.runId, "tool.started", eventData)
                toolEvents += buildJsonObject { eventData.forEach { (key, value) -> put(key, value) }; put("status", "running") }
                val outcome = runCatching {
                    require(selectedDefinition != null || isSpawnSubagent) { "Модель запросила неизвестный или неразрешённый инструмент." }
                    require(rawArgs.length <= MAX_TOOL_ARGUMENT_LENGTH) { "Аргументы инструмента слишком велики." }
                    require(parsedArgs != null) { "Аргументы инструмента должны быть JSON-объектом." }
                    if (isSpawnSubagent) {
                        require(parsedArgs.keys.all { it == "task" || it == "title" }) { "Неизвестные поля инструмента spawn_subagent." }
                        val task = parsedArgs["task"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val title = parsedArgs["title"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        require(task.isNotBlank() && task.length <= 6_000) { "Укажи задачу сабагента длиной до 6000 символов." }
                        require(title.length <= 120) { "Название сабагента не должно превышать 120 символов." }
                        return@runCatching spawnSubagent(run.runId, title, task)
                    }
                    requireNotNull(selectedDefinition)
                    McpClient.validateSchema(parsedArgs, selectedDefinition.second.inputSchema)
                    if (selectedDefinition.first.serverId == "board-memory" && selectedDefinition.second.name == "memory_propose_write") {
                        requireNotNull(memoryStore) { "Память доски недоступна." }.validateProposal(
                            store.laneDatabasePath(run.laneId), run.laneId,
                            parsedArgs["layer"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                            parsedArgs["memoryName"]?.jsonPrimitive?.contentOrNull,
                        )
                    }
                    if (!selectedDefinition.second.readOnly && !run.mcpAutoApprove) {
                        val reason = parsedArgs["reason"]?.jsonPrimitive?.contentOrNull ?: "Изменяющий инструмент запрошен моделью."
                        val approvalId = store.addMcpApproval(run.laneId, selectedDefinition.first.serverId,
                            selectedDefinition.second.name, parsedArgs, reason, null)
                        pendingApprovalCreated = true
                        buildJsonObject {
                            put("approvalId", approvalId); put("status", "pending")
                            put("message", "pending approval; действие не выполнено и данные не сохранены")
                        }
                    } else {
                        val approvalId = if (!selectedDefinition.second.readOnly) {
                            val id = store.addMcpApproval(run.laneId, selectedDefinition.first.serverId,
                                selectedDefinition.second.name, parsedArgs, parsedArgs["reason"]?.jsonPrimitive?.contentOrNull ?: "Явное разрешение autoapprove ленты.", "lane-autoapprove")
                            store.claimApproval(run.laneId, id)
                            id
                        } else null
                        try {
                            mcpClient.call(scopedServer(selectedDefinition.first.serverId, run.laneId), selectedDefinition.second.name, parsedArgs).also {
                                approvalId?.let { store.finishApproval(run.laneId, it, "approved", "lane-autoapprove") }
                                require(it.toString().length <= MAX_TOOL_RESULT_LENGTH) { "Результат инструмента слишком велик." }
                            }
                        } catch (error: Exception) {
                            approvalId?.let { store.finishApproval(run.laneId, it, "failed", "lane-autoapprove") }
                            throw error
                        }
                    }.also {
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
                    val cause = outcome.exceptionOrNull()
                    val failure = if (cause is IllegalArgumentException) cause.message ?: "Аргументы инструмента некорректны."
                    else "Не удалось выполнить MCP-инструмент."
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
                if (pendingApprovalCreated) activeTools = emptyList()
            }
        }
        error("Превышен предел раундов вызова инструментов ($MAX_TOOL_ROUNDS).")
    }

    private fun scopedServer(serverId: String, laneId: String): McpServerConfig {
        val server = mcpRegistry.server(serverId)
        if (!isLaneScopedMcpServer(serverId)) return server
        return scopedMcpServer(server, store.laneDatabasePath(laneId), laneId, memoryStore?.databasePath ?: "v3/data/memory.sqlite")
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

private const val MAX_TOOL_ROUNDS = 4
private const val MAX_TOOL_CALLS = 5
private const val MAX_TOOL_ARGUMENT_LENGTH = 64_000
private const val MAX_TOOL_RESULT_LENGTH = 100_000
