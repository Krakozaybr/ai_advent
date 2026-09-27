package ai.advent.v3

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.UUID

/** External-to-board database for board-scoped working and long-term memory. */
class MemoryStore(private val file: Path) {
    val databasePath: String get() = file.toAbsolutePath().toString()

    init {
        Files.createDirectories(file.toAbsolutePath().parent)
        Class.forName("org.sqlite.JDBC")
        connect().use { db ->
            db.createStatement().use { statement ->
                statement.execute("PRAGMA journal_mode=WAL")
                statement.execute("CREATE TABLE IF NOT EXISTS working_memories (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(board_id,name))")
                statement.execute("CREATE TABLE IF NOT EXISTS memory_items (board_id TEXT NOT NULL, layer TEXT NOT NULL CHECK(layer IN ('working','longTerm')), memory_name TEXT NOT NULL, memory_key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(board_id,layer,memory_name,memory_key))")
            }
        }
    }

    fun state(boardId: String): JsonObject = connect().use { db ->
        buildJsonObject {
            put("workingMemories", JsonArray(db.prepareStatement("SELECT id,name,created_at FROM working_memories WHERE board_id=? ORDER BY name").use { query ->
                query.setString(1, boardId)
                query.executeQuery().use { result -> buildList { while (result.next()) add(buildJsonObject {
                    put("id", result.getString("id")); put("name", result.getString("name")); put("createdAt", result.getString("created_at"))
                    put("items", items(db, boardId, "working", result.getString("name")))
                }) }
            } }))
            put("longTerm", items(db, boardId, "longTerm", ""))
        }
    }

    fun createWorkingMemory(boardId: String, name: String): JsonObject {
        require(name.isNotBlank() && name.length <= 80) { "Имя рабочей памяти должно содержать от 1 до 80 символов." }
        connect().use { db -> db.prepareStatement("INSERT INTO working_memories(id,board_id,name,created_at) VALUES(?,?,?,?)").use { query ->
            query.setString(1, UUID.randomUUID().toString()); query.setString(2, boardId); query.setString(3, name.trim()); query.setString(4, Instant.now().toString()); query.executeUpdate()
        } }
        return state(boardId)
    }

    fun validateProposal(boardDatabasePath: String, laneId: String, layer: String, memoryName: String?) {
        validateLayer(layer)
        val boardId = boardForLaneScope(boardDatabasePath, laneId)
        connect().use { db ->
            if (layer == "working") requireWorkingMemory(db, boardId, memoryName.orEmpty())
            else require(memoryName == null) { "У долговременной памяти нет имени рабочей памяти." }
        }
    }

    fun upsert(boardId: String, layer: String, memoryName: String, key: String, value: String): JsonObject {
        validateItem(layer, key, value)
        connect().use { db ->
            if (layer == "working") requireWorkingMemory(db, boardId, memoryName)
            db.prepareStatement("INSERT INTO memory_items(board_id,layer,memory_name,memory_key,value,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(board_id,layer,memory_name,memory_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").use { query ->
                query.setString(1, boardId); query.setString(2, layer); query.setString(3, if (layer == "working") memoryName else ""); query.setString(4, key.trim()); query.setString(5, value.trim()); query.setString(6, Instant.now().toString()); query.executeUpdate()
            }
        }
        return state(boardId)
    }

    fun deleteItem(boardId: String, layer: String, memoryName: String, key: String): JsonObject = connect().use { db ->
        validateLayer(layer)
        if (layer == "working") requireWorkingMemory(db, boardId, memoryName)
        db.prepareStatement("DELETE FROM memory_items WHERE board_id=? AND layer=? AND memory_name=? AND memory_key=?").use { query ->
            query.setString(1, boardId); query.setString(2, layer); query.setString(3, if (layer == "working") memoryName else ""); query.setString(4, key); query.executeUpdate()
        }
        state(boardId)
    }

    fun deleteWorkingMemory(boardId: String, name: String): JsonObject = connect().use { db ->
        requireWorkingMemory(db, boardId, name)
        db.autoCommit = false
        try {
            db.prepareStatement("DELETE FROM memory_items WHERE board_id=? AND layer='working' AND memory_name=?").use { it.setString(1, boardId); it.setString(2, name); it.executeUpdate() }
            db.prepareStatement("DELETE FROM working_memories WHERE board_id=? AND name=?").use { it.setString(1, boardId); it.setString(2, name); it.executeUpdate() }
            db.commit()
        } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true }
        state(boardId)
    }

    fun clear(boardId: String, layer: String, memoryName: String? = null): JsonObject = connect().use { db ->
        validateLayer(layer)
        if (layer == "working") requireWorkingMemory(db, boardId, memoryName.orEmpty())
        db.prepareStatement("DELETE FROM memory_items WHERE board_id=? AND layer=? AND memory_name=?").use { query ->
            query.setString(1, boardId); query.setString(2, layer); query.setString(3, if (layer == "working") memoryName else ""); query.executeUpdate()
        }
        state(boardId)
    }

    fun boardForLaneScope(boardDatabasePath: String, laneId: String): String = DriverManager.getConnection("jdbc:sqlite:$boardDatabasePath").use { db ->
        db.prepareStatement("SELECT board_id FROM lanes WHERE id=?").use { query ->
            query.setString(1, laneId); query.executeQuery().use { result -> check(result.next()) { "Unknown lane" }; result.getString(1) }
        }
    }

    private fun items(db: Connection, boardId: String, layer: String, memoryName: String) = JsonArray(
        db.prepareStatement("SELECT memory_key,value,updated_at FROM memory_items WHERE board_id=? AND layer=? AND memory_name=? ORDER BY memory_key").use { query ->
            query.setString(1, boardId); query.setString(2, layer); query.setString(3, memoryName)
            query.executeQuery().use { result -> buildList { while (result.next()) add(buildJsonObject {
                put("key", result.getString("memory_key")); put("value", result.getString("value")); put("updatedAt", result.getString("updated_at"))
            }) } }
        },
    )

    private fun requireWorkingMemory(db: Connection, boardId: String, name: String) {
        check(db.prepareStatement("SELECT 1 FROM working_memories WHERE board_id=? AND name=?").use { query ->
            query.setString(1, boardId); query.setString(2, name); query.executeQuery().use { it.next() }
        }) { "Рабочая память не найдена на этой доске." }
    }

    private fun validateItem(layer: String, key: String, value: String) {
        validateLayer(layer)
        require(key.isNotBlank() && key.length <= 100 && value.isNotBlank() && value.length <= 4000) { "Ключ или значение памяти некорректны." }
    }

    private fun validateLayer(layer: String) = require(layer in setOf("working", "longTerm")) { "Неизвестный слой памяти." }

    private fun connect(): Connection = DriverManager.getConnection("jdbc:sqlite:${file.toAbsolutePath()}").also { connection ->
        connection.createStatement().use { it.execute("PRAGMA busy_timeout=5000") }
    }
}
