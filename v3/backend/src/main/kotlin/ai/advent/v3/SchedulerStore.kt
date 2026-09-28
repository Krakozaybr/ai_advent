package ai.advent.v3

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.StandardOpenOption
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.UUID

fun interface SchedulerClock { fun nowMillis(): Long }

class SchedulerAlreadyRunningException : IllegalStateException("Другой backend уже владеет этим планировщиком.")
class ScheduleRunningException : IllegalStateException("Дождись завершения текущего запуска перед удалением расписания.")

/** Durable board-scoped schedules and an idempotent local read-only aggregation runner. */
class SchedulerStore(private val file: Path, private val clock: SchedulerClock = SchedulerClock { System.currentTimeMillis() }) : Closeable {
    private val lock = Any()
    private val samples = listOf(12, 18, 15, 21, 14, 20, 16)
    private var agentRunner: ((String, String) -> JsonObject)? = null
    private lateinit var databaseFile: Path
    private lateinit var ownershipFile: Path
    private var ownershipChannel: FileChannel? = null
    private var ownershipLock: FileLock? = null
    @Volatile private var closed = false

    init {
        val requestedFile = file.toAbsolutePath().normalize()
        Files.createDirectories(requestedFile.parent)
        databaseFile = if (Files.exists(requestedFile)) requestedFile.toRealPath() else requestedFile.parent.toRealPath().resolve(requestedFile.fileName)
        ownershipFile = databaseFile.resolveSibling("${databaseFile.fileName}.scheduler.lock")
        Class.forName("org.sqlite.JDBC")
        acquireOwnership()
        try {
            connect().use { db -> db.createStatement().use { statement ->
                statement.execute("PRAGMA journal_mode=WAL")
                statement.execute("""CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL,
                    repeat_every_ms INTEGER, next_run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                )""")
                statement.execute("CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at)")
                val columns = statement.executeQuery("PRAGMA table_info(schedules)").use { rows -> buildSet { while (rows.next()) add(rows.getString("name")) } }
                if ("agent_lane_id" !in columns) statement.execute("ALTER TABLE schedules ADD COLUMN agent_lane_id TEXT")
                if ("agent_prompt" !in columns) statement.execute("ALTER TABLE schedules ADD COLUMN agent_prompt TEXT")
                statement.execute("""CREATE TABLE IF NOT EXISTS schedule_runs (
                    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, board_id TEXT NOT NULL,
                    scheduled_for INTEGER NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
                    status TEXT NOT NULL, missed_count INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT, error TEXT, UNIQUE(schedule_id,scheduled_for)
                )""")
            } }
            recoverInterrupted()
        } catch (error: Exception) {
            releaseOwnership()
            throw error
        }
    }

    private fun acquireOwnership() {
        val channel = FileChannel.open(ownershipFile,StandardOpenOption.CREATE,StandardOpenOption.WRITE)
        try {
            val fileLock = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
            if (fileLock == null) throw SchedulerAlreadyRunningException()
            ownershipChannel = channel
            ownershipLock = fileLock
        } catch (error: Exception) {
            channel.close()
            throw error
        }
    }

    private fun requireOwnership() {
        check(!closed && ownershipLock?.isValid == true) { "Этот планировщик уже закрыт." }
    }

    private fun releaseOwnership() {
        try { ownershipLock?.release() } finally {
            ownershipLock = null
            ownershipChannel?.close()
            ownershipChannel = null
        }
    }

    private fun connect(): Connection = DriverManager.getConnection("jdbc:sqlite:$databaseFile?transaction_mode=IMMEDIATE&busy_timeout=5000")

    fun setAgentRunner(runner: (String, String) -> JsonObject) = synchronized(lock) { agentRunner = runner }

