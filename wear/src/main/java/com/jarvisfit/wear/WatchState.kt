package com.jarvisfit.wear

import kotlinx.coroutines.flow.MutableStateFlow

/** Stato condiviso tra il servizio che ascolta/parla e la schermata dell'orologio. */
object WatchState {
    enum class Phase { IDLE, LISTENING, THINKING, SPEAKING }

    val phase = MutableStateFlow(Phase.IDLE)
    val heard = MutableStateFlow("")
    val reply = MutableStateFlow("")
    val level = MutableStateFlow(0f) // volume della voce 0..1, anima la sfera
    val configured = MutableStateFlow(false)
}
