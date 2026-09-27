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
        assertEquals(2, plan.omittedMessages)
    }

    @Test
    fun `budget with enough headroom does not warn`() {
        assertFalse(ContextPlanner.plan(transcript, "next", ContextStrategy.FULL, 1, "", null, 1000, 100).overflow)
    }
}
