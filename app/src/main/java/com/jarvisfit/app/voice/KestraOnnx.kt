package com.jarvisfit.app.voice

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

/**
 * I tre modelli di "Kestra" caricati una volta sola (il riconoscimento si riaccende spesso, il caricamento costa).
 * Niente Android qui dentro: lo stesso codice gira sul PC con onnxruntime per confrontarlo con scripts/kestra_ww.
 */
class KestraOnnx(melModel: ByteArray, embModel: ByteArray, classifierJson: String) {
    private val env = OrtEnvironment.getEnvironment()
    private val mel = session(melModel)
    private val emb = session(embModel)
    private val melIn = mel.inputNames.first()
    private val embIn = emb.inputNames.first()
    val classifier = KestraDetector.Classifier.parse(classifierJson)

    private fun session(bytes: ByteArray): OrtSession {
        val opts = OrtSession.SessionOptions().apply { setIntraOpNumThreads(1); setInterOpNumThreads(1) }
        return env.createSession(bytes, opts)
    }

    fun detector() = KestraDetector(classifier, ::melspec, ::embed)

    private fun melspec(x: FloatArray): Array<FloatArray> {
        OnnxTensor.createTensor(env, FloatBuffer.wrap(x), longArrayOf(1, x.size.toLong())).use { t ->
            mel.run(mapOf(melIn to t)).use { r ->
                val fb = (r[0] as OnnxTensor).floatBuffer
                val rows = fb.remaining() / KestraDetector.MEL_BANDS
                // Stessa scala usata da openWakeWord e dall'addestramento: spettro / 10 + 2.
                return Array(rows) { FloatArray(KestraDetector.MEL_BANDS) { fb.get() / 10f + 2f } }
            }
        }
    }

    private fun embed(rows: Array<FloatArray>): FloatArray {
        val b = KestraDetector.MEL_BANDS
        val flat = FloatArray(rows.size * b)
        rows.forEachIndexed { i, r -> System.arraycopy(r, 0, flat, i * b, b) }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(flat), longArrayOf(1, rows.size.toLong(), b.toLong(), 1)).use { t ->
            emb.run(mapOf(embIn to t)).use { r ->
                val fb = (r[0] as OnnxTensor).floatBuffer
                return FloatArray(fb.remaining()) { fb.get() }
            }
        }
    }
}
