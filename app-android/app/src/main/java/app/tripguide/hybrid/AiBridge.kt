package app.tripguide.hybrid

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.DownloadStatus
import com.google.firebase.ai.GenerativeModel
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.OnDeviceModelOption
import com.google.firebase.ai.OnDeviceModelStatus
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.FirebaseAIOnDeviceInvalidRequestException
import com.google.firebase.ai.type.FirebaseAIOnDeviceNotAvailableException
import com.google.firebase.ai.type.FirebaseAIOnDeviceUnknownException
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * The only place in the app that runs AI. The web page (assets/web, copied from the PC Chrome version) asks for
 * every answer through window.TripBridge (see app-android/web/sdk.js); this class sends it to the
 * Firebase AI Logic Android SDK (firebase-ai + firebase-ai-ondevice) and streams the text back with the
 * inferenceSource the SDK reports (ON_DEVICE or IN_CLOUD). No other model API is called anywhere.
 *
 * Events to the page: window.__tripBridge.emit({id, type: 'chunk'|'done'|'error', ...}) and
 * window.__tripBridge.status({...}) when the on-device model status changes.
 * Every request is one line in files/ai-calls.jsonl (time, mode, source, timing, error; no answer text).
 */
@OptIn(PublicPreviewAPI::class)
class AiBridge(private val context: Context, private val toPage: (String) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val jobs = ConcurrentHashMap<String, Job>()
    private val models = ConcurrentHashMap<String, GenerativeModel>()
    private val prefs = context.getSharedPreferences("bridge", Context.MODE_PRIVATE)
    private val cloudLock = Mutex()
    private val log = File(context.filesDir, "ai-calls.jsonl")
    private val firebaseReady = BuildConfig.HAS_FIREBASE_CONFIG && FirebaseApp.getApps(context).isNotEmpty()

    @Volatile var online = true
        set(v) {
            val was = field
            field = v
            // A model that could not be downloaded offline is fetched once the phone is back online.
            if (v && !was && status == "DOWNLOADABLE") scope.launch { download() }
        }
    @Volatile private var status = if (firebaseReady) "CHECKING" else "UNAVAILABLE"
    @Volatile private var optionName = "preview"
    @Volatile private var modelName: String? = null
    @Volatile private var bytesDone: Long? = null
    @Volatile private var bytesTotal: Long? = null
    @Volatile private var downloading = false
    private var forced: String? = null
    private var lastCloudStart = 0L

    // ------------------------------------------------------------------ on-device model status

    /** Gemini Nano 4 is the PREVIEW option (Firebase docs, configuration options); STABLE is Nano 3 or 2. */
    private fun optionOf(name: String): OnDeviceModelOption = when (name) {
        "stable" -> OnDeviceModelOption.STABLE
        "fast" -> OnDeviceModelOption.PREVIEW_FAST
        else -> OnDeviceModelOption.PREVIEW
    }

    private fun statusModel(name: String): GenerativeModel = models.getOrPut("status|$name") {
        Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
            modelName = BuildConfig.CLOUD_MODEL,
            onDeviceConfig = OnDeviceConfig(mode = InferenceMode.PREFER_ON_DEVICE, modelOption = optionOf(name)),
        )
    }

    private fun statusName(s: OnDeviceModelStatus?): String = when (s) {
        OnDeviceModelStatus.AVAILABLE -> "AVAILABLE"
        OnDeviceModelStatus.DOWNLOADABLE -> "DOWNLOADABLE"
        OnDeviceModelStatus.DOWNLOADING -> "DOWNLOADING"
        OnDeviceModelStatus.UNAVAILABLE -> "UNAVAILABLE"
        null -> "UNAVAILABLE"
        else -> s.toString()
    }

    /** forcedOption: "preview" | "fast" | "stable" (test hook, adb --es model ...); null = Nano 4 first, then stable. */
    fun start(forcedOption: String?) {
        forced = forcedOption
        scope.launch { refreshStatus(allowDownload = true) }
    }

    private suspend fun refreshStatus(allowDownload: Boolean) {
        if (!firebaseReady) {
            setStatus("UNAVAILABLE")
            return
        }
        val order = forced?.let { listOf(it) } ?: listOf("preview", "stable")
        var picked: Pair<String, String>? = null
        for (name in order) {
            val s = try {
                statusName(statusModel(name).onDeviceExtension?.checkStatus())
            } catch (e: Throwable) {
                write(JSONObject().put("t", now()).put("kind", "status").put("option", name).put("error", errText(e)))
                "UNAVAILABLE"
            }
            write(JSONObject().put("t", now()).put("kind", "status").put("option", name).put("status", s))
            if (picked == null) picked = name to s
            if (s != "UNAVAILABLE") { picked = name to s; break }
        }
        val (name, s) = picked ?: ("preview" to "UNAVAILABLE")
        optionName = name
        if (s == "AVAILABLE") {
            modelName = try { statusModel(name).onDeviceExtension?.getModelName() } catch (e: Throwable) { null }
        }
        setStatus(if (downloading && s != "AVAILABLE") "DOWNLOADING" else s)
        if (allowDownload && s == "DOWNLOADABLE" && online) download()
    }

    /** Download the on-device model in the background (the SDK never starts it by itself). */
    private suspend fun download() {
        if (downloading || !firebaseReady) return
        val ext = statusModel(optionName).onDeviceExtension ?: return
        downloading = true
        setStatus("DOWNLOADING")
        val started = SystemClock.elapsedRealtime()
        var lastSent = 0L
        try {
            ext.download().collect { d ->
                when (d) {
                    is DownloadStatus.DownloadStarted -> { bytesTotal = d.bytesToDownload; event("download-started") }
                    is DownloadStatus.DownloadInProgress -> {
                        bytesDone = d.totalBytesDownloaded
                        val t = SystemClock.elapsedRealtime()
                        if (t - lastSent > 1000) { lastSent = t; emitStatus() }
                    }
                    is DownloadStatus.DownloadCompleted -> event("download-completed", SystemClock.elapsedRealtime() - started)
                    is DownloadStatus.DownloadFailed -> event("download-failed", SystemClock.elapsedRealtime() - started)
                    else -> {}
                }
            }
        } catch (e: Throwable) {
            write(JSONObject().put("t", now()).put("kind", "download").put("error", errText(e)))
        } finally {
            downloading = false
            refreshStatus(allowDownload = false)
        }
    }

    private fun event(what: String, ms: Long? = null) {
        write(JSONObject().put("t", now()).put("kind", "download").put("event", what).put("option", optionName).put("ms", ms ?: JSONObject.NULL))
        emitStatus()
    }

    private fun setStatus(s: String) {
        status = s
        emitStatus()
    }

    private fun statusJson(): JSONObject = JSONObject()
        .put("status", status)
        .put("option", optionName)
        .put("model", modelName ?: JSONObject.NULL)
        .put("bytesDone", bytesDone ?: JSONObject.NULL)
        .put("bytesTotal", bytesTotal ?: JSONObject.NULL)
        .put("firebase", firebaseReady)

    private fun emitStatus() = toPage("window.__tripBridge && window.__tripBridge.status(${statusJson()})")

    // ------------------------------------------------------------------ page interface

    @JavascriptInterface fun statusNow(): String = statusJson().toString()

    @JavascriptInterface fun sdkVersion(): String = "firebase-ai 18.2.0 / firebase-ai-ondevice 16.0.0-beta08"

    @JavascriptInterface fun generate(id: String, json: String) {
        val req = try { JSONObject(json) } catch (e: Throwable) {
            emit(JSONObject().put("id", id).put("type", "error").put("name", "BadRequest").put("message", "The request could not be read."))
            return
        }
        jobs[id] = scope.launch { run(id, req) }
    }

    @JavascriptInterface fun cancel(id: String) {
        jobs.remove(id)?.cancel()
    }

    fun close() = scope.cancel()

    // ------------------------------------------------------------------ one request

    private fun modeOf(name: String): InferenceMode = when (name) {
        "only_on_device" -> InferenceMode.ONLY_ON_DEVICE
        "only_in_cloud" -> InferenceMode.ONLY_IN_CLOUD
        "prefer_in_cloud" -> InferenceMode.PREFER_IN_CLOUD
        else -> InferenceMode.PREFER_ON_DEVICE
    }

    /**
     * On the device, the SDK does not take a hand-written JSON schema (only generateObject with @Generable classes),
     * so a request that may run on the device asks for the JSON form in its system instruction and the page reads it
     * with the same forgiving reader as on the web. A request that goes to the cloud gets the schema as
     * responseJsonSchema, as on the web.
     */
    private fun modelFor(modeName: String, system: String?, schema: JSONObject?, cloudModel: String): GenerativeModel {
        val mode = modeOf(modeName)
        val key = "$modeName|$optionName|$cloudModel|${system?.hashCode()}|${schema?.toString()?.hashCode()}"
        return models.getOrPut(key) {
            val deviceLeg = mode != InferenceMode.ONLY_IN_CLOUD
            val sys = when {
                deviceLeg && schema != null -> (system?.let { "$it\n\n" } ?: "") + JSON_HINT + schema.toString()
                else -> system
            }
            Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
                modelName = cloudModel,
                generationConfig = schema?.let { s ->
                    generationConfig {
                        responseMimeType = "application/json"
                        responseJsonSchema = SchemaJson.from(s)
                    }
                },
                systemInstruction = sys?.let { t -> content { text(t) } },
                onDeviceConfig = if (mode == InferenceMode.ONLY_IN_CLOUD) OnDeviceConfig(mode = mode)
                else OnDeviceConfig(mode = mode, modelOption = optionOf(optionName)),
            )
        }
    }

    private suspend fun run(id: String, req: JSONObject) {
        val modeName = req.optString("mode", "prefer_on_device")
        val mode = modeOf(modeName)
        val system = if (req.isNull("system")) null else req.optString("system")
        val schema = req.optJSONObject("schema")
        val cloudModel = if (req.isNull("model")) BuildConfig.CLOUD_MODEL else req.optString("model", BuildConfig.CLOUD_MODEL)
        val parts = req.optJSONArray("parts") ?: JSONArray()
        val texts = (0 until parts.length()).mapNotNull { parts.optJSONObject(it)?.optString("text")?.takeIf { t -> t.isNotEmpty() } }
        val hasImage = (0 until parts.length()).any { parts.optJSONObject(it)?.has("inlineData") == true }
        // Requests that may reach the cloud: everything except on-device only, and except device-first while a model is ready.
        val mayCloud = mode != InferenceMode.ONLY_ON_DEVICE && !(mode == InferenceMode.PREFER_ON_DEVICE && status == "AVAILABLE")
        val rec = JSONObject().put("t", now()).put("kind", "generate").put("id", id).put("mode", modeName)
            .put("option", optionName).put("modelName", modelName ?: JSONObject.NULL).put("modelStatus", status).put("json", schema != null)
            .put("chars", texts.sumOf { it.length }).put("image", hasImage).put("online", online)
            .put("ask", texts.lastOrNull()?.lineSequence()?.lastOrNull { it.isNotBlank() }?.take(120) ?: "")
        val t0 = SystemClock.elapsedRealtime()
        var sentToSdk = false
        try {
            if (!firebaseReady) { fail(id, rec, "NotConfigured", "Firebase is not set up in this build, so the AI cannot answer."); return }
            if (mayCloud) {
                if (!online && mode == InferenceMode.ONLY_IN_CLOUD) { fail(id, rec, "NetworkError", "No internet connection, so the cloud cannot be asked."); return }
                val ok = cloudLock.withLock {
                    val used = prefs.getInt("cloudCalls", 0)
                    if (BuildConfig.CLOUD_CAP > 0 && used >= BuildConfig.CLOUD_CAP) return@withLock false
                    val wait = lastCloudStart + BuildConfig.CLOUD_MIN_GAP_MS - SystemClock.elapsedRealtime()
                    if (lastCloudStart > 0 && wait > 0) { rec.put("waitedMs", wait); delay(wait) }
                    lastCloudStart = SystemClock.elapsedRealtime()
                    prefs.edit().putInt("cloudCalls", used + 1).apply()
                    rec.put("cloudCallNo", used + 1)
                    true
                }
                if (!ok) { fail(id, rec, "CloudCapReached", "This test build has used up its cloud requests (${BuildConfig.CLOUD_CAP})."); return }
            }
            val model = modelFor(modeName, system, schema, cloudModel)
            val prompt = content {
                for (i in 0 until parts.length()) {
                    val p = parts.optJSONObject(i) ?: continue
                    val inline = p.optJSONObject("inlineData")
                    if (inline != null) inlineData(Base64.decode(inline.optString("data"), Base64.DEFAULT), inline.optString("mimeType", "image/jpeg"))
                    else if (p.has("text")) text(p.optString("text"))
                }
            }
            val start = SystemClock.elapsedRealtime()
            var source: InferenceSource? = null
            var firstMs: Long? = null
            val acc = StringBuilder()
            sentToSdk = true
            model.generateContentStream(prompt).collect { r ->
                if (source == null) source = r.inferenceSource
                val t = r.text ?: ""
                // Chunks are pieces of the answer; if a chunk repeats everything so far, send only the new part.
                val delta = if (acc.isNotEmpty() && t.length > acc.length && t.startsWith(acc)) t.substring(acc.length) else t
                if (delta.isNotEmpty()) {
                    if (firstMs == null) firstMs = SystemClock.elapsedRealtime() - start
                    acc.append(delta)
                    emit(JSONObject().put("id", id).put("type", "chunk").put("text", delta))
                }
            }
            val src = sourceName(source)
            rec.put("source", src ?: JSONObject.NULL).put("firstMs", firstMs ?: JSONObject.NULL).put("answerChars", acc.length)
            emit(JSONObject().put("id", id).put("type", "done").put("source", src ?: JSONObject.NULL))
        } catch (e: CancellationException) {
            rec.put("cancelled", true)
            throw e
        } catch (e: Throwable) {
            val err = errorOf(e)
            rec.put("error", JSONObject(err.toString()).put("class", e.javaClass.simpleName))
            emit(err.put("id", id).put("type", "error"))
        } finally {
            rec.put("ms", SystemClock.elapsedRealtime() - t0).put("sentToSdk", sentToSdk)
            // A request counts as a cloud request when the SDK said the answer came from the cloud, or when it was
            // sent while it could only go to the cloud (an error from the cloud is still a request).
            val src = rec.optString("source")
            rec.put("cloud", src == "IN_CLOUD" || (sentToSdk && mayCloud && src != "ON_DEVICE"))
            write(rec)
            jobs.remove(id)
        }
    }

    private fun fail(id: String, rec: JSONObject, name: String, message: String) {
        rec.put("error", JSONObject().put("name", name).put("message", message)).put("blocked", true)
        emit(JSONObject().put("id", id).put("type", "error").put("name", name).put("message", message))
    }

    private fun sourceName(s: InferenceSource?): String? = when (s) {
        InferenceSource.ON_DEVICE -> "ON_DEVICE"
        InferenceSource.IN_CLOUD -> "IN_CLOUD"
        else -> null
    }

    /** Error names the web engine already understands (src/engine/index.js classify() and cloudFailed()). */
    private fun errorOf(e: Throwable): JSONObject {
        val msg = (e.message ?: e.javaClass.simpleName).take(600)
        val chain = generateSequence(e) { it.cause }.take(8).toList()
        val net = chain.any { it is java.net.UnknownHostException || it is java.net.ConnectException || it is java.net.SocketTimeoutException || it is javax.net.ssl.SSLException }
        val name = when {
            e is QuotaExceededException -> "ResourceExhausted"
            e is FirebaseAIOnDeviceUnknownException -> "UnknownError"
            e is FirebaseAIOnDeviceInvalidRequestException && Regex("token|too (large|long)|exceed", RegexOption.IGNORE_CASE).containsMatchIn(msg) -> "QuotaExceededError"
            e is FirebaseAIOnDeviceInvalidRequestException -> "InvalidRequest"
            e is FirebaseAIOnDeviceNotAvailableException -> "NotAvailable"
            e is RequestTimeoutException -> "CloudTimeout"
            net || (!online && e is java.io.IOException) -> "NetworkError"
            else -> e.javaClass.simpleName
        }
        val status: Any = when {
            e is QuotaExceededException -> 429
            Regex("\\b429\\b|RESOURCE_EXHAUSTED").containsMatchIn(msg) -> 429
            Regex("\\b401\\b|app ?check", RegexOption.IGNORE_CASE).containsMatchIn(msg) -> 401
            Regex("\\b403\\b").containsMatchIn(msg) -> 403
            else -> JSONObject.NULL
        }
        return JSONObject().put("name", name).put("message", msg).put("status", status)
    }

    private fun errText(e: Throwable) = "${e.javaClass.simpleName}: ${(e.message ?: "").take(300)}"

    private fun emit(o: JSONObject) = toPage("window.__tripBridge && window.__tripBridge.emit($o)")

    @Synchronized private fun write(o: JSONObject) {
        try { log.appendText(o.toString() + "\n") } catch (e: Throwable) { Log.w(TAG, "log write failed: ${e.message}") }
    }

    private fun now(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date())

    companion object {
        private const val TAG = "TripBridge"
        private const val JSON_HINT = "Reply with one JSON object and nothing else (no code fences, no text before or after it). " +
            "It must match this JSON Schema:\n"
    }
}
