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

/** External, board-scoped task database shared by the UI API and local MCP server. */
class TaskStore(private val file: Path) {
    val databasePath: String get() = file.toAbsolutePath().toString()

    init {
        Files.createDirectories(file.toAbsolutePath().parent)
        Class.forName("org.sqlite.JDBC")
        connect().use { db -> db.createStatement().use { statement ->
            statement.execute("PRAGMA journal_mode=WAL")
            statement.execute("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')), stage TEXT NOT NULL DEFAULT 'planning' CHECK(stage IN ('planning','execution','validation','done')), plan TEXT NOT NULL DEFAULT '', plan_approved INTEGER NOT NULL DEFAULT 0 CHECK(plan_approved IN (0,1)), current_step TEXT NOT NULL DEFAULT '', expected_action TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(board_id,id))")
            statement.execute("CREATE TABLE IF NOT EXISTS task_comments (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, task_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(board_id,task_id) REFERENCES tasks(board_id,id))")
            statement.execute("CREATE INDEX IF NOT EXISTS tasks_board_updated ON tasks(board_id,updated_at DESC)")
            statement.execute("CREATE INDEX IF NOT EXISTS task_comments_lookup ON task_comments(board_id,task_id,created_at)")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_stage_guard BEFORE UPDATE OF stage ON tasks WHEN OLD.stage != NEW.stage BEGIN SELECT CASE WHEN OLD.paused=1 THEN RAISE(ABORT,'Задача на паузе. Сначала продолжи её.') END; SELECT CASE WHEN NOT ((OLD.stage='planning' AND NEW.stage='execution') OR (OLD.stage='execution' AND NEW.stage='validation') OR (OLD.stage='validation' AND NEW.stage='done')) THEN RAISE(ABORT,'Недопустимый переход этапа: разрешена только следующая стадия.') END; SELECT CASE WHEN OLD.stage='planning' AND NEW.stage='execution' AND NEW.plan_approved != 1 THEN RAISE(ABORT,'Сначала составь и утверди план.') END; SELECT CASE WHEN OLD.stage='validation' AND NEW.stage='done' AND NEW.status != 'done' THEN RAISE(ABORT,'Задача не может быть завершена без этапа validation.') END; END")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_plan_edit_guard BEFORE UPDATE OF plan ON tasks WHEN OLD.plan != NEW.plan AND OLD.stage != 'planning' BEGIN SELECT RAISE(ABORT,'План можно менять только на этапе planning.'); END")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_plan_revoke AFTER UPDATE OF plan ON tasks WHEN OLD.plan != NEW.plan BEGIN UPDATE tasks SET plan_approved=0 WHERE id=NEW.id; END")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_plan_approval_guard BEFORE UPDATE OF plan_approved ON tasks WHEN OLD.plan_approved != NEW.plan_approved AND NEW.plan_approved=1 AND (NEW.plan='' OR NEW.stage!='planning') BEGIN SELECT RAISE(ABORT,'Утвердить можно только непустой план на этапе planning.'); END")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_plan_approval_edit_guard BEFORE UPDATE OF plan,plan_approved ON tasks WHEN OLD.plan != NEW.plan AND OLD.plan_approved != NEW.plan_approved AND NEW.plan_approved=1 BEGIN SELECT RAISE(ABORT,'Сначала сохрани план, затем утверди его отдельным действием.'); END")
            statement.execute("CREATE TRIGGER IF NOT EXISTS tasks_status_guard BEFORE UPDATE OF status ON tasks WHEN OLD.status != NEW.status AND (NEW.status!='done' OR NEW.stage!='done') BEGIN SELECT RAISE(ABORT,'Задачу нельзя завершить до этапа done после validation.'); END")
        } }
    }

    fun list(boardId: String): JsonObject = connect().use { db -> jsonTasks(db, boardId) }

    fun create(boardId: String, title: String, description: String): JsonObject {
        require(title.isNotBlank() && title.length <= 200) { "Название задачи должно содержать от 1 до 200 символов." }
        require(description.length <= 10_000) { "Описание слишком длинное." }
        val id = UUID.randomUUID().toString()
        val now = Instant.now().toString()
        connect().use { db -> db.prepareStatement("INSERT INTO tasks(id,board_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)").use {
            it.setString(1,id); it.setString(2,boardId); it.setString(3,title.trim()); it.setString(4,description.trim()); it.setString(5,now); it.setString(6,now); it.executeUpdate()
        } }
        return get(boardId, id)!!
    }

    fun get(boardId: String, taskId: String): JsonObject? = connect().use { db -> task(db, boardId, taskId) }

    fun update(boardId: String, taskId: String, title: String? = null, description: String? = null,
               plan: String? = null, approvePlan: Boolean? = null, stage: String? = null,
               currentStep: String? = null, expectedAction: String? = null, paused: Boolean? = null,
               status: String? = null, comment: String? = null): JsonObject {
        require(title == null || title.isNotBlank() && title.length <= 200) { "Название задачи должно содержать от 1 до 200 символов." }
        require(description == null || description.length <= 10_000) { "Описание слишком длинное." }
        require(plan == null || plan.length <= 10_000) { "План слишком длинный." }
        require(currentStep == null || currentStep.length <= 1000) { "Текущий шаг слишком длинный." }
        require(expectedAction == null || expectedAction.length <= 1000) { "Ожидаемое действие слишком длинное." }
        require(comment == null || comment.isNotBlank() && comment.length <= 4000) { "Комментарий должен содержать от 1 до 4000 символов." }
        require(stage == null || stage in setOf("planning", "execution", "validation", "done")) { "Неизвестный этап задачи." }
        require(status == null || status in setOf("open", "done")) { "Неизвестный статус задачи." }
        connect().use { db ->
            db.autoCommit = false
            try {
                db.prepareStatement("UPDATE tasks SET title=COALESCE(?,title),description=COALESCE(?,description),plan=COALESCE(?,plan),plan_approved=COALESCE(?,plan_approved),stage=COALESCE(?,stage),current_step=COALESCE(?,current_step),expected_action=COALESCE(?,expected_action),paused=COALESCE(?,paused),status=COALESCE(?,status),updated_at=? WHERE board_id=? AND id=?").use { q ->
                    q.setString(1,title?.trim()); q.setString(2,description?.trim()); q.setString(3,plan?.trim()); if (approvePlan == null) q.setNull(4, java.sql.Types.INTEGER) else q.setInt(4, if (approvePlan) 1 else 0)
                    q.setString(5,stage); q.setString(6,currentStep?.trim()); q.setString(7,expectedAction?.trim()); if (paused == null) q.setNull(8, java.sql.Types.INTEGER) else q.setInt(8, if (paused) 1 else 0)
                    q.setString(9,if (stage == "done") "done" else status); q.setString(10,Instant.now().toString()); q.setString(11,boardId); q.setString(12,taskId); check(q.executeUpdate() == 1) { "Задача не найдена на этой доске." }
                }
                if (comment != null) db.prepareStatement("INSERT INTO task_comments(id,board_id,task_id,content,created_at) VALUES(?,?,?,?,?)").use { q ->
                    q.setString(1,UUID.randomUUID().toString()); q.setString(2,boardId); q.setString(3,taskId); q.setString(4,comment.trim()); q.setString(5,Instant.now().toString()); q.executeUpdate()
                }
                db.commit()
            } catch (error: Exception) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
        return get(boardId, taskId)!!
    }

    private fun jsonTasks(db: Connection, boardId: String) = buildJsonObject {
        put("tasks", JsonArray(db.prepareStatement("SELECT id FROM tasks WHERE board_id=? ORDER BY updated_at DESC,id").use { q ->
            q.setString(1,boardId); q.executeQuery().use { rs -> buildList { while (rs.next()) add(task(db,boardId,rs.getString(1))!!) } }
        }))
    }

    private fun task(db: Connection, boardId: String, taskId: String): JsonObject? = db.prepareStatement("SELECT * FROM tasks WHERE board_id=? AND id=?").use { q ->
        q.setString(1,boardId); q.setString(2,taskId); q.executeQuery().use { rs -> if (!rs.next()) null else buildJsonObject {
            put("id",rs.getString("id")); put("boardId",rs.getString("board_id")); put("title",rs.getString("title")); put("description",rs.getString("description")); put("status",rs.getString("status")); put("stage",rs.getString("stage")); put("plan",rs.getString("plan")); put("planApproved",rs.getInt("plan_approved") == 1); put("currentStep",rs.getString("current_step")); put("expectedAction",rs.getString("expected_action")); put("paused",rs.getInt("paused") == 1); put("createdAt",rs.getString("created_at")); put("updatedAt",rs.getString("updated_at"))
            put("comments",JsonArray(db.prepareStatement("SELECT content,created_at FROM task_comments WHERE board_id=? AND task_id=? ORDER BY created_at,id").use { comments -> comments.setString(1,boardId); comments.setString(2,taskId); comments.executeQuery().use { rows -> buildList { while (rows.next()) add(buildJsonObject { put("content",rows.getString(1)); put("createdAt",rows.getString(2)) }) } } }))
        } }
    }

    private fun connect(): Connection = DriverManager.getConnection("jdbc:sqlite:${file.toAbsolutePath()}").also { db -> db.createStatement().use { it.execute("PRAGMA busy_timeout=5000"); it.execute("PRAGMA foreign_keys=ON") } }
}
