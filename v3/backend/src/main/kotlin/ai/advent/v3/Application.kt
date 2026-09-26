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
import io.ktor.server.routing.post
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
    store: BoardStore = BoardStore(Path.of(System.getenv("AI_ADVENT_V3_DB") ?: "v3/data/board.sqlite")),
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
            call.respond(store.board())
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
