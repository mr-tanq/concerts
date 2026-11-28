plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.yoda.pet"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yoda.pet"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "1.8"

        // Spotify app Client ID. Not a secret: the app signs in with PKCE,
        // which never uses a client secret.
        buildConfigField("String", "SPOTIFY_CLIENT_ID", "\"20fca973de8445509d31bf9ab4e13b0b\"")
    }

    // One committed debug key, so a phone can install a newer build (local
    // or from CI) over an older one without uninstalling first.
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
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
    // No libraries: plain platform views, HttpURLConnection and org.json.
    testImplementation(kotlin("test"))
}
