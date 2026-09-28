package ai.advent.v3

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertContains
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class WorkspaceStoreTest {
    @Test
    fun `new session requires provider choice only when requested`() {
        val database = Files.createTempDirectory("workspace-provider-choice-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val newBoard = store.createBoard(requiresProviderChoice = true)
        val first = newBoard["lanes"]!!.jsonArray.first().jsonObject
        assertEquals("false", first["providerChosen"]!!.jsonPrimitive.content)
        val firstId = first["id"]!!.jsonPrimitive.content
        assertFailsWith<IllegalStateException> { store.startRun(firstId, "Запрос") }
        val chosen = store.chooseProvider(firstId, "openrouter")["lanes"]!!.jsonArray.first().jsonObject
        assertEquals("openrouter", chosen["provider"]!!.jsonPrimitive.content)
        assertEquals("true", chosen["providerChosen"]!!.jsonPrimitive.content)
        assertFailsWith<IllegalStateException> { store.chooseProvider(firstId, "codex") }

        val legacy = store.createLane(boardId, "codex")["lanes"]!!.jsonArray.last().jsonObject
        assertEquals("true", legacy["providerChosen"]!!.jsonPrimitive.content)
        store.close()
    }

    @Test
    fun `empty optional Codex request settings use provider defaults`() {
        val database = Files.createTempDirectory("workspace-codex-defaults-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.createLane(boardId, "codex")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content

        val run = store.startRun(laneId, "Короткий запрос", RequestOverrides(effort = "", serviceTier = ""))
        assertEquals(null, run.config.effort)
        assertEquals(null, run.config.serviceTier)
        store.completeRun(run.runId)
        store.close()
    }

    @Test
    fun `deleted board is hidden after restart and lane subtree deletion keeps another root`() {
        val database = Files.createTempDirectory("workspace-deletion-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val rootId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        assertFailsWith<IllegalStateException> { store.deleteLaneTree(rootId) }
        val run = store.startRun(rootId, "Исходное сообщение")
        store.completeRun(run.runId)
        val sourceId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["messages"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        store.branchLane(rootId, sourceId)
        store.createLane(boardId, "codex")
        store.deleteLaneTree(rootId)
        assertEquals(1, store.board(boardId)["lanes"]!!.jsonArray.size)
        store.deleteBoard(boardId)
        assertEquals(0, store.boards().size)
        store.close()

        val reopened = WorkspaceStore(database)
        assertEquals(0, reopened.boards().size)
        assertFailsWith<IllegalStateException> { reopened.board(boardId) }
        reopened.close()
    }
    @Test
    fun `test workspace appearance and archive state survive restart`() {
        val database = Files.createTempDirectory("workspace-appearance-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content

        store.setBoardArchived(boardId, true)
        store.renameLane(laneId, "Планирование")
        store.setLaneArchived(laneId, true)
        store.setGroupColor(laneId, "#A8CBB5")
        assertFailsWith<IllegalArgumentException> { store.setGroupColor(laneId, "red") }
        store.close()

        val reopened = WorkspaceStore(database)
        val board = reopened.board(boardId)
        assertEquals("true", board["board"]!!.jsonObject["archived"]!!.jsonPrimitive.content)
        val lane = board["lanes"]!!.jsonArray.first().jsonObject
        assertEquals("Планирование", lane["title"]!!.jsonPrimitive.content)
        assertEquals("true", lane["archived"]!!.jsonPrimitive.content)
        assertEquals("#a8cbb5", lane["groupColor"]!!.jsonPrimitive.content)
        reopened.close()
    }

    @Test
    fun `test queued messages survive restart and start in order with their request settings`() {
        val database = Files.createTempDirectory("workspace-message-queue-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        store.saveSkills(laneId, listOf("files"))
        store.enqueueMessage(laneId, "Первый запрос", RequestOverrides(model = "model-one", contextStrategy = "sliding_window", contextWindowSize = 5, contextBudgetTokens = 2_048, skillIds = listOf("planning")))
        store.enqueueMessage(laneId, "Второй запрос", RequestOverrides(model = "model-two"))
        assertEquals(2, store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["queuedMessages"]!!.jsonArray.size)
        store.close()

        val reopened = WorkspaceStore(database)
        val lane = reopened.board(boardId)["lanes"]!!.jsonArray.first().jsonObject
        assertEquals(listOf("files"), lane["skills"]!!.jsonArray.map { it.jsonPrimitive.content })
        val first = reopened.startNextQueuedRun(laneId)!!
        assertEquals("Первый запрос", first.prompt)
        assertEquals("model-one", first.config.model)
        assertEquals("sliding_window", first.contextStrategy.wireName)
        assertContains(first.effectiveInstructions, "Навык «Планирование»")
        assertFalse(first.effectiveInstructions.contains("Навык «Работа с файлами»"))
        assertEquals(1, reopened.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["queuedMessages"]!!.jsonArray.size)
        assertFailsWith<ActiveRunException> { reopened.startNextQueuedRun(laneId) }
        reopened.completeRun(first.runId)

        val second = reopened.startNextQueuedRun(laneId)!!
        assertEquals("Второй запрос", second.prompt)
        assertEquals("model-two", second.config.model)
        assertContains(second.effectiveInstructions, "Навык «Работа с файлами»")
        reopened.completeRun(second.runId)
        assertEquals(0, reopened.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["queuedMessages"]!!.jsonArray.size)
        reopened.close()
    }

    @Test
    fun `model-created subagent is linked to the active assistant run and can be pinned`() {
        val database = Files.createTempDirectory("workspace-subagent-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val parentLaneId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        store.saveSkills(parentLaneId, listOf("planning"))
        val parentRun = store.startRun(parentLaneId, "Разложи работу")

        val child = store.createSubagentLane(parentRun.runId, "Проверка документации", "Проверь документацию")
        assertEquals(1, child.launchOrder)
        val childRun = store.startRun(child.laneId, "Проверь документацию")
        assertContains(childRun.effectiveInstructions, "Навык «Планирование»")
        assertFailsWith<IllegalArgumentException> {
            store.createSubagentLane(childRun.runId, "Вложенный", "Не допускается")
        }

        val board = store.board(boardId)
        val childLane = board["lanes"]!!.jsonArray.map { it.jsonObject }.first { it["id"]!!.jsonPrimitive.content == child.laneId }
        assertEquals("subagent", childLane["originKind"]!!.jsonPrimitive.content)
        assertEquals(parentLaneId, childLane["originLaneId"]!!.jsonPrimitive.content)
        assertEquals(parentRun.assistantMessageId, childLane["originMessageId"]!!.jsonPrimitive.content)
        assertEquals("false", childLane["subagentPinned"]!!.jsonPrimitive.content)

        store.updateSubagents(parentLaneId, expanded = true, pinnedIds = setOf(child.laneId))
        val updated = store.board(boardId)["lanes"]!!.jsonArray.map { it.jsonObject }.associateBy { it["id"]!!.jsonPrimitive.content }
        assertEquals("true", updated.getValue(parentLaneId)["subagentsExpanded"]!!.jsonPrimitive.content)
        assertEquals("true", updated.getValue(child.laneId)["subagentPinned"]!!.jsonPrimitive.content)

        store.completeRun(childRun.runId)
        store.completeRun(parentRun.runId)
        store.close()
    }

    @Test
    fun `board order follows creation time across imports new boards and restart`() {
        val directory = Files.createTempDirectory("workspace-board-order-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val expectedIds = mutableListOf(store.boards().first().jsonObject["id"]!!.jsonPrimitive.content)

        listOf("Импорт 1", "Импорт 2", "Импорт 3").forEachIndexed { index, title ->
            Thread.sleep(10)
            val imported = store.importPreparedBoard(
                ImportedBoard("external-$index", title, "", emptyList(), emptyList()),
            ).first
            expectedIds += imported["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        }

        Thread.sleep(10)
        val created = store.createBoard()
        expectedIds += created["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        assertEquals(expectedIds, store.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content })
        store.close()

        val reopened = WorkspaceStore(database)
        assertEquals(expectedIds, reopened.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content })
        assertEquals(
            listOf("Доска 1", "Импорт 1", "Импорт 2", "Импорт 3", "Доска 5"),
            reopened.boards().map { it.jsonObject["title"]!!.jsonPrimitive.content },
        )
        reopened.close()
    }

    @Test
    fun `board order uses board id as a stable tie breaker`() {
        val directory = Files.createTempDirectory("workspace-board-order-tie-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val primaryId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        repeat(3) { index ->
            store.importPreparedBoard(ImportedBoard("external-$index", "Импорт $index", "", emptyList(), emptyList()))
        }
        store.close()

        Files.list(directory.resolve("boards")).use { paths ->
            paths.filter { it.fileName.toString().endsWith(".sqlite") }.forEach { path ->
                java.sql.DriverManager.getConnection("jdbc:sqlite:$path").use { connection ->
                    connection.prepareStatement("UPDATE boards SET created_at = ?").use { statement ->
                        statement.setString(1, "2026-01-01T00:00:00Z")
                        statement.executeUpdate()
                    }
                }
            }
        }

        val reopened = WorkspaceStore(database)
        val orderedIds = reopened.boards().map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(primaryId, orderedIds.first())
        assertEquals(orderedIds.drop(1).sorted(), orderedIds.drop(1))
        reopened.close()
    }
}
