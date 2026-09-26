package com.example.ai_dj_companion

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Abgleich mit dem PC (über den Companion-Server im WLAN):
 *  - Bewertungen (👍/👎 für Übergänge, Reihenfolge, Tricks, Laser) in beide Richtungen –
 *    Track-Bezüge relativ zum Musik-Ordner, damit sie auf beiden Geräten für denselben Song gelten
 *  - Tracks: was auf dem Handy fehlt, kommt vom PC; was nur auf dem Handy liegt, geht zum PC.
 *    Gelöscht oder überschrieben wird nie etwas.
 * Läuft automatisch beim Verbinden mit dem PC, beim Start des Selbst-Modus und auf Knopfdruck.
 */
object SyncManager {
    private const val PHONE_FEEDBACK = "phone_feedback.json"
    private const val PC_FEEDBACK = "pc_feedback.json"
    private const val NOTIFY_ID = 7
    private val AUDIO = setOf("mp3", "wav", "ogg", "flac", "m4a", "aac", "opus")

    @Volatile var running = false
        private set
    @Volatile var status = ""
        private set

    // ------------------------------------------------------------ Bewertungen (Dateien)

    fun savePhoneFeedback(ctx: Context, json: String) {
        try {
            File(ctx.filesDir, PHONE_FEEDBACK).writeText(json)
        } catch (_: Exception) {
        }
    }

    private fun read(ctx: Context, name: String): String = try {
        File(ctx.filesDir, name).takeIf { it.exists() }?.readText() ?: "[]"
    } catch (_: Exception) {
        "[]"
    }

    /** Liegen Bewertungen vom PC bereit und hört der Mixer auf dem Handy zu: übergeben. */
    fun deliverPcFeedback(ctx: Context) {
        if (!SelfEngine.listening) return
        val pc = read(ctx, PC_FEEDBACK)
        if (pc.trim() == "[]") return
        SelfEngine.dispatch(JSONObject().put("cmd", "mergeFeedback").put("entries", JSONArray(pc)).toString())
    }

    // ------------------------------------------------------------ Ablauf

    fun start(ctx: Context, reason: String = "") {
        if (running || !DjRepo.configured) {
            if (!DjRepo.configured) setStatus("Kein PC eingerichtet – im Companion-Modus einmal verbinden")
            return
        }
        running = true
        val app = ctx.applicationContext
        Thread({
            try {
                run(app)
            } catch (e: Exception) {
                setStatus("Abgleich abgebrochen: ${e.message ?: "Fehler"}")
            } finally {
                running = false
                DjRepo.notifyChanged()
                (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFY_ID)
            }
        }, "aidj-sync").start()
    }

