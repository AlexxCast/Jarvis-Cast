package com.jarvisfit.app.device

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.jarvisfit.app.JarvisApp
import com.jarvisfit.app.net.Cloud
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Luoghi salvati per i promemoria "quando arrivo a casa". Android stesso ci avvisa quando entriamo o usciamo
 * da un cerchio attorno al luogo (proximity alert): non serve tenere acceso il GPS né l'app aperta.
 */
object Places {
    const val ACTION = "com.jarvisfit.app.PLACE"
    private const val PREFS = "places"

    data class Place(val key: String, val name: String, val lat: Double, val lon: Double, val radius: Float)

    fun parse(json: String): List<Place> = runCatching {
        Json.parseToJsonElement(json).jsonArray.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val key = o["key"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val lat = o["lat"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
            val lon = o["lon"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
            Place(key, o["name"]?.jsonPrimitive?.contentOrNull ?: key, lat, lon,
                (o["radius"]?.jsonPrimitive?.doubleOrNull ?: 150.0).toFloat())
        }
    }.getOrDefault(emptyList())

    private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    /** "none" senza permesso, "foreground" solo con app aperta, "always" anche in background. */
    fun status(ctx: Context): String = when {
        !granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) && !granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) -> "none"
        Build.VERSION.SDK_INT >= 29 && !granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> "foreground"
        else -> "always"
    }

    fun foregroundPermissions() = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** Elenco dal server: lo teniamo sul telefono così gli avvisi ripartono anche dopo un riavvio. */
    fun sync(ctx: Context, json: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("list", json).apply()
        register(ctx)
    }

    private fun pending(ctx: Context, key: String): PendingIntent {
        val i = Intent(ctx, PlaceReceiver::class.java).setAction(ACTION).setData(Uri.parse("jarvis-place:" + Uri.encode(key)))
        // Mutabile: Android aggiunge all'intent se stiamo entrando o uscendo.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, 0, i, flags)
    }

    @SuppressLint("MissingPermission")
    fun register(ctx: Context) {
        val app = ctx.applicationContext
        val lm = app.getSystemService(LocationManager::class.java) ?: return
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        for (key in prefs.getStringSet("registered", emptySet()).orEmpty()) runCatching { lm.removeProximityAlert(pending(app, key)) }
        val done = mutableSetOf<String>()
        if (status(app) != "none") {
            for (p in parse(prefs.getString("list", "[]") ?: "[]")) {
                runCatching { lm.addProximityAlert(p.lat, p.lon, p.radius, -1, pending(app, p.key)); done += p.key }
            }
        }
        prefs.edit().putStringSet("registered", done).apply()
    }

    /** Salva la posizione attuale con un nome. Ritorna subito "ok", "permesso" o "spento"; il resto avviene dopo. */
    @SuppressLint("MissingPermission")
    fun saveHere(ctx: Context, name: String): String {
        val app = ctx.applicationContext
        if (status(app) == "none") return "permesso"
        val lm = app.getSystemService(LocationManager::class.java) ?: return "spento"
        if (!LocationManagerCompat.isLocationEnabled(lm)) return "spento"
        val provider = if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
        LocationManagerCompat.getCurrentLocation(lm, provider, CancellationSignal(), ContextCompat.getMainExecutor(app)) { fix: Location? ->
            val loc = fix ?: lastKnown(lm)
            if (loc == null) {
                Toast.makeText(app, "Non riesco a leggere la posizione. Riprovi all'aperto.", Toast.LENGTH_LONG).show()
                return@getCurrentLocation
            }
            JarvisApp.scope.launch {
                val list = Cloud.savePlace(name, loc.latitude, loc.longitude)
                if (list != null) {
                    sync(app, list)
                    Toast.makeText(app, "Luogo \"$name\" salvato.", Toast.LENGTH_SHORT).show()
                } else Toast.makeText(app, "Non riesco a salvare il luogo sul server.", Toast.LENGTH_LONG).show()
            }
        }
        return "ok"
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown(lm: LocationManager): Location? = lm.getProviders(true)
        .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        .maxByOrNull { it.time }
}
