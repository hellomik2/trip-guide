package app.tripguide.hybrid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Trip Guide for Android: the same trip page as the PC Chrome version, inside a WebView.
 * - The page, the travel pack (61 places, 58 photos) and the app code are in the APK (assets/web), so the app opens
 *   with no internet and needs no download. They are served from https://appassets.androidplatform.net/ by this class.
 * - Every AI answer goes through AiBridge (Firebase AI Logic Android SDK). The page itself reaches no one: any request
 *   to another host is blocked here and written to files/blocked.jsonl. Links the user taps open in the browser.
 * - The network state is passed to the page (navigator.onLine and online/offline events).
 */
class TripActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var bridge: AiBridge
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private val blockedLog by lazy { File(filesDir, "blocked.jsonl") }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.HAS_FIREBASE_CONFIG && FirebaseApp.getApps(this).isNotEmpty() && BuildConfig.DEBUG) {
            // Test builds: App Check debug provider. Its secret is registered in the Firebase console and is never
            // committed. A build for other people needs a production provider (Play Integrity); see README.md.
            Firebase.appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        setContentView(web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            textZoom = 100
        }
        bridge = AiBridge(applicationContext) { js -> web.post { web.evaluateJavascript(js, null) } }
        web.addJavascriptInterface(bridge, "TripBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val u = request.url
                if (u.scheme == "https" && u.host == HOST) return asset(u.path ?: "/")
                blocked(u)
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "https" && u.host == HOST) return false
                // A link the user tapped (credits, licences, OpenStreetMap) opens in the phone's browser.
                if (request.hasGesture() && (u.scheme == "https" || u.scheme == "http")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Throwable) { Log.w(TAG, "no browser: ${e.message}") }
                }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(params.createIntent(), REQ_FILE)
                    true
                } catch (e: Throwable) {
                    fileCallback = null
                    false
                }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("TripWeb", "${m.messageLevel()} ${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()} ${m.message()}")
                return true
            }
        }
        watchNetwork()
        bridge.start(intent?.getStringExtra("model"))
        // Test hook: adb shell am start ... --es query simulate=no-model (the web page's own switches).
        val q = intent?.getStringExtra("query")?.takeIf { it.matches(Regex("[A-Za-z0-9=&_,.-]{1,80}")) }?.let { "?$it" } ?: ""
        web.loadUrl("https://$HOST/trip.html$q")
    }

    /** Files of the page, from assets/web (copied from the web app at build time). */
    private fun asset(path: String): WebResourceResponse {
        val p = path.trimStart('/').ifEmpty { "trip.html" }
        if (p.contains("..")) return notFound()
        return try {
            val stream = assets.open("web/$p")
            val mime = MIME[p.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
            val text = mime.startsWith("text/") || mime == "application/json"
            WebResourceResponse(mime, if (text) "utf-8" else null, 200, "OK", mapOf("Cache-Control" to "no-cache"), stream)
        } catch (e: java.io.IOException) {
            notFound()
        }
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    @Synchronized private fun blocked(u: Uri) {
        val line = JSONObject().put("t", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date()))
            .put("scheme", u.scheme).put("host", u.host ?: "").put("path", (u.path ?: "").take(80))
        try { blockedLog.appendText("$line\n") } catch (_: Throwable) { }
        Log.w(TAG, "blocked request to ${u.host}")
    }

    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java)
        fun online(caps: NetworkCapabilities?) = caps != null &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        fun set(on: Boolean) = runOnUiThread {
            bridge.online = on
            web.setNetworkAvailable(on)
        }
        set(online(cm.getNetworkCapabilities(cm.activeNetwork)))
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = set(online(caps))
            override fun onLost(network: Network) = set(online(cm.getNetworkCapabilities(cm.activeNetwork)))
        }
        cm.registerDefaultNetworkCallback(cb)
        netCallback = cb
    }

    @Deprecated("Activity result for the photo picker of the sign reader")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    @Deprecated("Back goes back in the page first (the sign reader is #read)")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }

    override fun onDestroy() {
        netCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        bridge.close()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "TripActivity"
        private const val HOST = "appassets.androidplatform.net"
        private const val REQ_FILE = 41
        private val MIME = mapOf(
            "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css",
            "json" to "application/json", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png",
            "webp" to "image/webp", "svg" to "image/svg+xml", "txt" to "text/plain",
        )
    }
}
