plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.listeningmirror.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.listeningmirror.companion"
        // MediaSessionManager.getActiveSessions() + the
        // NotificationListenerService access route both date to API 21;
        // 26 is a comfortable modern floor with no feature cost here.
        minSdk = 26
        targetSdk = 35
        versionCode = 12
        versionName = "1.3-concert-day-reminders"
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

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // Deliberately minimal. appcompat only for AppCompatActivity + the
    // DayNight theme; no Compose, no DI framework, no architecture
    // libraries — the prototype is one screen reading platform APIs.
    implementation("androidx.appcompat:appcompat:1.7.0")

    testImplementation(kotlin("test"))
}
