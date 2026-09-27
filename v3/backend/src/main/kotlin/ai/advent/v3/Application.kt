package ai.advent.v3

import io.ktor.http.HttpStatusCode
import io.ktor.http.HttpHeaders
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.delete
import io.ktor.server.routing.routing
import io.ktor.server.sse.SSE
import io.ktor.server.sse.sse
import io.ktor.sse.ServerSentEvent
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import io.ktor.server.netty.Netty
import io.ktor.server.engine.embeddedServer
import java.nio.file.Path

private val json = Json { ignoreUnknownKeys = true }

private fun JsonObject.taskString(name: String): String? {
    val value = this[name] ?: return null
    require(value is kotlinx.serialization.json.JsonPrimitive && value.isString) { "Поле $name должно быть строкой." }
    return value.content
}

private fun JsonObject.taskBoolean(name: String): Boolean? {
    val value = this[name] ?: return null
    require(value is kotlinx.serialization.json.JsonPrimitive && !value.isString && value.content in setOf("true", "false")) {
        "Поле $name должно быть логическим значением."
    }
    return value.content.toBooleanStrict()
}

private fun platformMemoryDatabasePath(): Path {
    System.getenv("AI_ADVENT_V3_MEMORY_DB")?.let { return Path.of(it) }
    val root = Path.of(System.getenv("AI_ADVENT_V3_CWD") ?: System.getProperty("user.dir")).toAbsolutePath()
        .let { if (it.resolve("examples/mcp/board-memory-server.mjs").toFile().exists()) it else it.parent.parent }
    return root.resolve("v3/data/memory.sqlite")
}

private fun platformTaskDatabasePath(): Path {
    System.getenv("AI_ADVENT_V3_TASKS_DB")?.let { return Path.of(it) }
    val root = Path.of(System.getenv("AI_ADVENT_V3_CWD") ?: System.getProperty("user.dir")).toAbsolutePath()
        .let { if (it.resolve("examples/mcp/board-memory-server.mjs").toFile().exists()) it else it.parent.parent }
    return root.resolve("v3/data/tasks.sqlite")
}

private fun platformScheduleDatabasePath(): Path {
    System.getenv("AI_ADVENT_V3_SCHEDULES_DB")?.let { return Path.of(it) }
    val root = Path.of(System.getenv("AI_ADVENT_V3_CWD") ?: System.getProperty("user.dir")).toAbsolutePath()
        .let { if (it.resolve("examples/mcp/board-memory-server.mjs").toFile().exists()) it else it.parent.parent }
    return root.resolve("v3/data/schedules.sqlite")
}

