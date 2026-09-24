package com.example.ai_dj_companion

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Verbindung zum AI-DJ auf dem PC (Companion-Server, Port 7777).
 * Status per Long-Polling, Befehle per POST, Suche per UDP-Broadcast (Port 7778).
 */
object DjRepo {
    data class Found(val host: String, val port: Int, val name: String)

    private const val PREFS = "aidj"
    private val main = Handler(Looper.getMainLooper())
    private val sender = Executors.newSingleThreadExecutor()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    var host = ""
    var port = 7777
    var pin = ""

    @Volatile var state: JSONObject? = null
        private set
    @Volatile var connected = false
        private set
    @Volatile var error: String? = null
        private set

    private var seq = 0L
    private var firstPoll = true

    fun load(ctx: Context) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        host = p.getString("host", "") ?: ""
        port = p.getInt("port", 7777)
        pin = p.getString("pin", "") ?: ""
    }

    fun save(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("host", host).putInt("port", port).putString("pin", pin).apply()
    }

    val configured get() = host.isNotBlank() && pin.length == 4

    fun addListener(l: () -> Unit) = listeners.add(l)
    fun removeListener(l: () -> Unit) = listeners.remove(l)
    private fun changed() = main.post { listeners.forEach { it() } }

    private fun base() = "http://$host:$port"

    /**
     * Ein Abfrage-Durchgang (blockiert bis zu [waitSec] Sekunden, bis sich etwas ändert).
     * Liefert neue Ereignisse (z. B. Playlist-Warnung). Wirft bei Netzwerkfehlern.
     */
    fun pollOnce(waitSec: Int): List<JSONObject> {
        val c = URL("${base()}/api/state?since=$seq&wait=$waitSec").openConnection() as HttpURLConnection
        c.connectTimeout = 4000
        c.readTimeout = (waitSec + 10) * 1000
        c.setRequestProperty("X-Pin", pin)
        try {
            if (c.responseCode == 401) {
                error = "PIN falsch"
                connected = false
                changed()
                throw IOException("PIN falsch")
            }
            val body = c.inputStream.bufferedReader().readText()
            val j = JSONObject(body)
            seq = j.optLong("seq", seq)
            state = j.optJSONObject("state")
            connected = true
            error = null
            val events = mutableListOf<JSONObject>()
            val arr = j.optJSONArray("events")
            // Beim ersten Abruf nur den Stand übernehmen – alte Ereignisse nicht nochmal melden
            if (!firstPoll && arr != null) for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { events.add(it) }
            firstPoll = false
            changed()
            return events
        } finally {
            c.disconnect()
        }
    }

    fun markDisconnected(msg: String?) {
        if (connected || error != msg) {
            connected = false
            if (error != "PIN falsch") error = msg
            changed()
        }
    }

    fun resetSession() {
        seq = 0
        firstPoll = true
        state = null
        connected = false
        error = null
        changed()
    }

    /** Befehl an den Mixer (im Hintergrund). */
    fun send(cmd: String, extra: Map<String, Any?> = emptyMap()) {
        val body = JSONObject().put("cmd", cmd)
        extra.forEach { (k, v) -> body.put(k, v) }
        sender.execute {
            try {
                val c = URL("${base()}/api/cmd").openConnection() as HttpURLConnection
                c.connectTimeout = 4000
                c.readTimeout = 5000
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("X-Pin", pin)
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = c.responseCode
                c.disconnect()
                if (code == 401) {
                    error = "PIN falsch"
                    changed()
                }
            } catch (e: Exception) {
                markDisconnected("Befehl nicht angekommen")
            }
        }
    }

    /** Prüft, ob unter host:port ein AI-DJ läuft (ohne PIN). */
    fun hello(h: String, p: Int): Boolean = try {
        val c = URL("http://$h:$p/api/hello").openConnection() as HttpURLConnection
        c.connectTimeout = 2500
        c.readTimeout = 2500
        val ok = c.responseCode == 200 && c.inputStream.bufferedReader().readText().contains("AI-DJ")
        c.disconnect()
        ok
    } catch (e: Exception) {
        false
    }

    /** Sucht AI-DJ-PCs im WLAN (UDP-Broadcast, ca. 1,5 s). Blockiert – nicht im UI-Thread aufrufen. */
    fun discover(): List<Found> {
        val found = linkedMapOf<String, Found>()
        try {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 400
                val msg = "AIDJ?".toByteArray()
                sock.send(DatagramPacket(msg, msg.size, InetAddress.getByName("255.255.255.255"), 7778))
                val until = System.currentTimeMillis() + 1500
                val buf = ByteArray(256)
                while (System.currentTimeMillis() < until) {
                    try {
                        val pkt = DatagramPacket(buf, buf.size)
                        sock.receive(pkt)
                        val text = String(pkt.data, 0, pkt.length).trim()
                        val parts = text.split(" ", limit = 3)
                        if (parts.size >= 2 && parts[0] == "AIDJ") {
                            val h = pkt.address.hostAddress ?: continue
                            found[h] = Found(h, parts[1].toIntOrNull() ?: 7777, parts.getOrElse(2) { "PC" })
                        }
                    } catch (_: SocketTimeoutException) {
                        sock.send(DatagramPacket(msg, msg.size, InetAddress.getByName("255.255.255.255"), 7778))
                    }
                }
            }
        } catch (_: Exception) {
        }
        return found.values.toList()
    }
}
