package ai.advent.v3

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.delete
import io.ktor.client.request.setBody
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.HttpClient
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicInteger

class ApplicationTest {
    @Test
    fun `board task API validates workflow and returns the rejection reason`() = testApplication {
        val directory = Files.createTempDirectory("board-tasks-api")
        val store = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        application { module(store, FakeCodexAppServer(), memoryStore = MemoryStore(directory.resolve("memory.sqlite")), taskStore = TaskStore(directory.resolve("tasks.sqlite"))) }

        val invalidTitle = client.post("/api/boards/$boardId/tasks") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"title":{"unexpected":"object"}}""")
        }
        assertEquals(HttpStatusCode.BadRequest, invalidTitle.status, invalidTitle.bodyAsText())

        val created = client.post("/api/boards/$boardId/tasks") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"title":"Релиз","description":"Подготовить релиз"}""")
        }
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        val task = Json.parseToJsonElement(created.bodyAsText()).jsonObject
        val id = task["id"]!!.jsonPrimitive.content
        val invalidPlan = client.patch("/api/boards/$boardId/tasks/$id") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"plan":{"unexpected":"object"}}""")
        }
        assertEquals(HttpStatusCode.BadRequest, invalidPlan.status, invalidPlan.bodyAsText())
        val skipped = client.patch("/api/boards/$boardId/tasks/$id") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"stage":"execution"}""")
        }
        assertEquals(HttpStatusCode.Conflict, skipped.status)
        assertTrue(skipped.bodyAsText().contains("непустой план"))
        client.patch("/api/boards/$boardId/tasks/$id") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"plan":"Собрать и проверить"}""")
        }
        client.patch("/api/boards/$boardId/tasks/$id") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"approvePlan":true}""")
        }
        val execution = client.patch("/api/boards/$boardId/tasks/$id") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"stage":"execution","currentStep":"Собрать"}""")
        }
        assertEquals(HttpStatusCode.OK, execution.status, execution.bodyAsText())
        assertEquals("execution", Json.parseToJsonElement(execution.bodyAsText()).jsonObject["stage"]!!.jsonPrimitive.content)
    }

    @Test
    fun `task MCP read autoapprove and manual approval use trusted application scope`() = testApplication {
        val directory = Files.createTempDirectory("board-tasks-mcp-application")
        val store = WorkspaceStore(directory.resolve("board.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.createLane(boardId,"openrouter")["lanes"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content
        val tasks = TaskStore(directory.resolve("tasks.sqlite"))
        val taskId = tasks.create(boardId,"Исходная задача","")["id"]!!.jsonPrimitive.content
        store.saveMcpTools(laneId,listOf(McpSelection("board-tasks","tasks_list"),McpSelection("board-tasks","tasks_propose_update")))
        val root = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isRegularFile(it.resolve("examples/mcp/board-tasks-server.mjs")) }
        val server = McpServerConfig("board-tasks","Задачи доски","test","node",
            listOf(root.resolve("examples/mcp/board-tasks-server.mjs").toString()),root.toString(),
            mapOf("AI_ADVENT_V3_TASKS_DB" to tasks.databasePath))
        val gateway = TaskMcpGateway(listOf(
            "tasks_list" to "{}",
            "tasks_propose_update" to """{"taskId":"$taskId","title":"Обновлено напрямую","reason":"Проверка autoapprove"}""",
            "tasks_propose_update" to """{"taskId":"$taskId","title":"Обновлено после approval","reason":"Проверка подтверждения"}""",
        ))
        val keys = OpenRouterKeyStore(directory.resolve("openrouter.key")).also { it.save("test-key") }
        application {
            module(store, FakeCodexAppServer(), openRouter = gateway, openRouterKeys = keys,
                mcpRegistry = McpRegistry(listOf(server)), memoryStore = MemoryStore(directory.resolve("memory.sqlite")),
                taskStore = tasks, schedulerStore = SchedulerStore(directory.resolve("schedules.sqlite")))
        }

        suspend fun run(prompt: String): String {
            val accepted = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString()); setBody("""{"text":"$prompt"}""")
            }
            assertEquals(HttpStatusCode.Accepted,accepted.status,accepted.bodyAsText())
            val runId = Json.parseToJsonElement(accepted.bodyAsText()).jsonObject["runId"]!!.jsonPrimitive.content
            withTimeout(5_000) { while (!store.isTerminal(runId)) delay(20) }
            return runId
        }

        run("Прочитай задачи")
        var calls = store.laneSnapshot(laneId)["messages"]!!.jsonArray.map { it.jsonObject }
            .last { it["role"]?.jsonPrimitive?.content == "assistant" }["technicalDetails"]!!.jsonObject["toolCalls"]!!.jsonArray
        assertEquals(true,calls.single().jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
        assertTrue(calls.single().jsonObject["result"].toString().contains("Исходная задача"))

        store.setMcpAutoApprove(laneId,true)
        run("Измени задачу автоматически")
        assertEquals("Обновлено напрямую",tasks.get(boardId,taskId)!!["title"]!!.jsonPrimitive.content)
        var approvals = store.laneSnapshot(laneId)["mcpApprovals"]!!.jsonArray
        assertEquals("lane-autoapprove",approvals.last().jsonObject["approvalSource"]!!.jsonPrimitive.content)

        store.setMcpAutoApprove(laneId,false)
        run("Предложи изменение")
        approvals = store.laneSnapshot(laneId)["mcpApprovals"]!!.jsonArray
        val pending = approvals.first { it.jsonObject["status"]!!.jsonPrimitive.content == "pending" }.jsonObject
        assertEquals("Обновлено напрямую",tasks.get(boardId,taskId)!!["title"]!!.jsonPrimitive.content)
        val approved = client.post("/api/lanes/$laneId/mcp-approvals/${pending["id"]!!.jsonPrimitive.content}") {
            header(HttpHeaders.ContentType,ContentType.Application.Json.toString()); setBody("""{"decision":"approve"}""")
        }
        assertEquals(HttpStatusCode.OK,approved.status,approved.bodyAsText())
        assertEquals("approved",store.approval(laneId,pending["id"]!!.jsonPrimitive.content)!!["status"]!!.jsonPrimitive.content)
        assertEquals("Обновлено после approval",tasks.get(boardId,taskId)!!["title"]!!.jsonPrimitive.content)
    }

    @Test
    fun `uncertain MCP approval can be closed through API without retrying it`() = testApplication {
        val directory = Files.createTempDirectory("approval-uncertain-api")
        val database = directory.resolve("board.sqlite")
        var store = WorkspaceStore(database)
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        val laneId = store.board(boardId)["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val approvalId = store.addMcpApproval(laneId, "sticky-facts", "update_fact", buildJsonObject {}, "restart", null)
        assertTrue(store.claimApproval(laneId, approvalId) != null)
        store.close()

        store = WorkspaceStore(database)
        application { module(store, FakeCodexAppServer(), memoryStore = MemoryStore(directory.resolve("memory.sqlite"))) }
        val response = client.post("/api/lanes/$laneId/mcp-approvals/$approvalId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"decision":"close_uncertain"}""")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        val responseLane = Json.parseToJsonElement(response.bodyAsText()).jsonObject["lanes"]!!.jsonArray.first().jsonObject
        val approval = responseLane["mcpApprovals"]!!.jsonArray.single().jsonObject
        assertEquals("uncertain_closed", approval["status"]!!.jsonPrimitive.content)
        assertEquals("uncertain_closed", store.approval(laneId, approvalId)!!["status"]!!.jsonPrimitive.content)
        assertTrue(store.claimApproval(laneId, approvalId) == null, "Closing an interrupted approval must not make it executable again")
    }

    @Test
    fun `working memory named dash remains separate from board long term memory in API mutations`() = testApplication {
        val directory = Files.createTempDirectory("working-memory-dash")
        val store = WorkspaceStore(directory.resolve("board.sqlite"))
        val memory = MemoryStore(directory.resolve("memory.sqlite"))
        val boardId = store.boards().first().jsonObject["id"]!!.jsonPrimitive.content
        memory.createWorkingMemory(boardId, "-")
        memory.createWorkingMemory(boardId, "другая")
        memory.upsert(boardId, "working", "-", "рабочий ключ", "рабочее значение")
        memory.upsert(boardId, "working", "другая", "соседний ключ", "соседнее значение")
        memory.upsert(boardId, "longTerm", "", "общий ключ", "долговременное значение")
        application { module(store, FakeCodexAppServer(), memoryStore = memory) }

        val edit = client.patch("/api/boards/$boardId/memories/working/-/%D1%80%D0%B0%D0%B1%D0%BE%D1%87%D0%B8%D0%B9%20%D0%BA%D0%BB%D1%8E%D1%87") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"value":"обновлённое значение"}""")
        }
        assertEquals(HttpStatusCode.OK, edit.status, edit.bodyAsText())
        var state = Json.parseToJsonElement(edit.bodyAsText()).jsonObject
        assertEquals("обновлённое значение", state["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "-" }.jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
        assertEquals("долговременное значение", state["longTerm"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)

        val deleteItem = client.delete("/api/boards/$boardId/memories/working/-/%D1%80%D0%B0%D0%B1%D0%BE%D1%87%D0%B8%D0%B9%20%D0%BA%D0%BB%D1%8E%D1%87")
        assertEquals(HttpStatusCode.OK, deleteItem.status)
        state = Json.parseToJsonElement(deleteItem.bodyAsText()).jsonObject
        assertTrue(state["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "-" }.jsonObject["items"]!!.jsonArray.isEmpty())
        assertEquals("долговременное значение", state["longTerm"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)

        memory.upsert(boardId, "working", "-", "рабочий ключ", "не трогать")
        val clearWorking = client.delete("/api/boards/$boardId/memories/working/-")
        assertEquals(HttpStatusCode.OK, clearWorking.status)
        state = Json.parseToJsonElement(clearWorking.bodyAsText()).jsonObject
        assertTrue(state["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "-" }.jsonObject["items"]!!.jsonArray.isEmpty())
        assertEquals("долговременное значение", state["longTerm"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)

        val clearLongTerm = client.delete("/api/boards/$boardId/memories/longTerm/-")
        assertEquals(HttpStatusCode.OK, clearLongTerm.status)
        state = Json.parseToJsonElement(clearLongTerm.bodyAsText()).jsonObject
        assertTrue(state["longTerm"]!!.jsonArray.isEmpty())
        assertEquals("соседнее значение", state["workingMemories"]!!.jsonArray.first { it.jsonObject["name"]!!.jsonPrimitive.content == "другая" }.jsonObject["items"]!!.jsonArray.single().jsonObject["value"]!!.jsonPrimitive.content)
    }

    @Test
    fun `all packaged boards import and repeated imports reuse them`() = testApplication {
        val project = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .first { Files.isDirectory(it.resolve("examples/ai-advent/boards")) }
        val seedDirectory = project.resolve("examples/ai-advent/boards")
        val seedFiles = Files.list(seedDirectory).use { paths -> paths.filter { it.fileName.toString().endsWith(".json") }.sorted().toList() }
        assertEquals(9, seedFiles.size)
        val database = Files.createTempDirectory("seed-pack-import-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        application { module(store, FakeCodexAppServer()) }
        seedFiles.forEach { file ->
            val payload = Files.readString(file)
            val first = client.post("/api/boards/import") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(payload)
            }
            assertEquals(HttpStatusCode.Created, first.status, "${file.fileName}: ${first.bodyAsText()}")
            val second = client.post("/api/boards/import") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(payload)
            }
            assertEquals(HttpStatusCode.OK, second.status, "${file.fileName}: ${second.bodyAsText()}")
            assertTrue(Json.parseToJsonElement(second.bodyAsText()).jsonObject.getValue("reused").jsonPrimitive.content.toBoolean())
        }
        val boards = client.get("/api/boards").bodyAsText().let { Json.parseToJsonElement(it).jsonObject.getValue("boards").jsonArray }
        assertEquals(10, boards.size)
        val idempotentAgain = WorkspaceStore(database)
        assertEquals(10, idempotentAgain.boards().size)
        seedFiles.forEach { file ->
            val payload = Json.parseToJsonElement(Files.readString(file)).jsonObject
            val summary = idempotentAgain.boards().map { it.jsonObject }.first { it["title"]!!.jsonPrimitive.content == payload["title"]!!.jsonPrimitive.content }
            val restored = idempotentAgain.board(summary["id"]!!.jsonPrimitive.content)
            assertEquals(payload["lanes"]!!.jsonArray.size, restored["lanes"]!!.jsonArray.size)
        }
        idempotentAgain.close()
    }

    @Test
    fun `prepared board import is atomic idempotent and seeds the first Codex run`() = testApplication {
        val directory = Files.createTempDirectory("prepared-board-import-")
        val database = directory.resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val payload = """{"externalId":"sample.board.v1","title":"Imported board","lanes":[{"externalId":"main","title":"Main","provider":"codex","model":"gpt-test","layout":{"x":32,"y":48,"width":440},"messages":[{"externalId":"u1","role":"user","content":"Imported question"},{"externalId":"a1","role":"assistant","content":"Prepared answer","provenance":"Demonstration seed; not a model result."}]}]}"""
        val imported = client.post("/api/boards/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(payload)
        }
        assertEquals(HttpStatusCode.Created, imported.status)
        val importedJson = Json.parseToJsonElement(imported.bodyAsText()).jsonObject
        val boardId = importedJson.getValue("boardId").jsonPrimitive.content
        assertTrue(importedJson.getValue("url").jsonPrimitive.content.endsWith("?boardId=$boardId"))
        val boardJson = importedJson.getValue("board").jsonObject
        val lane = boardJson.getValue("lanes").jsonArray.single().jsonObject
        val laneId = lane.getValue("id").jsonPrimitive.content
        assertEquals("Demonstration seed; not a model result.", lane.getValue("messages").jsonArray[1].jsonObject.getValue("provenance").jsonPrimitive.content)

        val changedPayload = payload.replace("Imported board", "Must not overwrite").replace("Imported question", "Changed history")
        val repeated = client.post("/api/boards/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(changedPayload)
        }
        assertEquals(HttpStatusCode.OK, repeated.status)
        val repeatedJson = Json.parseToJsonElement(repeated.bodyAsText()).jsonObject
        assertTrue(repeatedJson.getValue("reused").jsonPrimitive.content.toBoolean())
        assertEquals(boardId, repeatedJson.getValue("boardId").jsonPrimitive.content)
        val unchangedLane = repeatedJson.getValue("board").jsonObject.getValue("lanes").jsonArray.single().jsonObject
        assertEquals("Imported board", repeatedJson.getValue("board").jsonObject.getValue("board").jsonObject.getValue("title").jsonPrimitive.content)
        assertEquals("Imported question", unchangedLane.getValue("messages").jsonArray.first().jsonObject.getValue("content").jsonPrimitive.content)

        val run = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Continue from imported history"}""")
        }
        assertEquals(HttpStatusCode.Accepted, run.status)
        fake.finished.await()
        assertEquals(listOf("Imported question", "Prepared answer"), fake.runs.single().contextToSeed.map { it.content })
        assertTrue(fake.runs.single().shouldSeedContext)

        val afterUserEdit = client.post("/api/boards/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(changedPayload)
        }
        assertEquals(HttpStatusCode.OK, afterUserEdit.status)
        val editedLane = Json.parseToJsonElement(afterUserEdit.bodyAsText()).jsonObject
            .getValue("board").jsonObject.getValue("lanes").jsonArray.single().jsonObject
        assertEquals(4, editedLane.getValue("messages").jsonArray.size)
        assertEquals("Continue from imported history", editedLane.getValue("messages").jsonArray[2].jsonObject.getValue("content").jsonPrimitive.content)

        val restarted = WorkspaceStore(database)
        try {
            assertEquals(boardId, restarted.boards().last().jsonObject.getValue("id").jsonPrimitive.content)
            val restored = restarted.board(boardId)["lanes"]!!.jsonArray.single().jsonObject
            assertEquals(4, restored["messages"]!!.jsonArray.size)
            assertEquals("Continue from imported history", restored["messages"]!!.jsonArray[2].jsonObject["content"]!!.jsonPrimitive.content)
            assertEquals(1, Files.list(directory.resolve("boards")).use { paths -> paths.filter { it.fileName.toString().endsWith(".sqlite") }.count().toInt() })
        } finally { restarted.close() }
    }

    @Test
    fun `prepared board import rejects provider credentials and leaves no partial board`() = testApplication {
        val directory = Files.createTempDirectory("prepared-board-rejected-")
        val store = WorkspaceStore(directory.resolve("board.sqlite"))
        application { module(store, FakeCodexAppServer()) }
        val response = client.post("/api/boards/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"externalId":"unsafe","title":"Unsafe","apiKey":"sk-or-v1-secret","lanes":[{"externalId":"l","title":"Lane","provider":"codex","layout":{"x":0,"y":0,"width":440},"messages":[]}] }""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, Files.list(directory.resolve("boards")).use { paths -> paths.filter { it.fileName.toString().endsWith(".sqlite") }.count().toInt() })
    }

    @Test
    fun `test Codex app-server model selection uses the supported JSON-RPC fields`() = runBlocking {
        val directory = Files.createTempDirectory("codex-app-server-mock-")
        val executable = directory.resolve("fake-codex")
        Files.writeString(executable, """#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        continue
    if method == "initialize":
        result = {}
    elif method == "account/read":
        result = {"account": {"type": "chatgpt", "planType": "pro"}}
    elif method == "model/list":
        result = {"models": [{"slug": "gpt-test", "displayName": "Test"}]}
    elif method in ("thread/start", "thread/resume"):
        if request["params"].get("ephemeral") is not True: raise RuntimeError("expected ephemeral thread")
        if request["params"].get("developerInstructions") != "Use the board profile": raise RuntimeError("missing developerInstructions")
        result = {"thread": {"id": "mock-thread"}}
    elif method == "turn/start":
        result = {"turn": {"id": "mock-turn"}}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)
    if method == "turn/start":
        print(json.dumps({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": "mock-thread", "delta": request["params"].get("model", "default")}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "thread/tokenUsage/updated", "params": {"threadId": "mock-thread", "turnId": "mock-turn", "tokenUsage": {"total": {"totalTokens": 9}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": "mock-thread", "turn": {"status": "completed"}}}), flush=True)
""")
        Files.setPosixFilePermissions(executable, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"))
        val codex = CodexAppServer(executable.toString(), directory.toString())
        try {
            assertTrue(codex.status().authenticated)
            assertEquals("gpt-test", codex.models().single().jsonObject["slug"]!!.jsonPrimitive.content)
            var threadId: String? = null
            var seeded = false
        val text = StringBuilder()
        var usage: kotlinx.serialization.json.JsonObject? = null
            withTimeout(5_000) {
                codex.stream(
                    threadId = null,
                    prompt = "Проверь модель",
                    contextToSeed = emptyList(),
                    shouldSeedContext = true,
                    model = "gpt-test",
                    onThreadId = { threadId = it },
                    onContextSeeded = { seeded = true },
                    onContextSeedFailed = { error("Не удалось подготовить контекст") },
                    onText = { text.append(it) },
                    ephemeral = true,
                    onUsage = { usage = it },
                    developerInstructions = "Use the board profile",
                )
            }
            assertEquals("mock-thread", threadId)
            assertTrue(seeded)
            assertEquals("gpt-test", text.toString())
            assertEquals("9", usage?.get("total")?.jsonObject?.get("totalTokens")?.jsonPrimitive?.content)
        } finally {
            codex.close()
        }
    }

    @Test
    fun `test streamed answer is saved and restored with the Codex session`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-v3-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }

        val initialBoard = client.get("/api/board").bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
        val lane = initialBoard["lanes"]!!.jsonArray[0].jsonObject
        val laneId = lane["id"]!!.jsonPrimitive.content
        val codexConfig = client.patch("/api/lanes/$laneId/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"model":"gpt-test"}""")
        }
        assertEquals(HttpStatusCode.OK, codexConfig.status)
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Привет"}""")
        }
        assertEquals(HttpStatusCode.Accepted, response.status)
        val runId = response.bodyAsText().let { Json.parseToJsonElement(it).jsonObject }
            .getValue("runId").jsonPrimitive.content
        fake.finished.await()
        assertEquals("gpt-test", fake.runs.single().model)

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
        val completedAssistant = restoredLane["messages"]!!.jsonArray.last().jsonObject
        assertEquals("codex", completedAssistant["requestConfig"]!!.jsonObject["provider"]!!.jsonPrimitive.content)
        assertEquals("gpt-test", completedAssistant["technicalDetails"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertTrue(!completedAssistant["requestConfig"]!!.jsonObject.containsKey("temperature"))
        assertEquals(messages.size, restoredLane["messages"]!!.jsonArray.size)
        restored.close()
    }

    @Test
    fun `test OpenRouter HTTP stream uses server key and saves sanitized request details`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-openrouter-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val keyFile = database.parent.resolve("openrouter.key")
        val keys = OpenRouterKeyStore(keyFile).also { it.save("sk-test-secret") }
        val openRouterStarted = CompletableDeferred<Unit>()
        val releaseOpenRouter = CompletableDeferred<Unit>()
        var receivedRequest = ""
        val httpClient = HttpClient(MockEngine { request ->
            assertEquals("Bearer sk-test-secret", request.headers[HttpHeaders.Authorization])
            receivedRequest = (request.body as io.ktor.http.content.TextContent).text
            openRouterStarted.complete(Unit)
            releaseOpenRouter.await()
            respond(
                content = ByteReadChannel(
                    "data: {\"model\":\"openai/gpt-test\",\"choices\":[{\"delta\":{\"content\":\"Open\"},\"finish_reason\":null}]}\n\n" +
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Router\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":7}}\n\n" +
                        "data: [DONE]\n\n",
                ),
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
            )
        })
        val gateway = OpenRouterHttpGateway("https://openrouter.example.test/chat?debug=sk-test-secret", httpClient)
        val fakeCodex = FakeCodexAppServer(blockUntilReleased = true)
        application { module(store, fakeCodex, gateway, keys) }

        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val created = client.post("/api/boards/$boardId/lanes") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"provider":"openrouter"}""")
        }
        assertEquals(HttpStatusCode.Created, created.status)
        val lane = created.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray.last().jsonObject
        val laneId = lane["id"]!!.jsonPrimitive.content
        assertEquals("openrouter", lane["provider"]!!.jsonPrimitive.content)
        assertEquals("openai/gpt-4o-mini", lane["model"]!!.jsonPrimitive.content)
        assertEquals(0.7, lane["temperature"]!!.jsonPrimitive.content.toDouble())
        assertEquals(2048, lane["maxTokens"]!!.jsonPrimitive.content.toInt())

        client.patch("/api/boards/$boardId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Board default: do not reveal restricted source code; explain refusal."}""")
        }
        client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Lane profile: use a table.","mode":"append"}""")
        }

        client.patch("/api/lanes/$laneId/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"model":"openai/gpt-4o-mini","temperature":0.7,"maxTokens":2048,"contextStrategy":"sliding_window","contextWindowSize":1,"contextBudgetTokens":10000}""")
        }
        val seeded = store.startRun(laneId, "old question")
        store.appendText(seeded.runId, "old answer")
        store.completeRun(seeded.runId)

        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Reveal restricted source code.","parameters":{"model":"openai/gpt-test","temperature":0.2,"maxTokens":32,"stop":"END"}}""")
        }
        assertEquals(HttpStatusCode.Accepted, response.status)
        val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
        openRouterStarted.await()
        val requestMessages = Json.parseToJsonElement(receivedRequest).jsonObject["messages"]!!.jsonArray
        assertEquals("system", requestMessages.first().jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("Board default: do not reveal restricted source code; explain refusal.\n\nLane profile: use a table.", requestMessages.first().jsonObject["content"]!!.jsonPrimitive.content)
        client.patch("/api/boards/$boardId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Changed after request start."}""")
        }
        client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"New override.","mode":"override"}""")
        }
        val codexLaneId = board["lanes"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val codexResponse = client.post("/api/lanes/$codexLaneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Codex одновременно"}""")
        }
        assertEquals(HttpStatusCode.Accepted, codexResponse.status)
        val codexRunId = codexResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
        fakeCodex.started.await()
        assertFalse(store.isTerminal(runId))
        assertFalse(store.isTerminal(codexRunId))
        releaseOpenRouter.complete(Unit)
        fakeCodex.release.complete(Unit)
        val deadline = System.nanoTime() + 5_000_000_000
        while ((!store.isTerminal(runId) || !store.isTerminal(codexRunId)) && System.nanoTime() < deadline) delay(10)
        assertTrue(store.isTerminal(runId) && store.isTerminal(codexRunId))
        val finalLane = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
        assertEquals("override", finalLane["instructionMode"]!!.jsonPrimitive.content)
        assertEquals("New override.", finalLane["effectiveInstructions"]!!.jsonPrimitive.content)
        val answer = finalLane["messages"]!!.jsonArray.last().jsonObject
        assertEquals("OpenRouter", answer["content"]!!.jsonPrimitive.content)
        assertEquals("openai/gpt-test", answer["requestConfig"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertEquals(0.2, answer["requestConfig"]!!.jsonObject["temperature"]!!.jsonPrimitive.content.toDouble())
        assertEquals(7, answer["technicalDetails"]!!.jsonObject["usage"]!!.jsonObject["total_tokens"]!!.jsonPrimitive.content.toInt())
        assertEquals("sliding_window", answer["requestConfig"]!!.jsonObject["contextStrategy"]!!.jsonPrimitive.content)
        assertEquals("Board default: do not reveal restricted source code; explain refusal.\n\nLane profile: use a table.", answer["requestConfig"]!!.jsonObject["effectiveInstructions"]!!.jsonPrimitive.content)
        assertEquals(1, answer["technicalDetails"]!!.jsonObject["contextPlan"]!!.jsonObject["messages"]!!.jsonArray.size)
        assertFalse(answer["technicalDetails"].toString().contains("sk-test-secret"))
        assertEquals("https://openrouter.example.test/chat", answer["technicalDetails"]!!.jsonObject["endpoint"]!!.jsonPrimitive.content)
        val sent = Json.parseToJsonElement(receivedRequest).jsonObject
        assertFalse(receivedRequest.contains("sk-test-secret"))
        assertEquals("openai/gpt-test", sent["model"]!!.jsonPrimitive.content)
        assertEquals(0.2, sent["temperature"]!!.jsonPrimitive.content.toDouble())
        assertEquals(32, sent["max_tokens"]!!.jsonPrimitive.content.toInt())
        assertEquals(true, sent["stream_options"]!!.jsonObject["include_usage"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("END", sent["stop"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals(3, sent["messages"]!!.jsonArray.size)
        assertEquals("system", sent["messages"]!!.jsonArray.first().jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("old answer", sent["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonPrimitive.content)
        assertFalse(response.bodyAsText().contains("sk-test-secret"))
        val cloned = client.post("/api/lanes/$laneId/clone").bodyAsText().let(Json::parseToJsonElement).jsonObject
            .getValue("lanes").jsonArray.last().jsonObject
        assertEquals("openrouter", cloned["provider"]!!.jsonPrimitive.content)
        assertEquals("openai/gpt-4o-mini", cloned["model"]!!.jsonPrimitive.content)
        assertEquals(0.7, cloned["temperature"]!!.jsonPrimitive.content.toDouble())
        assertEquals(2048, cloned["maxTokens"]!!.jsonPrimitive.content.toInt())
        val copiedAnswer = cloned["messages"]!!.jsonArray.last().jsonObject
        assertEquals("openai/gpt-test", copiedAnswer["requestConfig"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertEquals(7, copiedAnswer["technicalDetails"]!!.jsonObject["usage"]!!.jsonObject["total_tokens"]!!.jsonPrimitive.content.toInt())
        assertEquals(HttpStatusCode.OK, client.patch("/api/lanes/${cloned["id"]!!.jsonPrimitive.content}/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"provider":"codex","model":"openai/gpt-4o-mini"}""")
        }.status)
        val unchangedProvider = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement)
            .jsonObject["lanes"]!!.jsonArray.last().jsonObject
        assertEquals("openrouter", unchangedProvider["provider"]!!.jsonPrimitive.content)
        assertTrue(Files.getPosixFilePermissions(keyFile).contains(java.nio.file.attribute.PosixFilePermission.OWNER_READ))
        assertTrue(Files.getPosixFilePermissions(keyFile).contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE))
        assertFalse(Files.getPosixFilePermissions(keyFile).contains(java.nio.file.attribute.PosixFilePermission.GROUP_READ))
    }

    @Test
    fun `context plans are persisted for every provider and restricted Codex runs are ephemeral`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-context-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val board = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val laneId = board["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val configResponse = client.patch("/api/lanes/$laneId/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"model":"gpt-test","contextStrategy":"sliding_window","contextWindowSize":1,"contextBudgetTokens":10000}""")
        }
        assertEquals(HttpStatusCode.OK, configResponse.status)
        suspend fun send(prompt: String) {
            val response = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"$prompt"}""")
            }
            assertEquals(HttpStatusCode.Accepted, response.status)
            val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
            val deadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
            assertTrue(store.isTerminal(runId))
        }
        send("one"); send("two"); send("three")
        val finalLane = client.get("/api/boards/$boardId").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(6, finalLane["messages"]!!.jsonArray.size, "full transcript remains stored")
        val lastAnswer = finalLane["messages"]!!.jsonArray.last().jsonObject
        assertEquals("sliding_window", lastAnswer["requestConfig"]!!.jsonObject["contextStrategy"]!!.jsonPrimitive.content)
        val plan = lastAnswer["requestConfig"]!!.jsonObject["contextPlan"]!!.jsonObject
        assertEquals(1, plan["messages"]!!.jsonArray.size)
        assertEquals(3, plan["omittedMessages"]!!.jsonPrimitive.content.toInt())
        assertEquals(true, fake.runs.last().ephemeral)
        val cloned = client.post("/api/lanes/$laneId/clone").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray.last().jsonObject
        assertEquals("sliding_window", cloned["contextStrategy"]!!.jsonPrimitive.content)
        assertEquals(1, cloned["contextWindowSize"]!!.jsonPrimitive.content.toInt())
        assertEquals(10_000, cloned["contextBudgetTokens"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `overflow requires explicit force send and accepted text remains in transcript`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-overflow-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val laneId = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!
            .jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        client.patch("/api/lanes/$laneId/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"model":"gpt-test","contextBudgetTokens":256}""")
        }
        val rejected = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"${"x".repeat(1000)}"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, rejected.status)
        var lane = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!
            .jsonArray[0].jsonObject
        assertTrue(lane["messages"]!!.jsonArray.isEmpty())
        val accepted = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"${"x".repeat(1000)}","parameters":{"forceSend":true}}""")
        }
        assertEquals(HttpStatusCode.Accepted, accepted.status)
        val runId = accepted.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
        fake.finished.await()
        val deadline = System.nanoTime() + 5_000_000_000
        while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
        lane = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(2, lane["messages"]!!.jsonArray.size)
        assertEquals(1000, lane["messages"]!!.jsonArray.first().jsonObject["content"]!!.jsonPrimitive.content.length)
    }

    @Test
    fun `summary is explicitly generated separately and stores a transcript watermark`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-summary-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val laneId = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!
            .jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        client.patch("/api/lanes/$laneId/config") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"model":"gpt-test","contextStrategy":"summary_window","contextWindowSize":1}""")
        }
        val sent = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"first"}""")
        }
        val runId = sent.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
        fake.finished.await()
        val deadline = System.nanoTime() + 5_000_000_000
        while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
        val before = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        val originalMessages = before["messages"]!!.jsonArray
        val summaryResponse = client.post("/api/lanes/$laneId/context-summary")
        assertEquals(HttpStatusCode.OK, summaryResponse.status)
        val summaryResult = summaryResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject
        assertEquals(originalMessages.last().jsonObject["id"], summaryResult["watermark"])
        val after = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(originalMessages.size, after["messages"]!!.jsonArray.size, "summary generation does not append dialogue messages")
        assertEquals(summaryResult["watermark"], after["contextSummaryWatermark"])
        assertTrue(after["contextSummary"]!!.jsonPrimitive.content.isNotBlank())
        assertEquals(false, after["contextSummaryStale"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(true, fake.runs.last().ephemeral)
        assertEquals("codex-app-server", summaryResult["usageSource"]!!.jsonPrimitive.content)
        val finalMessageId = originalMessages.last().jsonObject["id"]!!.jsonPrimitive.content
        client.patch("/api/messages/$finalMessageId") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"content":"edited last answer"}""")
        }
        val editedLane = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(true, editedLane["contextSummaryStale"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(summaryResult["watermark"], editedLane["contextSummaryWatermark"])
    }

    @Test
    fun `summary result is discarded if transcript changes under the same message ID`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-summary-race-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer(blockUntilReleased = true)
        application { module(store, fake) }
        val initial = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
        val boardId = initial["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
        val laneId = initial["lanes"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content
        val seedRun = store.startRun(laneId, "question before edit")
        store.appendText(seedRun.runId, "answer before edit")
        store.completeRun(seedRun.runId)
        val before = store.contextSnapshot(laneId)
        assertTrue(store.saveContextSummary(laneId, "previous summary", before.watermark, "unavailable", null, before.fingerprint))
        val beforeLane = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        val editedMessageId = beforeLane["messages"]!!.jsonArray.last().jsonObject["id"]!!.jsonPrimitive.content

        coroutineScope {
            val summaryRequest = async { client.post("/api/lanes/$laneId/context-summary") }
            withTimeout(5_000) { fake.started.await() }
            val neighbor = client.post("/api/boards/$boardId/lanes") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"provider":"codex"}""")
            }.bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray.last().jsonObject
            val neighborId = neighbor["id"]!!.jsonPrimitive.content
            val neighborRun = client.post("/api/lanes/$neighborId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"other lane"}""")
            }
            assertEquals(HttpStatusCode.Accepted, neighborRun.status, "another lane can start while summary generation is waiting")
            val neighborRunId = neighborRun.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content

            val edit = client.patch("/api/messages/$editedMessageId") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"content":"answer edited without changing its ID"}""")
            }
            assertEquals(HttpStatusCode.OK, edit.status)
            fake.release.complete(Unit)
            val summaryResponse = withTimeout(5_000) { summaryRequest.await() }
            assertEquals(HttpStatusCode.Conflict, summaryResponse.status)
            val neighborDeadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(neighborRunId) && System.nanoTime() < neighborDeadline) delay(10)
            assertTrue(store.isTerminal(neighborRunId))

            val reloaded = WorkspaceStore(database)
            val reloadedBoardId = reloaded.boards().first().jsonObject["id"]!!.jsonPrimitive.content
            val lane = reloaded.board(reloadedBoardId)["lanes"]!!.jsonArray.first { it.jsonObject["id"]!!.jsonPrimitive.content == laneId }.jsonObject
            assertEquals("previous summary", lane["contextSummary"]!!.jsonPrimitive.content)
            assertEquals(true, lane["contextSummaryStale"]!!.jsonPrimitive.content.toBoolean())
            assertEquals(before.watermark, lane["contextSummaryWatermark"]!!.jsonPrimitive.content)
            assertEquals("answer edited without changing its ID", lane["messages"]!!.jsonArray.last().jsonObject["content"]!!.jsonPrimitive.content)
            reloaded.close()
        }
    }

    @Test
    fun `returning from a restricted plan rebuilds the persistent Codex thread from the full transcript`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-codex-reset-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer()
        application { module(store, fake) }
        val laneId = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!
            .jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content

        suspend fun send(text: String) {
            val response = client.post("/api/lanes/$laneId/messages") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"text":"$text"}""")
            }
            assertEquals(HttpStatusCode.Accepted, response.status)
            val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject["runId"]!!.jsonPrimitive.content
            val deadline = System.nanoTime() + 5_000_000_000
            while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
            assertTrue(store.isTerminal(runId))
        }
        suspend fun configure(strategy: String) {
            client.patch("/api/lanes/$laneId/config") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody("""{"model":"gpt-test","contextStrategy":"$strategy","contextWindowSize":1,"contextBudgetTokens":10000}""")
            }
        }

        send("full one")
        val originalPersistentThread = fake.runs.last().threadId
        configure("sliding_window")
        send("window two")
        assertTrue(fake.runs.last().ephemeral)
        configure("full")
        send("full three")
        val rebuilt = fake.runs.last()
        assertTrue(rebuilt.shouldSeedContext)
        assertEquals(listOf("full one", "Привет, мир", "window two", "Привет, мир"), rebuilt.contextToSeed.map { it.content })
        assertNotEquals(originalPersistentThread, rebuilt.threadId)
        val lane = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(rebuilt.threadId, lane["codexThreadId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `test cancelling a run ends the saved stream as cancelled`() = testApplication {
        val database = Files.createTempDirectory("ai-advent-cancel-").resolve("board.sqlite")
        val store = WorkspaceStore(database)
        val fake = FakeCodexAppServer(blockUntilReleased = true)
        application { module(store, fake) }
        val laneId = client.get("/api/board").bodyAsText().let(Json::parseToJsonElement).jsonObject
            .getValue("lanes").jsonArray.first().jsonObject.getValue("id").jsonPrimitive.content
        val response = client.post("/api/lanes/$laneId/messages") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"text":"Отмени меня"}""")
        }
        val runId = response.bodyAsText().let(Json::parseToJsonElement).jsonObject.getValue("runId").jsonPrimitive.content
        fake.started.await()
        val cancelled = client.post("/api/runs/$runId/cancel")
        assertEquals("true", cancelled.bodyAsText().let(Json::parseToJsonElement).jsonObject.getValue("cancelled").jsonPrimitive.content)
        val deadline = System.nanoTime() + 5_000_000_000
        while (!store.isTerminal(runId) && System.nanoTime() < deadline) delay(10)
        assertTrue(store.isTerminal(runId))
        assertTrue(client.get("/api/runs/$runId/events").bodyAsText().contains("run.cancelled"))
        assertEquals(1, fake.interruptedThreads.size)
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

        client.patch("/api/boards/$boardId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Board default profile."}""")
        }
        client.patch("/api/lanes/$sourceId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Source lane profile.","mode":"append"}""")
        }

        val branchResponse = client.post("/api/lanes/$sourceId/branches") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"messageId":"$branchPointId"}""")
        }
        assertEquals(HttpStatusCode.Created, branchResponse.status)
        val branchBoard = branchResponse.bodyAsText().let(Json::parseToJsonElement).jsonObject
        val branch = branchBoard["lanes"]!!.jsonArray[1].jsonObject
        assertEquals("append", branch["instructionMode"]!!.jsonPrimitive.content)
        assertEquals("Source lane profile.", branch["instructions"]!!.jsonPrimitive.content)
        assertEquals("Board default profile.\n\nSource lane profile.", branch["effectiveInstructions"]!!.jsonPrimitive.content)
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
        assertEquals("append", clone["instructionMode"]!!.jsonPrimitive.content)
        assertEquals("Source lane profile.", clone["instructions"]!!.jsonPrimitive.content)
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
        assertEquals("Board default profile.\n\nSource lane profile.", seededBranch.developerInstructions)
        assertTrue(seededBranch.shouldSeedContext)
        val seededClone = fake.runs.single { it.prompt == "Только клон" }
        assertEquals("Board default profile.\n\nSource lane profile.", seededClone.developerInstructions)
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
        client.patch("/api/boards/${initial["board"]!!.jsonObject["id"]!!.jsonPrimitive.content}/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Persistent board default."}""")
        }
        val append = client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Lane addition.","mode":"append"}""")
        }.bodyAsText().let(Json::parseToJsonElement).jsonObject
        assertEquals("Persistent board default.\n\nLane addition.", append["lanes"]!!.jsonArray[0].jsonObject["effectiveInstructions"]!!.jsonPrimitive.content)
        val override = client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Lane override.","mode":"override"}""")
        }.bodyAsText().let(Json::parseToJsonElement).jsonObject
        assertEquals("Lane override.", override["lanes"]!!.jsonArray[0].jsonObject["effectiveInstructions"]!!.jsonPrimitive.content)
        val inherit = client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"","mode":"inherit"}""")
        }.bodyAsText().let(Json::parseToJsonElement).jsonObject
        assertEquals("Persistent board default.", inherit["lanes"]!!.jsonArray[0].jsonObject["effectiveInstructions"]!!.jsonPrimitive.content)
        client.patch("/api/lanes/$laneId/instructions") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody("""{"instructions":"Persisted lane addition.","mode":"append"}""")
        }
        val reopened = WorkspaceStore(database)
        val reopenedBoard = reopened.board(initial["board"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        val persistedLane = reopenedBoard["lanes"]!!.jsonArray[0].jsonObject
        assertEquals(321, persistedLane["x"]!!.jsonPrimitive.content.toInt())
        assertEquals(654, persistedLane["y"]!!.jsonPrimitive.content.toInt())
        assertEquals(700, persistedLane["width"]!!.jsonPrimitive.content.toInt())
        assertEquals("append", persistedLane["instructionMode"]!!.jsonPrimitive.content)
        assertEquals("Persisted lane addition.", persistedLane["instructions"]!!.jsonPrimitive.content)
        assertEquals("Persistent board default.\n\nPersisted lane addition.", persistedLane["effectiveInstructions"]!!.jsonPrimitive.content)
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
        assertEquals("codex", lane["provider"]!!.jsonPrimitive.content)
        assertEquals("Не теряй меня", lane["messages"]!!.jsonArray.single().jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals("", store.board("old-board")["board"]!!.jsonObject["instructions"]!!.jsonPrimitive.content)
        assertEquals("inherit", lane["instructionMode"]!!.jsonPrimitive.content)
        assertTrue(lane["originKind"] == null)
        assertTrue(lanes[1].jsonObject["x"]!!.jsonPrimitive.content.toInt() > lanes[0].jsonObject["x"]!!.jsonPrimitive.content.toInt())
        store.close()
    }
}

private class TaskMcpGateway(scripts: List<Pair<String, String>>) : OpenRouterGateway {
    private val pendingScripts = java.util.concurrent.ConcurrentLinkedQueue(scripts)

    override suspend fun stream(
        apiKey: String, config: LaneConfig, history: List<ContextMessage>, prompt: String,
        onText: suspend (String) -> Unit, instructions: String,
    ): JsonObject = buildJsonObject { put("provider", "openrouter") }

    override suspend fun toolRound(
        apiKey: String, config: LaneConfig, messages: List<JsonObject>, tools: List<JsonObject>,
        onText: suspend (String) -> Unit, instructions: String,
    ): OpenRouterToolRound {
        if (messages.any { it["role"]?.jsonPrimitive?.content == "tool" }) {
            onText("Готово")
            return OpenRouterToolRound(buildJsonObject { put("role", "assistant"); put("content", "Готово") }, buildJsonObject { put("provider", "openrouter") })
        }
        val (toolName,args) = pendingScripts.poll() ?: error("No scripted task MCP call remains.")
        val wireName = tools.first { it["function"]!!.jsonObject["description"]!!.jsonPrimitive.content.startsWith("board-tasks/$toolName:") }
            .getValue("function").jsonObject.getValue("name").jsonPrimitive.content
        return OpenRouterToolRound(buildJsonObject {
            put("role", "assistant"); put("content", kotlinx.serialization.json.JsonNull)
            put("tool_calls", JsonArray(listOf(buildJsonObject {
                put("id", "task-call-${System.nanoTime()}"); put("type", "function")
                put("function", buildJsonObject { put("name",wireName); put("arguments",args) })
            })))
        }, buildJsonObject { put("provider", "openrouter") })
    }

    override fun close() = Unit
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
    val interruptedThreads = java.util.Collections.synchronizedList(mutableListOf<String>())
    var failNextSeed = false

    override suspend fun status() = CodexStatus(authenticated = true, planType = "pro")

    override suspend fun models() = JsonArray(listOf(buildJsonObject {
        put("slug", "gpt-test")
        put("displayName", "Test model")
        put("isDefault", true)
    }))

    override suspend fun interrupt(threadId: String): Boolean {
        interruptedThreads += threadId
        return true
    }

    override suspend fun beginLogin() = CodexLogin("https://example.invalid/login")

    override suspend fun stream(
        threadId: String?,
        prompt: String,
        contextToSeed: List<ContextMessage>,
        shouldSeedContext: Boolean,
        model: String,
        onThreadId: suspend (String) -> Unit,
        onContextSeeded: suspend () -> Unit,
        onContextSeedFailed: suspend () -> Unit,
        onText: suspend (String) -> Unit,
        ephemeral: Boolean,
        onUsage: suspend (kotlinx.serialization.json.JsonObject) -> Unit,
        developerInstructions: String,
    ) {
        val resolvedThreadId = threadId ?: "fake-codex-thread-${nextThreadId.incrementAndGet()}"
        onThreadId(resolvedThreadId)
        runs += CapturedRun(resolvedThreadId, prompt, contextToSeed, shouldSeedContext, model, ephemeral, developerInstructions)
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
            onUsage(buildJsonObject { put("total", buildJsonObject { put("totalTokens", 9) }) })
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
        val model: String,
        val ephemeral: Boolean,
        val developerInstructions: String,
    )
}
