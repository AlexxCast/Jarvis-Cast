package com.jarvisfit.wear

import android.content.Context
import android.net.Uri
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/** Collegamento col telefono tramite il Data Layer di Wear OS (Bluetooth o Wi-Fi, gestito da Google). */
object PhoneLink {

    /** Legge indirizzo e token che il telefono ha pubblicato. Ritorna true se ora sono presenti. */
    suspend fun syncConfig(ctx: Context): Boolean {
        runCatching {
            val items = Wearable.getDataClient(ctx).getDataItems(Uri.parse("wear://*${Protocol.PATH_CONFIG}")).await()
            try {
                for (item in items) {
                    val map = DataMapItem.fromDataItem(item).dataMap
                    WatchConfig.save(map.getString("url"), map.getString("token"))
                }
            } finally {
                items.release()
            }
        }
        if (WatchConfig.ready) return true
        // Non ancora pubblicati: chiede al telefono di mandarli (arrivano a PhoneListener).
        runCatching {
            val nodes = Wearable.getNodeClient(ctx).connectedNodes.await()
            for (n in nodes) Wearable.getMessageClient(ctx).sendMessage(n.id, Protocol.PATH_CONFIG_REQUEST, ByteArray(0)).await()
        }
        return false
    }

    /**
     * Fa eseguire al telefono le azioni chieste dal server (aprire app, usare il telefono, chiamare).
     * Ritorna "offline" se il telefono non è raggiungibile: in quel caso l'orologio lo dice, non finge di averlo fatto.
     */
    suspend fun runOnPhone(ctx: Context, actions: List<Pair<String, String>>, password: String?): Protocol.DeviceResult {
        val id = UUID.randomUUID().toString()
        val nodes = runCatching { Wearable.getNodeClient(ctx).connectedNodes.await() }.getOrNull().orEmpty()
        val node = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull()
            ?: return Protocol.DeviceResult(id, "offline", "")
        val client = Wearable.getMessageClient(ctx)
        val answer = CompletableDeferred<Protocol.DeviceResult>()
        val listener = MessageClient.OnMessageReceivedListener { ev ->
            if (ev.path == Protocol.PATH_DEVICE_RESULT) {
                val r = Protocol.parseDeviceResult(String(ev.data))
                if (r.id == id) answer.complete(r)
            }
        }
        return try {
            client.addListener(listener).await()
            client.sendMessage(node.id, Protocol.PATH_DEVICE, Protocol.deviceRequest(id, actions, password).toByteArray()).await()
            withTimeoutOrNull(12_000) { answer.await() } ?: Protocol.DeviceResult(id, "offline", "")
        } catch (e: Exception) {
            Protocol.DeviceResult(id, "offline", "")
        } finally {
            runCatching { client.removeListener(listener) }
        }
    }
}