    fun create(boardId: String, title: String, delayMs: Long, repeatEveryMs: Long? = null, agentLaneId: String? = null, agentPrompt: String? = null): JsonObject = synchronized(lock) {
        requireOwnership()
        require(boardId.isNotBlank()) { "Доска не указана." }
        require(title.isNotBlank() && title.length <= 120) { "Название должно содержать от 1 до 120 символов." }
        require(delayMs in 250..86_400_000) { "Первый запуск должен быть через 250 мс — 24 часа." }
        require(repeatEveryMs == null || repeatEveryMs in 250..86_400_000) { "Интервал должен быть 250 мс — 24 часа." }
        require((agentLaneId == null && agentPrompt == null) || (!agentLaneId.isNullOrBlank() && !agentPrompt.isNullOrBlank() && agentPrompt.length <= 2_000)) { "Для запуска агента укажи ленту и задание до 2000 символов." }
        val now = clock.nowMillis()
        val id = UUID.randomUUID().toString()
        connect().use { db -> db.prepareStatement("INSERT INTO schedules(id,board_id,title,repeat_every_ms,next_run_at,status,created_at,updated_at,agent_lane_id,agent_prompt) VALUES(?,?,?,?,?,'active',?,?,?,?)").use {
            it.setString(1,id); it.setString(2,boardId); it.setString(3,title.trim()); if (repeatEveryMs == null) it.setNull(4,java.sql.Types.BIGINT) else it.setLong(4,repeatEveryMs)
            it.setLong(5,now+delayMs); it.setLong(6,now); it.setLong(7,now); it.setString(8,agentLaneId); it.setString(9,agentPrompt?.trim()); it.executeUpdate()
        } }
        read(boardId,id)!!
    }

    fun list(boardId: String): JsonObject = synchronized(lock) {
        connect().use { db -> db.prepareStatement("SELECT * FROM schedules WHERE board_id=? ORDER BY next_run_at,id").use { q ->
            q.setString(1,boardId); q.executeQuery().use { rs -> kotlinx.serialization.json.buildJsonObject { put("schedules", kotlinx.serialization.json.buildJsonArray { while(rs.next()) add(scheduleJson(rs)) }) } }
        } }
    }

    fun runs(boardId: String): JsonObject = synchronized(lock) {
        connect().use { db -> db.prepareStatement("SELECT r.*,s.title FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE r.board_id=? ORDER BY r.started_at DESC LIMIT 100").use { q ->
            q.setString(1,boardId); q.executeQuery().use { rs -> kotlinx.serialization.json.buildJsonObject { put("runs", kotlinx.serialization.json.buildJsonArray { while(rs.next()) add(runJson(rs)) }) } }
        } }
    }

    fun clearHistory(boardId: String): Int = synchronized(lock) {
        requireOwnership()
        connect().use { db -> db.prepareStatement("DELETE FROM schedule_runs WHERE board_id=? AND status!='running'").use { q ->
            q.setString(1,boardId); q.executeUpdate()
        } }
    }

    fun delete(boardId: String, id: String): Boolean = synchronized(lock) {
        requireOwnership()
        connect().use { db ->
            db.autoCommit = false
            try {
                val exists = db.prepareStatement("SELECT 1 FROM schedules WHERE board_id=? AND id=?").use { q ->
                    q.setString(1,boardId); q.setString(2,id); q.executeQuery().use { it.next() }
                }
                if (!exists) {
                    db.rollback()
                    false
                } else {
                    val running = db.prepareStatement("SELECT 1 FROM schedule_runs WHERE board_id=? AND schedule_id=? AND status='running' LIMIT 1").use { q ->
                        q.setString(1,boardId); q.setString(2,id); q.executeQuery().use { it.next() }
                    }
                    if (running) throw ScheduleRunningException()
                    db.prepareStatement("DELETE FROM schedule_runs WHERE board_id=? AND schedule_id=?").use { q ->
                        q.setString(1,boardId); q.setString(2,id); q.executeUpdate()
                    }
                    db.prepareStatement("DELETE FROM schedules WHERE board_id=? AND id=?").use { q ->
                        q.setString(1,boardId); q.setString(2,id); check(q.executeUpdate() == 1)
                    }
                    db.commit()
                    true
                }
            } catch (error: Exception) {
                db.rollback()
                throw error
            } finally { db.autoCommit = true }
        }
    }

    fun pause(boardId: String, id: String, paused: Boolean): JsonObject? = synchronized(lock) {
        requireOwnership()
        connect().use { db -> db.prepareStatement("UPDATE schedules SET status=?,updated_at=? WHERE board_id=? AND id=? AND status IN ('active','paused','running')").use { q ->
            q.setString(1,if(paused) "paused" else "active"); q.setLong(2,clock.nowMillis()); q.setString(3,boardId); q.setString(4,id); if(q.executeUpdate()!=1) return@synchronized null
        } }
        read(boardId,id)
    }

