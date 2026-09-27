package ai.advent.v3

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

data class ContextMessage(val role: String, val content: String, val id: String? = null) {
    override fun toString(): String = super.toString()
}

private fun effectiveInstructions(board: String, lane: String, mode: String, agent: String = "", agentName: String? = null): String {
    val agentSection = agent.takeIf(String::isNotBlank)?.let {
        "Инструкции назначенного агента${agentName?.let { name -> " «$name»" }.orEmpty()}:\n$it"
    }
    val inheritedBoard = board.takeIf { mode != "override" }
    val laneInstructions = lane.takeIf { mode == "override" || mode == "append" }
    return listOfNotNull(inheritedBoard, agentSection, laneInstructions).filter(String::isNotBlank).joinToString("\n\n")
}

data class TranscriptSnapshot(val messages: List<ContextMessage>, val watermark: String?, val fingerprint: String)

data class ImportedBoard(
    val externalId: String,
    val title: String,
    val instructions: String,
    val lanes: List<ImportedLane>,
    val agents: List<ImportedAgent>,
)

data class ImportedAgent(val externalId: String, val name: String, val description: String, val instructions: String)

data class ImportedLane(
    val externalId: String,
    val title: String,
    val provider: String,
    val model: String,
    val temperature: Double?,
    val maxTokens: Int?,
    val stop: String?,
    val contextStrategy: String,
    val contextWindowSize: Int,
    val contextBudgetTokens: Int,
    val summary: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val messages: List<ImportedMessage>,
    val originLaneExternalId: String?,
    val originMessageExternalId: String?,
    val originKind: String?,
    val agentExternalId: String?,
    val instructions: String,
    val instructionMode: String,
)

data class ImportedMessage(val externalId: String, val role: String, val content: String, val provenance: String?)

data class LaneConfig(
    val provider: String,
    val model: String,
    val temperature: Double?,
    val maxTokens: Int?,
    val stop: String?,
)

private fun LaneConfig.toJson(): String = kotlinx.serialization.json.Json.encodeToString(
    JsonObject.serializer(),
    buildJsonObject {
        put("provider", provider)
        put("model", model)
        temperature?.let { put("temperature", it) }
        maxTokens?.let { put("maxTokens", it) }
        stop?.let { put("stop", it) }
    },
)

private data class CopyableMessage(
    val id: String,
    val role: String,
    val content: String,
    val runStatus: String?,
    val runStartedAt: String?,
    val runCompletedAt: String?,
    val runError: String?,
    val requestConfig: String?,
    val technicalDetails: String?,
)

data class StartedRun(
    val boardId: String,
    val laneId: String,
    val runId: String,
    val threadId: String?,
    val contextToSeed: List<ContextMessage>,
    val contextPlan: ContextPlan,
    val contextStrategy: ContextStrategy,
    val shouldSeedContext: Boolean,
    val config: LaneConfig,
    val mcpTools: List<McpSelection>,
    val mcpAutoApprove: Boolean,
    val effectiveInstructions: String,
) {
    override fun toString(): String = super.toString()
}

data class RequestOverrides(
    val model: String? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val stop: String? = null,
    val forceSend: Boolean = false,
)

class ActiveRunException : IllegalStateException("A request is already running in this lane")

