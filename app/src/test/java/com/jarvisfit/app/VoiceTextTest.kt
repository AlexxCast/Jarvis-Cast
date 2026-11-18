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
    fun sensitivityChangesHowEasilyKestraAnswers() {
        assertTrue(VoiceText.wake("che ore sono kestra", 0.2f) is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("kestra che ore sono", 0.2f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("ehi kiestra accendi la luce", 0.5f) is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("ehi kiestra accendi la luce", 0.9f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("allora kestra mi dici il meteo di oggi", 0.9f) is VoiceText.Wake.Direct)
        assertTrue(VoiceText.wake("ieri ho visto la serie dove c'è Kestra", 0.9f) is VoiceText.Wake.Ambiguous)
    }

    @Test
    fun testWake_DirectCalls() {
        assertEquals("quante calorie mi restano", direct("Kestra, quante calorie mi restano?"))
        assertEquals("aggiungi una mela", direct("Ehi Kestra aggiungi una mela"))
        assertEquals("", direct("ciao Kestra"))
        assertEquals("", direct("Kestra"))
        assertEquals("che ore sono", direct("che ore sono Kestra"))
        assertEquals("ricordami alle 18 di chiamare il dentista", direct("Hey Kestra ricordami alle 18 di chiamare il dentista"))
        // Storpiature vere del riconoscimento italiano
        assertEquals("apri whatsapp", direct("chestra apri whatsapp"))
        assertEquals("che tempo fa", direct("questra che tempo fa"))
    }

    @Test
    fun testWake_NoWakeWord() {
        assertTrue(VoiceText.wake("che tempo fa oggi") is VoiceText.Wake.None)
        assertTrue(VoiceText.wake("") is VoiceText.Wake.None)
        assertFalse(VoiceText.containsWake("ok google apri gemini"))
        assertTrue(VoiceText.containsWake("ehi kestra"))
    }

    @Test
    fun `parole italiane comuni non attivano Kestra neanche con sensibilita alta`() {
        // Falsi positivi reali: "destra", "finestra", "questo" e il frammento "estra" la facevano partire con la TV accesa.
        for (heard in listOf("gira a destra dopo il semaforo", "chiudi la finestra che fa freddo", "questo è il mio quaderno",
                "un'orchestra suonava in piazza", "la minestra è pronta", "estrarre il dente")) {
            assertFalse("'$heard' non deve chiamare Kestra", VoiceText.containsWake(heard, 0.9f))
            assertTrue("'$heard' non deve chiamare Kestra", VoiceText.wake(heard, 0.9f) is VoiceText.Wake.None)
        }
    }

    @Test
    fun testWake_TalkingAboutKestraIsNotADirectCall() {
        val serie = VoiceText.wake("ieri ho visto il film dove c'è Kestra")
        assertTrue(serie is VoiceText.Wake.Ambiguous)
        assertTrue((serie as VoiceText.Wake.Ambiguous).aboutJarvis)

        val middle = VoiceText.wake("secondo me dovremmo chiedere a Kestra cosa cucinare stasera")
        assertTrue(middle is VoiceText.Wake.Ambiguous)
        assertTrue((middle as VoiceText.Wake.Ambiguous).aboutJarvis)

        val character = VoiceText.wake("Kestra è il personaggio di quella serie")
        assertTrue(character is VoiceText.Wake.Ambiguous)
    }

    @Test
    fun testWake_CommandMentioningFilmsStillReachesContextCheck() {
        // "film" è un indizio, non un divieto: la frase passa al controllo di contesto invece di essere scartata
        val w = VoiceText.wake("Kestra che film danno stasera al cinema")
        assertTrue(w is VoiceText.Wake.Ambiguous)
        assertEquals("Kestra che film danno stasera al cinema", (w as VoiceText.Wake.Ambiguous).text)
    }

    @Test
    fun `il nome perso nella frase finale lascia il comando`() {
        assertEquals("che ore sono", VoiceText.commandAfterLostWake("chestra che ore sono"))
        assertEquals("che ore sono", VoiceText.commandAfterLostWake("che ore sono"))
    }

    @Test
    fun `le frasi tipiche di Kestra sentite dal microfono sono eco`() {
        assertTrue(VoiceText.isSelfEcho("certamente capo ho registrato il pranzo", "", -1L))
        assertTrue(VoiceText.isSelfEcho("dimmi capo", "", -1L))
        assertFalse(VoiceText.isSelfEcho("capo della squadra ha detto di no", "", -1L))
    }
}
