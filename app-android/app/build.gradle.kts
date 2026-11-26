import java.time.OffsetDateTime

plugins {
    id("com.android.application")
}

// google-services.json comes from the Firebase console and is never committed.
// Without it the app still builds; the AI then answers nothing and the page says why.
val hasFirebaseConfig = file("google-services.json").exists()
if (hasFirebaseConfig) {
    apply(plugin = "com.google.gms.google-services")
}

// ---------------------------------------------------------------------------------------------
// The web app (../../app, the PC Chrome version) is copied into the APK at build time.
// Only the files the trip page needs are copied; app/local/ (Firebase settings, debug token) never is.
// Three things are swapped for Android (see ../web/README.md):
//   src/engine/sdk.js            -> ../web/sdk.js (same exports; every request goes to the Firebase AI Logic
//                                   Android SDK through the app's bridge, AiBridge.kt)
//   local/firebase-config.js     -> ../web/firebase-config.android.js (no keys: Firebase runs natively)
//   a few lines of text/code     -> ../web/patches.json (each must match exactly the given number of times)
// ---------------------------------------------------------------------------------------------
val webSrc = rootProject.file("../app")
val webOverlay = rootProject.file("web")
val webOut = layout.buildDirectory.dir("generated/webassets").get().asFile

val copyWebApp = tasks.register("copyWebApp") {
    inputs.dir(webSrc.resolve("src"))
    inputs.dir(webSrc.resolve("packs"))
    inputs.file(webSrc.resolve("trip.html"))
    inputs.dir(webOverlay)
    outputs.dir(webOut)
    doLast {
        val out = webOut.resolve("web")
        out.deleteRecursively()
        val files = listOf(
            "trip.html",
            "src/ui/trip.js", "src/ui/trip.css", "src/ui/map.js", "src/ui/read.js",
            "src/engine/index.js", "src/engine/session-store.js", "src/engine/cloud.js", "src/engine/partial-json.js",
            "src/engine/tasks/trip.js", "src/engine/tasks/sign.js",
        ) + webSrc.resolve("src/engine/trip").listFiles()!!.filter { it.name.endsWith(".js") }.map { "src/engine/trip/${it.name}" }
        for (f in files) webSrc.resolve(f).copyTo(out.resolve(f), overwrite = true)
        webSrc.resolve("packs").copyRecursively(out.resolve("packs"), overwrite = true)
        webOverlay.resolve("sdk.js").copyTo(out.resolve("src/engine/sdk.js"), overwrite = true)
        webOverlay.resolve("android.css").copyTo(out.resolve("src/ui/android.css"), overwrite = true)
        webOverlay.resolve("firebase-config.android.js").copyTo(out.resolve("local/firebase-config.js"), overwrite = true)
        // patches: [{ "file", "find", "replace", "count" }]
        @Suppress("UNCHECKED_CAST")
        val patches = groovy.json.JsonSlurper().parse(webOverlay.resolve("patches.json")) as List<Map<String, Any>>
        for (p in patches) {
            val target = out.resolve(p["file"] as String)
            val text = target.readText()
            val find = p["find"] as String
            val want = (p["count"] as Number).toInt()
            val n = text.split(find).size - 1
            if (n != want) throw GradleException("patches.json: '${find.take(60)}' found $n times in ${p["file"]}, expected $want")
            target.writeText(text.replace(find, p["replace"] as String))
        }
        // Which web version went into this APK (the copy takes app/ as it is at build time).
        fun git(vararg a: String): String = try {
            val p = ProcessBuilder(listOf("git") + a).directory(rootProject.file("..")).redirectErrorStream(true).start()
            p.inputStream.bufferedReader().readText().trim().also { p.waitFor() }
        } catch (e: Exception) { "" }
        val builtAt = OffsetDateTime.now().toString()
        val appCommit = git("log", "-1", "--format=%h", "--", "app/")
        val appDirty = git("status", "--porcelain", "--", "app/src", "app/trip.html", "app/packs").isNotEmpty()
        out.resolve("build-info.json").writeText(
            """{"appCommit":"$appCommit","appDirty":$appDirty,"overlayCommit":"${git("log", "-1", "--format=%h", "--", "app-android/")}","builtAt":"$builtAt"}""" + "\n",
        )
        // Nothing from app/local/ and no service worker may end up in the APK except the generated config.
        val stray = out.walkTopDown().filter { it.isFile && (it.name.startsWith(".env") || it.name == "sw-trip.js") }.toList()
        if (stray.isNotEmpty()) throw GradleException("unexpected files in web assets: $stray")
    }
}

android {
    namespace = "app.tripguide.hybrid"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.tripguide.hybrid"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "1.0-android"
        buildConfigField("boolean", "HAS_FIREBASE_CONFIG", hasFirebaseConfig.toString())
        // Cloud model used when the on-device model can't answer (same as the web version).
        buildConfigField("String", "CLOUD_MODEL", "\"gemini-3.5-flash-lite\"")
        // Requests that may reach the cloud, per install (free-tier guard for test builds). 0 = no limit.
        buildConfigField("int", "CLOUD_CAP", (findProperty("cloudCap") as String? ?: "45"))
        // Minimum gap between requests that may reach the cloud (free tier).
        buildConfigField("long", "CLOUD_MIN_GAP_MS", "6500L")
        // Off unless asked for: -PappCheckDebugTokenFile=<file outside the repo> puts an App Check debug token
        // (registered in the Firebase console) into this debug build, so a phone that installs the APK passes App Check
        // without registering its own. The token then sits inside the APK: only for a test build handed to someone you trust, and the
        // token should be deleted in the console afterwards. The value is never printed or committed.
        (findProperty("appCheckDebugTokenFile") as String?)?.let { f ->
            val token = file(f).readText().trim()
            require(token.matches(Regex("[0-9a-fA-F-]{36}"))) { "appCheckDebugTokenFile: not a debug token" }
            resValue("string", "firebase_app_check_debug_token", token)
        }
    }

    buildTypes {
        getByName("debug") {
            // Off unless asked for: -Pshrink=true lets R8 shrink this debug build so the APK stays under the 10 MB
            // upload limit of remote test phones. Still debuggable, same code paths.
            if ((findProperty("shrink") as String?) == "true") {
                isMinifyEnabled = true
                proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        // Needed by the appCheckDebugTokenFile option above (resValue); off by default since AGP 9.
        resValues = true
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(webOut)
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:35.2.0"))
    implementation("com.google.firebase:firebase-ai:18.2.0")
    // The on-device SDK is not in the BoM yet (Firebase docs).
    implementation("com.google.firebase:firebase-ai-ondevice:16.0.0-beta08")
    implementation("com.google.firebase:firebase-appcheck-debug")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // JsonSchema.obj() is typed with kotlinx.serialization JsonObject (already a dependency of firebase-ai).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
}
