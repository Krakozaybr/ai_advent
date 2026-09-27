package ai.advent.v3

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID

/** Locates one independent SQLite database per board, while retaining the original database in place. */
class WorkspaceStore(private val originalFile: Path) : Closeable {
    private val lock = Any()
    private val boardsDirectory = originalFile.toAbsolutePath().parent.resolve("boards")
    private val stores = linkedMapOf<String, BoardStore>()

    init {
        Files.createDirectories(boardsDirectory)
        openBoard(originalFile, "Доска 1")
        Files.list(boardsDirectory).use { paths ->
            paths.filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".sqlite") }
                .sorted()
                .forEach { openBoard(it, "Доска ${stores.size + 1}") }
        }
    }

    fun boards(): JsonArray = synchronized(lock) {
        JsonArray(stores.values.map { it.board()["board"]!!.jsonObject })
    }

    fun board(boardId: String): JsonObject = synchronized(lock) {
        store(boardId).board()
    }

    fun createBoard(): JsonObject = synchronized(lock) {
        val path = boardsDirectory.resolve("${UUID.randomUUID()}.sqlite")
        openBoard(path, "Доска ${stores.size + 1}").board()
    }

    fun importPreparedBoard(imported: ImportedBoard): Pair<JsonObject, Boolean> = synchronized(lock) {
        stores.values.firstNotNullOfOrNull { it.findBoardByExternalId(imported.externalId) }?.let { return@synchronized store(it).board() to true }
        val temp = boardsDirectory.resolve(".import-${UUID.randomUUID()}.tmp")
        val finalPath = boardsDirectory.resolve("${UUID.randomUUID()}.sqlite")
        try {
            val staged = BoardStore(temp, imported.title, createDefaultLane = false)
            staged.importPreparedBoard(imported.externalId, imported.title, imported.lanes, imported.agents)
            staged.checkpointForMove()
            staged.close()
            Files.move(temp, finalPath, StandardCopyOption.ATOMIC_MOVE)
            val ready = BoardStore(finalPath, imported.title, createDefaultLane = false)
            val id = ready.board()["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
            stores[id] = ready
            ready.board() to false
        } catch (error: Exception) {
            Files.deleteIfExists(temp)
            Files.deleteIfExists(Path.of("$temp-wal"))
            Files.deleteIfExists(Path.of("$temp-shm"))
            Files.deleteIfExists(finalPath)
            throw error
        }
    }

    fun createLane(boardId: String, provider: String = "codex"): JsonObject = synchronized(lock) {
        val boardStore = store(boardId)
        boardStore.createLane(provider)
        boardStore.board()
    }

    fun updateLaneConfig(
        laneId: String, model: String, temperature: Double?, maxTokens: Int?, stop: String?,
        contextStrategy: String, contextWindowSize: Int, contextBudgetTokens: Int,
    ): JsonObject = synchronized(lock) {
        storeForLane(laneId).also {
            it.updateLaneConfig(laneId, model, temperature, maxTokens, stop, contextStrategy, contextWindowSize, contextBudgetTokens)
        }.board()
    }

    fun saveContextSummary(
        laneId: String, summary: String, watermark: String?, usageSource: String?, usage: kotlinx.serialization.json.JsonObject?, expectedFingerprint: String,
    ): Boolean = synchronized(lock) {
        storeForLane(laneId).saveContextSummary(laneId, summary, watermark, usageSource, usage, expectedFingerprint)
    }

    fun contextSnapshot(laneId: String): TranscriptSnapshot = synchronized(lock) { storeForLane(laneId).transcriptSnapshot(laneId) }

    fun laneSnapshot(laneId: String): JsonObject = synchronized(lock) {
        storeForLane(laneId).board()["lanes"]!!.let { it as JsonArray }
            .map { it.jsonObject }.first { it["id"]?.jsonPrimitive?.content == laneId }
    }
    fun boardForLane(laneId: String): JsonObject = synchronized(lock) { storeForLane(laneId).board() }

    fun providerForLane(laneId: String): String = storeForLane(laneId).providerForLane(laneId)
    fun laneDatabasePath(laneId: String): String = storeForLane(laneId).laneDatabasePath()
    fun setMcpAutoApprove(laneId: String, enabled: Boolean): JsonObject = synchronized(lock) {
        storeForLane(laneId).also { it.setMcpAutoApprove(laneId, enabled) }.board()
    }
    fun addMcpApproval(laneId: String, serverId: String, toolName: String, arguments: JsonObject, reason: String, source: String?): String =
        storeForLane(laneId).addMcpApproval(laneId, serverId, toolName, arguments, reason, source)
    fun approval(laneId: String, approvalId: String): JsonObject? = storeForLane(laneId).approval(laneId, approvalId)
    fun claimApproval(laneId: String, approvalId: String): JsonObject? = storeForLane(laneId).claimApproval(laneId, approvalId)
    fun finishApproval(laneId: String, approvalId: String, status: String, source: String? = null) =
        storeForLane(laneId).finishApproval(laneId, approvalId, status, source)
    fun editFact(laneId: String, key: String, value: String?): JsonObject =
        storeForLane(laneId).also { it.editFact(laneId, key, value) }.board()
    fun clearFacts(laneId: String): JsonObject = storeForLane(laneId).also { it.clearFacts(laneId) }.board()

    fun branchLane(laneId: String, messageId: String): JsonObject = synchronized(lock) {
        val boardStore = storeForLane(laneId)
        boardStore.branchLane(laneId, messageId)
        boardStore.board()
    }

    fun cloneLane(laneId: String): JsonObject = synchronized(lock) {
        val boardStore = storeForLane(laneId)
        boardStore.cloneLane(laneId)
        boardStore.board()
    }

    fun editMessage(messageId: String, content: String): JsonObject = synchronized(lock) {
        storeForMessage(messageId).also { it.editMessage(messageId, content) }.board()
    }

    fun deleteMessagesFrom(messageId: String): JsonObject = synchronized(lock) {
        storeForMessage(messageId).also { it.deleteMessagesFrom(messageId) }.board()
    }

    fun copyMessage(sourceLaneId: String, messageId: String, targetLaneId: String): JsonObject = synchronized(lock) {
        val source = storeForLane(sourceLaneId)
        val target = storeForLane(targetLaneId)
        check(source === target) { "Messages can only be copied within one board" }
        target.copyMessage(sourceLaneId, messageId, targetLaneId)
        target.board()
    }

    fun saveLayout(laneId: String, x: Int, y: Int, width: Int): JsonObject = synchronized(lock) {
        storeForLane(laneId).also { it.saveLayout(laneId, x, y, width) }.board()
    }

    fun saveMcpTools(laneId: String, tools: List<McpSelection>): JsonObject = synchronized(lock) {
        storeForLane(laneId).also { it.saveMcpTools(laneId, tools) }.board()
    }

    fun mcpTools(laneId: String): List<McpSelection> = storeForLane(laneId).mcpTools(laneId)

    fun startRun(laneId: String, prompt: String, overrides: RequestOverrides = RequestOverrides()): StartedRun = storeForLane(laneId).startRun(laneId, prompt, overrides)
    fun saveThread(laneId: String, threadId: String) = storeForLane(laneId).saveThread(laneId, threadId)
    fun markContextSeeded(laneId: String) = storeForLane(laneId).markContextSeeded(laneId)
    fun markContextSeedFailed(laneId: String) = storeForLane(laneId).markContextSeedFailed(laneId)
    fun appendText(runId: String, delta: String) = storeForRun(runId).appendText(runId, delta)
    fun appendRunEvent(runId: String, type: String, data: JsonObject) = storeForRun(runId).appendRunEvent(runId, type, data)
    fun completeRun(runId: String) = storeForRun(runId).completeRun(runId)
    fun failRun(runId: String, reason: String) = storeForRun(runId).failRun(runId, reason)
    fun cancelRun(runId: String) = storeForRun(runId).cancelRun(runId)
    fun saveTechnicalDetails(runId: String, details: JsonObject) = storeForRun(runId).saveTechnicalDetails(runId, details)
    fun eventsAfter(runId: String, sequence: Long): List<Pair<Long, JsonObject>> =
        storeForRun(runId).eventsAfter(runId, sequence)
    fun isTerminal(runId: String): Boolean = storeForRun(runId).isTerminal(runId)
    fun runExists(runId: String): Boolean = synchronized(lock) { stores.values.any { it.runExists(runId) } }

    private fun openBoard(path: Path, title: String): BoardStore {
        val boardStore = BoardStore(path, title)
        val board = boardStore.board()["board"]!!.jsonObject
        val id = board["id"]!!.jsonPrimitive.content
        stores[id] = boardStore
        return boardStore
    }

    private fun store(boardId: String): BoardStore = stores[boardId]
        ?: throw IllegalStateException("Unknown board")

    private fun storeForLane(laneId: String): BoardStore = synchronized(lock) { stores.values.firstOrNull { candidate ->
        candidate.hasLane(laneId)
    } ?: throw IllegalStateException("Unknown lane") }

    private fun storeForMessage(messageId: String): BoardStore = synchronized(lock) {
        stores.values.firstOrNull { it.hasMessage(messageId) } ?: throw IllegalStateException("Unknown message")
    }

    private fun storeForRun(runId: String): BoardStore = synchronized(lock) { stores.values.firstOrNull { it.runExists(runId) }
        ?: throw IllegalStateException("Unknown run")
    }

    override fun close() = synchronized(lock) { stores.values.forEach(BoardStore::close) }
}
