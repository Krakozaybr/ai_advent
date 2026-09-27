package ai.advent.v3

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ContextPlannerTest {
    private val transcript = listOf(
        ContextMessage("user", "one"),
        ContextMessage("assistant", "two"),
        ContextMessage("user", "three"),
    )

    @Test
    fun `full plan retains every message without mutating transcript`() {
        val original = transcript.toList()
        val plan = ContextPlanner.plan(transcript, "next", ContextStrategy.FULL, 1, "", null, 32_768, 100)
        assertEquals(transcript, plan.messages)
        assertEquals(0, plan.omittedMessages)
        assertEquals(original, transcript)
    }

    @Test
    fun `sliding window retains only last N and counts omitted messages`() {
        val plan = ContextPlanner.plan(transcript, "next", ContextStrategy.SLIDING_WINDOW, 1, "", null, 32_768, 100)
        assertEquals(listOf(transcript.last()), plan.messages)
        assertEquals(2, plan.omittedMessages)
    }

    @Test
    fun `summary is a separate planned message and overflow is a warning`() {
        val plan = ContextPlanner.plan(transcript, "next", ContextStrategy.SUMMARY_WINDOW, 1, "key facts", "message-2", 256, 250)
        assertEquals("Сводка предыдущего диалога (до watermark message-2):\nkey facts", plan.messages.first().content)
        assertTrue(plan.overflow)
        assertEquals(0, plan.omittedMessages)
    }

    @Test
    fun `summary watermark keeps every newer message without repeating covered history`() {
        val history = listOf(
            ContextMessage("user", "one", "m1"),
            ContextMessage("assistant", "two", "m2"),
            ContextMessage("user", "three", "m3"),
            ContextMessage("assistant", "four", "m4"),
            ContextMessage("user", "five", "m5"),
        )
        val plan = ContextPlanner.plan(history, "next", ContextStrategy.SUMMARY_WINDOW, 2, "facts", "m2", 1_000, 20)

        assertEquals(listOf("facts", "three", "four", "five"), plan.messages.map { it.content.substringAfterLast("\n") })
        assertEquals(0, plan.omittedMessages)
        assertFalse(plan.overflow)
    }

    @Test
    fun `summary context budget includes every message newer than watermark`() {
        val history = listOf(
            ContextMessage("user", "one", "m1"),
            ContextMessage("assistant", "two", "m2"),
            ContextMessage("user", "three", "m3"),
            ContextMessage("assistant", "four", "m4"),
            ContextMessage("user", "five", "m5"),
        )
        val plan = ContextPlanner.plan(history, "next", ContextStrategy.SUMMARY_WINDOW, 1, "facts", "m2", 256, 250)

        assertEquals(listOf("facts", "three", "four", "five"), plan.messages.map { it.content.substringAfterLast("\n") })
        assertTrue(plan.overflow)
        assertEquals(plan.messages.sumOf { ((it.content.length + 3) / 4).coerceAtLeast(1) }, plan.historyTokensEstimate)
    }

    @Test
    fun `legacy summary without watermark covers the existing transcript`() {
        val history = transcript.mapIndexed { index, item -> item.copy(id = "m${index + 1}") }
        val plan = ContextPlanner.plan(history, "next", ContextStrategy.SUMMARY_WINDOW, 1, "legacy facts", null, 1_000, 20)

        assertEquals(listOf("legacy facts"), plan.messages.map { it.content.substringAfterLast("\n") })
        assertEquals(0, plan.omittedMessages)
        assertFalse(plan.overflow)
    }

    @Test
    fun `budget with enough headroom does not warn`() {
        assertFalse(ContextPlanner.plan(transcript, "next", ContextStrategy.FULL, 1, "", null, 1000, 100).overflow)
    }
}
