plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.gubby251.sebudollarai"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.gubby251.sebudollarai"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    val stableKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
        ?: "android-signing.p12"

    val stableKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        ?: error("ANDROID_KEYSTORE_PASSWORD is required")

    signingConfigs {
        create("stableDebug") {
            storeFile = file(stableKeystorePath)
            storePassword = stableKeystorePassword
            keyAlias = "sebu-dollar-ai"
            keyPassword = stableKeystorePassword
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("stableDebug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.3.0"))

    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-firestore")

    implementation("com.google.android.gms:play-services-auth:22.0.0")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
