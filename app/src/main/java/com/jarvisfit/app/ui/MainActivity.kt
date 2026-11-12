package com.jarvisfit.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Kitchen
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.jarvisfit.app.data.ImageUtil
import com.jarvisfit.app.data.Store
import com.jarvisfit.app.voice.Speaker
import java.io.File

class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_TAKE_PHOTO = "take_photo"
    }

    /** Impostato quando si apre l'app dalla notifica "Jarvis vuole una foto". */
    val photoRequested = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Speaker.init(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        // Chiedi l'esclusione dal risparmio batteria per permettere l'ascolto continuo a schermo spento
        runCatching {
            val pm = getSystemService(PowerManager::class.java)
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        }

        photoRequested.value = intent?.getBooleanExtra(EXTRA_TAKE_PHOTO, false) == true
        setContent {
            MaterialTheme(colorScheme = JarvisColors) {
                AppRoot(photoRequested)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_TAKE_PHOTO, false)) photoRequested.value = true
    }
}

val JarvisColors = darkColorScheme(
    primary = Color(0xFF39FF14), // Neon Green
    onPrimary = Color(0xFF003300),
    secondary = Color(0xFF00FF00), // Bright Green
    tertiary = Color(0xFF22D3EE),
    background = Color(0xFF050F05), // Very dark greenish-black
    surface = Color(0xFF0A1A0A),
    surfaceVariant = Color(0xFF152A15),
    onSurface = Color(0xFFE5F6E5),
    onSurfaceVariant = Color(0xFF8FB08F),
    error = Color(0xFFF87171),
)

@Composable
fun AppRoot(photoRequested: androidx.compose.runtime.MutableState<Boolean>) {
    var tab by remember { mutableIntStateOf(if (Store.diary.profile.isComplete) 0 else 4) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Oggi") })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                    icon = { Icon(Icons.Filled.Kitchen, null) }, label = { Text("Dispensa") })
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 },
                    icon = { Icon(Icons.Filled.MenuBook, null) }, label = { Text("Ricettario") })
                NavigationBarItem(selected = tab == 3, onClick = { tab = 3 },
                    icon = { Icon(Icons.Filled.CalendarMonth, null) }, label = { Text("Storico") })
                NavigationBarItem(selected = tab == 4, onClick = { tab = 4 },
                    icon = { Icon(Icons.Filled.Person, null) }, label = { Text("Profilo") })
            }
        }
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (tab) {
                0 -> TodayScreen(photoRequested)
                1 -> PantryScreen(onAskJarvisMeal = { tab = 0 })
                2 -> RecipeBookScreen(onStartCooking = { tab = 0 })
                3 -> HistoryScreen()
                else -> ProfileScreen(onSaved = { tab = 0 })
            }
        }
    }
}

// ------------------------------------------------------------------ helper condivisi

/** Restituisce una funzione che chiede il permesso fotocamera, scatta e consegna il file. */
@Composable
fun rememberPhotoTaker(prefix: String, onPhoto: (File) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    var target by remember { mutableStateOf<File?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = target
        if (ok && f != null && f.length() > 0) onPhoto(f)
    }
    fun launch() {
        val f = ImageUtil.newPhotoFile(ctx, prefix)
        target = f
        camera.launch(FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", f))
    }
    val perm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launch()
    }
    return {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launch()
        else perm.launch(Manifest.permission.CAMERA)
    }
}

@Composable
fun rememberGalleryPicker(prefix: String, onPhoto: (File) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri != null) runCatching { ImageUtil.copyToApp(ctx, uri, prefix) }.getOrNull()?.let(onPhoto)
    }
    return { picker.launch("image/*") }
}

/** Permessi necessari per l'ascolto continuo. */
fun listeningPermissions(): Array<String> = buildList {
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    if (Build.VERSION.SDK_INT >= 29) add(Manifest.permission.ACTIVITY_RECOGNITION)
}.toTypedArray()

fun requestIgnoreBatteryOptimizations(ctx: android.content.Context) {
    val pm = ctx.getSystemService(PowerManager::class.java)
    if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
        runCatching {
            ctx.startActivity(
                Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName))
            )
        }
    }
}
