package com.example.ai_dj_companion

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Selbst-Modus: der komplette Mixer (dieselbe Engine wie am PC) läuft auf dem Handy – in einem
 * WebView hinter der App-Oberfläche. Die Oberfläche bleibt die gleiche wie im Companion-Modus;
 * statt an den PC gehen Befehle an diesen eingebauten Mixer, und sein Status kommt direkt zurück.
 *
 * Brücke (siehe tools/phone/phone-shim.js im Mixer-Projekt):
 *  - /scan/<Ordner>, /fs/<Datei>   Musik-Ordner lesen (nur Audio, nur unter [musicRoot])
 *  - /net/<URL>                    Genre online nachschlagen (nur iTunes/MusicBrainz, wie am PC)
 *  - AutomixNative                 Status, Ereignisse, Bewertungen für den Abgleich
 */
object SelfEngine {
    private const val ORIGIN = "https://appassets.androidplatform.net"
    private val AUDIO = setOf("mp3", "wav", "ogg", "flac", "m4a", "aac", "opus")
    private val WEB_HOSTS = listOf("https://itunes.apple.com/", "https://musicbrainz.org/ws/2/")
    private val main = Handler(Looper.getMainLooper())

    var webView: WebView? = null
        private set
    @Volatile var listening = false
        private set

    val musicRoot: File get() = File(Environment.getExternalStorageDirectory(), "Music/Automix")

    val running get() = webView != null

    @SuppressLint("SetJavaScriptEnabled")
    fun start(activity: Activity, host: FrameLayout) {
        if (webView != null) return
        musicRoot.mkdirs()
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity))
            .addPathHandler("/scan/") { path -> scan("/" + path.trimStart('/')) }
            .addPathHandler("/fs/") { path -> file("/" + path.trimStart('/')) }
            .addPathHandler("/net/") { path -> net(path) }
            .build()
        val wv = WebView(activity)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.databaseEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        wv.settings.allowFileAccess = false
        wv.settings.useWideViewPort = true
        wv.settings.loadWithOverviewMode = true
        wv.settings.builtInZoomControls = true
        wv.settings.displayZoomControls = false
        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
        }
        wv.addJavascriptInterface(Bridge(activity.applicationContext), "AutomixNative")
        host.addView(wv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        listening = false
        DjRepo.localSend = { json -> dispatch(json) }
        DjRepo.setLocalState(null)
        wv.loadUrl("$ORIGIN/assets/web/index.html")
    }

    fun stop() {
        val wv = webView ?: return
        webView = null
        listening = false
        DjRepo.localSend = null
        (wv.parent as? ViewGroup)?.removeView(wv)
        wv.destroy()
    }

    /** Befehl an den Mixer (JSON wie vom PC-Companion: {"cmd":…}). */
    fun dispatch(json: String) {
        main.post {
            webView?.evaluateJavascript("window.__automixCmd && window.__automixCmd(${JSONObject.quote(json)})", null)
        }
    }

    // ------------------------------------------------------------ Dateien

    private fun inRoot(f: File): Boolean = try {
        f.canonicalPath.startsWith(musicRoot.canonicalPath + File.separator) || f.canonicalPath == musicRoot.canonicalPath
    } catch (_: Exception) {
        false
    }

    private fun scan(path: String): WebResourceResponse {
        val dir = File(path)
        if (!inRoot(dir) || !dir.isDirectory) return json(404, JSONObject().put("error", "Ordner nicht gefunden").toString())
        val out = JSONArray()
        fun walk(d: File, depth: Int) {
            val list = d.listFiles() ?: return
            for (f in list.sortedBy { it.name.lowercase() }) {
                if (f.isDirectory) {
                    if (depth < 4) walk(f, depth + 1)
                } else if (f.extension.lowercase() in AUDIO) {
                    out.put(JSONObject().put("path", f.absolutePath).put("name", f.name).put("size", f.length()).put("modified", f.lastModified() / 1000))
                }
            }
        }
        walk(dir, 0)
        return json(200, out.toString())
    }

    private fun file(path: String): WebResourceResponse {
        val f = File(path)
        if (!inRoot(f) || !f.isFile || f.extension.lowercase() !in AUDIO) return json(404, JSONObject().put("error", "Datei nicht gefunden").toString())
        return WebResourceResponse("application/octet-stream", null, 200, "OK", mapOf("Content-Length" to f.length().toString()), FileInputStream(f))
    }

    private fun net(url: String): WebResourceResponse {
        if (WEB_HOSTS.none { url.startsWith(it) }) return json(403, JSONObject().put("error", "Adresse nicht erlaubt").toString())
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 8000
            c.readTimeout = 8000
            c.setRequestProperty("User-Agent", "Automix/0.2 ( https://github.com/IseeU93/Ai-DJ )")
            val code = c.responseCode
            val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            c.disconnect()
            json(code, body)
        } catch (e: Exception) {
            json(502, JSONObject().put("error", e.message ?: "offline").toString())
        }
    }

    private fun json(code: Int, body: String) = WebResourceResponse(
        "application/json", "utf-8", code, if (code < 400) "OK" else "Fehler", emptyMap(), ByteArrayInputStream(body.toByteArray()),
    )

    // ------------------------------------------------------------ Brücke

    private class Bridge(private val ctx: android.content.Context) {
        @JavascriptInterface fun musicRoot(): String = SelfEngine.musicRoot.absolutePath

        @JavascriptInterface fun push(state: String) = DjRepo.setLocalState(state)

        @JavascriptInterface fun event(ev: String) {
            try {
                DjService.notifyEvent(ctx, JSONObject(ev))
            } catch (_: Exception) {
            }
        }

        /** Stand für den PC-Abgleich (Bewertungen relativ zum Musik-Ordner). */
        @JavascriptInterface fun syncSet(root: String, feedback: String) = SyncManager.savePhoneFeedback(ctx, feedback)

        /** Mixer hört jetzt auf Befehle – liegen Bewertungen vom PC bereit, gleich übergeben. */
        @JavascriptInterface fun listening() {
            SelfEngine.listening = true
            SyncManager.deliverPcFeedback(ctx)
        }
    }
}
