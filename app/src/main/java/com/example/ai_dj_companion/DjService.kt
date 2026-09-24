package com.example.ai_dj_companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Hält die Verbindung zum Mixer auch im Hintergrund (Vordergrund-Dienst mit kleiner
 * "Verbunden"-Benachrichtigung). Kommt vom PC die Playlist-Warnung, erscheint sie als richtige
 * Benachrichtigung – das ist der "Push", ganz ohne Cloud, direkt über das Heimnetz.
 */
class DjService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    private var lastOngoing = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stop()
            return START_NOT_STICKY
        }
        createChannels(this)
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        ServiceCompat.startForeground(this, ONGOING_ID, ongoing("Verbinde mit ${DjRepo.host} …"), type)
        if (!running) {
            running = true
            worker = Thread({ loop() }, "aidj-poll").apply { start() }
        }
        return START_STICKY
    }

    private fun loop() {
        DjRepo.resetSession()
        var backoff = 1000L
        while (running) {
            try {
                val events = DjRepo.pollOnce(25)
                backoff = 1000L
                for (e in events) handleEvent(e)
                updateOngoing()
            } catch (e: Exception) {
                if (!running) break
                DjRepo.markDisconnected(if (DjRepo.error == "PIN falsch") "PIN falsch" else "PC nicht erreichbar – versuche erneut …")
                updateOngoing()
                try {
                    Thread.sleep(backoff)
                } catch (_: InterruptedException) {
                    break
                }
                backoff = (backoff * 2).coerceAtMost(15000L)
            }
        }
    }

    private fun handleEvent(e: org.json.JSONObject) {
        when (e.optString("type")) {
            "playlistLow" -> {
                val text = e.optString("text", "Playlist fast vorbei")
                val n = NotificationCompat.Builder(this, CH_ALERT)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("AI-DJ: Playlist fast vorbei")
                    .setContentText(text)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setAutoCancel(true)
                    .setContentIntent(openApp())
                    .build()
                notifySafe(ALERT_ID + e.optInt("remaining", 0), n)
            }
        }
    }

    private fun updateOngoing() {
        val s = DjRepo.state
        val text = when {
            !DjRepo.connected -> DjRepo.error ?: "Nicht verbunden"
            s?.optJSONObject("now") != null -> {
                val now = s.optJSONObject("now")!!
                "▶ ${now.optString("title")} · noch ${s.optInt("remaining")} in der Queue"
            }
            else -> "Verbunden mit ${DjRepo.host}"
        }
        if (text != lastOngoing) {
            lastOngoing = text
            notifySafe(ONGOING_ID, ongoing(text))
        }
    }

    private fun ongoing(text: String): Notification {
        val stop = PendingIntent.getService(this, 1, Intent(this, DjService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CH_ONGOING)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("AI-DJ Companion")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .addAction(0, "Trennen", stop)
            .build()
    }

    private fun openApp() = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notifySafe(id: Int, n: Notification) {
        try {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(id, n)
        } catch (_: SecurityException) {
            // Benachrichtigungen nicht erlaubt
        }
    }

    private fun stop() {
        running = false
        worker?.interrupt()
        DjRepo.markDisconnected("Getrennt")
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "stop"
        private const val CH_ONGOING = "verbindung"
        private const val CH_ALERT = "warnung"
        private const val ONGOING_ID = 1
        private const val ALERT_ID = 100

        fun createChannels(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CH_ONGOING, "Verbindung zum PC", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(
                NotificationChannel(CH_ALERT, "Warnungen (Playlist fast vorbei)", NotificationManager.IMPORTANCE_HIGH).apply {
                    enableVibration(true)
                },
            )
        }

        fun start(ctx: Context) {
            val i = Intent(ctx, DjService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, DjService::class.java).setAction(ACTION_STOP))
        }
    }
}
