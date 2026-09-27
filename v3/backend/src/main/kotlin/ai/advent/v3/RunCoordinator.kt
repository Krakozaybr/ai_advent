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
                        openRouter.stream(apiKey, run.config, run.contextToSeed, prompt) { store.appendText(run.runId, it) }
                    } else {
                        codex.stream(
                            threadId = run.threadId,
                            prompt = prompt,
                            contextToSeed = run.contextToSeed,
                            shouldSeedContext = run.shouldSeedContext,
                            model = run.config.model,
                            onThreadId = {
                                threadIds[run.runId] = it
                                store.saveThread(laneId, it)
                            },
                            onContextSeeded = { store.markContextSeeded(laneId) },
                            onContextSeedFailed = { store.markContextSeedFailed(laneId) },
                            onText = { store.appendText(run.runId, it) },
                        )
                        kotlinx.serialization.json.buildJsonObject {
                            put("provider", "codex")
                            put("model", run.config.model.ifBlank { "Codex configured default" })
                            put("durationMs", (System.nanoTime() - startedAt) / 1_000_000)
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
