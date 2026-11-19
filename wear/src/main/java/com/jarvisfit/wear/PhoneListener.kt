package com.jarvisfit.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

/** Il telefono ha pubblicato (o cambiato) indirizzo del server e token: li salva. */
class PhoneListener : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        WatchConfig.init(this)
        for (e in events) {
            if (e.type != DataEvent.TYPE_CHANGED || e.dataItem.uri.path != Protocol.PATH_CONFIG) continue
            val map = DataMapItem.fromDataItem(e.dataItem).dataMap
            WatchConfig.save(map.getString("url"), map.getString("token"))
        }
        WatchState.configured.value = WatchConfig.ready
    }
}
