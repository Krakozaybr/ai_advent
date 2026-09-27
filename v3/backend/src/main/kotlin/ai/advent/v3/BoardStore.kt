package ai.advent.v3

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.time.Instant
import java.util.UUID

data class ContextMessage(val role: String, val content: String)

private data class CopyableMessage(
    val id: String,
    val role: String,
    val content: String,
    val runStatus: String?,
    val runStartedAt: String?,
    val runCompletedAt: String?,
    val runError: String?,
)

data class StartedRun(
    val boardId: String,
    val laneId: String,
    val runId: String,
    val threadId: String?,
    val contextToSeed: List<ContextMessage>,
    val shouldSeedContext: Boolean,
) {
    override fun toString(): String = super.toString()
}

class ActiveRunException : IllegalStateException("A request is already running in this lane")

class BoardStore(private val file: Path, private val initialBoardTitle: String = "Доска") : Closeable {
    private val lock = Any()

    init {
        Files.createDirectories(file.toAbsolutePath().parent)
        Class.forName("org.sqlite.JDBC")
        connect().use { db ->
            db.createStatement().use { statement ->
                statement.execute("PRAGMA journal_mode=WAL")
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS boards (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS lanes (
                        id TEXT PRIMARY KEY,
                        board_id TEXT NOT NULL REFERENCES boards(id),
                        title TEXT NOT NULL,
                        codex_thread_id TEXT,
                        created_at TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS messages (
                        id TEXT PRIMARY KEY,
                        lane_id TEXT NOT NULL REFERENCES lanes(id),
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        run_id TEXT,
                        created_at TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS runs (
                        id TEXT PRIMARY KEY,
                        board_id TEXT NOT NULL,
                        lane_id TEXT NOT NULL REFERENCES lanes(id),
                        assistant_message_id TEXT NOT NULL REFERENCES messages(id),
                        status TEXT NOT NULL,
                        started_at TEXT NOT NULL,
                        completed_at TEXT,
                        error TEXT
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS run_events (
                        run_id TEXT NOT NULL REFERENCES runs(id),
                        sequence INTEGER NOT NULL,
                        event_json TEXT NOT NULL,
                        PRIMARY KEY (run_id, sequence)
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS one_running_run_per_lane " +
                        "ON runs(lane_id) WHERE status = 'running'",
                )
            }
            ensureColumn(db, "lanes", "origin_lane_id", "TEXT")
            ensureColumn(db, "lanes", "origin_message_id", "TEXT")
            ensureColumn(db, "lanes", "origin_message_role", "TEXT")
            ensureColumn(db, "lanes", "origin_message_content", "TEXT")
            ensureColumn(db, "lanes", "origin_kind", "TEXT")
            ensureColumn(db, "lanes", "codex_context_seeded", "INTEGER NOT NULL DEFAULT 1")
            ensureColumn(db, "lanes", "position_x", "INTEGER")
            ensureColumn(db, "lanes", "position_y", "INTEGER")
            ensureColumn(db, "lanes", "width", "INTEGER")
            backfillLaneLayout(db)
            ensureBoard(db, initialBoardTitle)
            markInterruptedRuns(db)
        }
    }

    fun board(): JsonObject = synchronized(lock) {
        connect().use { db ->
            val board = db.prepareStatement(
                "SELECT id, title FROM boards ORDER BY created_at LIMIT 1",
            ).use { query ->
                query.executeQuery().use { result ->
                    check(result.next()) { "Board has not been initialized" }
                    buildJsonObject {
                        put("id", result.getString("id"))
                        put("title", result.getString("title"))
                    }
                }
            }
            val lanes = mutableListOf<JsonObject>()
            db.prepareStatement(
                "SELECT id, title, codex_thread_id, origin_lane_id, origin_message_id, origin_kind, " +
                    "origin_message_role, origin_message_content, " +
                    "position_x, position_y, width " +
                    "FROM lanes WHERE board_id = ? ORDER BY created_at, rowid",
            ).use { query ->
                query.setString(1, board["id"]!!.jsonPrimitive.content)
                query.executeQuery().use { result ->
                    while (result.next()) {
                        val laneId = result.getString("id")
                        lanes += buildJsonObject {
                            put("id", laneId)
                            put("title", result.getString("title"))
                            put("x", result.getInt("position_x").takeUnless { result.wasNull() } ?: 24)
                            put("y", result.getInt("position_y").takeUnless { result.wasNull() } ?: 24)
                            put("width", result.getInt("width").takeUnless { result.wasNull() } ?: 440)
                            result.getString("codex_thread_id")?.let { put("codexThreadId", it) }
                            result.getString("origin_lane_id")?.let { put("originLaneId", it) }
                            result.getString("origin_message_id")?.let { put("originMessageId", it) }
                            result.getString("origin_kind")?.let { put("originKind", it) }
                            result.getString("origin_lane_id")?.let { originLaneId ->
                                val originMessageId = result.getString("origin_message_id")
                                if (originMessageId != null) {
                                    val snapshotRole = result.getString("origin_message_role")
                                    val snapshotContent = result.getString("origin_message_content")
                                    val snapshot = if (snapshotRole != null && snapshotContent != null) {
                                        buildJsonObject {
                                            put("id", originMessageId)
                                            put("role", snapshotRole)
                                            put("content", snapshotContent)
                                        }
                                    } else {
                                        message(db, originLaneId, originMessageId)
                                    }
                                    put("originMessage", snapshot ?: JsonNull)
                                }
                            }
                            put("messages", messages(db, laneId))
                            put("activeRun", activeRun(db, laneId) ?: JsonNull)
                        }
                    }
                }
            }
            buildJsonObject {
                put("board", board)
                put("lanes", kotlinx.serialization.json.JsonArray(lanes))
            }
        }
    }

    fun createLane(): String = synchronized(lock) {
        connect().use { db ->
            val boardId = db.createStatement().use { statement ->
                statement.executeQuery("SELECT id FROM boards LIMIT 1").use { result ->
                    check(result.next()) { "Board has not been initialized" }
                    result.getString("id")
                }
            }
            val count = db.prepareStatement("SELECT COUNT(*) FROM lanes WHERE board_id = ?").use { query ->
                query.setString(1, boardId)
                query.executeQuery().use { result -> result.next(); result.getInt(1) }
            }
            val laneId = UUID.randomUUID().toString()
            db.prepareStatement(
                "INSERT INTO lanes(id, board_id, title, created_at, position_x, position_y, width) VALUES (?, ?, ?, ?, ?, 24, 440)",
            ).use { query ->
                query.setString(1, laneId)
                query.setString(2, boardId)
                query.setString(3, "Лента ${count + 1}")
                query.setString(4, Instant.now().toString())
                query.setInt(5, 24 + count * 460)
                query.executeUpdate()
            }
            laneId
        }
    }

    fun branchLane(sourceLaneId: String, messageId: String): String = synchronized(lock) {
        copyLane(sourceLaneId, messageId, "branch")
    }

    fun cloneLane(sourceLaneId: String): String = synchronized(lock) {
        copyLane(sourceLaneId, null, "clone")
    }

    fun editMessage(messageId: String, content: String) = synchronized(lock) {
        check(!activeRunForMessage(messageId)) { "Cannot edit messages while a request is running" }
        mutateHistoryFrom(messageId) { db, laneId, selectedId ->
            deleteMessagesAfter(db, laneId, selectedId, includeSelected = false)
            db.prepareStatement("UPDATE messages SET content = ? WHERE id = ? AND lane_id = ?").use { query ->
                query.setString(1, content)
                query.setString(2, selectedId)
                query.setString(3, laneId)
                check(query.executeUpdate() == 1) { "Unknown message" }
            }
            resetThread(db, laneId)
        }
    }

    fun deleteMessagesFrom(messageId: String) = synchronized(lock) {
        check(!activeRunForMessage(messageId)) { "Cannot edit messages while a request is running" }
        mutateHistoryFrom(messageId) { db, laneId, selectedId ->
            deleteMessagesAfter(db, laneId, selectedId, includeSelected = true)
            resetThread(db, laneId)
        }
    }

    fun copyMessage(sourceLaneId: String, messageId: String, targetLaneId: String) = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                check(sourceLaneId != targetLaneId) { "Choose another target lane" }
                check(!hasActiveRun(db, sourceLaneId) && !hasActiveRun(db, targetLaneId)) {
                    "Cannot copy messages while a request is running"
                }
                val message = db.prepareStatement(
                    "SELECT role, content FROM messages WHERE id = ? AND lane_id = ?",
                ).use { query ->
                    query.setString(1, messageId)
                    query.setString(2, sourceLaneId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown message" }
                        result.getString("role") to result.getString("content")
                    }
                }
                val laneExists = db.prepareStatement("SELECT 1 FROM lanes WHERE id = ?").use { query ->
                    query.setString(1, targetLaneId)
                    query.executeQuery().use { it.next() }
                }
                check(laneExists) { "Unknown target lane" }
                val copiedMessageId = UUID.randomUUID().toString()
                db.prepareStatement(
                    "INSERT INTO messages(id, lane_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                ).use { query ->
                    query.setString(1, copiedMessageId)
                    query.setString(2, targetLaneId)
                    query.setString(3, message.first)
                    query.setString(4, message.second)
                    query.setString(5, Instant.now().toString())
                    query.executeUpdate()
                }
                resetThread(db, targetLaneId)
                db.commit()
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    fun saveLayout(laneId: String, x: Int, y: Int, width: Int) = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET position_x = ?, position_y = ?, width = ? WHERE id = ?").use { query ->
                query.setInt(1, x)
                query.setInt(2, y)
                query.setInt(3, width)
                query.setString(4, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
    }

    private fun activeRunForMessage(messageId: String): Boolean = connect().use { db ->
        db.prepareStatement(
            "SELECT 1 FROM messages m JOIN runs r ON r.id = m.run_id WHERE m.id = ? AND r.status = 'running'",
        ).use { query ->
            query.setString(1, messageId)
            query.executeQuery().use { it.next() }
        }
    }

    private fun mutateHistoryFrom(messageId: String, mutate: (Connection, String, String) -> Unit) {
        connect().use { db ->
            db.autoCommit = false
            try {
                val laneId = db.prepareStatement("SELECT lane_id FROM messages WHERE id = ?").use { query ->
                    query.setString(1, messageId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown message" }
                        result.getString(1)
                    }
                }
                check(!hasActiveRun(db, laneId)) { "Cannot edit messages while a request is running" }
                mutate(db, laneId, messageId)
                db.commit()
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    private fun resetThread(db: Connection, laneId: String) {
        db.prepareStatement("UPDATE lanes SET codex_thread_id = NULL, codex_context_seeded = 0 WHERE id = ?").use { query ->
            query.setString(1, laneId)
            check(query.executeUpdate() == 1) { "Unknown lane" }
        }
    }

    private fun deleteMessagesAfter(db: Connection, laneId: String, messageId: String, includeSelected: Boolean) {
        val orderedIds = db.prepareStatement(
            "SELECT id, run_id FROM messages WHERE lane_id = ? ORDER BY created_at, rowid",
        ).use { query ->
            query.setString(1, laneId)
            query.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(result.getString("id") to result.getString("run_id"))
                }
            }
        }
        val selectedIndex = orderedIds.indexOfFirst { it.first == messageId }
        check(selectedIndex >= 0) { "Unknown message" }
        val deleteFrom = selectedIndex + if (includeSelected) 0 else 1
        val removed = orderedIds.drop(deleteFrom)
        removed.mapNotNull { it.second }.distinct().forEach { runId ->
            db.prepareStatement("DELETE FROM run_events WHERE run_id = ?").use { query ->
                query.setString(1, runId)
                query.executeUpdate()
            }
            db.prepareStatement("DELETE FROM runs WHERE id = ?").use { query ->
                query.setString(1, runId)
                query.executeUpdate()
            }
        }
        removed.forEach { (id) ->
            db.prepareStatement("DELETE FROM messages WHERE id = ? AND lane_id = ?").use { query ->
                query.setString(1, id)
                query.setString(2, laneId)
                query.executeUpdate()
            }
        }
    }

    private fun copyLane(sourceLaneId: String, throughMessageId: String?, kind: String): String {
        connect().use { db ->
            db.autoCommit = false
            try {
                val source = db.prepareStatement(
                    "SELECT board_id, title FROM lanes WHERE id = ?",
                ).use { query ->
                    query.setString(1, sourceLaneId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown lane" }
                        result.getString("board_id") to result.getString("title")
                    }
                }
                check(!hasActiveRun(db, sourceLaneId)) { "Cannot copy a lane while a request is running" }
                val selectedMessageExists = throughMessageId == null || db.prepareStatement(
                    "SELECT 1 FROM messages WHERE id = ? AND lane_id = ?",
                ).use { query ->
                    query.setString(1, throughMessageId)
                    query.setString(2, sourceLaneId)
                    query.executeQuery().use { it.next() }
                }
                check(selectedMessageExists) { "Unknown message" }
                val originSnapshot = throughMessageId?.let { selectedId ->
                    db.prepareStatement("SELECT role, content FROM messages WHERE id = ? AND lane_id = ?").use { query ->
                        query.setString(1, selectedId)
                        query.setString(2, sourceLaneId)
                        query.executeQuery().use { result ->
                            check(result.next()) { "Unknown message" }
                            result.getString("role") to result.getString("content")
                        }
                    }
                }
                val count = db.prepareStatement("SELECT COUNT(*) FROM lanes WHERE board_id = ?").use { query ->
                    query.setString(1, source.first)
                    query.executeQuery().use { result -> result.next(); result.getInt(1) }
                }
                val laneId = UUID.randomUUID().toString()
                db.prepareStatement(
                    "INSERT INTO lanes(id, board_id, title, created_at, origin_lane_id, origin_message_id, " +
                        "origin_kind, codex_context_seeded, origin_message_role, origin_message_content, " +
                        "position_x, position_y, width) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 24, 440)",
                ).use { query ->
                    query.setString(1, laneId)
                    query.setString(2, source.first)
                    query.setString(3, "${source.second} · ${if (kind == "branch") "ветка" else "клон"} ${count + 1}")
                    query.setString(4, Instant.now().toString())
                    query.setString(5, sourceLaneId)
                    query.setString(6, throughMessageId)
                    query.setString(7, kind)
                    query.setString(8, originSnapshot?.first)
                    query.setString(9, originSnapshot?.second)
                    query.setInt(10, 24 + count * 460)
                    query.executeUpdate()
                }
                val sourceMessages = db.prepareStatement(
                    """SELECT m.id, m.role, m.content, r.status, r.started_at, r.completed_at, r.error
                       FROM messages m LEFT JOIN runs r ON r.id = m.run_id
                       WHERE m.lane_id = ? ORDER BY m.created_at, m.rowid""",
                ).use { query ->
                    query.setString(1, sourceLaneId)
                    query.executeQuery().use { result ->
                        buildList {
                            while (result.next()) {
                                val item = CopyableMessage(
                                    result.getString("id"),
                                    result.getString("role"),
                                    result.getString("content"),
                                    result.getString("status"),
                                    result.getString("started_at"),
                                    result.getString("completed_at"),
                                    result.getString("error"),
                                )
                                add(item)
                                if (item.id == throughMessageId) break
                            }
                        }
                    }
                }
                check(kind != "branch" || sourceMessages.lastOrNull()?.id == throughMessageId) {
                    "Unknown message"
                }
                val now = Instant.now().toString()
                sourceMessages.forEach { item ->
                    val copiedRunId = item.runStatus?.let { UUID.randomUUID().toString() }
                    val copiedMessageId = UUID.randomUUID().toString()
                    db.prepareStatement(
                        "INSERT INTO messages(id, lane_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    ).use { query ->
                        query.setString(1, copiedMessageId)
                        query.setString(2, laneId)
                        query.setString(3, item.role)
                        query.setString(4, item.content)
                        query.setString(5, copiedRunId)
                        query.setString(6, now)
                        query.executeUpdate()
                    }
                    if (copiedRunId != null) {
                        db.prepareStatement(
                            "INSERT INTO runs(id, board_id, lane_id, assistant_message_id, status, started_at, completed_at, error) " +
                                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        ).use { query ->
                            query.setString(1, copiedRunId)
                            query.setString(2, source.first)
                            query.setString(3, laneId)
                            query.setString(4, copiedMessageId)
                            query.setString(5, item.runStatus)
                            query.setString(6, item.runStartedAt)
                            query.setString(7, item.runCompletedAt)
                            query.setString(8, item.runError)
                            query.executeUpdate()
                        }
                    }
                }
                db.commit()
                return laneId
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    fun hasLane(laneId: String): Boolean = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT 1 FROM lanes WHERE id = ?").use { query ->
                query.setString(1, laneId)
                query.executeQuery().use { it.next() }
            }
        }
    }

    fun hasMessage(messageId: String): Boolean = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT 1 FROM messages WHERE id = ?").use { query ->
                query.setString(1, messageId)
                query.executeQuery().use { it.next() }
            }
        }
    }

    fun renameLegacyBoard() = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE boards SET title = 'Доска 1' WHERE title = 'AI Advent'").use { it.executeUpdate() }
        }
    }

