// Plugin versions follow firebase/quickstart-android (firebase-ai, Apache-2.0) as of 2026-11-23.
// AGP 9 compiles Kotlin itself (built-in Kotlin); the Kotlin Gradle plugin on the classpath
// sets the compiler version (2.4.x is needed for the Firebase/ML Kit libraries' metadata).
buildscript {
    repositories {
        mavenCentral()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    id("com.android.application") version "9.4.1" apply false
    id("com.google.gms.google-services") version "4.6.0" apply false
}
