package ai.advent.v3

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

data class McpServerConfig(val id: String, val name: String, val description: String, val command: String, val args: List<String>, val cwd: String, val environment: Map<String, String> = emptyMap())
data class McpTool(val serverId: String, val name: String, val description: String, val inputSchema: JsonObject, val readOnly: Boolean = false)

/** Registry commands are loaded only from this server-owned file; requests can select IDs, never commands. */
class McpRegistry(private val servers: List<McpServerConfig> = defaultServers()) {
    private val byId = servers.associateBy { it.id }
    init {
        require(servers.size == byId.size) { "MCP server IDs must be unique." }
        servers.forEach { require(it.id.matches(Regex("[a-z0-9][a-z0-9-]{0,49}")) && it.command.isNotBlank()) }
    }
    fun server(id: String): McpServerConfig = byId[id] ?: error("Unknown MCP server.")
    fun servers(): List<McpServerConfig> = servers

    companion object {
        fun defaultServers(): List<McpServerConfig> {
            val root = Path.of(System.getenv("AI_ADVENT_V3_CWD") ?: System.getProperty("user.dir"))
                .toAbsolutePath().let { if (it.resolve("examples/mcp/catalog-server.mjs").toFile().exists()) it else it.parent.parent }
            val config = Path.of(System.getenv("AI_ADVENT_V3_MCP_REGISTRY") ?: root.resolve("v3/data/mcp-servers.json").toString())
            val example = root.resolve("examples/mcp/catalog-server.mjs").toString()
            val facts = root.resolve("examples/mcp/sticky-facts-server.mjs").toString()
            val history = root.resolve("examples/mcp/lane-history-server.mjs").toString()
            val memory = root.resolve("examples/mcp/board-memory-server.mjs").toString()
            val builtIns = listOf(
                McpServerConfig("local-catalog", "Локальный каталог", "Поиск в демонстрационном локальном каталоге.", "node", listOf(example), root.toString()),
                McpServerConfig("sticky-facts", "Постоянные факты", "Факты пользователя для текущей ленты.", "node", listOf(facts), root.toString()),
                McpServerConfig("lane-history", "История текущей ленты", "Поиск по сохранённой истории только этой ленты.", "node", listOf(history), root.toString()),
                McpServerConfig("board-memory", "Память доски", "Рабочие и долговременная память доски в отдельной SQLite.", "node", listOf(memory), root.toString()),
            )
            if (Files.isRegularFile(config)) return (fromFile(config, root).filterNot { configured -> builtIns.any { it.id == configured.id } } + builtIns)
            return builtIns
        }

        private fun fromFile(config: Path, root: Path): List<McpServerConfig> {
            val value = Json.parseToJsonElement(Files.readString(config)).jsonObject
            require(value.keys == setOf("servers")) { "MCP registry must contain only a servers array." }
            return value.getValue("servers").jsonArray.map { element ->
                val item = element.jsonObject
                require(item.keys.all { it in setOf("id", "name", "description", "command", "args", "cwd") }) { "MCP registry contains an unsupported field." }
                val resolve = { raw: String ->
                    Path.of(raw.replace("${'$'}{PROJECT_ROOT}", root.toString())).let { if (it.isAbsolute) it.normalize() else config.toAbsolutePath().parent.resolve(it).normalize() }.toString()
                }
                val rawCwd = item["cwd"]?.jsonPrimitive?.content ?: "${'$'}{PROJECT_ROOT}"
                McpServerConfig(
                    item.getValue("id").jsonPrimitive.content,
                    item.getValue("name").jsonPrimitive.content,
                    item["description"]?.jsonPrimitive?.content.orEmpty(),
                    item.getValue("command").jsonPrimitive.content,
                    item["args"]?.jsonArray?.map { it.jsonPrimitive.content }?.map { it.replace("${'$'}{PROJECT_ROOT}", root.toString()) }.orEmpty(),
                    resolve(rawCwd),
                )
            }
        }
    }
}