    fun startRun(laneId: String, prompt: String): StartedRun = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                val lane = db.prepareStatement(
                    "SELECT board_id, codex_thread_id, codex_context_seeded FROM lanes WHERE id = ?",
                ).use { query ->
                    query.setString(1, laneId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown lane" }
                        Triple(result.getString("board_id"), result.getString("codex_thread_id"), result.getInt("codex_context_seeded") == 0)
                    }
                }
                val isActive = db.prepareStatement(
                    "SELECT 1 FROM runs WHERE lane_id = ? AND status = 'running' LIMIT 1",
                ).use { query ->
                    query.setString(1, laneId)
                    query.executeQuery().use { it.next() }
                }
                if (isActive) throw ActiveRunException()

                val contextToSeed = if (lane.second == null || lane.third) history(db, laneId) else emptyList()
                val reusableThreadId = if (lane.third) null else lane.second

                val now = Instant.now().toString()
                val userMessageId = UUID.randomUUID().toString()
                val answerId = UUID.randomUUID().toString()
                val runId = UUID.randomUUID().toString()
                db.prepareStatement(
                    "INSERT INTO messages(id, lane_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
                ).use { query ->
                    query.setString(1, userMessageId)
                    query.setString(2, laneId)
                    query.setString(3, prompt)
                    query.setString(4, now)
                    query.executeUpdate()
                }
                db.prepareStatement(
                    "INSERT INTO messages(id, lane_id, role, content, run_id, created_at) " +
                        "VALUES (?, ?, 'assistant', '', ?, ?)",
                ).use { query ->
                    query.setString(1, answerId)
                    query.setString(2, laneId)
                    query.setString(3, runId)
                    query.setString(4, now)
                    query.executeUpdate()
                }
                db.prepareStatement(
                    "INSERT INTO runs(id, board_id, lane_id, assistant_message_id, status, started_at) " +
                        "VALUES (?, ?, ?, ?, 'running', ?)",
                ).use { query ->
                    query.setString(1, runId)
                    query.setString(2, lane.first)
                    query.setString(3, laneId)
                    query.setString(4, answerId)
                    query.setString(5, now)
                    query.executeUpdate()
                }
                insertEvent(db, lane.first, laneId, runId, "run.started", buildJsonObject {})
                db.commit()
                StartedRun(
                    lane.first,
                    laneId,
                    runId,
                    reusableThreadId,
                    contextToSeed,
                    shouldSeedContext = reusableThreadId == null || lane.third,
                )
            } catch (error: SQLException) {
                db.rollback()
                if (error.message.orEmpty().contains("one_running_run_per_lane")) throw ActiveRunException()
                throw error
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    fun saveThread(laneId: String, threadId: String) = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET codex_thread_id = ? WHERE id = ?").use { query ->
                query.setString(1, threadId)
                query.setString(2, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
    }

    fun markContextSeeded(laneId: String) = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET codex_context_seeded = 1 WHERE id = ?").use { query ->
                query.setString(1, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
    }

    fun markContextSeedFailed(laneId: String) = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET codex_thread_id = NULL, codex_context_seeded = 0 WHERE id = ?").use { query ->
                query.setString(1, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
    }

    fun appendText(runId: String, delta: String) = synchronized(lock) {
        connect().use { db ->
            val run = runDetails(db, runId)
            db.prepareStatement("UPDATE messages SET content = content || ? WHERE id = ?").use { query ->
                query.setString(1, delta)
                query.setString(2, run.answerMessageId)
                query.executeUpdate()
            }
            insertEvent(db, run.boardId, run.laneId, runId, "text.delta", buildJsonObject { put("text", delta) })
        }
    }

    fun completeRun(runId: String) = finishRun(runId, "completed", null, "run.completed")

    fun failRun(runId: String, reason: String) = finishRun(runId, "failed", reason, "run.failed")

    fun eventsAfter(runId: String, sequence: Long): List<Pair<Long, JsonObject>> = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement(
                "SELECT sequence, event_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
            ).use { query ->
                query.setString(1, runId)
                query.setLong(2, sequence)
                query.executeQuery().use { result ->
                    buildList {
                        while (result.next()) {
                            add(result.getLong("sequence") to kotlinx.serialization.json.Json
                                .parseToJsonElement(result.getString("event_json")).jsonObject)
                        }
                    }
                }
            }
        }
    }

    fun isTerminal(runId: String): Boolean = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT status FROM runs WHERE id = ?").use { query ->
                query.setString(1, runId)
                query.executeQuery().use { result ->
                    !result.next() || result.getString("status") != "running"
                }
            }
        }
    }

    fun runExists(runId: String): Boolean = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT 1 FROM runs WHERE id = ?").use { query ->
                query.setString(1, runId)
                query.executeQuery().use { it.next() }
            }
        }
    }

    private fun history(db: Connection, laneId: String): List<ContextMessage> = db.prepareStatement(
        "SELECT role, content FROM messages WHERE lane_id = ? ORDER BY created_at, rowid",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val content = result.getString("content")
                    if (content.isNotEmpty()) add(ContextMessage(result.getString("role"), content))
                }
            }
        }
    }

    private fun hasActiveRun(db: Connection, laneId: String): Boolean = db.prepareStatement(
        "SELECT 1 FROM runs WHERE lane_id = ? AND status = 'running' LIMIT 1",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { it.next() }
    }

    private fun message(db: Connection, laneId: String, messageId: String) = db.prepareStatement(
        "SELECT id, role, content FROM messages WHERE id = ? AND lane_id = ?",
    ).use { query ->
        query.setString(1, messageId)
        query.setString(2, laneId)
        query.executeQuery().use { result ->
            if (!result.next()) null else buildJsonObject {
                put("id", result.getString("id"))
                put("role", result.getString("role"))
                put("content", result.getString("content"))
            }
        }
    }

    private fun ensureColumn(db: Connection, table: String, column: String, definition: String) {
        val exists = db.createStatement().use { statement ->
            statement.executeQuery("PRAGMA table_info($table)").use { result ->
                generateSequence { if (result.next()) result.getString("name") else null }.any { it == column }
            }
        }
        if (!exists) db.createStatement().use { it.execute("ALTER TABLE $table ADD COLUMN $column $definition") }
    }

    private fun backfillLaneLayout(db: Connection) {
        var nextX = db.createStatement().use { statement ->
            statement.executeQuery("SELECT COALESCE(MAX(position_x + COALESCE(width, 440)), 4) + 20 FROM lanes")
                .use { result -> result.next(); maxOf(24, result.getInt(1)) }
        }
        val missing = db.createStatement().use { statement ->
            statement.executeQuery(
                "SELECT id, position_x, position_y, width FROM lanes WHERE position_x IS NULL OR position_y IS NULL OR width IS NULL ORDER BY created_at, rowid",
            ).use { result ->
                buildList {
                    while (result.next()) {
                        add(
                            listOf(
                                result.getString("id"),
                                result.getInt("position_x").takeUnless { result.wasNull() },
                                result.getInt("position_y").takeUnless { result.wasNull() },
                                result.getInt("width").takeUnless { result.wasNull() },
                            ),
                        )
                    }
                }
            }
        }
        missing.forEach { lane ->
            db.prepareStatement("UPDATE lanes SET position_x = ?, position_y = ?, width = ? WHERE id = ?").use { query ->
                query.setInt(1, lane[1] as? Int ?: nextX)
                query.setInt(2, lane[2] as? Int ?: 24)
                query.setInt(3, lane[3] as? Int ?: 440)
                query.setString(4, lane[0] as String)
                query.executeUpdate()
            }
            if (lane[1] == null) nextX += 460
        }
    }

    private fun finishRun(runId: String, status: String, reason: String?, eventType: String) = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                val details = runDetails(db, runId)
                db.prepareStatement(
                    "UPDATE runs SET status = ?, completed_at = ?, error = ? WHERE id = ? AND status = 'running'",
                ).use { query ->
                    query.setString(1, status)
                    query.setString(2, Instant.now().toString())
                    query.setString(3, reason)
                    query.setString(4, runId)
                    if (query.executeUpdate() == 1) {
                        val data = buildJsonObject { if (reason != null) put("error", reason) }
                        insertEvent(db, details.boardId, details.laneId, runId, eventType, data)
                    }
                }
                db.commit()
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    private fun insertEvent(
        db: Connection,
        boardId: String,
        laneId: String,
        runId: String,
        type: String,
        data: JsonObject,
    ) {
        val sequence = db.prepareStatement("SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?")
            .use { query ->
                query.setString(1, runId)
                query.executeQuery().use { result -> result.next(); result.getLong(1) }
            }
        val event = buildJsonObject {
            put("boardId", boardId)
            put("laneId", laneId)
            put("runId", runId)
            put("sequence", sequence)
            put("type", type)
            put("data", data)
        }
        db.prepareStatement("INSERT INTO run_events(run_id, sequence, event_json) VALUES (?, ?, ?)").use { query ->
            query.setString(1, runId)
            query.setLong(2, sequence)
            query.setString(3, kotlinx.serialization.json.Json.encodeToString(JsonObject.serializer(), event))
            query.executeUpdate()
        }
    }

    private fun messages(db: Connection, laneId: String) = kotlinx.serialization.json.JsonArray(
        db.prepareStatement(
            """SELECT m.id, m.role, m.content, m.created_at, r.status AS run_status, r.error AS run_error
               FROM messages m LEFT JOIN runs r ON r.id = m.run_id
               WHERE m.lane_id = ? ORDER BY m.created_at, m.rowid""",
        ).use { query ->
            query.setString(1, laneId)
            val branchPoints = db.prepareStatement(
                "SELECT origin_message_id FROM lanes WHERE origin_lane_id = ? AND origin_kind = 'branch'",
            ).use { origins ->
                origins.setString(1, laneId)
                origins.executeQuery().use { result -> buildSet { while (result.next()) add(result.getString(1)) } }
            }
            query.executeQuery().use { result ->
                buildList {
                    while (result.next()) {
                        add(buildJsonObject {
                            put("id", result.getString("id"))
                            put("role", result.getString("role"))
                            put("content", result.getString("content"))
                            if (result.getString("id") in branchPoints) put("hasBranches", true)
                            put("createdAt", result.getString("created_at"))
                            result.getString("run_status")?.let { put("runStatus", it) }
                            result.getString("run_error")?.let { put("runError", it) }
                        })
                    }
                }
            }
        },
    )

    private fun activeRun(db: Connection, laneId: String) = db.prepareStatement(
        """SELECT r.id, r.status, COALESCE(MAX(e.sequence), 0) AS sequence
           FROM runs r LEFT JOIN run_events e ON e.run_id = r.id
           WHERE r.lane_id = ? AND r.status = 'running' GROUP BY r.id LIMIT 1""",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result ->
            if (result.next()) buildJsonObject {
                put("id", result.getString("id"))
                put("status", result.getString("status"))
                put("sequence", result.getLong("sequence"))
            } else null
        }
    }

    private data class RunDetails(
        val boardId: String,
        val laneId: String,
        val answerMessageId: String,
    ) {
        override fun toString(): String = super.toString()
    }

    private fun runDetails(db: Connection, runId: String) = db.prepareStatement(
        "SELECT board_id, lane_id, assistant_message_id FROM runs WHERE id = ?",
    ).use { query ->
        query.setString(1, runId)
        query.executeQuery().use { result ->
            check(result.next()) { "Unknown run" }
            RunDetails(result.getString("board_id"), result.getString("lane_id"), result.getString("assistant_message_id"))
        }
    }

    private fun ensureBoard(db: Connection, title: String) {
        val exists = db.createStatement().use { statement ->
            statement.executeQuery("SELECT 1 FROM boards LIMIT 1").use { it.next() }
        }
        if (exists) return
        val now = Instant.now().toString()
        val boardId = UUID.randomUUID().toString()
        val laneId = UUID.randomUUID().toString()
        db.prepareStatement("INSERT INTO boards(id, title, created_at) VALUES (?, ?, ?)").use { query ->
            query.setString(1, boardId)
            query.setString(2, title)
            query.setString(3, now)
            query.executeUpdate()
        }
        db.prepareStatement("INSERT INTO lanes(id, board_id, title, created_at) VALUES (?, ?, 'Лента 1', ?)").use { query ->
            query.setString(1, laneId)
            query.setString(2, boardId)
            query.setString(3, now)
            query.executeUpdate()
        }
    }

    private fun markInterruptedRuns(db: Connection) {
        db.prepareStatement("SELECT id FROM runs WHERE status = 'running'").use { query ->
            query.executeQuery().use { result ->
                val interrupted = buildList { while (result.next()) add(result.getString("id")) }
                interrupted.forEach { runId ->
                    db.prepareStatement(
                        "UPDATE runs SET status = 'failed', completed_at = ?, error = 'Сервер перезапустился до завершения ответа' " +
                            "WHERE id = ?",
                    ).use { update ->
                        update.setString(1, Instant.now().toString())
                        update.setString(2, runId)
                        update.executeUpdate()
                    }
                    val run = runDetails(db, runId)
                    insertEvent(
                        db,
                        run.boardId,
                        run.laneId,
                        runId,
                        "run.failed",
                        buildJsonObject { put("error", "Сервер перезапустился до завершения ответа") },
                    )
                }
            }
        }
    }

    private fun connect(): Connection = DriverManager.getConnection("jdbc:sqlite:${file.toAbsolutePath()}")

    override fun close() = Unit
}
