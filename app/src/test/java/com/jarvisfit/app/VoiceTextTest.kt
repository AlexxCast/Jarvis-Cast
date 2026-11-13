package com.jarvisfit.app

import com.jarvisfit.app.voice.VoiceText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceTextTest {

    @Test
    fun testCleanForSpeech() {
        val markdown = "Ecco il tuo pasto: **150g di petto di pollo** con *olio* e `riso`! \uD83C\uDF57\uD83D\uDD25 https://example.com"
        val cleaned = VoiceText.cleanForSpeech(markdown)

        assertFalse("Should not contain markdown asterisks", cleaned.contains("*"))
        assertFalse("Should not contain backticks", cleaned.contains("`"))
        assertFalse("Should not contain http links", cleaned.contains("http"))
        assertFalse("Should not contain emojis", cleaned.contains("\uD83C\uDF57"))
        assertTrue("Should contain core text", cleaned.contains("150g di petto di pollo"))
    }

    @Test
    fun testIsCancelPhrase_Valid() {
        val validPhrases = listOf(
            "basta",
            "grazie",
            "grazie mille",
            "ok grazie",
            "a posto così",
            "stop",
            "annulla",
            "niente",
            "chiudi",
            "lascia stare",
            "arrivederci",
            "ciao",
            "va bene così",
            "perfetto grazie"
        )

        for (phrase in validPhrases) {
            assertTrue("Expected cancel phrase for '$phrase'", VoiceText.isCancelPhrase(phrase))
        }
    }

    @Test
    fun testIsCancelPhrase_NonCancelUtterances() {
        val legitimateUserUtterances = listOf(
            "grazie, quante calorie mi restano oggi?",
            "niente pasta stasera, solo pollo",
            "basta che aggiungi 100g di riso",
            "stop ai carboidrati",
            "non ho ancora finito",
            "vorrei chiudere la giornata con 2000 calorie"
        )

        for (utterance in legitimateUserUtterances) {
            assertFalse("'$utterance' should NOT be treated as a cancel phrase", VoiceText.isCancelPhrase(utterance))
        }
    }

    @Test
    fun testIsSelfEcho_DetectsEcho() {
        val jarvisSpoken = "Hai ancora 650 calorie disponibili prima di raggiungere il tuo obiettivo giornaliero."
        val recognizedEcho = "ancora 650 calorie disponibili prima di raggiungere"

        // Within 15s window
        assertTrue(
            "Should detect recognized utterance as an acoustic echo of Jarvis's own TTS output",
            VoiceText.isSelfEcho(
                recognized = recognizedEcho,
                lastSpoken = jarvisSpoken,
                msSinceSpoken = 1200L
            )
        )
    }

    @Test
    fun testIsSelfEcho_AllowsLegitimateUserResponses() {
        val jarvisSpoken = "Ho registrato 200g di petto di pollo. Vuoi aggiungere qualcos'altro per cena?"

        // Short user responses containing 1-2 words from Jarvis or totally new words
        val legitimateResponses = listOf(
            "100 grammi di riso",
            "si, una mela",
            "pasta al pomodoro",
            "olio extravergine 10 grammi",
            "solo l'acqua"
        )

        for (resp in legitimateResponses) {
            assertFalse(
                "'$resp' should not be rejected as self echo",
                VoiceText.isSelfEcho(
                    recognized = resp,
                    lastSpoken = jarvisSpoken,
                    msSinceSpoken = 1500L
                )
            )
        }
    }

    @Test
    fun testIsSelfEcho_ExpiresAfterWindow() {
        val jarvisSpoken = "Hai ancora 650 calorie disponibili prima di raggiungere il tuo obiettivo."
        val recognized = "Hai ancora 650 calorie disponibili prima di raggiungere"

        // If 20 seconds passed, acoustic echo from that speech is physically impossible
        assertFalse(
            "Should not flag echo if elapsed time exceeds window",
            VoiceText.isSelfEcho(
                recognized = recognized,
                lastSpoken = jarvisSpoken,
                msSinceSpoken = 20_000L
            )
        )
    }

    // ---------------------------------------------------------------- parola di attivazione

    private fun direct(text: String): String? = (VoiceText.wake(text) as? VoiceText.Wake.Direct)?.command

    @Test
    fun sensitivityChangesHowEasilyJarvisAnswers() {
        assertTrue(VoiceText.wake("che ore sono jarvis", 0.2f) is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("jarvis che ore sono", 0.2f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("ehi jarbis accendi la luce", 0.5f) is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("ehi jarbis accendi la luce", 0.9f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("allora jarvis mi dici il meteo di oggi", 0.9f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("ieri ho visto il film Marvel dove c'è Jarvis", 0.9f) is VoiceText.Wake.Ambiguous)
    }

    @Test
    fun testWake_DirectCalls() {
        assertEquals("quante calorie mi restano", direct("Jarvis, quante calorie mi restano?"))
        assertEquals("aggiungi una mela", direct("Ehi Jarvis aggiungi una mela"))
        assertEquals("", direct("ciao Jarvis"))
        assertEquals("", direct("Jarvis"))
        assertEquals("che ore sono", direct("che ore sono Jarvis"))
        // Il comando deve arrivare intero, non troncato
        assertEquals("ricordami alle 18 di chiamare il dentista", direct("Hey Jarvis ricordami alle 18 di chiamare il dentista"))
    }

    @Test
    fun testWake_NoWakeWord() {
        assertTrue(VoiceText.wake("che tempo fa oggi") is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("") is VoiceText.Wake.None)
        assertFalse(VoiceText.containsWake("ok google apri gemini"))
        assertTrue(VoiceText.containsWake("ehi jarvis"))
    }

    @Test
    fun testWake_TalkingAboutJarvisIsNotADirectCall() {
        val film = VoiceText.wake("ieri ho visto il film Marvel dove c'è Jarvis")
        assertTrue(film is VoiceText.Wake.Ambiguous)
        assertTrue((film as VoiceText.Wake.Ambiguous).aboutJarvis)

        val middle = VoiceText.wake("secondo me dovremmo chiedere a Jarvis cosa cucinare stasera")
        assertTrue(middle is VoiceText.Wake.Ambiguous)

        // Anche a inizio frase, se si parla del personaggio decide il contesto
        val character = VoiceText.wake("Jarvis è il maggiordomo di Tony Stark nei film")
        assertTrue(character is VoiceText.Wake.Ambiguous)
        assertTrue((character as VoiceText.Wake.Ambiguous).aboutJarvis)
    }

    @Test
    fun testWake_CommandMentioningFilmsStillReachesContextCheck() {
        // "film" è un indizio, non un divieto: la frase passa al controllo di contesto invece di essere scartata
        val w = VoiceText.wake("Jarvis che film danno stasera al cinema")
        assertTrue(w is VoiceText.Wake.Ambiguous)
        assertEquals("Jarvis che film danno stasera al cinema", (w as VoiceText.Wake.Ambiguous).text)
    }
}
