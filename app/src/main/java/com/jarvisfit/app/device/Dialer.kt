package com.jarvisfit.app.device

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat

/** Telefonate normali: "chiama Marcolino" cerca il nome in rubrica e avvia la chiamata. */
object Dialer {
    val permissions = arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.CALL_PHONE)

    fun hasPermission(ctx: Context): Boolean =
        permissions.all { ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED }

    data class Contact(val name: String, val number: String)

    /** È già un numero ("+39 333 1234567", "112")? Ritorna solo cifre e +, altrimenti null. */
    fun asNumber(text: String): String? {
        val t = text.trim()
        if (t.isEmpty() || t.any { it.isLetter() }) return null
        val digits = t.filter { it.isDigit() || it == '+' }
        return if (digits.count { it.isDigit() } >= 3) digits else null
    }

    private fun contacts(ctx: Context): List<Contact> = runCatching {
        val out = mutableListOf<Contact>()
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null,
            // Prima il numero predefinito del contatto, così tra più numeri si sceglie quello giusto.
            ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY + " DESC",
        )?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(0)?.trim().orEmpty()
                val number = c.getString(1)?.trim().orEmpty()
                if (name.isNotEmpty() && number.isNotEmpty()) out += Contact(name, number)
            }
        }
        out
    }.getOrDefault(emptyList())

    /** Il contatto che corrisponde meglio al nome detto (anche storpiato), oppure null. */
    fun find(ctx: Context, query: String): Contact? {
        val all = contacts(ctx)
        val idx = AppLauncher.bestMatch(query, all.map { it.name })
        return all.getOrNull(idx)
    }

    /**
     * Avvia la chiamata. Ritorna "ok:<nome>" se è partita, "permesso" se mancano i permessi,
     * "sconosciuto" se il nome non è in rubrica, "errore" se il telefono ha rifiutato.
     */
    fun call(ctx: Context, who: String): String {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) return "permesso"
        val direct = asNumber(who)
        val (name, number) = if (direct != null) who to direct else {
            if (!hasPermission(ctx)) return "permesso"
            val c = find(ctx, who) ?: return "sconosciuto"
            c.name to c.number
        }
        return try {
            ctx.startActivity(Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            "ok:$name"
        } catch (e: Exception) {
            "errore"
        }
    }

    /** Frase da dire quando la chiamata non parte; null se è partita. */
    fun problem(result: String, who: String): String? = when {
        result.startsWith("ok:") -> null
        result == "permesso" -> "Non posso chiamare: mi servono i permessi Contatti e Telefono. Apra Jarvis, Altro, Impostazioni e li conceda."
        result == "sconosciuto" -> "Non trovo $who nella rubrica, signore."
        else -> "Il telefono non mi ha lasciato avviare la chiamata, signore."
    }
}