fun Application.module(
    store: WorkspaceStore = WorkspaceStore(Path.of(System.getenv("AI_ADVENT_V3_DB") ?: "v3/data/board.sqlite")),
    codex: CodexGateway = CodexAppServer(),
    openRouter: OpenRouterGateway = OpenRouterHttpGateway(),
    openRouterKeys: OpenRouterKeyStore = OpenRouterKeyStore(Path.of(System.getenv("AI_ADVENT_V3_SETTINGS") ?: "../data/openrouter.key")),
    mcpRegistry: McpRegistry = McpRegistry(),
    mcpClient: McpClient = McpClient(),
    memoryStore: MemoryStore = MemoryStore(platformMemoryDatabasePath()),
    taskStore: TaskStore = TaskStore(platformTaskDatabasePath()),
    schedulerStore: SchedulerStore = SchedulerStore(platformScheduleDatabasePath()),
) {
    install(ContentNegotiation) { json(json) }
    install(SSE)
    val coordinator = RunCoordinator(store, codex, openRouter, openRouterKeys, mcpRegistry, mcpClient, memoryStore)
    val schedulerScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val schedulerIntervalMs = System.getenv("AI_ADVENT_V3_SCHEDULER_TICK_MS")?.toLongOrNull()?.coerceIn(50, 10_000) ?: 250L
    schedulerScope.launch { while (true) { runCatching { schedulerStore.tick() }; delay(schedulerIntervalMs) } }
    monitor.subscribe(ApplicationStopped) { schedulerScope.cancel(); schedulerStore.close(); coordinator.close() }

    routing {
        get("/api/health") {
            call.respond(buildJsonObject { put("status", "ok") })
        }

        get("/api/board") {
            val boardId = call.request.queryParameters["boardId"]
            val id = boardId ?: store.boards().firstOrNull()?.jsonObject?.get("id")?.jsonPrimitive?.content
            if (id == null) call.respond(HttpStatusCode.NotFound)
            else try {
                call.respond(store.board(id))
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") })
            }
        }

        get("/api/boards") {
            call.respond(buildJsonObject { put("boards", store.boards()) })
        }

        post("/api/boards") {
            call.respond(HttpStatusCode.Created, store.createBoard())
        }

        patch("/api/boards/{boardId}/instructions") {
            val boardId = call.parameters["boardId"]
            val instructions = runCatching { call.receive<JsonObject>()["instructions"]?.jsonPrimitive?.content }.getOrNull()
            if (boardId == null || instructions == null) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи текст инструкций доски.") })
                return@patch
            }
            try {
                call.respond(store.updateBoardInstructions(boardId, instructions))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Инструкции некорректны.") })
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") })
            }
        }

        get("/api/boards/{boardId}/memories") {
            val boardId = call.parameters["boardId"] ?: ""
            try { store.board(boardId); call.respond(memoryStore.state(boardId)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        get("/api/boards/{boardId}/tasks") {
            val boardId = call.parameters["boardId"] ?: ""
            try { store.board(boardId); call.respond(taskStore.list(boardId)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        get("/api/boards/{boardId}/schedules") {
            val boardId = call.parameters["boardId"] ?: ""
            try { store.board(boardId); call.respond(schedulerStore.list(boardId)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        get("/api/boards/{boardId}/schedule-runs") {
            val boardId = call.parameters["boardId"] ?: ""
            try { store.board(boardId); call.respond(schedulerStore.runs(boardId)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        post("/api/boards/{boardId}/schedules") {
            val boardId = call.parameters["boardId"] ?: ""
            val body = runCatching { call.receive<JsonObject>() }.getOrNull()
            val title = body?.get("title")?.jsonPrimitive?.contentOrNull
            val delayMs = body?.get("delayMs")?.jsonPrimitive?.longOrNull
            val repeatEveryMs = body?.get("repeatEveryMs")?.jsonPrimitive?.longOrNull
            if (title == null || delayMs == null) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи название и задержку до первого запуска.") }); return@post }
            try { store.board(boardId); call.respond(HttpStatusCode.Created, schedulerStore.create(boardId,title,delayMs,repeatEveryMs)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error",error.message ?: "Расписание некорректно.") }) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        patch("/api/boards/{boardId}/schedules/{scheduleId}") {
            val boardId = call.parameters["boardId"] ?: ""; val scheduleId = call.parameters["scheduleId"] ?: ""
            val paused = runCatching { call.receive<JsonObject>()["paused"]?.jsonPrimitive?.content?.toBooleanStrict() }.getOrNull()
            if (paused == null) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи paused: true или false.") }); return@patch }
            try { store.board(boardId); val item = schedulerStore.pause(boardId,scheduleId,paused); if(item == null) call.respond(HttpStatusCode.NotFound) else call.respond(item) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        post("/api/boards/{boardId}/tasks") {
            val boardId = call.parameters["boardId"] ?: ""
            val body = runCatching { call.receive<JsonObject>() }.getOrNull()
            try {
                val title = body?.taskString("title")
                require(title != null) { "Укажи название задачи." }
                val description = body.taskString("description").orEmpty()
                store.board(boardId)
                call.respond(HttpStatusCode.Created, taskStore.create(boardId,title,description))
            }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Задача некорректна.") }) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
        }

        patch("/api/boards/{boardId}/tasks/{taskId}") {
            val boardId = call.parameters["boardId"] ?: ""
            val taskId = call.parameters["taskId"] ?: ""
            val body = runCatching { call.receive<JsonObject>() }.getOrNull()
            if (body == null) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Тело запроса должно быть JSON-объектом.") }); return@patch }
            try { store.board(boardId) } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }); return@patch
            }
            try {
                call.respond(taskStore.update(boardId,taskId,
                    title=body.taskString("title"),
                    description=body.taskString("description"),
                    plan=body.taskString("plan"),
                    approvePlan=body.taskBoolean("approvePlan"),
                    stage=body.taskString("stage"),
                    currentStep=body.taskString("currentStep"),
                    expectedAction=body.taskString("expectedAction"),
                    paused=body.taskBoolean("paused"),
                    status=body.taskString("status"),
                    comment=body.taskString("comment")))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Операция некорректна.") })
            } catch (error: Exception) {
                val message = error.message ?: "Операция задачи отклонена."
                call.respond(if (message.contains("не найдена")) HttpStatusCode.NotFound else HttpStatusCode.Conflict, buildJsonObject { put("error", message) })
            }
        }

        post("/api/boards/{boardId}/memories/working") {
            val boardId = call.parameters["boardId"] ?: ""
            val name = runCatching { call.receive<JsonObject>()["name"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            if (name.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи имя рабочей памяти.") }); return@post }
            try { store.board(boardId); call.respond(HttpStatusCode.Created, memoryStore.createWorkingMemory(boardId, name)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Имя памяти некорректно.") }) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") }) }
            catch (_: Exception) { call.respond(HttpStatusCode.Conflict, buildJsonObject { put("error", "Рабочая память с таким именем уже существует.") }) }
        }

        patch("/api/boards/{boardId}/memories/{layer}/{memoryName}/{key}") {
            val boardId = call.parameters["boardId"] ?: ""; val layer = call.parameters["layer"] ?: ""
            val memoryName = call.parameters["memoryName"] ?: ""; val key = call.parameters["key"] ?: ""
            val value = runCatching { call.receive<JsonObject>()["value"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            if (value.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи значение записи.") }); return@patch }
            try { store.board(boardId); call.respond(memoryStore.upsert(boardId, layer, if (layer == "longTerm") "" else memoryName, key, value)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Запись памяти некорректна.") }) }
            catch (error: Exception) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", error.message ?: "Память не найдена.") }) }
        }

        delete("/api/boards/{boardId}/memories/{layer}/{memoryName}/{key}") {
            val boardId = call.parameters["boardId"] ?: ""; val layer = call.parameters["layer"] ?: ""
            val memoryName = call.parameters["memoryName"] ?: ""; val key = call.parameters["key"] ?: ""
            try { store.board(boardId); call.respond(memoryStore.deleteItem(boardId, layer, if (layer == "longTerm") "" else memoryName, key)) }
            catch (error: Exception) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", error.message ?: "Память не найдена.") }) }
        }

        delete("/api/boards/{boardId}/memories/{layer}/{memoryName}") {
            val boardId = call.parameters["boardId"] ?: ""; val layer = call.parameters["layer"] ?: ""
            val memoryName = call.parameters["memoryName"] ?: ""
            try {
                store.board(boardId)
                call.respond(memoryStore.clear(boardId, layer, if (layer == "longTerm") "" else memoryName))
            } catch (error: Exception) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", error.message ?: "Память не найдена.") }) }
        }

        delete("/api/boards/{boardId}/working-memories/{memoryName}") {
            val boardId = call.parameters["boardId"] ?: ""; val memoryName = call.parameters["memoryName"] ?: ""
            try { store.board(boardId); call.respond(memoryStore.deleteWorkingMemory(boardId, memoryName)) }
            catch (error: Exception) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", error.message ?: "Рабочая память не найдена.") }) }
        }

        post("/api/boards/import") {
            try {
                val contentLength = call.request.headers[HttpHeaders.ContentLength]?.toLongOrNull()
                require(contentLength == null || contentLength <= 2_000_000) { "Пакет импорта превышает 2 МБ." }
                val payload = call.receiveText()
                require(payload.toByteArray(Charsets.UTF_8).size <= 2_000_000) { "Пакет импорта превышает 2 МБ." }
                val element = Json.parseToJsonElement(payload)
                BoardImport.validateNoSecretsOrThreadIds(element)
                val root = element as? JsonObject ?: error("Корень пакета должен быть объектом.")
                val imported = BoardImport.parse(root)
                val (board, reused) = store.importPreparedBoard(imported)
                val boardId = board["board"]!!.jsonObject["id"]!!.jsonPrimitive.content
                call.respond(if (reused) HttpStatusCode.OK else HttpStatusCode.Created, buildJsonObject {
                    put("boardId", boardId)
                    put("url", "/?boardId=$boardId")
                    put("reused", reused)
                    put("board", board)
                })
            } catch (error: Exception) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Пакет импорта некорректен.") })
            }
        }

        get("/api/boards/{boardId}") {
            val boardId = call.parameters["boardId"]
            try {
                call.respond(store.board(boardId ?: ""))
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") })
            }
        }

        post("/api/boards/{boardId}/lanes") {
            val boardId = call.parameters["boardId"]
            val provider = runCatching { call.receive<JsonObject>()["provider"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: "codex"
            if (provider !in setOf("codex", "openrouter")) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Провайдер ленты должен быть Codex или OpenRouter.") })
                return@post
            }
            try {
                call.respond(HttpStatusCode.Created, store.createLane(boardId ?: "", provider))
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") })
            }
        }

        patch("/api/lanes/{laneId}/config") {
            val laneId = call.parameters["laneId"]
            val body = runCatching { call.receive<JsonObject>() }.getOrNull()
            val model = body?.get("model")?.jsonPrimitive?.contentOrNull
            val temperature = body?.get("temperature")?.jsonPrimitive?.doubleOrNull
            val maxTokens = body?.get("maxTokens")?.jsonPrimitive?.intOrNull
            val stop = body?.get("stop")?.jsonPrimitive?.contentOrNull
            val contextStrategy = body?.get("contextStrategy")?.jsonPrimitive?.contentOrNull ?: "full"
            val contextWindowSize = body?.get("contextWindowSize")?.jsonPrimitive?.intOrNull ?: 10
            val contextBudgetTokens = body?.get("contextBudgetTokens")?.jsonPrimitive?.intOrNull ?: 32768
            if (laneId == null || model == null) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи модель и параметры ленты.") })
                return@patch
            }
            try {
                if (store.providerForLane(laneId) == "codex" && (temperature != null || maxTokens != null || !stop.isNullOrBlank())) {
                    call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Codex не принимает эти параметры.") })
                    return@patch
                }
                call.respond(store.updateLaneConfig(laneId, model, temperature, maxTokens, stop,
                    contextStrategy, contextWindowSize, contextBudgetTokens))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Параметры некорректны.") })
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
            }
        }

        patch("/api/lanes/{laneId}/instructions") {
            val laneId = call.parameters["laneId"]
            val body = runCatching { call.receive<JsonObject>() }.getOrNull()
            val instructions = body?.get("instructions")?.jsonPrimitive?.content
            val mode = body?.get("mode")?.jsonPrimitive?.content
            if (laneId == null || instructions == null || mode == null) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи текст и режим инструкций ленты.") })
                return@patch
            }
            try {
                call.respond(store.updateLaneInstructions(laneId, instructions, mode))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Инструкции некорректны.") })
            } catch (error: IllegalStateException) {
                val status = if (error.message.orEmpty().contains("во время запроса")) HttpStatusCode.Conflict else HttpStatusCode.NotFound
                call.respond(status, buildJsonObject { put("error", error.message ?: "Лента не найдена.") })
            }
        }

        post("/api/lanes/{laneId}/context-summary") {
            val laneId = call.parameters["laneId"]
            if (laneId == null) {
                call.respond(HttpStatusCode.NotFound)
                return@post
            }
            try {
                when (store.providerForLane(laneId)) {
                    "codex" -> if (!codex.status().authenticated) {
                        call.respond(HttpStatusCode.Unauthorized, buildJsonObject { put("error", "Сначала войди в Codex через подписку ChatGPT.") })
                        return@post
                    }
                    "openrouter" -> if (!openRouterKeys.isConfigured()) {
                        call.respond(HttpStatusCode.Unauthorized, buildJsonObject { put("error", "Сначала сохрани API-ключ OpenRouter в настройках.") })
                        return@post
                    }
                }
                call.respond(coordinator.generateSummary(laneId))
            } catch (_: ActiveRunException) {
                call.respond(HttpStatusCode.Conflict, buildJsonObject { put("error", "Дождись завершения запроса перед созданием сводки.") })
            } catch (error: StaleSummarySnapshotException) {
                call.respond(HttpStatusCode.Conflict, buildJsonObject { put("error", error.message ?: "История изменилась; создай сводку заново.") })
            } catch (error: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", error.message ?: "Лента не найдена.") })
            } catch (error: Exception) {
                val message = error.message ?: "Не удалось создать сводку."
                val safeMessage = openRouterKeys.get().takeIf(String::isNotBlank)?.let { message.replace(it, "[скрытый ключ]") } ?: message
                call.respond(HttpStatusCode.BadGateway, buildJsonObject { put("error", safeMessage) })
            }
        }

        post("/api/lanes/{laneId}/branches") {
            val laneId = call.parameters["laneId"]
            val messageId = try {
                call.receive<JsonObject>()["messageId"]?.jsonPrimitive?.contentOrNull
            } catch (_: Exception) {
                null
            }
            if (laneId == null || messageId.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Не выбрано сообщение для ветки.") })
                return@post
            }
            try {
                call.respond(HttpStatusCode.Created, store.branchLane(laneId, messageId))
            } catch (error: IllegalStateException) {
                val status = if (error.message?.contains("running") == true) HttpStatusCode.Conflict else HttpStatusCode.NotFound
                call.respond(status, buildJsonObject {
                    put("error", if (status == HttpStatusCode.Conflict) "Дождись завершения запроса перед копированием ленты." else "Лента или сообщение не найдены.")
                })
            }
        }

        post("/api/lanes/{laneId}/clone") {
            val laneId = call.parameters["laneId"]
            if (laneId == null) {
                call.respond(HttpStatusCode.NotFound)
                return@post
            }
            try {
                call.respond(HttpStatusCode.Created, store.cloneLane(laneId))
            } catch (error: IllegalStateException) {
                val status = if (error.message?.contains("running") == true) HttpStatusCode.Conflict else HttpStatusCode.NotFound
                call.respond(status, buildJsonObject {
                    put("error", if (status == HttpStatusCode.Conflict) "Дождись завершения запроса перед копированием ленты." else "Лента не найдена.")
                })
            }
        }

        patch("/api/messages/{messageId}") {
            val messageId = call.parameters["messageId"]
            val content = try {
                call.receive<JsonObject>()["content"]?.jsonPrimitive?.contentOrNull
            } catch (_: Exception) {
                null
            }
            if (messageId == null || content.isNullOrBlank() || content.length > 50_000) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "Текст сообщения должен содержать до 50000 символов.")
                })
                return@patch
            }
            try {
                call.respond(store.editMessage(messageId, content))
            } catch (error: IllegalStateException) {
                val conflict = error.message?.contains("running") == true
                call.respond(if (conflict) HttpStatusCode.Conflict else HttpStatusCode.NotFound, buildJsonObject {
                    put("error", if (conflict) "Дождись завершения запроса перед изменением истории." else "Сообщение не найдено.")
                })
            }
        }

        delete("/api/messages/{messageId}") {
            val messageId = call.parameters["messageId"]
            if (messageId == null) {
                call.respond(HttpStatusCode.NotFound)
                return@delete
            }
            try {
                call.respond(store.deleteMessagesFrom(messageId))
            } catch (error: IllegalStateException) {
                val conflict = error.message?.contains("running") == true
                call.respond(if (conflict) HttpStatusCode.Conflict else HttpStatusCode.NotFound, buildJsonObject {
                    put("error", if (conflict) "Дождись завершения запроса перед изменением истории." else "Сообщение не найдено.")
                })
            }
        }

        post("/api/lanes/{sourceLaneId}/messages/{messageId}/copy") {
            val sourceLaneId = call.parameters["sourceLaneId"]
            val messageId = call.parameters["messageId"]
            val targetLaneId = try {
                call.receive<JsonObject>()["targetLaneId"]?.jsonPrimitive?.contentOrNull
            } catch (_: Exception) {
                null
            }
            if (sourceLaneId == null || messageId == null || targetLaneId.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "Выбери другую ленту на этой доске.")
                })
                return@post
            }
            try {
                call.respond(store.copyMessage(sourceLaneId, messageId, targetLaneId))
            } catch (error: IllegalStateException) {
                val conflict = error.message?.contains("running") == true
                val badRequest = error.message?.contains("only be copied") == true ||
                    error.message?.contains("another target") == true
                val status = when { conflict -> HttpStatusCode.Conflict; badRequest -> HttpStatusCode.BadRequest; else -> HttpStatusCode.NotFound }
                call.respond(status, buildJsonObject {
                    put("error", when {
                        conflict -> "Дождись завершения запросов в обеих лентах."
                        badRequest -> "Выбери другую ленту на этой доске."
                        else -> "Лента или сообщение не найдены."
                    })
                })
            }
        }

        patch("/api/lanes/{laneId}/layout") {
            val laneId = call.parameters["laneId"]
            val layout = try { call.receive<JsonObject>() } catch (_: Exception) { null }
            val x = layout?.get("x")?.jsonPrimitive?.content?.toIntOrNull()
            val y = layout?.get("y")?.jsonPrimitive?.content?.toIntOrNull()
            val width = layout?.get("width")?.jsonPrimitive?.content?.toIntOrNull()
            if (laneId == null || x == null || y == null || width == null || x !in 0..20_000 || y !in 0..20_000 || width !in 280..900) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "Положение ленты некорректно или ширина вне диапазона 280–900 px.")
                })
                return@patch
            }
            try {
                call.respond(store.saveLayout(laneId, x, y, width))
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
            }
        }

        get("/api/codex/status") {
            try {
                val status = codex.status()
                call.respond(buildJsonObject {
                    put("authenticated", status.authenticated)
                    status.planType?.let { put("planType", it) }
                })
            } catch (_: Exception) {
                call.respond(
                    HttpStatusCode.ServiceUnavailable,
                    buildJsonObject {
                        put("authenticated", false)
                        put("error", "Не удалось подключиться к Codex app-server.")
                    },
                )
            }
        }

        get("/api/codex/models") {
            try {
                call.respond(buildJsonObject { put("models", codex.models()) })
            } catch (_: Exception) {
                call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject { put("error", "Список моделей Codex недоступен.") })
            }
        }

        get("/api/openrouter/status") {
            call.respond(buildJsonObject { put("configured", openRouterKeys.isConfigured()) })
        }

        get("/api/mcp/catalog") {
            val servers = withContext(Dispatchers.IO) { mcpRegistry.servers().map { server ->
                runCatching { mcpClient.listTools(server) }.fold(
                    onSuccess = { tools -> buildJsonObject {
                        put("id", server.id); put("name", server.name); put("description", server.description); put("status", "connected")
                        put("tools", kotlinx.serialization.json.buildJsonArray { tools.forEach { tool -> add(buildJsonObject {
                            put("name", tool.name); put("description", tool.description); put("inputSchema", tool.inputSchema); put("readOnly", tool.readOnly)
                        }) } })
                    } },
                    onFailure = { _ -> buildJsonObject {
                        put("id", server.id); put("name", server.name); put("description", server.description); put("status", "error")
                        put("error", "Не удалось подключиться к MCP-серверу.")
                        put("tools", kotlinx.serialization.json.JsonArray(emptyList()))
                    } },
                )
            } }
            call.respond(buildJsonObject { put("servers", kotlinx.serialization.json.JsonArray(servers)) })
        }

        patch("/api/lanes/{laneId}/mcp-tools") {
            val laneId = call.parameters["laneId"]
            val tools = runCatching { call.receive<JsonObject>()["tools"]?.jsonArray }.getOrNull()
            if (laneId == null || tools == null || tools.size > 12) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи не более 12 разрешённых инструментов.") })
                return@patch
            }
            val provider = runCatching { store.providerForLane(laneId) }.getOrNull()
            if (provider == null) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
                return@patch
            }
            try {
                val selections = tools.map { entry ->
                    val value = entry.jsonObject
                    McpSelection(value["serverId"]?.jsonPrimitive?.contentOrNull ?: error("Не указан MCP-сервер."),
                        value["toolName"]?.jsonPrimitive?.contentOrNull ?: error("Не указан инструмент."))
                }.distinct()
                require(selections.isEmpty() || provider == "openrouter") {
                    "MCP-инструменты пока доступны только для OpenRouter."
                }
                withContext(Dispatchers.IO) {
                    selections.forEach { selection ->
                        val registered = mcpRegistry.server(selection.serverId)
                        require(mcpClient.listTools(registered).any { it.name == selection.toolName }) { "Инструмент не найден в реестре." }
                    }
                }
                call.respond(store.saveMcpTools(laneId, selections))
            } catch (_: ActiveRunException) {
                call.respond(HttpStatusCode.Conflict, buildJsonObject { put("error", "Нельзя менять разрешённые инструменты во время запроса.") })
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Выбор MCP-инструментов некорректен.") })
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.BadGateway, buildJsonObject { put("error", "Не удалось проверить MCP-сервер или выбранный инструмент.") })
            } catch (_: Exception) {
                call.respond(HttpStatusCode.BadGateway, buildJsonObject { put("error", "Не удалось подключиться к MCP-серверу или проверить его схему.") })
            }
        }

        patch("/api/lanes/{laneId}/mcp-approval-settings") {
            val laneId = call.parameters["laneId"]
            val enabled = runCatching { call.receive<JsonObject>()["autoApprove"]?.jsonPrimitive?.content?.toBooleanStrict() }.getOrNull()
            if (laneId == null || enabled == null) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи autoApprove: true или false.") })
                return@patch
            }
            try { call.respond(store.setMcpAutoApprove(laneId, enabled)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") }) }
        }

        post("/api/lanes/{laneId}/mcp-approvals/{approvalId}") {
            val laneId = call.parameters["laneId"]
            val approvalId = call.parameters["approvalId"]
            val decision = runCatching { call.receive<JsonObject>()["decision"]?.jsonPrimitive?.content }.getOrNull()
            if (laneId == null || approvalId == null || decision !in setOf("approve", "deny", "close_uncertain")) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи решение approve, deny или close_uncertain.") })
                return@post
            }
            try {
                if (decision == "deny") {
                    if (store.approval(laneId, approvalId) == null) { call.respond(HttpStatusCode.NotFound); return@post }
                    store.denyApproval(laneId, approvalId)
                    call.respond(store.boardForLane(laneId))
                    return@post
                }
                if (decision == "close_uncertain") {
                    if (store.approval(laneId, approvalId) == null) { call.respond(HttpStatusCode.NotFound); return@post }
                    store.closeUncertainApproval(laneId, approvalId)
                    call.respond(store.boardForLane(laneId))
                    return@post
                }
                val approval = store.claimApproval(laneId, approvalId)
                if (approval == null) { call.respond(store.boardForLane(laneId)); return@post }
                try {
                    val serverId = approval["serverId"]!!.jsonPrimitive.content
                    val toolName = approval["toolName"]!!.jsonPrimitive.content
                    val arguments = approval["arguments"]!!.jsonObject
                    val registered = mcpRegistry.server(serverId)
                    val server = if (isLaneScopedMcpServer(serverId)) {
                        scopedMcpServer(registered, store.laneDatabasePath(laneId), laneId, memoryStore.databasePath)
                    } else registered
                    val tool = withContext(Dispatchers.IO) { mcpClient.listTools(server).firstOrNull { it.name == toolName } }
                        ?: error("Selected MCP tool is no longer registered.")
                    require(!tool.readOnly) { "Read-only tools cannot be approved for execution." }
                    McpClient.validateSchema(arguments, tool.inputSchema)
                    withContext(Dispatchers.IO) { mcpClient.call(server, toolName, arguments) }
                    store.finishApproval(laneId, approvalId, "approved", "user")
                } catch (_: Exception) {
                    store.finishApproval(laneId, approvalId, "failed", "user")
                }
                call.respond(store.boardForLane(laneId))
            } catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") }) }
        }

        patch("/api/lanes/{laneId}/facts") {
            val laneId = call.parameters["laneId"]
            val payload = runCatching { call.receive<JsonObject>() }.getOrNull()
            val key = payload?.get("key")?.jsonPrimitive?.contentOrNull
            val value = payload?.get("value")?.jsonPrimitive?.contentOrNull
            if (laneId == null || key.isNullOrBlank() || value == null) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Укажи ключ и значение факта.") }); return@patch
            }
            try { call.respond(store.editFact(laneId, key, value)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Ключ или значение факта превышает допустимую длину.") }) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") }) }
        }

        delete("/api/lanes/{laneId}/facts/{key}") {
            val laneId = call.parameters["laneId"]; val key = call.parameters["key"]
            if (laneId == null || key == null) { call.respond(HttpStatusCode.BadRequest); return@delete }
            try { call.respond(store.editFact(laneId, key, null)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") }) }
        }

        delete("/api/lanes/{laneId}/facts") {
            val laneId = call.parameters["laneId"]
            if (laneId == null) { call.respond(HttpStatusCode.BadRequest); return@delete }
            try { call.respond(store.clearFacts(laneId)) }
            catch (_: IllegalStateException) { call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") }) }
        }

        post("/api/openrouter/key") {
            val key = runCatching { call.receive<JsonObject>()["apiKey"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            if (key.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Введи API-ключ OpenRouter.") })
                return@post
            }
            try {
                openRouterKeys.save(key)
                call.respond(buildJsonObject { put("configured", true) })
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Ключ некорректен.") })
            }
        }

        post("/api/codex/login") {
            try {
                val login = codex.beginLogin()
                call.respond(buildJsonObject { put("authUrl", login.authUrl) })
            } catch (_: Exception) {
                call.respond(
                    HttpStatusCode.ServiceUnavailable,
                    buildJsonObject { put("error", "Не удалось начать вход через ChatGPT.") },
                )
            }
        }

        post("/api/lanes/{laneId}/messages") {
            val laneId = call.parameters["laneId"]
            val body = try {
                call.receive<JsonObject>()
            } catch (_: Exception) {
                buildJsonObject {}
            }
            val prompt = body["text"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val parameters = body["parameters"]?.jsonObject
            if (laneId == null || prompt.isBlank() || prompt.length > 6_000) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "Введи сообщение длиной до 6000 символов.")
                })
                return@post
            }
            val provider = try { store.providerForLane(laneId) } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
                return@post
            }
            if (provider == "codex") {
                val status = try { codex.status() } catch (_: Exception) {
                    call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject { put("error", "Codex app-server недоступен.") })
                    return@post
                }
                if (!status.authenticated) {
                    call.respond(HttpStatusCode.Unauthorized, buildJsonObject { put("error", "Сначала войди в Codex через подписку ChatGPT.") })
                    return@post
                }
            } else if (!openRouterKeys.isConfigured()) {
                call.respond(HttpStatusCode.Unauthorized, buildJsonObject { put("error", "Сначала сохрани API-ключ OpenRouter в настройках.") })
                return@post
            }
            val overrides = RequestOverrides(
                parameters?.get("model")?.jsonPrimitive?.contentOrNull,
                parameters?.get("temperature")?.jsonPrimitive?.doubleOrNull,
                parameters?.get("maxTokens")?.jsonPrimitive?.intOrNull,
                parameters?.get("stop")?.jsonPrimitive?.contentOrNull,
                parameters?.get("forceSend")?.jsonPrimitive?.contentOrNull == "true",
            )
            if (provider == "codex" && parameters != null &&
                listOf("temperature", "maxTokens", "stop").any { parameters.containsKey(it) }
            ) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "Codex не принимает temperature, max tokens и stop.") })
                return@post
            }
            try {
                val runId = coordinator.submit(laneId, prompt, overrides)
                call.respond(HttpStatusCode.Accepted, buildJsonObject { put("runId", runId) })
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", error.message ?: "Параметры запроса некорректны.") })
            } catch (_: ActiveRunException) {
                call.respond(HttpStatusCode.Conflict, buildJsonObject {
                    put("error", "В этой ленте уже выполняется запрос.")
                })
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
            }
        }

        post("/api/runs/{runId}/cancel") {
            val runId = call.parameters["runId"]
            if (runId == null || !store.runExists(runId)) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Запрос не найден.") })
                return@post
            }
            call.respond(buildJsonObject { put("cancelled", coordinator.cancel(runId)) })
        }

        sse("/api/runs/{runId}/events") {
            val runId = call.parameters["runId"]
            if (runId == null || !store.runExists(runId)) {
                call.respond(HttpStatusCode.NotFound)
                return@sse
            }
            val lastEventId = call.request.headers["Last-Event-ID"]?.toLongOrNull()
                ?: call.request.queryParameters["after"]?.toLongOrNull()
                ?: 0L
            var sequence = lastEventId
            while (true) {
                val events = withContext(Dispatchers.IO) { store.eventsAfter(runId, sequence) }
                for ((eventSequence, event) in events) {
                    send(
                        ServerSentEvent(
                            id = eventSequence.toString(),
                            data = json.encodeToString(JsonObject.serializer(), event),
                        ),
                    )
                    sequence = eventSequence
                }
                if (store.isTerminal(runId) && events.isEmpty()) break
                delay(250)
            }
        }
    }
}

fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8787
    embeddedServer(
        Netty,
        host = "127.0.0.1",
        port = port,
        module = { module() },
    ).start(wait = true)
}
