package ai.advent.v3

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/** Strict, generic decoder for a prepared board payload. */
object BoardImport {
    private val forbiddenNames = setOf("apikey", "authorization", "token", "secret", "codexthreadid", "threadid", "thread_id")
    private val safeText = Regex("(?i)(sk-or-v1-[a-z0-9]{12,}|bearer\\s+[a-z0-9._-]{12,}|api[_ -]?key\\s*[:=]|thread_[a-z0-9_-]{8,})")

    fun parse(root: JsonObject): ImportedBoard {
        require(root.keys.all { it in setOf("externalId", "title", "lanes", "agents") }) { "В пакете есть неизвестные поля." }
        val externalId = root.string("externalId", 120).also { require(it.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]*"))) { "Некорректный externalId." } }
        val title = root.string("title", 160)
        val rawLanes = root.array("lanes")
        require(rawLanes.size in 1..16) { "В доске должно быть от 1 до 16 лент." }
        val agents = (root["agents"] as? JsonArray ?: JsonArray(emptyList())).map { element ->
            val agent = element as? JsonObject ?: error("Агент должен быть объектом.")
            require(agent.keys == setOf("externalId", "name", "description", "instructions")) { "Некорректная схема агента." }
            ImportedAgent(agent.string("externalId", 120), agent.string("name", 120), agent.string("description", 2_000), agent.string("instructions", 10_000))
        }
        require(agents.map { it.externalId }.toSet().size == agents.size && agents.size <= 16) { "externalId агентов должны быть уникальными; допустимо до 16 агентов." }
        val lanes = rawLanes.map { element ->
            val obj = element as? JsonObject ?: error("Лента должна быть объектом.")
            val allowed = setOf("externalId", "title", "provider", "model", "temperature", "maxTokens", "stop", "contextStrategy", "contextWindowSize", "contextBudgetTokens", "summary", "layout", "messages", "origin", "agentExternalId")
            require(obj.keys.all { it in allowed } && allowed.containsAll(obj.keys)) { "В ленте есть неизвестные поля." }
            val layout = obj.obj("layout")
            require(layout.keys == setOf("x", "y", "width")) { "Некорректная геометрия ленты." }
            val messages = obj.array("messages").also { require(it.size <= 400) { "В ленте слишком много сообщений." } }.map { item ->
                val message = item as? JsonObject ?: error("Сообщение должно быть объектом.")
                require(message.keys.all { it in setOf("externalId", "role", "content", "provenance") }) { "В сообщении есть неизвестные поля." }
                val content = message.string("content", 40_000)
                require(!safeText.containsMatchIn(content)) { "Похоже, сообщение содержит секрет или ключ." }
                val role = message.string("role", 16)
                require(role == "user" || role == "assistant") { "Допустимы только роли user и assistant." }
                ImportedMessage(message.string("externalId", 120), role, content, message.optionalString("provenance", 200))
            }
            require(messages.sumOf { it.content.length } <= 1_000_000) { "История ленты превышает 1 МБ текста." }
            val origin = obj["origin"]?.let { it as? JsonObject ?: error("origin должен быть объектом.") }
            if (origin != null) require(origin.keys == setOf("laneExternalId", "messageExternalId", "kind")) { "Некорректная ссылка ветвления." }
            val provider = obj.string("provider", 20)
            require(provider == "codex" || provider == "openrouter") { "Неизвестный провайдер." }
            val model = obj.optionalString("model", 200) ?: if (provider == "openrouter") "openai/gpt-4o-mini" else ""
            val temperature = obj["temperature"]?.numberDouble("temperature")
            val maxTokens = obj["maxTokens"]?.numberInt("maxTokens")
            val stop = obj.optionalString("stop", 500)
            if (provider == "codex") require(temperature == null && maxTokens == null && stop == null) { "Конфигурация Codex содержит параметры OpenRouter." }
            require(temperature == null || temperature in 0.0..2.0) { "temperature вне диапазона 0–2." }
            require(maxTokens == null || maxTokens in 1..200_000) { "maxTokens вне допустимого диапазона." }
            val strategy = obj.optionalString("contextStrategy", 32) ?: "full"
            ContextStrategy.parse(strategy)
            ImportedLane(
                externalId = obj.string("externalId", 120), title = obj.string("title", 160), provider = provider, model = model,
                temperature = temperature, maxTokens = maxTokens, stop = stop, contextStrategy = strategy,
                contextWindowSize = obj.optionalInt("contextWindowSize") ?: 10,
                contextBudgetTokens = obj.optionalInt("contextBudgetTokens") ?: 32768,
                summary = obj.optionalString("summary", 50_000) ?: "",
                x = layout.requiredInt("x"), y = layout.requiredInt("y"), width = layout.requiredInt("width"),
                messages = messages, originLaneExternalId = origin?.string("laneExternalId", 120),
                originMessageExternalId = origin?.string("messageExternalId", 120), originKind = origin?.string("kind", 16),
                agentExternalId = obj.optionalString("agentExternalId", 120),
            ).also {
                require(it.contextWindowSize in 1..200 && it.contextBudgetTokens in 256..1_000_000) { "Настройки контекста вне допустимого диапазона." }
                require(it.x in 0..20_000 && it.y in 0..20_000 && it.width in 280..900) { "Геометрия ленты вне допустимого диапазона." }
                require(it.originKind == null || it.originKind in setOf("branch", "clone")) { "Неизвестный тип связи лент." }
                require(it.messages.map { message -> message.externalId }.toSet().size == it.messages.size) { "externalId сообщений должны быть уникальными в ленте." }
            }
        }
        require(lanes.map { it.externalId }.toSet().size == lanes.size) { "externalId лент должны быть уникальными." }
        val byLane = lanes.associateBy { it.externalId }
        val agentIds = agents.map { it.externalId }.toSet()
        lanes.forEach { lane ->
            require(lane.agentExternalId == null || lane.agentExternalId in agentIds) { "Связанный агент не найден." }
            require((lane.originLaneExternalId == null) == (lane.originMessageExternalId == null) && (lane.originLaneExternalId == null) == (lane.originKind == null)) { "Связь ленты должна содержать источник, сообщение и тип." }
            lane.originLaneExternalId?.let { sourceId ->
                require(sourceId != lane.externalId) { "Лента не может ветвиться сама от себя." }
                val source = byLane[sourceId] ?: error("Источник ветки не найден.")
                require(source.messages.any { it.externalId == lane.originMessageExternalId }) { "Сообщение точки ветвления не найдено." }
            }
        }
        val visiting = mutableSetOf<String>()
        val visited = mutableSetOf<String>()
        fun visit(id: String) {
            if (id in visited) return
            require(visiting.add(id)) { "Связи лент не должны образовывать цикл." }
            byLane.getValue(id).originLaneExternalId?.let(::visit)
            visiting.remove(id)
            visited.add(id)
        }
        lanes.forEach { visit(it.externalId) }
        return ImportedBoard(externalId, title, lanes, agents)
    }

    private fun JsonObject.string(key: String, limit: Int): String {
        val value = (this[key] as? JsonPrimitive)?.contentOrNull ?: error("Поле $key должно быть строкой.")
        require(value.isNotBlank() && value.length <= limit && !safeText.containsMatchIn(value)) { "Поле $key пустое, слишком длинное или содержит запрещённое значение." }
        return value
    }

    private fun JsonObject.optionalString(key: String, limit: Int): String? = when (val value = this[key]) {
        null, JsonNull -> null
        else -> string(key, limit)
    }

    private fun JsonObject.array(key: String): JsonArray = this[key] as? JsonArray ?: error("Поле $key должно быть массивом.")
    private fun JsonObject.obj(key: String): JsonObject = this[key] as? JsonObject ?: error("Поле $key должно быть объектом.")
    private fun JsonObject.requiredInt(key: String): Int = this[key]?.numberInt(key) ?: error("Поле $key должно быть целым числом.")
    private fun JsonObject.optionalInt(key: String): Int? = when (val value = this[key]) {
        null, JsonNull -> null
        else -> value.numberInt(key)
    }
    private fun JsonElement.numberInt(key: String): Int = (this as? JsonPrimitive)?.intOrNull ?: error("Поле $key должно быть целым числом.")
    private fun JsonElement.numberDouble(key: String): Double = (this as? JsonPrimitive)?.doubleOrNull ?: error("Поле $key должно быть числом.")

    fun validateNoSecretsOrThreadIds(element: JsonElement) {
        when (element) {
            is JsonObject -> element.forEach { (key, value) ->
                require(key.lowercase().replace("_", "") !in forbiddenNames) { "Импорт не принимает секреты или ID внутренних threads." }
                validateNoSecretsOrThreadIds(value)
            }
            is JsonArray -> element.forEach(::validateNoSecretsOrThreadIds)
            is JsonPrimitive -> if (element.isString) require(!safeText.containsMatchIn(element.content)) { "Импорт похож на содержащий ключ или токен." }
        }
    }
}
