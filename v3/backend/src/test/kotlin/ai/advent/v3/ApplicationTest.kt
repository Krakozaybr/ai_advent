package ai.advent.v3

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.delete
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import java.nio.file.Files
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicInteger

class ApplicationTest {
    @Test
    fun `test streamed answer is saved and restored with the Codex session`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }

        val initialBoard = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val lane = initialBoard["lanes"]!!.jsonArray[0].jsonObject
        val laneId = lane["id"]!!.jsonPrimitive.content
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Привет"}""")
        }
        assertEquals(HttpStatusCode.Accepted, response.status)
        val runId = response.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
            .getValue("runId").jsonPrimitive.content
        fake.finished.await()

        val stream = client.get("/api/runs/$runId/events").bodyAsText()
        assertTrue(stream.contains("\"type\":\"text.delta\""))
        assertTrue(stream.contains("Привет, "))
        assertTrue(stream.contains("мир"))
        assertTrue(stream.contains("\"type\":\"run.completed\""))

        val finalBoard = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val messages = finalBoard["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray
        assertEquals("Привет, мир", messages.last().jsonObject["content"]!!.jsonPrimitive.content)

        val restored = WorkspaceStore(database)
        val restoredBoardId = restored.boards()[0].jsonObject["id"]!!.jsonPrimitive.content
        val restoredLane = restored.board(restoredBoardId)["lanes"]!!.jsonArray[0].jsonObject
        assertEquals("fake-codex-thread-1", restoredLane["codexThreadId"]!!.jsonPrimitive.content)
        assertEquals(messages.size, restoredLane["messages"]!!.jsonArray.size)
        restored.close()
    }

    @Test
    fun `test a lane rejects a second active request`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer(blockUntilReleased = true)
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val laneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        val first = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Первый запрос"}""")
        }
        assertEquals(HttpStatusCode.Accepted, first.status)
        fake.started.await()
        val activeBoard = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val activeMessageId = activeBoard["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray[0]
            .jsonObject["id"]!!.jsonPrimitive.content
        val branchDuringRun = client.post("/api/lanes/$laneId/branches") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"messageId":"$activeMessageId"}""")
        }
        assertEquals(HttpStatusCode.Conflict, branchDuringRun.status)
        assertEquals(HttpStatusCode.Conflict, client.post("/api/lanes/$laneId/clone").status)
        assertEquals(HttpStatusCode.Conflict, client.patch("/api/messages/$activeMessageId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"content":"Изменение во время запроса"}""")
        }.status)
        assertEquals(HttpStatusCode.Conflict, client.delete("/api/messages/$activeMessageId").status)
        val second = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Второй запрос"}""")
        }
        assertEquals(HttpStatusCode.Conflict, second.status)

        fake.release.complete(Unit)
        fake.finished.await()
    }

    @Test
    fun `test failed app-server turn stays a failed run`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer(failTurn = true)
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val laneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Ошибка"}""")
        }
        val runId = response.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
            .getValue("runId").jsonPrimitive.content
        fake.finished.await()
        val stream = client.get("/api/runs/$runId/events").bodyAsText()

        assertTrue(stream.contains("\"type\":\"run.failed\""))
        assertFalse(stream.contains("\"type\":\"run.completed\""))
        val copy = client.post("/api/lanes/$laneId/clone").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject
        val copiedAnswer = copy["lanes"]!!.jsonArray[1].jsonObject["messages"]!!.jsonArray[1].jsonObject
        assertEquals("partial", copiedAnswer["content"]!!.jsonPrimitive.content)
        assertEquals("failed", copiedAnswer["runStatus"]!!.jsonPrimitive.content)
        assertEquals("Fake Codex failure", copiedAnswer["runError"]!!.jsonPrimitive.content)
    }
    @Test
    fun `test creating a board retains the original SQLite database`() = testApplication {
        val directory = Files.createTempDirectory("ai-advent-v3-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        application { module(store, FakeCodexAppServer()) }

        val first = client.get("/api/boards").bodyAsText().let(Json::parseToJsonElement)
            .jsonObject["boards"]!!.jsonArray[0].jsonObject
        val originalId = first["id"]!!.jsonPrimitive.content
        val originalLaneId = client.get("/api/boards/$originalId").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val originalMessage = client.post("/api/lanes/$originalLaneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Сохранённый запрос"}""")
        }
        assertEquals(HttpStatusCode.Accepted, originalMessage.status)
        val originalRunId = originalMessage.bodyAsText().let(Json::parseToJsonElement)
            .jsonObject["runId"]!!.jsonPrimitive.content
        // A normal request completes before the second database is created.
        while (!store.isTerminal(originalRunId)) kotlinx.coroutines.delay(10)
        val originalMessages = client.get("/api/boards/$originalId").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray
        assertTrue(Files.exists(database))
        val created = client.post("/api/boards")
        assertEquals(HttpStatusCode.Created, created.status)
        val second = created.bodyAsText().let(Json::parseToJsonElement).jsonObject["board"]!!.jsonObject
        assertTrue(second["id"]!!.jsonPrimitive.content != originalId)
        assertEquals(1L, Files.list(directory.resolve("boards")).use { it.count() })
        assertEquals(originalId, client.get("/api/boards/$originalId").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["board"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        val afterCreateMessages = client.get("/api/boards/$originalId").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray
        assertEquals(originalMessages.map { it.jsonObject["content"] }, afterCreateMessages.map { it.jsonObject["content"] })
        assertTrue(Files.exists(database))
    }

    @Test
    fun `test separate lanes accept concurrent requests`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer(blockUntilReleased = true, expectedStreams = 2)
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val firstLaneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val expanded = client.post("/api/boards/$boardId/lanes")
        assertEquals(HttpStatusCode.Created, expanded.status)
        val secondLaneId = expanded.bodyAsText().let(Json::parseToJsonElement).jsonObject
            .getValue("lanes").jsonArray[1].jsonObject.getValue("id").jsonPrimitive.content

        suspend fun send(laneId: String) = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Запрос"}""")
        }

        assertEquals(HttpStatusCode.Accepted, send(firstLaneId).status)
        fake.started.await()
        assertEquals(HttpStatusCode.Accepted, send(secondLaneId).status)
        fake.allStarted.await()
        fake.release.complete(Unit)
        fake.finished.await()
    }

    @Test
    fun `test branch and clone keep independent snapshots and seed Codex from visible history`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-copy-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val sourceId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        suspend fun sendAndWait(laneId: String, prompt: String) {
            val response = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"$prompt"}""")
            }
            assertEquals(HttpStatusCode.Accepted, response.status)
            val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
            val deadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
            assertTrue(store.isTerminal(runId), "run $prompt did not finish")
        }

        sendAndWait(sourceId, "Первый вопрос")
        sendAndWait(sourceId, "Второй вопрос")
        val originalBoard = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val sourceLane = originalBoard["lanes"]!!.jsonArray[0].jsonObject
        val sourceMessages = sourceLane["messages"]!!.jsonArray
        val branchPointId = sourceMessages[1].jsonObject["id"]!!.jsonPrimitive.content

        val branchResponse = client.post("/api/lanes/$sourceId/branches") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"messageId":"$branchPointId"}""")
        }
        assertEquals(HttpStatusCode.Created, branchResponse.status)
        val branchBoard = branchResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject
        val branch = branchBoard["lanes"]!!.jsonArray[1].jsonObject
        val branchId = branch["id"]!!.jsonPrimitive.content
        val branchMessages = branch["messages"]!!.jsonArray
        assertEquals(2, branchMessages.size)
        assertEquals(sourceMessages.take(2).map { it.jsonObject["content"] }, branchMessages.map { it.jsonObject["content"] })
        assertTrue(sourceMessages.take(2).map { it.jsonObject["id"] }.none { sourceIdValue ->
            branchMessages.any { it.jsonObject["id"] == sourceIdValue }
        })
        assertEquals("branch", branch["originKind"]!!.jsonPrimitive.content)
        assertEquals(branchPointId, branch["originMessageId"]!!.jsonPrimitive.content)
        assertTrue(branch["x"]!!.jsonPrimitive.content.toInt() > sourceLane["x"]!!.jsonPrimitive.content.toInt())

        val cloneResponse = client.post("/api/lanes/$sourceId/clone")
        assertEquals(HttpStatusCode.Created, cloneResponse.status)
        val cloneBoard = cloneResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject
        val clone = cloneBoard["lanes"]!!.jsonArray[2].jsonObject
        val cloneId = clone["id"]!!.jsonPrimitive.content
        val cloneMessages = clone["messages"]!!.jsonArray
        assertEquals(sourceMessages.map { it.jsonObject["content"] }, cloneMessages.map { it.jsonObject["content"] })
        assertTrue(cloneMessages.map { it.jsonObject["id"] }.none { cloneMessageId ->
            sourceMessages.any { it.jsonObject["id"] == cloneMessageId }
        })
        assertEquals("clone", clone["originKind"]!!.jsonPrimitive.content)

        sendAndWait(sourceId, "Только родитель")
        sendAndWait(branchId, "Только ветка")
        sendAndWait(cloneId, "Только клон")
        val finalBoard = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val lanes = finalBoard["lanes"]!!.jsonArray
        assertEquals(6, lanes[0].jsonObject["messages"]!!.jsonArray.size)
        assertEquals(4, lanes[1].jsonObject["messages"]!!.jsonArray.size)
        assertEquals(6, lanes[2].jsonObject["messages"]!!.jsonArray.size)
        assertEquals("Только родитель", lanes[0].jsonObject["messages"]!!.jsonArray[4].jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals("Только ветка", lanes[1].jsonObject["messages"]!!.jsonArray[2].jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals("Только клон", lanes[2].jsonObject["messages"]!!.jsonArray[4].jsonObject["content"]!!.jsonPrimitive.content)

        val seededBranch = fake.runs.single { it.prompt == "Только ветка" }
        assertEquals(listOf("Первый вопрос", "Привет, мир"), seededBranch.contextToSeed.map { it.content })
        assertTrue(seededBranch.shouldSeedContext)
        val seededClone = fake.runs.single { it.prompt == "Только клон" }
        assertEquals(listOf("Первый вопрос", "Привет, мир", "Второй вопрос", "Привет, мир"), seededClone.contextToSeed.map { it.content })
        assertTrue(seededClone.shouldSeedContext)
        val resumedParent = fake.runs.single { it.prompt == "Только родитель" }
        assertFalse(resumedParent.shouldSeedContext)
        assertEquals(3, listOf(seededBranch.threadId, seededClone.threadId, resumedParent.threadId).toSet().size)
    }

    @Test
    fun `test edit delete and copy reset Codex to the visible target history`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-history-edit-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val initialBoard = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = initialBoard["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val sourceId = initialBoard["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        suspend fun sendAndWait(laneId: String, prompt: String) {
            val response = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"$prompt"}""")
            }
            assertEquals(HttpStatusCode.Accepted, response.status)
            val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
            val deadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
            assertTrue(store.isTerminal(runId), "run $prompt did not finish")
        }

        sendAndWait(sourceId, "Старый запрос")
        sendAndWait(sourceId, "Хвост")
        val before = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val originalMessages = before["lanes"]!!.jsonArray[0].jsonObject["messages"]!!.jsonArray
        val selectedId = originalMessages[0].jsonObject["id"]!!.jsonPrimitive.content
        val branch = client.post("/api/lanes/$sourceId/branches") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"messageId":"$selectedId"}""")
        }.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[1].jsonObject
        val clone = client.post("/api/lanes/$sourceId/clone").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[2].jsonObject

        val edit = client.patch("/api/messages/$selectedId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"content":"Исправленный запрос"}""")
        }
        assertEquals(HttpStatusCode.OK, edit.status)
        val editedLanes = edit.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray
        assertEquals(listOf("Исправленный запрос"), editedLanes[0].jsonObject["messages"]!!.jsonArray
            .map { it.jsonObject["content"]!!.jsonPrimitive.content })
        assertEquals(branch["messages"], editedLanes[1].jsonObject["messages"])
        assertEquals("Старый запрос", editedLanes[1].jsonObject["originMessage"]!!.jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals(clone["messages"], editedLanes[2].jsonObject["messages"])
        assertTrue(editedLanes[0].jsonObject["codexThreadId"] == null)

        sendAndWait(sourceId, "После правки")
        val afterEdit = fake.runs.single { it.prompt == "После правки" }
        assertTrue(afterEdit.shouldSeedContext)
        assertEquals(listOf("Исправленный запрос"), afterEdit.contextToSeed.map { it.content })
        assertTrue(afterEdit.threadId != fake.runs.first().threadId)

        val newLane = client.post("/api/boards/$boardId/lanes").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[3].jsonObject
        val targetId = newLane["id"]!!.jsonPrimitive.content
        val sameTarget = client.post("/api/lanes/$sourceId/messages/$selectedId/copy") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"targetLaneId":"$sourceId"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, sameTarget.status)
        val otherBoardId = client.post("/api/boards").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val otherBoardLaneId = client.post("/api/boards/$otherBoardId/lanes").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val crossBoardCopy = client.post("/api/lanes/$sourceId/messages/$selectedId/copy") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"targetLaneId":"$otherBoardLaneId"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, crossBoardCopy.status)
        sendAndWait(targetId, "Целевая история")
        val targetBoardBeforeCopy = client.get("/api/boards/$boardId").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject
        val targetBeforeCopy = targetBoardBeforeCopy["lanes"]!!.jsonArray[3].jsonObject
        val targetOriginalIds = targetBeforeCopy["messages"]!!.jsonArray.map { it.jsonObject["id"] }
        val sourceAssistant = editedLanes[1].jsonObject["messages"]!!.jsonArray.last().jsonObject
        val copiedResponse = client.post("/api/lanes/${branch["id"]!!.jsonPrimitive.content}/messages/${sourceAssistant["id"]!!.jsonPrimitive.content}/copy") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"targetLaneId":"$targetId"}""")
        }
        assertEquals(HttpStatusCode.OK, copiedResponse.status)
        val copiedLane = copiedResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[3].jsonObject
        val copied = copiedLane["messages"]!!.jsonArray.last().jsonObject
        assertEquals(sourceAssistant["content"], copied["content"])
        assertEquals(sourceAssistant["role"], copied["role"])
        assertTrue(copied["id"]!!.jsonPrimitive.content !in targetOriginalIds.map { it!!.jsonPrimitive.content })
        assertTrue(copiedLane["codexThreadId"] == null)
        sendAndWait(targetId, "После копирования")
        val afterCopy = fake.runs.single { it.prompt == "После копирования" }
        assertTrue(afterCopy.shouldSeedContext)
        assertEquals(listOf("Целевая история", "Привет, мир", sourceAssistant["content"]!!.jsonPrimitive.content),
            afterCopy.contextToSeed.map { it.content })

        val deletingId = copiedLane["messages"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val delete = client.delete("/api/messages/$deletingId")
        assertEquals(HttpStatusCode.OK, delete.status)
        val deletedTarget = delete.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[3].jsonObject
        assertTrue(deletedTarget["messages"]!!.jsonArray.isEmpty())
        assertTrue(deletedTarget["codexThreadId"] == null)
    }

    @Test
    fun `test a failed history seed starts a clean Codex thread on retry`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-seed-retry-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val sourceId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        suspend fun send(laneId: String, prompt: String) {
            val response = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"$prompt"}""")
            }
            assertEquals(HttpStatusCode.Accepted, response.status)
            val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
            val deadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
            assertTrue(store.isTerminal(runId), "run $prompt did not finish")
        }

        send(sourceId, "Original transcript")
        val clone = client.post("/api/lanes/$sourceId/clone").bodyAsText()
            .let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[1].jsonObject
        val cloneId = clone["id"]!!.jsonPrimitive.content
        fake.failNextSeed = true
        send(cloneId, "Первая попытка")
        val failedSeed = fake.runs.single { it.prompt == "Первая попытка" }
        assertTrue(failedSeed.shouldSeedContext)

        send(cloneId, "Повтор после сбоя")
        val retry = fake.runs.single { it.prompt == "Повтор после сбоя" }
        assertTrue(retry.shouldSeedContext)
        assertEquals(listOf("Original transcript", "Привет, мир", "Первая попытка"), retry.contextToSeed.map { it.content })
        assertTrue(retry.threadId != failedSeed.threadId)
        val final = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject
        assertEquals(6, final["lanes"]!!.jsonArray[1].jsonObject["messages"]!!.jsonArray.size)
    }

    @Test
    fun `test saved lane layout survives reopening the workspace`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-layout-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        application { module(store, FakeCodexAppServer()) }
        val initial = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val laneId = initial["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        val response = client.patch("/api/lanes/$laneId/layout") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"x":321,"y":654,"width":700}""")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        val reopened = WorkspaceStore(database)
        val reopenedBoard = reopened.board(initial["board"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        val persistedLane = reopenedBoard["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(321, persistedLane["x"]!!.jsonPrimitive.content.toInt())
        assertEquals(654, persistedLane["y"]!!.jsonPrimitive.content.toInt())
        assertEquals(700, persistedLane["width"]!!.jsonPrimitive.content.toInt())
        reopened.close()
    }

    @Test
    fun `test old board database migrates without replacing its lane or messages`() {
        val database = Files.createTempDirectory("ai-advent-v3-migration-").resolve("board.sqlite")
        Class.forName("org.sqlite.JDBC")
        DriverManager.getConnection("jdbc:sqlite:$database").use { db ->
            db.createStatement().use { statement ->
                statement.execute("CREATE TABLE boards(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL)")
                statement.execute("CREATE TABLE lanes(id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), title TEXT NOT NULL, codex_thread_id TEXT, created_at TEXT NOT NULL)")
                statement.execute("CREATE TABLE messages(id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lanes(id), role TEXT NOT NULL, content TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL)")
                statement.execute("INSERT INTO boards VALUES ('old-board', 'Старая доска', '2026-01-01T00:00:00Z')")
                statement.execute("INSERT INTO lanes VALUES ('old-lane', 'old-board', 'Лента 1', 'old-thread', '2026-01-01T00:00:00Z')")
                statement.execute("INSERT INTO lanes VALUES ('old-lane-2', 'old-board', 'Лента 2', NULL, '2026-01-02T00:00:00Z')")
                statement.execute("INSERT INTO messages VALUES ('old-message', 'old-lane', 'user', 'Не теряй меня', NULL, '2026-01-01T00:00:00Z')")
            }
        }

        val store = WorkspaceStore(database)
        val lanes = store.board("old-board")["lanes"]!!.jsonArray
        val lane = lanes[0].jsonObject
        assertEquals("old-lane", lane["id"]!!.jsonPrimitive.content)
        assertEquals("old-thread", lane["codexThreadId"]!!.jsonPrimitive.content)
        assertEquals("Не теряй меня", lane["messages"]!!.jsonArray.single().jsonObject["content"]!!.jsonPrimitive.content)
        assertTrue(lane["originKind"] == null)
        assertTrue(lanes[1].jsonObject["x"]!!.jsonPrimitive.content.toInt() > lanes[0].jsonObject["x"]!!.jsonPrimitive.content.toInt())
        store.close()
    }
}

private class FakeCodexAppServer(
    private val blockUntilReleased: Boolean = false,
    private val failTurn: Boolean = false,
    private val expectedStreams: Int = 1,
) : CodexGateway {
    val started = CompletableDeferred<Unit>()
    val allStarted = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val finished = CompletableDeferred<Unit>()
    private var startedCount = 0
    private var finishedCount = 0
    private val nextThreadId = AtomicInteger()
    val runs = java.util.Collections.synchronizedList(mutableListOf<CapturedRun>())
    var failNextSeed = false

    override suspend fun status() = CodexStatus(authenticated = true, planType = "pro")

    override suspend fun beginLogin() = CodexLogin("https://example.invalid/login")

    override suspend fun stream(
        threadId: String?,
        prompt: String,
        contextToSeed: List<ContextMessage>,
        shouldSeedContext: Boolean,
        onThreadId: suspend (String) -> Unit,
        onContextSeeded: suspend () -> Unit,
        onContextSeedFailed: suspend () -> Unit,
        onText: suspend (String) -> Unit,
    ) {
        val resolvedThreadId = threadId ?: "fake-codex-thread-${nextThreadId.incrementAndGet()}"
        onThreadId(resolvedThreadId)
        runs += CapturedRun(resolvedThreadId, prompt, contextToSeed, shouldSeedContext)
        if (shouldSeedContext && failNextSeed) {
            failNextSeed = false
            onContextSeedFailed()
            error("Fake Codex context injection failed")
        }
        if (shouldSeedContext) onContextSeeded()
        synchronized(this) {
            startedCount += 1
            started.complete(Unit)
            if (startedCount == expectedStreams) allStarted.complete(Unit)
        }
        try {
            if (blockUntilReleased) release.await()
            if (failTurn) {
                onText("partial")
                error("Fake Codex failure")
            }
            onText("Привет, ")
            delay(20)
            onText("мир")
        } finally {
            synchronized(this) {
                finishedCount += 1
                if (finishedCount == expectedStreams) finished.complete(Unit)
            }
        }
    }

    override fun close() = Unit

    data class CapturedRun(
        val threadId: String,
        val prompt: String,
        val contextToSeed: List<ContextMessage>,
        val shouldSeedContext: Boolean,
    )
}
