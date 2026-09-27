package ai.advent.v3

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.ConcurrentHashMap

class RunCoordinator(
    private val store: WorkspaceStore,
    private val codex: CodexGateway,
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val laneLocks = ConcurrentHashMap<String, Mutex>()
    private val jobs = ConcurrentHashMap<String, Job>()

    suspend fun submit(laneId: String, prompt: String): String {
        val laneLock = laneLocks.computeIfAbsent(laneId) { Mutex() }
        if (!laneLock.tryLock()) throw ActiveRunException()
        var jobStarted = false
        try {
            val run = store.startRun(laneId, prompt)
            val job = scope.launch {
                try {
                    codex.stream(
                        threadId = run.threadId,
                        prompt = prompt,
                        contextToSeed = run.contextToSeed,
                        shouldSeedContext = run.shouldSeedContext,
                        onThreadId = { store.saveThread(laneId, it) },
                        onContextSeeded = { store.markContextSeeded(laneId) },
                        onContextSeedFailed = { store.markContextSeedFailed(laneId) },
                        onText = { store.appendText(run.runId, it) },
                    )
                    store.completeRun(run.runId)
                } catch (error: Exception) {
                    store.failRun(run.runId, error.message ?: "Ошибка запроса Codex")
                } finally {
                    jobs.remove(run.runId)
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

    override fun close() {
        scope.cancel()
        jobs.values.forEach { it.cancel() }
        codex.close()
        store.close()
    }
}
