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

    @Test
    fun startWithProject() {
        assertEquals("monomitos", ClaudeChat.startProject("Kestra, modalità Claude, progetto Monomitos"))
        assertEquals("inglese b2", ClaudeChat.startProject("attiva la modalità Claude sul progetto inglese B2"))
        assertNull(ClaudeChat.startProject("modalità Claude"))
        assertTrue(ClaudeChat.isStartPhrase("modalità Claude nel progetto Monomitos"))
    }

    @Test
    fun studyRequests() {
        assertEquals(ClaudeChat.Study("monomitos", false, false), ClaudeChat.studyRequest("Kestra, informati sul progetto Monomitos su Claude"))
        assertEquals(ClaudeChat.Study(null, true, false), ClaudeChat.studyRequest("cerca su Claude e informati sul progetto"))
        assertEquals(ClaudeChat.Study(null, false, true), ClaudeChat.studyRequest("guarda su Claude che progetti ho"))
        assertEquals("inglese b2", ClaudeChat.studyRequest("leggi su claude il progetto inglese b2 e dimmi a che punto sono")?.project)
        assertNull(ClaudeChat.studyRequest("informati sul meteo di domani"))
        assertNull(ClaudeChat.studyRequest("modalità Claude"))
    }

    @Test
    fun askRequests() {
        val a = ClaudeChat.askRequest("Chiedi a Claude nel progetto Monomitos se il post di oggi va bene")
        assertEquals("monomitos", a?.project)
        assertEquals("il post di oggi va bene", a?.question)
        val b = ClaudeChat.askRequest("chiedi a claude nel progetto inglese b2 qual è il prossimo argomento")
        assertEquals("inglese b2", b?.project)
        assertEquals("qual è il prossimo argomento", b?.question)
        assertNull(ClaudeChat.askRequest("chiedi a Marco se viene")?.project)
        assertEquals(null, ClaudeChat.askRequest("chiedi a claude")?.question)
        assertEquals("come si dice gatto in inglese", ClaudeChat.askRequest("Kestra chiedi a Claude come si dice gatto in inglese")?.question)
    }

    @Test
    fun workRequests() {
        assertEquals("b2", ClaudeChat.workRequest("facciamo il progetto B2"))
        assertEquals("inglese", ClaudeChat.workRequest("Kestra, riprendiamo la lezione di inglese"))
        assertEquals("monomitos", ClaudeChat.workRequest("lavoriamo a Monomitos su Claude"))
        assertEquals("inglese b2", ClaudeChat.workRequest("dai facciamo il progetto inglese b2 su claude"))
        assertNull(ClaudeChat.workRequest("facciamo la spesa"))
        assertNull(ClaudeChat.workRequest("apri WhatsApp"))
        assertNull(ClaudeChat.workRequest("riprendiamo domani"))
    }
}
