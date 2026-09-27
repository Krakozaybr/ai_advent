package ai.advent.v3

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import io.ktor.server.netty.Netty
import io.ktor.server.engine.embeddedServer
import java.nio.file.Path

private val json = Json { ignoreUnknownKeys = true }

fun Application.module(
    store: WorkspaceStore = WorkspaceStore(Path.of(System.getenv("AI_ADVENT_V3_DB") ?: "v3/data/board.sqlite")),
    codex: CodexGateway = CodexAppServer(),
) {
    install(ContentNegotiation) { json(json) }
    install(SSE)
    val coordinator = RunCoordinator(store, codex)
    monitor.subscribe(ApplicationStopped) { coordinator.close() }

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
            try {
                call.respond(HttpStatusCode.Created, store.createLane(boardId ?: ""))
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Доска не найдена.") })
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
            val prompt = try {
                call.receive<JsonObject>()["text"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            } catch (_: Exception) {
                ""
            }
            if (laneId == null || prompt.isBlank() || prompt.length > 6_000) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "Введи сообщение длиной до 6000 символов.")
                })
                return@post
            }
            val status = try {
                codex.status()
            } catch (_: Exception) {
                call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject {
                    put("error", "Codex app-server недоступен.")
                })
                return@post
            }
            if (!status.authenticated) {
                call.respond(HttpStatusCode.Unauthorized, buildJsonObject {
                    put("error", "Сначала войди в Codex через подписку ChatGPT.")
                })
                return@post
            }
            try {
                val runId = coordinator.submit(laneId, prompt)
                call.respond(HttpStatusCode.Accepted, buildJsonObject { put("runId", runId) })
            } catch (_: ActiveRunException) {
                call.respond(HttpStatusCode.Conflict, buildJsonObject {
                    put("error", "В этой ленте уже выполняется запрос.")
                })
            } catch (_: IllegalStateException) {
                call.respond(HttpStatusCode.NotFound, buildJsonObject { put("error", "Лента не найдена.") })
            }
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
