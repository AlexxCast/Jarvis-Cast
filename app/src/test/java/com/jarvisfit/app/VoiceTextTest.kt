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
}