    private fun read(boardId: String,id: String): JsonObject? = connect().use { db -> db.prepareStatement("SELECT * FROM schedules WHERE board_id=? AND id=?").use { q -> q.setString(1,boardId); q.setString(2,id); q.executeQuery().use { rs -> if(rs.next()) scheduleJson(rs) else null } } }

    /** Claim one overdue schedule, then finish it after the task has ended. */
    fun runOneDue(): Boolean {
        val claimed = synchronized(lock) {
            requireOwnership()
            val now = clock.nowMillis()
            connect().use { db ->
            db.autoCommit = false
            try {
                val row = db.prepareStatement("SELECT * FROM schedules WHERE status='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 1").use { q -> q.setLong(1,now); q.executeQuery().use { rs -> if(rs.next()) ScheduleRow(rs.getString("id"),rs.getString("board_id"),rs.getString("title"),rs.getLong("repeat_every_ms").let { if(rs.wasNull()) null else it },rs.getLong("next_run_at"),rs.getString("agent_lane_id"),rs.getString("agent_prompt")) else null } }
                if (row == null) { db.rollback(); return@synchronized null }
                val missed = if (row.repeatEveryMs == null) 0 else ((now-row.nextRunAt)/row.repeatEveryMs).toInt()
                val exists = db.prepareStatement("SELECT id,status FROM schedule_runs WHERE schedule_id=? AND scheduled_for=?").use { q -> q.setString(1,row.id); q.setLong(2,row.nextRunAt); q.executeQuery().use { rs -> if(rs.next()) rs.getString("status") else null } }
                if (exists == null) db.prepareStatement("INSERT INTO schedule_runs(id,schedule_id,board_id,scheduled_for,started_at,status,missed_count) VALUES(?,?,?,?,?,'running',?)").use { q -> q.setString(1,UUID.randomUUID().toString()); q.setString(2,row.id); q.setString(3,row.boardId); q.setLong(4,row.nextRunAt); q.setLong(5,now); q.setInt(6,missed); q.executeUpdate() }
                else if (exists != "interrupted") { db.rollback(); return@synchronized null }
                if (exists == "interrupted") db.prepareStatement("UPDATE schedule_runs SET status='running',started_at=?,missed_count=?,error=NULL WHERE schedule_id=? AND scheduled_for=? AND status='interrupted'").use { q -> q.setLong(1,now); q.setInt(2,missed); q.setString(3,row.id); q.setLong(4,row.nextRunAt); q.executeUpdate() }
                db.prepareStatement("UPDATE schedules SET status='running',updated_at=? WHERE id=? AND status='active'").use { q -> q.setLong(1,now); q.setString(2,row.id); check(q.executeUpdate() == 1) }
                db.commit(); Claimed(row.id,row.boardId,row.nextRunAt,missed,row.repeatEveryMs,row.agentLaneId,row.agentPrompt)
            } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true }
            }
        }
        if (claimed == null) return false
        try { complete(claimed) }
        catch (error: Exception) { fail(claimed,error.message ?: "Не удалось выполнить расписание.") }
        return true
    }

    private fun complete(run: Claimed) {
        val average = (samples.average() * 100).toInt() / 100.0
        val result = if (run.agentLaneId != null && run.agentPrompt != null) {
            checkNotNull(agentRunner) { "Запуск агента не настроен на сервере." }(run.agentLaneId, run.agentPrompt)
        } else buildJsonObject {
            put("source", "local-demo-metrics"); put("sampleCount",samples.size); put("total",samples.sum()); put("average",average); put("minimum",samples.min()); put("maximum",samples.max()); put("missedCount",run.missed)
        }
        synchronized(lock) { connect().use { db -> db.autoCommit = false; try {
            val completedAt = clock.nowMillis()
            val updated = db.prepareStatement("UPDATE schedule_runs SET status='completed',completed_at=?,result_json=?,error=NULL WHERE schedule_id=? AND scheduled_for=? AND status IN ('running','interrupted')").use { q ->
                q.setLong(1,completedAt); q.setString(2,Json.encodeToString(JsonObject.serializer(),result)); q.setString(3,run.id); q.setLong(4,run.slot); q.executeUpdate()
            }
            check(updated == 1) { "Запуск расписания уже завершён или потерял захват." }
            finishSchedule(db, run, completedAt)
            db.commit()
        } catch(error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true } } }
    }

    private fun fail(run: Claimed, message: String) = synchronized(lock) {
        connect().use { db -> db.autoCommit = false; try {
            val completedAt = clock.nowMillis()
            db.prepareStatement("UPDATE schedule_runs SET status='failed',completed_at=?,error=? WHERE schedule_id=? AND scheduled_for=? AND status='running'").use { q ->
                q.setLong(1,completedAt); q.setString(2,message.take(500)); q.setString(3,run.id); q.setLong(4,run.slot); q.executeUpdate()
            }
            finishSchedule(db, run, completedAt)
            db.commit()
        } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true } }
    }

    private fun finishSchedule(db: Connection, run: Claimed, completedAt: Long) {
        if (run.repeatEveryMs == null) db.prepareStatement("UPDATE schedules SET status='completed',updated_at=? WHERE id=? AND status IN ('running','paused','active')").use { q ->
            q.setLong(1,completedAt); q.setString(2,run.id); q.executeUpdate()
        } else db.prepareStatement("UPDATE schedules SET next_run_at=?,status=CASE WHEN status='paused' THEN 'paused' ELSE 'active' END,updated_at=? WHERE id=? AND status IN ('running','paused','active')").use { q ->
            q.setLong(1,completedAt + run.repeatEveryMs); q.setLong(2,completedAt); q.setString(3,run.id); q.executeUpdate()
        }
    }

    fun tick(maxRuns: Int = 20): Int { var count=0; while(count<maxRuns && runOneDue()) count++; return count }

    private fun recoverInterrupted() = synchronized(lock) {
        connect().use { db -> db.autoCommit = false; try {
            val pending = db.prepareStatement("SELECT schedule_id,scheduled_for FROM schedule_runs WHERE status='running'").use { q -> q.executeQuery().use { rs -> buildList { while(rs.next()) add(rs.getString(1) to rs.getLong(2)) } } }
            db.prepareStatement("UPDATE schedule_runs SET status='interrupted',error='Backend остановился во время запуска' WHERE status='running'").use { it.executeUpdate() }
            pending.forEach { (scheduleId,slot) -> db.prepareStatement("UPDATE schedules SET status='active',next_run_at=MIN(next_run_at,?),updated_at=? WHERE id=? AND status!='paused'").use { q -> q.setLong(1,slot); q.setLong(2,clock.nowMillis()); q.setString(3,scheduleId); q.executeUpdate() } }
            db.commit()
        } catch(error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true } }
    }

    private data class ScheduleRow(val id:String,val boardId:String,val title:String,val repeatEveryMs:Long?,val nextRunAt:Long,val agentLaneId:String?,val agentPrompt:String?) {
        override fun toString(): String = super.toString()
    }
    private data class Claimed(val id:String,val boardId:String,val slot:Long,val missed:Int,val repeatEveryMs:Long?,val agentLaneId:String?,val agentPrompt:String?) {
        override fun toString(): String = super.toString()
    }
    private fun scheduleJson(rs: java.sql.ResultSet) = buildJsonObject {
        put("id",rs.getString("id")); put("boardId",rs.getString("board_id")); put("title",rs.getString("title")); rs.getLong("repeat_every_ms").let { if(!rs.wasNull()) put("repeatEveryMs",it) }
        put("nextRunAt",rs.getLong("next_run_at")); put("status",rs.getString("status")); put("createdAt",Instant.ofEpochMilli(rs.getLong("created_at")).toString())
        rs.getString("agent_lane_id")?.let { put("agentLaneId",it) }
    }
    private fun runJson(rs: java.sql.ResultSet) = buildJsonObject {
        put("id",rs.getString("id")); put("scheduleId",rs.getString("schedule_id")); put("title",rs.getString("title")); put("scheduledFor",rs.getLong("scheduled_for")); put("startedAt",rs.getLong("started_at")); rs.getLong("completed_at").let { if(!rs.wasNull()) put("completedAt",it) }
        put("status",rs.getString("status")); put("missedCount",rs.getInt("missed_count")); rs.getString("result_json")?.let { put("result",Json.parseToJsonElement(it)) }; rs.getString("error")?.let { put("error",it) }
    }
    override fun close() = synchronized(lock) {
        if (closed) return@synchronized
        closed = true
        releaseOwnership()
    }
}