data class McpSelection(val serverId: String, val toolName: String)

fun scopedMcpServer(server: McpServerConfig, laneDatabasePath: String, laneId: String, memoryDatabasePath: String): McpServerConfig =
    server.copy(environment = server.environment + buildMap {
        put("AI_ADVENT_V3_BOARD_DB", laneDatabasePath)
        put("AI_ADVENT_V3_LANE_ID", laneId)
        if (server.id == "board-memory") put("AI_ADVENT_V3_MEMORY_DB", memoryDatabasePath)
    })

class McpClient(private val timeoutMs: Long = 5_000) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ids = AtomicLong(1)

    fun listTools(server: McpServerConfig): List<McpTool> = withSession(server) { session ->
        session.request("tools/list").getValue("tools").jsonArray.map { item ->
            val tool = item.jsonObject
            McpTool(server.id, tool.getValue("name").jsonPrimitive.content,
                tool["description"]?.jsonPrimitive?.contentOrNull.orEmpty(), tool.getValue("inputSchema").jsonObject,
                tool["annotations"]?.jsonObject?.get("readOnlyHint")?.jsonPrimitive?.content == "true")
        }
    }

    fun call(server: McpServerConfig, toolName: String, arguments: JsonObject): JsonObject = withSession(server) { session ->
        val listed = session.request("tools/list").getValue("tools").jsonArray.map { it.jsonObject }
        val tool = listed.firstOrNull { it["name"]?.jsonPrimitive?.content == toolName } ?: error("Unknown tool.")
        validateSchema(arguments, tool.getValue("inputSchema").jsonObject)
        val result = session.request("tools/call", buildJsonObject { put("name", toolName); put("arguments", arguments) })
        if (result["isError"]?.jsonPrimitive?.content == "true") error(result["content"]?.toString() ?: "MCP tool failed.")
        result
    }

    private fun <T> withSession(server: McpServerConfig, block: (Session) -> T): T {
        val builder = ProcessBuilder(listOf(server.command) + server.args).directory(Path.of(server.cwd).toFile())
        builder.environment().putAll(server.environment)
        val process = builder.start()
        val queue = ArrayBlockingQueue<String>(16)
        val reader = Thread {
            process.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines -> lines.forEach { queue.offer(it) } }
        }.apply { isDaemon = true; start() }
        try {
            val session = Session(process, queue)
            session.request("initialize", buildJsonObject {
                put("protocolVersion", "2025-03-26")
                put("capabilities", buildJsonObject {})
                put("clientInfo", buildJsonObject { put("name", "ai-advent-v3"); put("version", "1.0") })
            })
            session.notify("notifications/initialized")
            return block(session)
        } finally {
            process.destroy()
            if (!process.waitFor(250, TimeUnit.MILLISECONDS)) process.destroyForcibly()
            reader.interrupt()
        }
    }

    private inner class Session(private val process: Process, private val lines: ArrayBlockingQueue<String>) {
        fun notify(method: String) = send(buildJsonObject { put("jsonrpc", "2.0"); put("method", method) })
        fun request(method: String, params: JsonObject = buildJsonObject {}): JsonObject {
            val id = ids.getAndIncrement()
            send(buildJsonObject { put("jsonrpc", "2.0"); put("id", id); put("method", method); put("params", params) })
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (true) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) error("MCP server timed out after ${timeoutMs}ms.")
                val line = lines.poll(remaining, TimeUnit.NANOSECONDS)
                if (line == null) {
                    if (process.isAlive) error("MCP server timed out after ${timeoutMs}ms.")
                    error("MCP server closed its output.")
                }
                val response = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
                if (response["id"]?.jsonPrimitive?.content != id.toString()) continue
                response["error"]?.let { error("MCP error: ${it.jsonObject["message"]?.jsonPrimitive?.content ?: it}") }
                return response["result"]?.jsonObject ?: error("MCP response has no result.")
            }
        }
        private fun send(message: JsonObject) {
            process.outputStream.bufferedWriter(Charsets.UTF_8).apply {
                write(json.encodeToString(JsonObject.serializer(), message)); newLine(); flush()
            }
        }
    }

    companion object {
        fun validateSchema(value: JsonObject, schema: JsonObject) {
            validateSupportedSchema(schema, "Tool schema")
            validateValue(value, schema, "Tool arguments")
        }

        private fun validateSupportedSchema(schema: JsonObject, path: String) {
            val supported = setOf("\$schema", "type", "enum", "required", "additionalProperties", "properties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "description", "title")
            val unsupported = schema.keys - supported
            require(unsupported.isEmpty()) { "$path uses unsupported schema constraints: ${unsupported.sorted().joinToString()}" }
            schema["properties"]?.jsonObject?.forEach { (key, child) -> validateSupportedSchema(child.jsonObject, "$path.$key") }
            schema["items"]?.jsonObject?.let { validateSupportedSchema(it, "$path[]") }
        }

        private fun validateValue(value: kotlinx.serialization.json.JsonElement, schema: JsonObject, path: String) {
            val expectedTypes = when (val type = schema["type"]) {
                is JsonPrimitive -> listOf(type.content)
                is JsonArray -> type.map { it.jsonPrimitive.content }
                else -> emptyList()
            }
            val actual = when (value) {
                is JsonObject -> "object"
                is JsonArray -> "array"
                JsonNull -> "null"
                is JsonPrimitive -> when {
                    value.isString -> "string"
                    value.content == "true" || value.content == "false" -> "boolean"
                    value.doubleOrNull != null -> if (value.intOrNull != null) "integer" else "number"
                    else -> "unknown"
                }
            }
            require(expectedTypes.isEmpty() || actual in expectedTypes || actual == "integer" && "number" in expectedTypes) {
                "$path must be ${expectedTypes.joinToString(" or ")}."
            }
            schema["enum"]?.jsonArray?.let { choices -> require(value in choices) { "$path has an unsupported value." } }
            if (value is JsonObject) {
                val properties = schema["properties"]?.jsonObject ?: buildJsonObject {}
                val required = schema["required"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet().orEmpty()
                require(required.all(value::containsKey)) { "$path is missing required fields." }
                val additional = schema["additionalProperties"]?.jsonPrimitive?.content == "true"
                require(additional || value.keys.all { it in properties }) { "$path contains unknown fields." }
                value.forEach { (key, child) -> properties[key]?.jsonObject?.let { validateValue(child, it, "$path.$key") } }
            }
            if (value is JsonArray) {
                schema["minItems"]?.jsonPrimitive?.intOrNull?.let { require(value.size >= it) { "$path has too few items." } }
                schema["maxItems"]?.jsonPrimitive?.intOrNull?.let { require(value.size <= it) { "$path has too many items." } }
                schema["items"]?.jsonObject?.let { itemSchema -> value.forEachIndexed { index, child -> validateValue(child, itemSchema, "$path[$index]") } }
            }
            if (value is JsonPrimitive && value.isString) {
                schema["minLength"]?.jsonPrimitive?.intOrNull?.let { require(value.content.length >= it) { "$path is too short." } }
                schema["maxLength"]?.jsonPrimitive?.intOrNull?.let { require(value.content.length <= it) { "$path is too long." } }
            }
            if (actual == "number" || actual == "integer") {
                val number = value.jsonPrimitive.doubleOrNull!!
                schema["minimum"]?.jsonPrimitive?.doubleOrNull?.let { require(number >= it) { "$path is below the minimum." } }
                schema["maximum"]?.jsonPrimitive?.doubleOrNull?.let { require(number <= it) { "$path exceeds the maximum." } }
            }
        }
    }
}

private val kotlinx.serialization.json.JsonPrimitive.intOrNull: Int? get() = content.toIntOrNull()
private val kotlinx.serialization.json.JsonPrimitive.doubleOrNull: Double? get() = content.toDoubleOrNull()
