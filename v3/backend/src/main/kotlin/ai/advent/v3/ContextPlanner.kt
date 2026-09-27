package ai.advent.v3

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class ContextStrategy(val wireName: String) {
    FULL("full"), SLIDING_WINDOW("sliding_window"), SUMMARY_WINDOW("summary_window");

    companion object {
        fun parse(value: String): ContextStrategy = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Неизвестная стратегия контекста.")
    }
}

data class ContextPlan(
    val messages: List<ContextMessage>,
    val omittedMessages: Int,
    val inputTokensEstimate: Int,
    val currentMessageTokensEstimate: Int,
    val historyTokensEstimate: Int,
    val responseTokensEstimate: Int,
    val budgetTokens: Int,
    val overflow: Boolean,
    val summaryMissing: Boolean,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("messages", kotlinx.serialization.json.buildJsonArray {
            messages.forEach { add(buildJsonObject { put("role", it.role); put("content", it.content) }) }
        })
        put("omittedMessages", omittedMessages)
        put("inputTokensEstimate", inputTokensEstimate)
        put("currentMessageTokensEstimate", currentMessageTokensEstimate)
        put("historyTokensEstimate", historyTokensEstimate)
        put("responseTokensEstimate", responseTokensEstimate)
        put("budgetTokens", budgetTokens)
        put("overflow", overflow)
        put("summaryMissing", summaryMissing)
        put("estimateKind", "character-based approximation")
    }
}

/** Pure planner shared by all boards and providers. Transcript input is never mutated. */
object ContextPlanner {
    fun plan(
        transcript: List<ContextMessage>,
        prompt: String,
        strategy: ContextStrategy,
        windowSize: Int,
        summary: String,
        summaryWatermark: String?,
        budgetTokens: Int,
        responseTokensEstimate: Int,
    ): ContextPlan {
        require(windowSize in 1..200) { "Размер окна должен быть от 1 до 200 сообщений." }
        require(budgetTokens in 256..1_000_000) { "Бюджет контекста должен быть от 256 до 1000000 токенов." }
        require(responseTokensEstimate in 1..200_000) { "Оценка ответа вне допустимого диапазона." }
        val stableTranscript = transcript.filter { it.content.isNotEmpty() }
        val summaryBoundary = if (summary.isBlank()) {
            null
        } else if (summaryWatermark == null) {
            stableTranscript.size
        } else {
            stableTranscript.indexOfFirst { it.id == summaryWatermark }.takeIf { it >= 0 }?.plus(1)
                ?: (stableTranscript.size - windowSize).coerceAtLeast(0)
        }
        val selected = when (strategy) {
            ContextStrategy.FULL -> stableTranscript
            ContextStrategy.SLIDING_WINDOW -> stableTranscript.takeLast(windowSize)
            ContextStrategy.SUMMARY_WINDOW -> buildList {
                if (summary.isNotBlank()) add(ContextMessage("user", "Сводка предыдущего диалога (до watermark ${summaryWatermark ?: "не задан"}):\n$summary"))
                val afterSummary = summaryBoundary?.let { stableTranscript.drop(it) } ?: stableTranscript
                addAll(if (summary.isBlank()) afterSummary.takeLast(windowSize) else afterSummary)
            }
        }
        val estimate: (String) -> Int = { text -> ((text.length + 3) / 4).coerceAtLeast(if (text.isEmpty()) 0 else 1) }
        val historyTokens = selected.sumOf { estimate(it.content) }
        val currentTokens = estimate(prompt)
        val inputTokens = historyTokens + currentTokens
        val overflow = inputTokens + responseTokensEstimate > budgetTokens
        val includedTranscriptCount = when (strategy) {
            ContextStrategy.FULL -> stableTranscript.size
            ContextStrategy.SLIDING_WINDOW -> minOf(stableTranscript.size, windowSize)
            ContextStrategy.SUMMARY_WINDOW -> if (summary.isNotBlank()) stableTranscript.size else minOf(stableTranscript.size, windowSize)
        }
        return ContextPlan(selected.toList(), (stableTranscript.size - includedTranscriptCount).coerceAtLeast(0),
            inputTokens, currentTokens, historyTokens, responseTokensEstimate, budgetTokens, overflow,
            strategy == ContextStrategy.SUMMARY_WINDOW && summary.isBlank())
    }
}
