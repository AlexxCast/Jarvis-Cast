plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Kestra per orologio Wear OS. Stesso applicationId e stessa firma dell'app del telefono:
// è la condizione di Google perché orologio e telefono si parlino (indirizzo e token arrivano da soli).
android {
    namespace = "com.jarvisfit.wear"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jarvisfit.app"
        minSdk = 30 // Wear OS 3 o successivo
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        getByName("debug") {
            val ciKeystore = System.getenv("JARVIS_DEBUG_KEYSTORE")?.let { file(it) }
            if (ciKeystore != null && ciKeystore.exists()) {
                storeFile = ciKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.google.android.gms:play-services-wearable:18.2.0")

    testImplementation("junit:junit:4.13.2")
}
