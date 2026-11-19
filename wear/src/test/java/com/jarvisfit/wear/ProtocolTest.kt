package com.jarvisfit.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    @Test
    fun rispostaNormale() {
        val r = Protocol.parseReply("""{"reply":"Sono le 9.","expectReply":true}""")
        assertEquals("Sono le 9.", r.text)
        assertTrue(r.expectReply)
        assertFalse(r.ignored)
        assertTrue(r.phone.isEmpty())
    }

    @Test
    fun azioniPerIlTelefonoSoloQuelleAmmesse() {
        val r = Protocol.parseReply(
            """{"reply":"Apro WhatsApp.","device":[{"type":"open_app","name":"WhatsApp"},{"type":"visual","data":{}},{"type":"phone_task","goal":"scrivi a Marco"},{"type":"call","name":""}]}"""
        )
        assertEquals(listOf("open_app" to "WhatsApp", "phone_task" to "scrivi a Marco"), r.phone)
    }

    @Test
    fun fraseIgnorata() {
        assertTrue(Protocol.parseReply("""{"ignored":true}""").ignored)
    }

    @Test
    fun rispostaRotta() {
        assertEquals("Risposta del server non valida.", Protocol.parseReply("<html>").text)
    }

    @Test
    fun richiestaERispostaDelTelefono() {
        val req = Protocol.deviceRequest("a1", listOf("call" to "Mamma"), "niente più fili")
        assertTrue(req.contains("\"password\":\"niente più fili\""))
        val res = Protocol.parseDeviceResult("""{"id":"a1","status":"password"}""")
        assertEquals("a1", res.id)
        assertEquals("password", res.status)
        assertEquals("error", Protocol.parseDeviceResult("boh").status)
    }

    @Test
    fun saluti() {
        assertTrue(Protocol.isGoodbye("Grazie Kestra."))
        assertFalse(Protocol.isGoodbye("grazie, segna il pranzo"))
    }
}