class BoardStore(
    private val file: Path,
    private val initialBoardTitle: String = "Доска",
    private val createDefaultLane: Boolean = true,
) : Closeable {
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
                        created_at TEXT NOT NULL,
                        external_id TEXT UNIQUE,
                        instructions TEXT NOT NULL DEFAULT ''
                    )
                    """.trimIndent(),
                )
                statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS agents (
                        id TEXT PRIMARY KEY,
                        board_id TEXT NOT NULL REFERENCES boards(id),
                        name TEXT NOT NULL,
                        description TEXT NOT NULL,
                        instructions TEXT NOT NULL,
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
                        provenance TEXT,
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
                        error TEXT,
                        request_config TEXT,
                        technical_details TEXT
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
                statement.execute("""CREATE TABLE IF NOT EXISTS lane_mcp_tools (
                    lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
                    server_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    PRIMARY KEY(lane_id, server_id, tool_name)
                )""")
                statement.execute("""CREATE TABLE IF NOT EXISTS sticky_facts (
                    lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
                    fact_key TEXT NOT NULL,
                    fact_value TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(lane_id, fact_key)
                )""")
                statement.execute("""CREATE TABLE IF NOT EXISTS mcp_approvals (
                    id TEXT PRIMARY KEY,
                    lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
                    server_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    arguments TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL,
                    approval_source TEXT,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                )""")
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
            ensureColumn(db, "lanes", "provider", "TEXT NOT NULL DEFAULT 'codex'")
            ensureColumn(db, "lanes", "model", "TEXT NOT NULL DEFAULT ''")
            ensureColumn(db, "lanes", "temperature", "REAL")
            ensureColumn(db, "lanes", "max_tokens", "INTEGER")
            ensureColumn(db, "lanes", "stop", "TEXT")
            ensureColumn(db, "lanes", "context_strategy", "TEXT NOT NULL DEFAULT 'full'")
            ensureColumn(db, "lanes", "context_window_size", "INTEGER NOT NULL DEFAULT 10")
            ensureColumn(db, "lanes", "context_summary", "TEXT NOT NULL DEFAULT ''")
            ensureColumn(db, "lanes", "context_summary_watermark", "TEXT")
            ensureColumn(db, "lanes", "context_summary_usage", "TEXT")
            ensureColumn(db, "lanes", "context_summary_usage_source", "TEXT")
            ensureColumn(db, "lanes", "context_summary_stale", "INTEGER NOT NULL DEFAULT 0")
            ensureColumn(db, "lanes", "context_budget_tokens", "INTEGER NOT NULL DEFAULT 32768")
            ensureColumn(db, "lanes", "agent_id", "TEXT")
            ensureColumn(db, "lanes", "mcp_auto_approve", "INTEGER NOT NULL DEFAULT 0")
            ensureColumn(db, "boards", "external_id", "TEXT")
            ensureColumn(db, "boards", "instructions", "TEXT NOT NULL DEFAULT ''")
            ensureColumn(db, "lanes", "instructions", "TEXT NOT NULL DEFAULT ''")
            ensureColumn(db, "lanes", "instruction_mode", "TEXT NOT NULL DEFAULT 'inherit'")
            ensureColumn(db, "messages", "provenance", "TEXT")
            db.createStatement().use { it.execute("CREATE UNIQUE INDEX IF NOT EXISTS boards_external_id ON boards(external_id) WHERE external_id IS NOT NULL") }
            ensureColumn(db, "runs", "request_config", "TEXT")
            ensureColumn(db, "runs", "technical_details", "TEXT")
            ensureColumn(db, "mcp_approvals", "interrupted_at", "TEXT")
            backfillLaneLayout(db)
            ensureBoard(db, initialBoardTitle, createDefaultLane)
            markInterruptedRuns(db)
            markInterruptedApprovals(db)
        }
    }

    fun board(): JsonObject = synchronized(lock) {
        connect().use { db ->
            val board = db.prepareStatement(
                "SELECT id, title, instructions FROM boards ORDER BY created_at LIMIT 1",
            ).use { query ->
                query.executeQuery().use { result ->
                    check(result.next()) { "Board has not been initialized" }
                    buildJsonObject {
                        put("id", result.getString("id"))
                        put("title", result.getString("title"))
                        put("instructions", result.getString("instructions"))
                    }
                }
            }
            val lanes = mutableListOf<JsonObject>()
            val agents = db.prepareStatement("SELECT id, name, description, instructions FROM agents WHERE board_id = ? ORDER BY rowid").use { query ->
                query.setString(1, board["id"]!!.jsonPrimitive.content)
                query.executeQuery().use { result -> buildList {
                    while (result.next()) add(buildJsonObject {
                        put("id", result.getString("id")); put("name", result.getString("name"))
                        put("description", result.getString("description")); put("instructions", result.getString("instructions"))
                    })
                } }
            }
            db.prepareStatement(
                "SELECT id, title, codex_thread_id, origin_lane_id, origin_message_id, origin_kind, " +
                    "origin_message_role, origin_message_content, " +
                    "position_x, position_y, width, provider, model, temperature, max_tokens, stop, " +
                    "context_strategy, context_window_size, context_summary, context_summary_watermark, context_budget_tokens, " +
                    "context_summary_usage, context_summary_usage_source, context_summary_stale, agent_id, mcp_auto_approve, " +
                    "instructions, instruction_mode, (SELECT instructions FROM boards WHERE id = lanes.board_id) AS board_instructions, " +
                    "(SELECT instructions FROM agents WHERE id = lanes.agent_id) AS agent_instructions, " +
                    "(SELECT name FROM agents WHERE id = lanes.agent_id) AS agent_name " +
                    "FROM lanes WHERE board_id = ? ORDER BY created_at, rowid",
            ).use { query ->
                query.setString(1, board["id"]!!.jsonPrimitive.content)
                query.executeQuery().use { result ->
                    while (result.next()) {
                        val laneId = result.getString("id")
                        lanes += buildJsonObject {
                            put("id", laneId)
                            put("title", result.getString("title"))
                            put("instructions", result.getString("instructions"))
                            put("instructionMode", result.getString("instruction_mode"))
                            put("effectiveInstructions", effectiveInstructions(result.getString("board_instructions"), result.getString("instructions"), result.getString("instruction_mode"), result.getString("agent_instructions") ?: "", result.getString("agent_name")))
                            result.getString("agent_id")?.let { put("agentId", it) }
                            put("mcpAutoApprove", result.getInt("mcp_auto_approve") != 0)
                            put("stickyFacts", JsonArray(stickyFacts(db, laneId)))
                            put("mcpApprovals", JsonArray(mcpApprovals(db, laneId)))
                            put("provider", result.getString("provider"))
                            put("model", result.getString("model"))
                            result.getDouble("temperature").takeUnless { result.wasNull() }?.let { put("temperature", it) }
                            result.getInt("max_tokens").takeUnless { result.wasNull() }?.let { put("maxTokens", it) }
                            result.getString("stop")?.let { put("stop", it) }
                            put("contextStrategy", result.getString("context_strategy"))
                            put("contextWindowSize", result.getInt("context_window_size"))
                            put("contextSummary", result.getString("context_summary"))
                            result.getString("context_summary_watermark")?.let { put("contextSummaryWatermark", it) }
                            put("contextBudgetTokens", result.getInt("context_budget_tokens"))
                            result.getString("context_summary_usage")?.let { usage ->
                                runCatching { kotlinx.serialization.json.Json.parseToJsonElement(usage) }.getOrNull()?.let { put("contextSummaryUsage", it) }
                            }
                            result.getString("context_summary_usage_source")?.let { put("contextSummaryUsageSource", it) }
                            put("contextSummaryStale", result.getInt("context_summary_stale") != 0)
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
                            put("mcpTools", kotlinx.serialization.json.JsonArray(mcpTools(db, laneId).map { selection ->
                                buildJsonObject { put("serverId", selection.serverId); put("toolName", selection.toolName) }
                            }))
                            put("activeRun", activeRun(db, laneId) ?: JsonNull)
                        }
                    }
                }
            }
            buildJsonObject {
                put("board", board)
                put("lanes", kotlinx.serialization.json.JsonArray(lanes))
                put("agents", kotlinx.serialization.json.JsonArray(agents))
            }
        }
    }

    fun boardOrder(): Pair<String, String> = synchronized(lock) {
        connect().use { db ->
            db.createStatement().use { statement ->
                statement.executeQuery("SELECT id, created_at FROM boards ORDER BY created_at LIMIT 1").use { result ->
                    check(result.next()) { "Board has not been initialized" }
                    result.getString("id") to result.getString("created_at")
                }
            }
        }
    }

    fun createLane(provider: String): String = synchronized(lock) {
        require(provider in setOf("codex", "openrouter")) { "Unsupported provider" }
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
                "INSERT INTO lanes(id, board_id, title, created_at, position_x, position_y, width, provider, model, temperature, max_tokens) " +
                    "VALUES (?, ?, ?, ?, ?, 24, 440, ?, ?, ?, ?)",
            ).use { query ->
                query.setString(1, laneId)
                query.setString(2, boardId)
                query.setString(3, "Лента ${count + 1}")
                query.setString(4, Instant.now().toString())
                query.setInt(5, 24 + count * 460)
                query.setString(6, provider)
                query.setString(7, if (provider == "codex") "" else "openai/gpt-4o-mini")
                if (provider == "openrouter") query.setDouble(8, 0.7) else query.setNull(8, java.sql.Types.REAL)
                if (provider == "openrouter") query.setInt(9, 2048) else query.setNull(9, java.sql.Types.INTEGER)
                query.executeUpdate()
            }
            laneId
        }
    }

    fun updateBoardInstructions(instructions: String): JsonObject = synchronized(lock) {
        require(instructions.length <= 20_000) { "Инструкции доски не должны превышать 20 000 символов." }
        connect().use { db ->
            db.prepareStatement("UPDATE boards SET instructions = ? WHERE id = (SELECT id FROM boards LIMIT 1)").use { query ->
                query.setString(1, instructions)
                check(query.executeUpdate() == 1) { "Board has not been initialized" }
            }
        }
        board()
    }

    fun updateLaneInstructions(laneId: String, instructions: String, mode: String): JsonObject = synchronized(lock) {
        require(instructions.length <= 20_000) { "Инструкции ленты не должны превышать 20 000 символов." }
        require(mode in setOf("inherit", "override", "append")) { "Режим инструкций должен быть inherit, override или append." }
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET instructions = ?, instruction_mode = ? WHERE id = ?").use { query ->
                query.setString(1, instructions)
                query.setString(2, mode)
                query.setString(3, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
        board()
    }

    fun importPreparedBoard(externalId: String, title: String, instructions: String, lanes: List<ImportedLane>, agents: List<ImportedAgent>): String = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                db.prepareStatement("UPDATE boards SET title = ?, external_id = ?, instructions = ? WHERE id = (SELECT id FROM boards LIMIT 1)").use { query ->
                    query.setString(1, title)
                    query.setString(2, externalId)
                    query.setString(3, instructions)
                    check(query.executeUpdate() == 1) { "Board has not been initialized" }
                }
                val boardId = db.createStatement().use { statement ->
                    statement.executeQuery("SELECT id FROM boards LIMIT 1").use { result -> result.next(); result.getString(1) }
                }
                val laneIds = lanes.associate { it.externalId to UUID.randomUUID().toString() }
                val agentIds = agents.associate { it.externalId to UUID.randomUUID().toString() }
                val messageIds = lanes.flatMap { lane -> lane.messages.map { "${lane.externalId}/${it.externalId}" to UUID.randomUUID().toString() } }.toMap()
                agents.forEach { agent ->
                    db.prepareStatement("INSERT INTO agents(id, board_id, name, description, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?)").use { query ->
                        query.setString(1, agentIds.getValue(agent.externalId)); query.setString(2, boardId); query.setString(3, agent.name)
                        query.setString(4, agent.description); query.setString(5, agent.instructions); query.setString(6, Instant.now().toString())
                        query.executeUpdate()
                    }
                }
                lanes.forEachIndexed { index, lane ->
                    val laneId = laneIds.getValue(lane.externalId)
                    db.prepareStatement(
                        """INSERT INTO lanes(id, board_id, title, created_at, codex_context_seeded, position_x, position_y, width,
                           provider, model, temperature, max_tokens, stop, context_strategy, context_window_size, context_summary,
                           context_summary_watermark, context_budget_tokens, agent_id, instructions, instruction_mode)
                           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    ).use { query ->
                        query.setString(1, laneId); query.setString(2, boardId); query.setString(3, lane.title)
                        query.setString(4, Instant.now().plusNanos(index.toLong()).toString())
                        query.setInt(5, lane.x); query.setInt(6, lane.y); query.setInt(7, lane.width)
                        query.setString(8, lane.provider); query.setString(9, lane.model)
                        if (lane.temperature == null) query.setNull(10, java.sql.Types.REAL) else query.setDouble(10, lane.temperature)
                        if (lane.maxTokens == null) query.setNull(11, java.sql.Types.INTEGER) else query.setInt(11, lane.maxTokens)
                        query.setString(12, lane.stop); query.setString(13, lane.contextStrategy)
                        query.setInt(14, lane.contextWindowSize); query.setString(15, lane.summary)
                        val summaryWatermark = lane.messages.lastOrNull()?.takeIf { lane.summary.isNotBlank() }
                            ?.let { messageIds.getValue("${lane.externalId}/${it.externalId}") }
                        query.setString(16, summaryWatermark); query.setInt(17, lane.contextBudgetTokens)
                        query.setString(18, lane.agentExternalId?.let(agentIds::get))
                        query.setString(19, lane.instructions)
                        query.setString(20, lane.instructionMode)
                        query.executeUpdate()
                    }
                    lane.messages.forEachIndexed { messageIndex, message ->
                        db.prepareStatement("INSERT INTO messages(id, lane_id, role, content, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)").use { query ->
                            query.setString(1, messageIds.getValue("${lane.externalId}/${message.externalId}")); query.setString(2, laneId)
                            query.setString(3, message.role); query.setString(4, message.content); query.setString(5, message.provenance)
                            query.setString(6, Instant.now().plusNanos((index * 1000L + messageIndex).toLong()).toString())
                            query.executeUpdate()
                        }
                    }
                }
                lanes.forEach { lane ->
                    if (lane.originLaneExternalId != null) {
                        val sourceLane = lanes.first { it.externalId == lane.originLaneExternalId }
                        val sourceMessage = sourceLane.messages.first { it.externalId == lane.originMessageExternalId }
                        db.prepareStatement(
                            "UPDATE lanes SET origin_lane_id = ?, origin_message_id = ?, origin_kind = ?, origin_message_role = ?, origin_message_content = ? WHERE id = ?",
                        ).use { query ->
                            query.setString(1, laneIds.getValue(sourceLane.externalId))
                            query.setString(2, messageIds.getValue("${sourceLane.externalId}/${sourceMessage.externalId}"))
                            query.setString(3, lane.originKind); query.setString(4, sourceMessage.role); query.setString(5, sourceMessage.content)
                            query.setString(6, laneIds.getValue(lane.externalId)); query.executeUpdate()
                        }
                    }
                }
                db.commit()
                boardId
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    fun findBoardByExternalId(externalId: String): String? = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT id FROM boards WHERE external_id = ? LIMIT 1").use { query ->
                query.setString(1, externalId)
                query.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
            }
        }
    }

    fun checkpointForMove() = synchronized(lock) {
        connect().use { db ->
            db.createStatement().use { statement ->
                statement.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                statement.execute("PRAGMA journal_mode=DELETE")
            }
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
            markSummaryStale(db, laneId)
        }
    }

    fun deleteMessagesFrom(messageId: String) = synchronized(lock) {
        check(!activeRunForMessage(messageId)) { "Cannot edit messages while a request is running" }
        mutateHistoryFrom(messageId) { db, laneId, selectedId ->
            deleteMessagesAfter(db, laneId, selectedId, includeSelected = true)
            resetThread(db, laneId)
            markSummaryStale(db, laneId)
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

    fun updateLaneConfig(
        laneId: String, model: String, temperature: Double?, maxTokens: Int?, stop: String?,
        contextStrategy: String = "full", contextWindowSize: Int = 10, contextBudgetTokens: Int = 32768,
    ) = synchronized(lock) {
        require(model.length <= 200) { "Model is too long" }
        require(temperature == null || temperature in 0.0..2.0) { "Temperature must be between 0 and 2" }
        require(maxTokens == null || maxTokens in 1..200_000) { "Max tokens is out of range" }
        require(stop == null || stop.length <= 500) { "Stop sequence is too long" }
        ContextStrategy.parse(contextStrategy)
        require(contextWindowSize in 1..200) { "Размер окна должен быть от 1 до 200 сообщений." }
        require(contextBudgetTokens in 256..1_000_000) { "Бюджет контекста должен быть от 256 до 1000000 токенов." }
        connect().use { db ->
            db.prepareStatement("UPDATE lanes SET model = ?, temperature = ?, max_tokens = ?, stop = ?, context_strategy = ?, context_window_size = ?, context_budget_tokens = ? WHERE id = ?").use { query ->
                query.setString(1, model.trim())
                if (temperature == null) query.setNull(2, java.sql.Types.REAL) else query.setDouble(2, temperature)
                if (maxTokens == null) query.setNull(3, java.sql.Types.INTEGER) else query.setInt(3, maxTokens)
                query.setString(4, stop?.takeIf(String::isNotBlank))
                query.setString(5, contextStrategy)
                query.setInt(6, contextWindowSize)
                query.setInt(7, contextBudgetTokens)
                query.setString(8, laneId)
                check(query.executeUpdate() == 1) { "Unknown lane" }
            }
        }
    }

    fun setMcpAutoApprove(laneId: String, enabled: Boolean) = synchronized(lock) {
        connect().use { db -> db.prepareStatement("UPDATE lanes SET mcp_auto_approve = ? WHERE id = ?").use { query ->
            query.setInt(1, if (enabled) 1 else 0); query.setString(2, laneId)
            check(query.executeUpdate() == 1) { "Unknown lane" }
        } }
    }

    fun mcpAutoApprove(laneId: String): Boolean = synchronized(lock) {
        connect().use { db -> db.prepareStatement("SELECT mcp_auto_approve FROM lanes WHERE id = ?").use { query ->
            query.setString(1, laneId); query.executeQuery().use { result -> check(result.next()); result.getInt(1) != 0 }
        } }
    }

    fun addMcpApproval(laneId: String, serverId: String, toolName: String, arguments: JsonObject, reason: String, source: String?): String = synchronized(lock) {
        val id = UUID.randomUUID().toString()
        connect().use { db -> db.prepareStatement("INSERT INTO mcp_approvals(id,lane_id,server_id,tool_name,arguments,reason,status,approval_source,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)").use { query ->
            query.setString(1, id); query.setString(2, laneId); query.setString(3, serverId); query.setString(4, toolName)
            query.setString(5, Json.encodeToString(JsonObject.serializer(), arguments)); query.setString(6, reason)
            query.setString(7, source); query.setString(8, Instant.now().toString()); query.executeUpdate()
        } }
        id
    }

    fun laneDatabasePath(): String = file.toAbsolutePath().toString()

    fun approval(laneId: String, approvalId: String): JsonObject? = synchronized(lock) {
        connect().use { db -> db.prepareStatement("SELECT * FROM mcp_approvals WHERE lane_id=? AND id=?").use { query ->
            query.setString(1, laneId); query.setString(2, approvalId); query.executeQuery().use { result -> if (result.next()) approvalJson(result) else null }
        } }
    }

    fun claimApproval(laneId: String, approvalId: String): JsonObject? = synchronized(lock) {
        connect().use { db -> db.autoCommit = false; try {
            db.prepareStatement("UPDATE mcp_approvals SET status='applying' WHERE lane_id=? AND id=? AND status='pending'").use { query ->
                query.setString(1, laneId); query.setString(2, approvalId); if (query.executeUpdate() != 1) { db.rollback(); return@synchronized null }
            }
            val item = db.prepareStatement("SELECT * FROM mcp_approvals WHERE lane_id=? AND id=?").use { query ->
                query.setString(1, laneId); query.setString(2, approvalId); query.executeQuery().use { result -> check(result.next()); approvalJson(result) }
            }
            db.commit(); item
        } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true } }
    }

    fun denyApproval(laneId: String, approvalId: String): Boolean = synchronized(lock) {
        connect().use { db -> db.prepareStatement("UPDATE mcp_approvals SET status='denied', approval_source='user', resolved_at=? WHERE lane_id=? AND id=? AND status='pending'").use { query ->
            query.setString(1, Instant.now().toString()); query.setString(2, laneId); query.setString(3, approvalId); query.executeUpdate() == 1
        } }
    }

    fun closeUncertainApproval(laneId: String, approvalId: String): Boolean = synchronized(lock) {
        connect().use { db -> db.prepareStatement("UPDATE mcp_approvals SET status='uncertain_closed', resolved_at=? WHERE lane_id=? AND id=? AND status='uncertain'").use { query ->
            query.setString(1, Instant.now().toString()); query.setString(2, laneId); query.setString(3, approvalId); query.executeUpdate() == 1
        } }
    }

    fun finishApproval(laneId: String, approvalId: String, status: String, source: String? = null): Boolean = synchronized(lock) {
        require(status in setOf("approved", "failed"))
        connect().use { db -> db.prepareStatement("UPDATE mcp_approvals SET status=?, approval_source=COALESCE(?, approval_source), resolved_at=? WHERE lane_id=? AND id=? AND status='applying'").use { query ->
            query.setString(1, status); query.setString(2, source); query.setString(3, Instant.now().toString()); query.setString(4, laneId); query.setString(5, approvalId); query.executeUpdate() == 1
        } }
    }

    private fun markInterruptedApprovals(db: Connection) {
        db.prepareStatement("UPDATE mcp_approvals SET status='uncertain', interrupted_at=? WHERE status='applying'").use { query ->
            query.setString(1, Instant.now().toString())
            query.executeUpdate()
        }
    }

    fun editFact(laneId: String, key: String, value: String?) = synchronized(lock) {
        require(key.isNotBlank() && key.length <= 80 && (value == null || value.length <= 2000))
        connect().use { db ->
            if (value == null) db.prepareStatement("DELETE FROM sticky_facts WHERE lane_id=? AND fact_key=?").use { it.setString(1,laneId); it.setString(2,key); it.executeUpdate() }
            else db.prepareStatement("INSERT INTO sticky_facts(lane_id,fact_key,fact_value,updated_at) VALUES(?,?,?,?) ON CONFLICT(lane_id,fact_key) DO UPDATE SET fact_value=excluded.fact_value,updated_at=excluded.updated_at").use { it.setString(1,laneId); it.setString(2,key); it.setString(3,value); it.setString(4,Instant.now().toString()); it.executeUpdate() }
        }
    }

    fun clearFacts(laneId: String) = synchronized(lock) { connect().use { db -> db.prepareStatement("DELETE FROM sticky_facts WHERE lane_id=?").use { it.setString(1,laneId); it.executeUpdate() } } }

    fun transcriptSnapshot(laneId: String): TranscriptSnapshot = synchronized(lock) {
        connect().use { db -> transcriptSnapshot(db, laneId) }
    }

    fun saveContextSummary(
        laneId: String, summary: String, watermark: String?, usageSource: String?, usage: JsonObject?, expectedFingerprint: String,
    ): Boolean = synchronized(lock) {
        require(summary.length <= 50_000) { "Сводка слишком длинная." }
        connect().use { db ->
            db.autoCommit = false
            try {
                if (transcriptSnapshot(db, laneId).fingerprint != expectedFingerprint) {
                    db.rollback()
                    return@synchronized false
                }
                db.prepareStatement("UPDATE lanes SET context_summary = ?, context_summary_watermark = ?, context_summary_usage = ?, context_summary_usage_source = ?, context_summary_stale = 0 WHERE id = ?").use { query ->
                    query.setString(1, summary)
                    query.setString(2, watermark)
                    query.setString(3, usage?.let { kotlinx.serialization.json.Json.encodeToString(JsonObject.serializer(), it) })
                    query.setString(4, usageSource)
                    query.setString(5, laneId)
                    check(query.executeUpdate() == 1) { "Unknown lane" }
                }
                db.commit()
                true
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
    }

    private fun transcriptSnapshot(db: Connection, laneId: String): TranscriptSnapshot {
        val rows = db.prepareStatement(
            "SELECT id, role, content FROM messages WHERE lane_id = ? ORDER BY created_at, rowid",
        ).use { query ->
            query.setString(1, laneId)
            query.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(Triple(result.getString("id"), result.getString("role"), result.getString("content")))
                }
            }
        }
        val digest = MessageDigest.getInstance("SHA-256")
        rows.forEach { (id, role, content) ->
            listOf(id, role, content).forEach { value ->
                val bytes = value.toByteArray(StandardCharsets.UTF_8)
                digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
                digest.update(bytes)
            }
        }
        val messages = rows.mapNotNull { (id, role, content) ->
            if (content.isEmpty() || role !in setOf("user", "assistant")) null else ContextMessage(role, content, id)
        }
        return TranscriptSnapshot(messages, rows.lastOrNull()?.first, digest.digest().joinToString("") { "%02x".format(it) })
    }

    private fun markSummaryStale(db: Connection, laneId: String) {
        db.prepareStatement("UPDATE lanes SET context_summary_stale = 1 WHERE id = ? AND context_summary <> ''").use { query ->
            query.setString(1, laneId)
            query.executeUpdate()
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
                    "SELECT board_id, title, provider, model, temperature, max_tokens, stop, context_strategy, " +
                        "context_window_size, context_budget_tokens, agent_id, instructions, instruction_mode FROM lanes WHERE id = ?",
                ).use { query ->
                    query.setString(1, sourceLaneId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown lane" }
                        listOf(result.getString("board_id"), result.getString("title"), result.getString("provider"),
                            result.getString("model"), result.getString("temperature"), result.getString("max_tokens"), result.getString("stop"),
                            result.getString("context_strategy"), result.getString("context_window_size"), result.getString("context_budget_tokens"),
                            result.getString("agent_id"), result.getString("instructions"), result.getString("instruction_mode"))
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
                    query.setString(1, source[0])
                    query.executeQuery().use { result -> result.next(); result.getInt(1) }
                }
                val laneId = UUID.randomUUID().toString()
                db.prepareStatement(
                    "INSERT INTO lanes(id, board_id, title, created_at, origin_lane_id, origin_message_id, " +
                    "origin_kind, codex_context_seeded, origin_message_role, origin_message_content, " +
                        "position_x, position_y, width, provider, model, temperature, max_tokens, stop, " +
                        "context_strategy, context_window_size, context_budget_tokens, agent_id, instructions, instruction_mode) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 24, 440, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ).use { query ->
                    query.setString(1, laneId)
                    query.setString(2, source[0])
                    query.setString(3, "${source[1]} · ${if (kind == "branch") "ветка" else "клон"} ${count + 1}")
                    query.setString(4, Instant.now().toString())
                    query.setString(5, sourceLaneId)
                    query.setString(6, throughMessageId)
                    query.setString(7, kind)
                    query.setString(8, originSnapshot?.first)
                    query.setString(9, originSnapshot?.second)
                    query.setInt(10, 24 + count * 460)
                    query.setString(11, source[2])
                    query.setString(12, source[3])
                    source[4]?.toDoubleOrNull()?.let { query.setDouble(13, it) } ?: query.setNull(13, java.sql.Types.REAL)
                    source[5]?.toIntOrNull()?.let { query.setInt(14, it) } ?: query.setNull(14, java.sql.Types.INTEGER)
                    query.setString(15, source[6])
                    query.setString(16, source[7])
                    query.setInt(17, source[8].toInt())
                    query.setInt(18, source[9].toInt())
                    query.setString(19, source[10])
                    query.setString(20, source[11])
                    query.setString(21, source[12])
                    query.executeUpdate()
                }
                db.prepareStatement("INSERT INTO lane_mcp_tools(lane_id, server_id, tool_name) SELECT ?, server_id, tool_name FROM lane_mcp_tools WHERE lane_id = ?").use { query ->
                    query.setString(1, laneId)
                    query.setString(2, sourceLaneId)
                    query.executeUpdate()
                }
                val sourceMessages = db.prepareStatement(
                    """SELECT m.id, m.role, m.content, r.status, r.started_at, r.completed_at, r.error,
                              r.request_config, r.technical_details
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
                                    result.getString("request_config"),
                                    result.getString("technical_details"),
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
                            "INSERT INTO runs(id, board_id, lane_id, assistant_message_id, status, started_at, completed_at, error, request_config, technical_details) " +
                                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        ).use { query ->
                            query.setString(1, copiedRunId)
                            query.setString(2, source[0])
                            query.setString(3, laneId)
                            query.setString(4, copiedMessageId)
                            query.setString(5, item.runStatus)
                            query.setString(6, item.runStartedAt)
                            query.setString(7, item.runCompletedAt)
                            query.setString(8, item.runError)
                            query.setString(9, item.requestConfig)
                            query.setString(10, item.technicalDetails)
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

    fun providerForLane(laneId: String): String = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("SELECT provider FROM lanes WHERE id = ?").use { query ->
                query.setString(1, laneId)
                query.executeQuery().use { result ->
                    check(result.next()) { "Unknown lane" }
                    result.getString(1)
                }
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

    fun startRun(laneId: String, prompt: String, overrides: RequestOverrides = RequestOverrides()): StartedRun = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                val lane = db.prepareStatement(
                "SELECT l.board_id, l.codex_thread_id, l.codex_context_seeded, l.provider, l.model, l.temperature, l.max_tokens, l.stop, " +
                        "l.context_strategy, l.context_window_size, l.context_summary, l.context_summary_watermark, l.context_budget_tokens, l.mcp_auto_approve, " +
                        "l.instructions, l.instruction_mode, b.instructions AS board_instructions, " +
                        "l.agent_id, a.name AS agent_name, a.instructions AS agent_instructions " +
                        "FROM lanes l JOIN boards b ON b.id = l.board_id LEFT JOIN agents a ON a.id = l.agent_id WHERE l.id = ?",
                ).use { query ->
                    query.setString(1, laneId)
                    query.executeQuery().use { result ->
                        check(result.next()) { "Unknown lane" }
                        listOf(result.getString("board_id"), result.getString("codex_thread_id"),
                            (result.getInt("codex_context_seeded") == 0).toString(), result.getString("provider"),
                            result.getString("model"), result.getString("temperature"), result.getString("max_tokens"), result.getString("stop"),
                            result.getString("context_strategy"), result.getString("context_window_size"), result.getString("context_summary"),
                            result.getString("context_summary_watermark"), result.getString("context_budget_tokens"), result.getString("mcp_auto_approve"),
                            result.getString("instructions"), result.getString("instruction_mode"), result.getString("board_instructions"),
                            result.getString("agent_id"), result.getString("agent_name"), result.getString("agent_instructions"))
                    }
                }
                val isActive = db.prepareStatement(
                    "SELECT 1 FROM runs WHERE lane_id = ? AND status = 'running' LIMIT 1",
                ).use { query ->
                    query.setString(1, laneId)
                    query.executeQuery().use { it.next() }
                }
                if (isActive) throw ActiveRunException()

                val needsSeed = lane[2].toBoolean()
                val completeTranscript = history(db, laneId)
                val summaryWatermark = lane[11] ?: completeTranscript.lastOrNull()?.id?.takeIf { lane[10].isNotBlank() }
                if (lane[11] == null && summaryWatermark != null && lane[10].isNotBlank()) {
                    db.prepareStatement("UPDATE lanes SET context_summary_watermark = ? WHERE id = ? AND context_summary_watermark IS NULL").use { query ->
                        query.setString(1, summaryWatermark)
                        query.setString(2, laneId)
                        query.executeUpdate()
                    }
                }
                val provider = lane[3]
                val config = LaneConfig(
                    provider,
                    overrides.model?.takeIf(String::isNotBlank) ?: lane[4],
                    if (provider == "openrouter") overrides.temperature ?: lane[5]?.toDoubleOrNull() else null,
                    if (provider == "openrouter") overrides.maxTokens ?: lane[6]?.toIntOrNull() else null,
                    if (provider == "openrouter") (overrides.stop ?: lane[7])?.takeIf(String::isNotBlank) else null,
                )
                require(config.provider != "openrouter" || config.model.isNotBlank()) { "OpenRouter model is required" }
                require(config.temperature == null || config.temperature in 0.0..2.0) { "Temperature must be between 0 and 2" }
                require(config.maxTokens == null || config.maxTokens in 1..200_000) { "Max tokens is out of range" }
                require(config.stop == null || config.stop.length <= 500) { "Stop sequence is too long" }
                val strategy = ContextStrategy.parse(lane[8])
                val plan = ContextPlanner.plan(
                    transcript = completeTranscript,
                    prompt = prompt,
                    strategy = strategy,
                    windowSize = lane[9].toInt(),
                    summary = lane[10],
                    summaryWatermark = summaryWatermark,
                    budgetTokens = lane[12].toInt(),
                    responseTokensEstimate = config.maxTokens ?: 1024,
                )
                require(!plan.overflow || overrides.forceSend) {
                    "Контекст оценивается в ${plan.inputTokensEstimate + plan.responseTokensEstimate} токенов при бюджете ${plan.budgetTokens}; подтверди отправку ещё раз."
                }
                if (strategy != ContextStrategy.FULL) resetThread(db, laneId)
                val reuseFullThread = strategy == ContextStrategy.FULL && !needsSeed && lane[1] != null
                val contextToSeed = if (reuseFullThread) emptyList() else plan.messages
                val reusableThreadId = if (reuseFullThread) lane[1] else null

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
                    "INSERT INTO runs(id, board_id, lane_id, assistant_message_id, status, started_at, request_config) " +
                        "VALUES (?, ?, ?, ?, 'running', ?, ?)",
                ).use { query ->
                    query.setString(1, runId)
                    query.setString(2, lane[0])
                    query.setString(3, laneId)
                    query.setString(4, answerId)
                    query.setString(5, now)
                    query.setString(6, kotlinx.serialization.json.Json.encodeToString(JsonObject.serializer(), buildJsonObject {
                        kotlinx.serialization.json.Json.parseToJsonElement(config.toJson()).jsonObject.forEach { (key, value) -> put(key, value) }
                        put("contextPlan", plan.toJson())
                        put("contextStrategy", strategy.wireName)
                        put("effectiveInstructions", effectiveInstructions(lane[16], lane[14], lane[15], lane[19] ?: "", lane[18]))
                        put("instructionSource", when (lane[15]) {
                            "override" -> "lane-override"
                            "append" -> "board-and-lane"
                            else -> "board-default"
                        })
                        lane[17]?.let { put("agentId", it) }
                        lane[18]?.let { put("agentName", it) }
                        put("instructionPriority", "Доска задаёт общий контекст; агент уточняет роль; инструкции ленты имеют приоритет. Режим override заменяет инструкции доски, но не назначенного агента.")
                    }))
                    query.executeUpdate()
                }
                insertEvent(db, lane[0], laneId, runId, "run.started", buildJsonObject {})
                db.commit()
                StartedRun(
                    lane[0],
                    laneId,
                    runId,
                    reusableThreadId,
                    contextToSeed,
                    plan,
                    strategy,
                    shouldSeedContext = reusableThreadId == null || needsSeed,
                    config = config,
                    mcpTools = mcpTools(db, laneId),
                    mcpAutoApprove = lane[13].toInt() != 0,
                    effectiveInstructions = effectiveInstructions(lane[16], lane[14], lane[15], lane[19] ?: "", lane[18]),
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

    fun saveMcpTools(laneId: String, tools: List<McpSelection>) = synchronized(lock) {
        connect().use { db ->
            db.autoCommit = false
            try {
                check(db.prepareStatement("SELECT 1 FROM lanes WHERE id = ?").use { q -> q.setString(1, laneId); q.executeQuery().use { it.next() } }) { "Unknown lane" }
                if (hasActiveRun(db, laneId)) throw ActiveRunException()
                db.prepareStatement("DELETE FROM lane_mcp_tools WHERE lane_id = ?").use { q -> q.setString(1, laneId); q.executeUpdate() }
                tools.distinct().forEach { selection ->
                    db.prepareStatement("INSERT INTO lane_mcp_tools(lane_id, server_id, tool_name) VALUES (?, ?, ?)").use { q ->
                        q.setString(1, laneId); q.setString(2, selection.serverId); q.setString(3, selection.toolName); q.executeUpdate()
                    }
                }
                db.commit()
            } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
    }

    fun mcpTools(laneId: String): List<McpSelection> = synchronized(lock) { connect().use { mcpTools(it, laneId) } }

    private fun mcpTools(db: Connection, laneId: String): List<McpSelection> = db.prepareStatement(
        "SELECT server_id, tool_name FROM lane_mcp_tools WHERE lane_id = ? ORDER BY server_id, tool_name",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result -> buildList { while (result.next()) add(McpSelection(result.getString(1), result.getString(2))) } }
    }

    private fun stickyFacts(db: Connection, laneId: String): List<JsonObject> = db.prepareStatement(
        "SELECT fact_key,fact_value,updated_at FROM sticky_facts WHERE lane_id=? ORDER BY fact_key",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result -> buildList {
            while (result.next()) add(buildJsonObject {
                put("key", result.getString("fact_key")); put("value", result.getString("fact_value")); put("updatedAt", result.getString("updated_at"))
            })
        } }
    }

    private fun mcpApprovals(db: Connection, laneId: String): List<JsonObject> = db.prepareStatement(
        "SELECT * FROM mcp_approvals WHERE lane_id=? ORDER BY created_at DESC",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result -> buildList { while (result.next()) add(approvalJson(result)) } }
    }

    private fun approvalJson(result: java.sql.ResultSet): JsonObject = buildJsonObject {
        put("id", result.getString("id")); put("laneId", result.getString("lane_id")); put("serverId", result.getString("server_id"))
        put("toolName", result.getString("tool_name")); put("arguments", kotlinx.serialization.json.Json.parseToJsonElement(result.getString("arguments")))
        put("reason", result.getString("reason")); put("status", result.getString("status")); result.getString("approval_source")?.let { put("approvalSource", it) }
        put("createdAt", result.getString("created_at")); result.getString("resolved_at")?.let { put("resolvedAt", it) }
        result.getString("interrupted_at")?.let { put("interruptedAt", it) }
    }

    fun appendRunEvent(runId: String, type: String, data: JsonObject) = synchronized(lock) {
        connect().use { db ->
            val (boardId, laneId) = runDetails(db, runId).let { it.boardId to it.laneId }
            insertEvent(db, boardId, laneId, runId, type, data)
        }
    }

    fun saveTechnicalDetails(runId: String, details: JsonObject) = synchronized(lock) {
        connect().use { db ->
            db.prepareStatement("UPDATE runs SET technical_details = ? WHERE id = ?").use { query ->
                query.setString(1, kotlinx.serialization.json.Json.encodeToString(JsonObject.serializer(), details))
                query.setString(2, runId)
                check(query.executeUpdate() == 1) { "Unknown run" }
            }
        }
    }

    fun cancelRun(runId: String) = finishRun(runId, "cancelled", null, "run.cancelled")

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
        "SELECT id, role, content FROM messages WHERE lane_id = ? ORDER BY created_at, rowid",
    ).use { query ->
        query.setString(1, laneId)
        query.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val content = result.getString("content")
                    if (content.isNotEmpty()) add(ContextMessage(result.getString("role"), content, result.getString("id")))
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
            """SELECT m.id, m.role, m.content, m.provenance, m.created_at, r.status AS run_status, r.error AS run_error,
                      r.request_config, r.technical_details
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
                            result.getString("provenance")?.let { put("provenance", it) }
                            if (result.getString("id") in branchPoints) put("hasBranches", true)
                            put("createdAt", result.getString("created_at"))
                            result.getString("run_status")?.let { put("runStatus", it) }
                            result.getString("run_error")?.let { put("runError", it) }
                            result.getString("request_config")?.let { runConfig ->
                                runCatching { kotlinx.serialization.json.Json.parseToJsonElement(runConfig) }
                                    .getOrNull()?.let { put("requestConfig", it) }
                            }
                            result.getString("technical_details")?.let { details ->
                                runCatching { kotlinx.serialization.json.Json.parseToJsonElement(details) }
                                    .getOrNull()?.let { put("technicalDetails", it) }
                            }
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

    private fun ensureBoard(db: Connection, title: String, withDefaultLane: Boolean) {
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
        if (withDefaultLane) {
            db.prepareStatement("INSERT INTO lanes(id, board_id, title, created_at) VALUES (?, ?, 'Лента 1', ?)").use { query ->
                query.setString(1, laneId)
                query.setString(2, boardId)
                query.setString(3, now)
                query.executeUpdate()
            }
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
