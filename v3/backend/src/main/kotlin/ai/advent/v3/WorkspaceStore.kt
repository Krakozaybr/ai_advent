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
import java.util.UUID

/** Locates one independent SQLite database per board, while retaining the original database in place. */
class WorkspaceStore(private val originalFile: Path) : Closeable {
    private val lock = Any()
    private val boardsDirectory = originalFile.toAbsolutePath().parent.resolve("boards")
    private val stores = linkedMapOf<String, BoardStore>()

    init {
        Files.createDirectories(boardsDirectory)
        openBoard(originalFile, "Доска 1").renameLegacyBoard()
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

    fun createLane(boardId: String): JsonObject = synchronized(lock) {
        val boardStore = store(boardId)
        boardStore.createLane()
        boardStore.board()
    }

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

    fun startRun(laneId: String, prompt: String): StartedRun = storeForLane(laneId).startRun(laneId, prompt)
    fun saveThread(laneId: String, threadId: String) = storeForLane(laneId).saveThread(laneId, threadId)
    fun markContextSeeded(laneId: String) = storeForLane(laneId).markContextSeeded(laneId)
    fun markContextSeedFailed(laneId: String) = storeForLane(laneId).markContextSeedFailed(laneId)
    fun appendText(runId: String, delta: String) = storeForRun(runId).appendText(runId, delta)
    fun completeRun(runId: String) = storeForRun(runId).completeRun(runId)
    fun failRun(runId: String, reason: String) = storeForRun(runId).failRun(runId, reason)
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
