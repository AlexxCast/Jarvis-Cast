package com.jarvisfit.app.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import com.jarvisfit.app.data.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * Riconoscimento della voce del proprietario. Prima di usare il telefono o telefonare, Jarvis
 * chiede una frase e la confronta con l'impronta registrata. Tutto resta sul telefono.
 */
object VoiceId {
    const val PHRASE = "Jarvis, sono io, procedi pure"
    /** Dopo un riconoscimento riuscito non lo richiede per un po'. */
    private const val TRUST_MS = 10 * 60_000L
    private const val SAMPLES_NEEDED = 3

    @Volatile private var trustedUntil = 0L
    @Volatile var enrolling = false
        private set

    val enrolled: Boolean get() = VoicePrint.decode(Settings.voiceModel) != null
    /** Serve la verifica adesso? Solo se l'utente l'ha attivata e ha registrato la voce. */
    fun needed(): Boolean = Settings.voiceLock && enrolled && System.currentTimeMillis() > trustedUntil

    fun forget() { Settings.voiceModel = ""; Settings.voiceLock = false; trustedUntil = 0 }

    /** Registra dal microfono per [ms] millisecondi. Ritorna null se il microfono non è disponibile. */
    @SuppressLint("MissingPermission")
    suspend fun record(ctx: Context, ms: Long): ShortArray? = withContext(Dispatchers.IO) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return@withContext null
        val rate = VoicePrint.SAMPLE_RATE
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return@withContext null
        val rec = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate))
        }.getOrNull() ?: return@withContext null
        try {
            if (rec.state != AudioRecord.STATE_INITIALIZED) return@withContext null
            val total = (rate * ms / 1000).toInt()
            val out = ShortArray(total)
            rec.startRecording()
            var got = 0
            var empty = 0
            while (got < total && empty < 50) {
                val n = rec.read(out, got, minOf(1600, total - got))
                if (n > 0) { got += n; empty = 0 } else empty++
            }
            if (got < total / 2) null else out.copyOf(got)
        } catch (e: Exception) {
            null
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    private suspend fun say(text: String) = suspendCancellableCoroutine<Unit> { c ->
        Speaker.speak(text) { if (c.isActive) c.resume(Unit) }
    }

    /**
     * Registra la voce dell'utente: tre volte la stessa frase. [progress] riceve i messaggi da mostrare.
     * Ritorna null se è andata bene, altrimenti il motivo.
     */
    suspend fun enroll(ctx: Context, progress: (String) -> Unit): String? {
        if (enrolling) return "Sto già registrando."
        enrolling = true
        try {
            Speaker.init(ctx)
            val prints = mutableListOf<DoubleArray>()
            var tries = 0
            say("Registro la sua voce. Dopo ogni segnale dica: $PHRASE")
            while (prints.size < SAMPLES_NEEDED && tries < SAMPLES_NEEDED + 3) {
                tries++
                progress("Registrazione ${prints.size + 1} di $SAMPLES_NEEDED: dica \"$PHRASE\"")
                say(if (prints.isEmpty() && tries == 1) "Prima volta." else "Ancora.")
                delay(250) // la coda della voce di Jarvis non deve finire nella registrazione
                val pcm = record(ctx, 3500) ?: return "Non riesco a usare il microfono: chiuda le altre app che registrano e riprovi."
                val p = VoicePrint.of(pcm)
                if (p == null) { say("Non ho sentito abbastanza, riproviamo."); continue }
                prints += p.vector
            }
            if (prints.size < SAMPLES_NEEDED) return "Non sono riuscito a sentire bene la voce. Riprovi in un posto silenzioso."
            val model = VoicePrint.enroll(prints) ?: return "Registrazione non riuscita."
            Settings.voiceModel = VoicePrint.encode(model)
            Settings.voiceLock = true
            trustedUntil = System.currentTimeMillis() + TRUST_MS
            progress("Voce registrata.")
            say("Fatto. D'ora in poi, prima di usare il telefono al posto suo, le chiederò di dire la frase.")
            return null
        } finally {
            enrolling = false
        }
    }

    /**
     * Chiede la frase e controlla che sia la voce registrata. Ritorna true se può procedere.
     * Va chiamata quando il riconoscimento vocale è fermo, così il microfono è libero.
     */
    suspend fun gate(ctx: Context): Boolean {
        if (!needed()) return true
        val model = VoicePrint.decode(Settings.voiceModel) ?: return true
        Speaker.init(ctx)
        repeat(2) { attempt ->
            say(if (attempt == 0) "Conferma con la voce: dica, $PHRASE" else "Non ne sono sicuro. Ripeta: $PHRASE")
            delay(250)
            val pcm = record(ctx, 3500)
            val p = pcm?.let { VoicePrint.of(it) }
            if (p != null && VoicePrint.matches(model, p.vector, Settings.voiceStrictness)) {
                trustedUntil = System.currentTimeMillis() + TRUST_MS
                return true
            }
        }
        say("Non riconosco la sua voce, quindi non procedo.")
        return false
    }
}
