package com.jarvisfit.app

import com.jarvisfit.app.device.ClaudeChat
import com.jarvisfit.app.device.ClaudeChat.Block
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeChatTest {

    private val oldChat = listOf(
        Block("English B2"),
        Block("Let's practise the past perfect."),
        Block("Sure! Here is your first exercise: complete the sentence."),
        Block("Copy", clickable = true),
        Block("Retry", clickable = true),
    )
    private val seen = ClaudeChat.messages(oldChat).map { ClaudeChat.norm(it) }.toSet()

    @Test
    fun oldMessagesAreNeverRead() {
        // All'accensione tutto ciò che c'è è già visto: nessuna risposta da leggere.
        assertNull(ClaudeChat.update(oldChat, seen, sent = null))
    }

    @Test
    fun replyIsWhatComesAfterTheSentMessage() {
        val sent = "I had already left when she arrived"
        val screen = oldChat + listOf(
            Block(sent),
            Block("Great job! That's correct."),
            Block("Now try another one: by the time we got there, the film ___ (start)."),
            Block("Copy", clickable = true),
        )
        val r = ClaudeChat.update(screen, seen, sent)
        assertEquals(listOf("Great job! That's correct.", "Now try another one: by the time we got there, the film ___ (start)."), r)
    }

    @Test
    fun noReplyYetAfterSending() {
        val sent = "I had already left when she arrived"
        assertNull(ClaudeChat.update(oldChat + Block(sent), seen, sent))
    }

    @Test
    fun longReplyStillFollowedWhenSentMessageScrollsAway() {
        val sent = "Can you explain the difference?"
        val current = listOf("Of course.", "The past simple describes")
        // Il messaggio inviato non è più sullo schermo, l'ultimo pezzo intanto è cresciuto.
        val screen = listOf(
            Block("Of course."),
            Block("The past simple describes a finished action."),
            Block("The past perfect describes an earlier one."),
        )
        val r = ClaudeChat.update(screen, seen, sent, current)
        assertEquals(listOf("Of course.", "The past simple describes a finished action.", "The past perfect describes an earlier one."), r)
    }

    @Test
    fun otherChatWithoutAnchorIsSilent() {
        val other = listOf(Block("A totally different conversation."), Block("With an old answer."))
        assertNull(ClaudeChat.update(other, seen, sent = null))
    }

    @Test
    fun manuallyTypedMessageReplyFoundViaSeenAnchor() {
        // Alessio scrive a mano (nessun messaggio dettato): la risposta segue l'ultimo blocco già visto.
        val screen = oldChat + listOf(Block("Answer: had started"), Block("Perfect, well done!"))
        val r = ClaudeChat.update(screen, seen, sent = "Answer: had started")
        assertEquals(listOf("Perfect, well done!"), r)
    }

    @Test
    fun uiLabelsAreNotMessages() {
        assertFalse(ClaudeChat.isMessageText(Block("Copy", clickable = true)))
        assertFalse(ClaudeChat.isMessageText(Block("Sonnet 4.5")))
        assertFalse(ClaudeChat.isMessageText(Block("Claude can make mistakes. Please double-check responses.")))
        assertFalse(ClaudeChat.isMessageText(Block("Thought for 4 seconds", clickable = true)))
        assertTrue(ClaudeChat.isMessageText(Block("Great job!", clickable = true)))
        assertTrue(ClaudeChat.isMessageText(Block("Yes, exactly. The verb goes at the end.")))
    }

    @Test
    fun buttons() {
        assertTrue(ClaudeChat.isStopButton("Stop response"))
        assertTrue(ClaudeChat.isStopButton("Interrompi"))
        assertFalse(ClaudeChat.isStopButton("Stopwatch"))
        assertTrue(ClaudeChat.isSendButton("Send message"))
        assertTrue(ClaudeChat.isSendButton("Invia"))
        assertFalse(ClaudeChat.isSendButton("Sender settings and more options here"))
    }

    @Test
    fun voiceCommands() {
        for (s in listOf("modalità Claude", "Kestra modalità Claude", "attiva la modalità claude", "claude mode", "leggimi Claude", "modalità cloud"))
            assertTrue(s, ClaudeChat.isStartPhrase(s))
        for (s in listOf("che tempo fa", "modalità claude è bella oggi?"))
            assertFalse(s, ClaudeChat.isStartPhrase(s))
        for (s in listOf("basta", "stop", "Stop Kestra", "esci dalla modalità Claude", "exit claude mode", "ok basta così", "stop reading"))
            assertTrue(s, ClaudeChat.isStopPhrase(s))
        for (s in listOf("stop is a verb", "I stopped smoking", "the end of the story"))
            assertFalse(s, ClaudeChat.isStopPhrase(s))
        for (s in listOf("ripeti", "repeat that", "say it again"))
            assertTrue(s, ClaudeChat.isRepeatPhrase(s))
        assertFalse(ClaudeChat.isRepeatPhrase("repeat after me the sentence"))
    }

    @Test
    fun chunksLongTextAtSentences() {
        val long = (1..60).joinToString(" ") { "This is sentence number $it." }
        val c = ClaudeChat.chunks(listOf(long), max = 300)
        assertTrue(c.size > 1)
        assertTrue(c.all { it.length <= 300 })
        assertEquals(long, c.joinToString(" "))
    }

    @Test
    fun replyLanguage() {
        assertEquals("en", ClaudeChat.language("Great job! Now try the next sentence with the past perfect."))
        assertEquals("it", ClaudeChat.language("Ottimo! Il past perfect si usa per un'azione che è avvenuta prima di un'altra."))
        assertEquals("it", ClaudeChat.language("Perché qui serve il present perfect? Ecco un esempio."))
    }

    @Test
    fun navigationInsideClaude() {
        for (s in listOf("apri il progetto inglese", "Kestra apri il progetto English B2", "torna alla lista dei progetti", "nuova chat", "vai nella chat di ieri"))
            assertTrue(s, ClaudeChat.isNavPhrase(s))
        for (s in listOf("open the project", "the project is late", "apri la finestra per favore"))
            assertFalse(s, ClaudeChat.isNavPhrase(s))
    }
}