    private fun run(ctx: Context) {
        setStatus("Suche PC …")
        if (!DjRepo.hello(DjRepo.host, DjRepo.port)) {
            setStatus("PC nicht erreichbar – Abgleich beim nächsten Verbinden")
            return
        }
        // 1. Bewertungen in beide Richtungen
        setStatus("Gleiche Bewertungen ab …")
        val remote = JSONObject(get("/api/sync/feedback"))
        val pcFeedback = remote.optJSONArray("feedback") ?: JSONArray()
        File(ctx.filesDir, PC_FEEDBACK).writeText(pcFeedback.toString())
        val phoneFeedback = JSONArray(read(ctx, PHONE_FEEDBACK))
        if (phoneFeedback.length() > 0) post("/api/cmd", JSONObject().put("cmd", "mergeFeedback").put("entries", phoneFeedback).toString().toByteArray(), "application/json")
        deliverPcFeedback(ctx)

        // 2. Tracks in beide Richtungen
        setStatus("Vergleiche Tracks …")
        val root = SelfEngine.musicRoot
        root.mkdirs()
        val pcList = JSONArray(get("/api/sync/library"))
        val pcFiles = HashMap<String, Long>()
        for (i in 0 until pcList.length()) pcList.optJSONObject(i)?.let { pcFiles[it.optString("p")] = it.optLong("size") }
        val phoneFiles = HashMap<String, Long>()
        fun walk(d: File, depth: Int) {
            for (f in d.listFiles() ?: return) {
                if (f.isDirectory) {
                    if (depth < 4) walk(f, depth + 1)
                } else if (f.extension.lowercase() in AUDIO) {
                    phoneFiles[f.relativeTo(root).invariantSeparatorsPath] = f.length()
                }
            }
        }
        walk(root, 0)
        val down = pcFiles.keys.filter { it !in phoneFiles }.sorted()
        val up = phoneFiles.keys.filter { it !in pcFiles }.sorted()
        var got = 0
        var sent = 0
        for ((i, rel) in down.withIndex()) {
            progress(ctx, "↓ ${i + 1}/${down.size} ${rel.substringAfterLast('/')}", i, down.size + up.size)
            val target = File(root, rel)
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, target.name + ".part")
            val c = open("/api/sync/file?p=${enc(rel)}")
            c.readTimeout = 60000
            try {
                if (c.responseCode != 200) continue
                c.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it, 256 * 1024) } }
            } finally {
                c.disconnect()
            }
            if (tmp.length() > 0 && tmp.renameTo(target)) got++ else tmp.delete()
        }
        for ((i, rel) in up.withIndex()) {
            progress(ctx, "↑ ${i + 1}/${up.size} ${rel.substringAfterLast('/')}", down.size + i, down.size + up.size)
            val f = File(root, rel)
            val c = open("/api/sync/upload?p=${enc(rel)}")
            c.requestMethod = "POST"
            c.doOutput = true
            c.readTimeout = 60000
            c.setFixedLengthStreamingMode(f.length())
            c.setRequestProperty("Content-Type", "application/octet-stream")
            try {
                f.inputStream().use { input -> c.outputStream.use { input.copyTo(it, 256 * 1024) } }
                if (c.responseCode == 200) sent++
            } finally {
                c.disconnect()
            }
        }
        if (got > 0) SelfEngine.dispatch(JSONObject().put("cmd", "reloadLibrary").toString())
        val time = java.text.SimpleDateFormat("HH:mm", java.util.Locale.GERMANY).format(java.util.Date())
        setStatus(
            "Abgeglichen um $time · " +
                (if (got + sent == 0) "Tracks auf beiden Geräten gleich" else "$got Track${if (got == 1) "" else "s"} aufs Handy, $sent zum PC") +
                " · Bewertungen: Handy ${phoneFeedback.length()}, PC ${pcFeedback.length()}",
        )
    }

    // ------------------------------------------------------------ HTTP

    private fun enc(rel: String) = URLEncoder.encode(rel, "UTF-8").replace("+", "%20")

    private fun open(path: String): HttpURLConnection {
        val c = URL("http://${DjRepo.host}:${DjRepo.port}$path").openConnection() as HttpURLConnection
        c.connectTimeout = 5000
        c.readTimeout = 20000
        c.setRequestProperty("X-Pin", DjRepo.pin)
        return c
    }

    private fun get(path: String): String {
        val c = open(path)
        try {
            if (c.responseCode == 409) throw IllegalStateException("am PC ist noch kein Musik-Ordner geladen")
            if (c.responseCode != 200) throw IllegalStateException("PC antwortet mit ${c.responseCode}")
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }

    private fun post(path: String, body: ByteArray, type: String) {
        val c = open(path)
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("Content-Type", type)
        try {
            c.outputStream.use { it.write(body) }
            c.responseCode
        } finally {
            c.disconnect()
        }
    }

    // ------------------------------------------------------------ Anzeige

    private fun setStatus(s: String) {
        status = s
        DjRepo.notifyChanged()
    }

    private fun progress(ctx: Context, text: String, done: Int, total: Int) {
        setStatus(text)
        val n = NotificationCompat.Builder(ctx, DjService.CH_ONGOING)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Automix: Tracks abgleichen")
            .setContentText(text)
            .setProgress(total, done, false)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
        try {
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFY_ID, n)
        } catch (_: SecurityException) {
        }
    }
}
