package ai.advent.v3

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Test
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TaskStoreTest {
    @Test
    fun `workflow guards, pause, comments, board isolation and restart persistence`() {
        val temp = Files.createTempDirectory("board-tasks")
        val file = temp.resolve("tasks.sqlite")
        var store = TaskStore(file)
        val boardA = "board-a"
        val boardB = "board-b"
        val task = store.create(boardA, "Собрать план", "Описание")
        val id = task["id"]!!.jsonPrimitive.content
        store.create(boardB, "Чужая задача", "")

        assertFailsWith<Exception> { store.update(boardA,id,stage="execution") }
        val withPlan = store.update(boardA,id,plan="Шаг 1. Уточнить требования")
        assertFalse(withPlan["planApproved"]!!.jsonPrimitive.content.toBoolean())
        assertFailsWith<Exception> { store.update(boardA,id,stage="execution") }
        store.update(boardA,id,approvePlan=true)
        store.update(boardA,id,paused=true,currentStep="Шаг 1",expectedAction="Собрать вводные",comment="Старт")
        assertFailsWith<Exception> { store.update(boardA,id,stage="execution") }
        store.update(boardA,id,paused=false)
        store.update(boardA,id,stage="execution")
        assertFailsWith<Exception> { store.update(boardA,id,stage="done") }
        store.update(boardA,id,stage="validation")
        assertFailsWith<Exception> { store.update(boardA,id,status="done") }
        store.update(boardA,id,stage="done")
        assertFailsWith<Exception> { store.update(boardA,id,status="open") }

        store = TaskStore(file)
        val resumed = store.get(boardA,id)!!
        assertEquals("done",resumed["stage"]!!.jsonPrimitive.content)
        assertEquals("done",resumed["status"]!!.jsonPrimitive.content)
        assertEquals("Шаг 1",resumed["currentStep"]!!.jsonPrimitive.content)
        assertEquals("Собрать вводные",resumed["expectedAction"]!!.jsonPrimitive.content)
        assertEquals("Старт",resumed["comments"]!!.jsonArray.single().jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals(1,store.list(boardB)["tasks"]!!.jsonArray.size)
        assertTrue(store.get(boardB,id) == null)
    }

    @Test
    fun `editing an approved plan revokes approval and concurrent connections preserve updates`() {
        val file = Files.createTempDirectory("board-tasks-concurrent").resolve("tasks.sqlite")
        val store = TaskStore(file)
        val task = store.create("board", "Задача", "")
        val id = task["id"]!!.jsonPrimitive.content
        assertFailsWith<Exception> { store.update("board",id,plan="Новый план",approvePlan=true) }
        store.update("board",id,plan="Первый план")
        store.update("board",id,approvePlan=true)
        store.update("board",id,plan="Новый план")
        assertFailsWith<Exception> { store.update("board",id,stage="execution") }
        store.update("board",id,approvePlan=true)
        val updates = (1..8).map { number -> Thread { store.update("board",id,comment="Комментарий $number") } }
        updates.forEach(Thread::start)
        updates.forEach(Thread::join)
        assertEquals(8,store.get("board",id)!!["comments"]!!.jsonArray.size)
    }

    @Test
    fun `MCP server sees only the board from trusted lane scope and database guards transitions`() {
        val root = generateSequence(java.nio.file.Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/board-tasks-server.mjs")) }
        val temp = Files.createTempDirectory("board-tasks-mcp")
        val workspace = WorkspaceStore(temp.resolve("board.sqlite"))
        val boardA = workspace.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneA = workspace.createLane(boardA,"openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val boardB = workspace.createBoard()["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val laneB = workspace.createLane(boardB,"openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val tasks = TaskStore(temp.resolve("tasks.sqlite"))
        val taskA = tasks.create(boardA,"Только A","")["id"]!!.jsonPrimitive.content
        tasks.create(boardB,"Только B","")
        val config = McpServerConfig("board-tasks","Tasks","","node",listOf(root.resolve("examples/mcp/board-tasks-server.mjs").toString()),root.toString(),mapOf("AI_ADVENT_V3_TASKS_DB" to tasks.databasePath))
        val client = McpClient()
        val scopedA = scopedMcpServer(config,workspace.laneDatabasePath(laneA),laneA,temp.resolve("memory.sqlite").toString())
        val scopedB = scopedMcpServer(config,workspace.laneDatabasePath(laneB),laneB,temp.resolve("memory.sqlite").toString())
        val tools = client.listTools(scopedA)
        assertTrue(tools.single { it.name == "tasks_propose_update" }.readOnly.not())
        assertEquals(1,client.call(scopedA,"tasks_list",buildJsonObject {})["structuredContent"]!!.jsonObject["tasks"]!!.jsonArray.size)
        assertEquals(1,client.call(scopedB,"tasks_list",buildJsonObject {})["structuredContent"]!!.jsonObject["tasks"]!!.jsonArray.size)
        assertFailsWith<IllegalStateException> { client.call(scopedA,"tasks_propose_update",buildJsonObject { put("taskId",taskA); put("stage","execution"); put("reason","Пропуск плана") }) }
        workspace.close()
    }
}
