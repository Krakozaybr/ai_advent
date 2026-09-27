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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.ConcurrentHashMap

class RunCoordinator(
    private val store: WorkspaceStore,
    private val codex: CodexGateway,
    private val openRouter: OpenRouterGateway,
    private val openRouterKeys: OpenRouterKeyStore,
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
            val details = openRouter.stream(openRouterKeys.get(), LaneConfig("openrouter", model, 0.2, 2048, null), snapshot.first, requestPrompt) { summary.append(it) }
            usage = details["usage"] as? JsonObject
        } else {
            var actualUsage: JsonObject? = null
            codex.stream(
                threadId = null,
                prompt = requestPrompt,
                contextToSeed = snapshot.first,
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
        store.saveContextSummary(laneId, summary.toString().trim(), snapshot.second, usageSource, usage)
        return buildJsonObject {
            put("summary", summary.toString().trim())
            snapshot.second?.let { put("watermark", it) }
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
                        val details = openRouter.stream(apiKey, run.config, run.contextPlan.messages, prompt) { store.appendText(run.runId, it) }
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
