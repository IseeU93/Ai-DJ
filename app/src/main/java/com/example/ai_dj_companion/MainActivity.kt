package com.example.ai_dj_companion

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.addCallback
import com.google.android.material.button.MaterialButtonToggleGroup
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.switchmaterial.SwitchMaterial
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private val listener: () -> Unit = { render() }
    private var userDragsVolume = false
    private var wishSentAt = 0L
    private var mixerVisible = false
    private var syncedThisStart = false
    private var engineTest = false
    private var suppressSwitch = false

    private val v by lazy { Views(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        DjRepo.load(this)
        DjService.createChannels(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        v.editHost.setText(if (DjRepo.host.isNotBlank()) "${DjRepo.host}:${DjRepo.port}" else "")
        v.editPin.setText(DjRepo.pin)
        v.btnConnect.setOnClickListener { connectFromFields() }
        v.btnSearch.setOnClickListener { search() }
        v.btnDisconnect.setOnClickListener {
            if (DjRepo.selfMode) {
                showMixer(true)
            } else {
                DjService.stop(this)
                showConnect(true)
            }
        }
        v.btnMixerBack.setOnClickListener { showMixer(false) }
        onBackPressedDispatcher.addCallback(this) {
            if (mixerVisible) showMixer(false) else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }
        v.btnSync.setOnClickListener { SyncManager.start(this, "Knopf") }
        // Modus-Umschalter (oben im Verbinden- und im Steuer-Bildschirm)
        for ((group, self) in listOf(v.modeGroupA to R.id.modeSelfA, v.modeGroupB to R.id.modeSelfB)) {
            group.addOnButtonCheckedListener { _: MaterialButtonToggleGroup, id: Int, checked: Boolean ->
                if (!checked) return@addOnButtonCheckedListener
                val m = if (id == self) "self" else "companion"
                if (m != DjRepo.mode) {
                    DjRepo.mode = m
                    DjRepo.save(this)
                    applyMode()
                }
            }
        }

        v.btnPlay.setOnClickListener { DjRepo.send("togglePlay") }
        v.btnMixNow.setOnClickListener { DjRepo.send("mixNow") }
        v.btnExtend.setOnClickListener { DjRepo.send("extend") }
        v.btnReorder.setOnClickListener { DjRepo.send("reorder") }
        v.btnReshuffle.setOnClickListener { DjRepo.send("reshuffle") }
        v.btnLaser.setOnClickListener { DjRepo.send("laser") }
        v.btnBlackout.setOnClickListener { DjRepo.send("blackout") }
        v.btnUp.setOnClickListener {
            DjRepo.send("rate", mapOf("verdict" to "up"))
            v.rateRow.visibility = View.GONE
        }
        v.btnDown.setOnClickListener { askReason() }
        v.trickUp.setOnClickListener {
            DjRepo.send("rateTrick", mapOf("verdict" to "up"))
            v.trickRow.visibility = View.GONE
        }
        v.trickDown.setOnClickListener {
            DjRepo.send("rateTrick", mapOf("verdict" to "down"))
            v.trickRow.visibility = View.GONE
        }
        v.laserUp.setOnClickListener { DjRepo.send("rateLaser", mapOf("verdict" to "up")) }
        v.laserDown.setOnClickListener { askLaserReason() }
        v.btnPlaylists.setOnClickListener { pickPlaylists() }
        v.orderUp.setOnClickListener {
            DjRepo.send("rateOrder", mapOf("verdict" to "up"))
            v.orderRow.visibility = View.GONE
        }
        v.orderDown.setOnClickListener {
            val keys = arrayOf("energy", "style", "tempo")
            val labels = arrayOf("Energie passt nicht", "Stil passt nicht", "Tempo-Sprung")
            AlertDialog.Builder(this)
                .setTitle("Warum passte der Song nicht?")
                .setItems(labels) { _, which ->
                    DjRepo.send("rateOrder", mapOf("verdict" to "down", "reason" to keys[which]))
                    v.orderRow.visibility = View.GONE
                }
                .show()
        }
        v.btnPlGenre.setOnClickListener { pickPlaylistGenre() }

        // Musikwunsch: Text oder Schnellknopf -> passende Songs kommen als Nächstes
        val sendWish = { text: String ->
            if (text.isNotBlank()) {
                DjRepo.send("wish", mapOf("text" to text))
                v.wishResult.visibility = View.VISIBLE
                v.wishResult.setTextColor(getColor(R.color.muted))
                v.wishResult.text = "Wunsch gesendet: \u201E$text\u201C …"
                wishSentAt = System.currentTimeMillis()
            }
        }
        v.wishSend.setOnClickListener {
            sendWish(v.wishInput.text.toString())
            v.wishInput.text.clear()
            hideKeyboard()
        }
        v.wishInput.setOnEditorActionListener { _, _, _ ->
            sendWish(v.wishInput.text.toString())
            v.wishInput.text.clear()
            hideKeyboard()
            true
        }
        for ((id, text) in listOf(
            R.id.wParty to "Party", R.id.wRuhig to "ruhig", R.id.wHaerter to "härter", R.id.wWeicher to "weicher",
            R.id.wSchneller to "schneller", R.id.wLangsamer to "langsamer", R.id.wHiphop to "Hip-Hop",
            R.id.wHouse to "House", R.id.wSchlager to "Schlager", R.id.wHardstyle to "Hardstyle",
        )) findViewById<View>(id).setOnClickListener { sendWish(text) }
        v.wishUndo.setOnClickListener { DjRepo.send("undoWish") }

        bindSwitch(v.swAutomix, "automix")
        bindSwitch(v.swAutopilot, "autopilot")
        bindSwitch(v.swFreestyle, "freestyle")
        v.seekMaster.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, p: Int, fromUser: Boolean) {
                if (fromUser) DjRepo.send("master", mapOf("value" to p / 100.0))
            }
            override fun onStartTrackingTouch(s: SeekBar?) { userDragsVolume = true }
            override fun onStopTrackingTouch(s: SeekBar?) { userDragsVolume = false }
        })

        // Test per adb: am start … --es mode self [--ez engineTest true]
        intent?.getStringExtra("mode")?.let { if (it == "self" || it == "companion") DjRepo.mode = it }
        engineTest = intent?.getBooleanExtra("engineTest", false) == true
        applyMode()
    }

    override fun onResume() {
        super.onResume()
        // aus den Einstellungen zurück (Speicher-Zugriff erteilt?) -> Mixer starten
        if (DjRepo.selfMode && !SelfEngine.running && hasStorage()) startEngine()
    }

    override fun onDestroy() {
        if (isFinishing) SelfEngine.stop()
        super.onDestroy()
    }

    // ------------------------------------------------------------ Modus

    private fun syncToggles() {
        val self = DjRepo.selfMode
        v.modeGroupA.check(if (self) R.id.modeSelfA else R.id.modeCompanionA)
        v.modeGroupB.check(if (self) R.id.modeSelfB else R.id.modeCompanionB)
    }

    /** Companion: PC steuern. Selbst: Mixer läuft auf dem Handy mit den Tracks in Musik/Automix. */
    private fun applyMode() {
        syncToggles()
        if (DjRepo.selfMode) {
            DjService.stop(this)
            DjRepo.resetSession()
            showConnect(false)
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (hasStorage() || engineTest) startEngine() else askStorage()
        } else {
            showMixer(false)
            SelfEngine.stop()
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            DjRepo.resetSession()
            if (DjRepo.configured) {
                DjService.start(this)
                showConnect(false)
            } else {
                showConnect(true)
            }
        }
        render()
    }

    private fun startEngine() {
        SelfEngine.start(this, v.engineHost)
        // mit dem PC abgleichen, wenn er erreichbar ist (einmal pro Start)
        if (!syncedThisStart && DjRepo.configured) {
            syncedThisStart = true
            SyncManager.start(this, "Selbst-Modus")
        }
    }

    private fun hasStorage(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private fun askStorage() {
        AlertDialog.Builder(this)
            .setTitle("Zugriff auf deine Musik")
            .setMessage("Im Selbst-Modus spielt der Mixer die Tracks aus „Musik/Automix“ auf diesem Handy. Dafür braucht die App Zugriff auf Dateien (auch zum Abgleich mit dem PC). Bitte im nächsten Bildschirm erlauben.")
            .setPositiveButton("Erlauben") { _, _ ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                } else {
                    requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 2)
                }
            }
            .setNegativeButton("Zurück zum PC") { _, _ ->
                DjRepo.mode = "companion"
                DjRepo.save(this)
                applyMode()
            }
            .show()
    }

    /** Volle Mixer-Oberfläche (wie am PC) anzeigen – z. B. für die Bibliothek. */
    private fun showMixer(on: Boolean) {
        mixerVisible = on && SelfEngine.running
        v.controlView.visibility = if (mixerVisible || v.connectView.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        v.btnMixerBack.visibility = if (mixerVisible) View.VISIBLE else View.GONE
        if (!mixerVisible && v.connectView.visibility != View.VISIBLE) v.controlView.visibility = View.VISIBLE
    }

    override fun onStart() {
        super.onStart()
        DjRepo.addListener(listener)
        render()
    }

    override fun onStop() {
        DjRepo.removeListener(listener)
        super.onStop()
    }

    // ------------------------------------------------------------ Verbinden

    private fun showConnect(on: Boolean) {
        v.connectView.visibility = if (on) View.VISIBLE else View.GONE
        v.controlView.visibility = if (on) View.GONE else View.VISIBLE
    }

    private fun parseHost(text: String): Pair<String, Int>? {
        val t = text.trim().removePrefix("http://").trimEnd('/')
        if (t.isBlank()) return null
        val parts = t.split(":")
        return parts[0] to (parts.getOrNull(1)?.toIntOrNull() ?: 7777)
    }

    private fun connectFromFields() {
        val hp = parseHost(v.editHost.text.toString())
        val pin = v.editPin.text.toString().trim()
        if (hp == null) return status("Bitte Adresse eingeben (steht im Mixer unter „Handy“)")
        if (pin.length != 4) return status("Die PIN hat 4 Ziffern")
        status("Verbinde …")
        v.btnConnect.isEnabled = false
        Thread {
            val ok = DjRepo.hello(hp.first, hp.second)
            runOnUiThread {
                v.btnConnect.isEnabled = true
                if (!ok) {
                    status("Kein AI-DJ unter ${hp.first}:${hp.second} gefunden. Läuft der Mixer? Gleiches WLAN? Windows-Firewall erlaubt?")
                    return@runOnUiThread
                }
                DjRepo.host = hp.first
                DjRepo.port = hp.second
                DjRepo.pin = pin
                DjRepo.save(this)
                status("")
                DjService.stop(this)
                v.root.postDelayed({ DjService.start(this) }, 300)
                showConnect(false)
            }
        }.start()
    }

    private fun search() {
        status("Suche im WLAN …")
        v.foundList.removeAllViews()
        Thread {
            val found = DjRepo.discover()
            runOnUiThread {
                if (found.isEmpty()) {
                    status("Nichts gefunden – Adresse bitte von Hand eingeben (Mixer → „Handy“).")
                    return@runOnUiThread
                }
                status("")
                for (f in found) {
                    val row = TextView(this).apply {
                        text = "🖥  ${f.name}   ${f.host}:${f.port}"
                        setTextColor(getColor(R.color.text))
                        textSize = 16f
                        setPadding(24, 28, 24, 28)
                        setBackgroundResource(R.drawable.card)
                        setOnClickListener {
                            v.editHost.setText("${f.host}:${f.port}")
                            v.editPin.requestFocus()
                        }
                    }
                    v.foundList.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12 })
                }
            }
        }.start()
    }

    private fun status(s: String) {
        v.connectStatus.text = s
    }

    // ------------------------------------------------------------ Anzeige

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(v.wishInput.windowToken, 0)
        v.wishInput.clearFocus()
    }

    private fun render() {
        if (v.connectView.visibility == View.VISIBLE) {
            if (DjRepo.error == "PIN falsch") status("PIN falsch – bitte im Mixer unter „Handy“ nachsehen")
            return
        }
        if (DjRepo.error == "PIN falsch") {
            DjService.stop(this)
            showConnect(true)
            status("PIN falsch – bitte im Mixer unter „Handy“ nachsehen")
            return
        }
        v.connDot.text = when {
            DjRepo.selfMode && DjRepo.connected -> "● Selbst-Modus · Musik aus „Musik/Automix“"
            DjRepo.selfMode -> "○ ${DjRepo.error ?: "Mixer startet …"}"
            DjRepo.connected -> "● verbunden mit ${DjRepo.host}"
            else -> "○ ${DjRepo.error ?: "verbinde …"}"
        }
        v.connDot.setTextColor(getColor(if (DjRepo.connected) R.color.ok else R.color.warn))
        v.btnDisconnect.text = if (DjRepo.selfMode) "Mixer-Ansicht" else "Trennen"
        v.syncCard.visibility = if (DjRepo.configured) View.VISIBLE else View.GONE
        v.syncStatus.text = SyncManager.status.ifBlank {
            if (DjRepo.selfMode) "Bewertungen und Tracks werden mit dem PC (${DjRepo.host}) abgeglichen, sobald er erreichbar ist."
            else "Beim Verbinden werden Bewertungen und Tracks automatisch abgeglichen."
        }
        v.btnSync.isEnabled = !SyncManager.running
        v.btnSync.text = if (SyncManager.running) "Gleiche ab …" else "Jetzt abgleichen (Bewertungen + Tracks)"
        val s = DjRepo.state ?: return

        val now = s.optJSONObject("now")
        if (now != null) {
            v.nowLabel.text = "LÄUFT GERADE · DECK ${now.optString("deck")}" + if (now.optBoolean("playing")) "" else " · PAUSE"
            v.nowTitle.text = now.optString("title")
            v.nowMeta.text = meta(now)
            val dur = now.optInt("dur", 0)
            val pos = now.optInt("pos", 0)
            v.nowProgress.progress = if (dur > 0) (pos * 1000 / dur) else 0
            v.nowTime.text = "${time(pos)} / ${time(dur)}   noch ${time(dur - pos)}"
        } else {
            v.nowLabel.text = "LÄUFT GERADE"
            v.nowTitle.text = "Nichts läuft"
            v.nowMeta.text = ""
            v.nowProgress.progress = 0
            v.nowTime.text = ""
        }

        val plan = s.optJSONObject("plan")
        val next = s.optJSONObject("next")
        v.planText.text = when {
            plan == null -> if (next != null) "wird geplant …" else "kein weiterer Track"
            plan.optBoolean("committed") -> "läuft: ${plan.optString("label")}"
            plan.has("inSec") && !plan.isNull("inSec") ->
                "${plan.optString("label")} · in ${time(plan.optInt("inSec"))}" + if (plan.optBoolean("extended")) " (verlängert)" else ""
            else -> plan.optString("label")
        }
        v.nextText.text = if (next != null) "→ ${next.optString("title")}  ${meta(next)}" else ""

        val last = s.optJSONObject("lastTransition")
        v.rateRow.visibility = if (last != null) View.VISIBLE else View.GONE
        if (last != null) v.rateText.text = "Wie war: ${last.optString("label")}?"
        v.learnedText.text = s.optString("learned")

        val pair = s.optJSONObject("lastPair")
        v.orderRow.visibility = if (pair != null) View.VISIBLE else View.GONE
        if (pair != null) v.orderText.text = "Reihenfolge: ${pair.optString("title")} – passte?"

        // Musikwunsch: Karte zeigen, Rückmeldung vom Mixer (was verstanden wurde)
        v.wishCard.visibility = View.VISIBLE
        val wish = s.optJSONObject("lastWish")
        if (wish != null && wishSentAt > 0 && wish.optLong("at") >= wishSentAt - 5_000) {
            v.wishResult.visibility = View.VISIBLE
            v.wishResult.text = wish.optString("message")
            v.wishResult.setTextColor(getColor(if (wish.optBoolean("ok")) R.color.ok else R.color.warn))
            v.wishUndo.visibility = if (wish.optBoolean("canUndo")) View.VISIBLE else View.GONE
        }

        val trick = s.optJSONObject("lastTrick")
        v.trickRow.visibility = if (trick != null) View.VISIBLE else View.GONE
        if (trick != null) v.trickText.text = if (trick.optString("kind") == "teaser") "Teaser vom nächsten Track – gut?" else "Freestyle: ${trick.optString("name")} – gut?"

        val laserOn = (s.optJSONObject("flags")?.optString("laser", "off") ?: "off") != "off"
        val effect = s.optString("laserEffect", "")
        v.laserRateRow.visibility = if (laserOn && effect.isNotBlank() && effect != "null") View.VISIBLE else View.GONE
        v.laserText.text = "Laser: $effect"

        val remaining = s.optInt("remaining", 99)
        v.warnBanner.visibility = if (remaining in 1..10) View.VISIBLE else View.GONE
        v.warnBanner.text = if (remaining == 1) "⚠ Nur noch 1 Song in der Queue!" else "⚠ Nur noch $remaining Songs – Playlist fast vorbei"

        val f = s.optJSONObject("flags") ?: JSONObject()
        suppressSwitch = true
        v.swAutomix.isChecked = f.optBoolean("automix")
        v.swAutopilot.isChecked = f.optBoolean("autopilot")
        v.swFreestyle.isChecked = f.optBoolean("freestyle")
        suppressSwitch = false
        v.btnLaser.text = if (f.optString("laser", "off") == "off") "Lasershow an" else "Lasershow aus"
        v.btnBlackout.setTextColor(getColor(if (f.optBoolean("blackout")) R.color.warn else R.color.text))
        if (!userDragsVolume) v.seekMaster.progress = (s.optDouble("master", 1.0) * 100).toInt()

        val pl = s.optJSONObject("playlists")
        v.plCard.visibility = if (pl != null && (pl.optJSONArray("items")?.length() ?: 0) > 1) View.VISIBLE else View.GONE
        if (pl != null) {
            v.plSummary.text = pl.optString("label")
            val g = pl.optString("genre", "auto")
            v.btnPlGenre.text = "Richtung: " + (GENRES[g] ?: "Auto")
        }

        renderQueue(s)
    }

    /** Playlists (Unterordner) an-/abwählen – wie oben im Mixer, mit Alle/Keine und Übernehmen. */
    private fun pickPlaylists() {
        val items = DjRepo.state?.optJSONObject("playlists")?.optJSONArray("items") ?: return
        val names = Array(items.length()) { items.getJSONObject(it).optString("name") }
        val labels = Array(items.length()) {
            val o = items.getJSONObject(it)
            "${o.optString("label")}  (${o.optInt("count")})"
        }
        val checked = BooleanArray(items.length()) { items.getJSONObject(it).optBoolean("selected") }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Playlists")
            .setMultiChoiceItems(labels, checked) { _, which, on -> checked[which] = on }
            .setPositiveButton("Übernehmen") { _, _ ->
                val pick = names.filterIndexed { i, _ -> checked[i] }
                if (pick.isEmpty()) {
                    android.widget.Toast.makeText(this, "Mindestens eine Playlist anhaken", android.widget.Toast.LENGTH_SHORT).show()
                } else {
                    DjRepo.send("setPlaylists", mapOf("names" to org.json.JSONArray(pick)))
                }
            }
            .setNeutralButton("Alle / Keine", null)
            .setNegativeButton("Abbrechen", null)
            .create()
        dialog.setOnShowListener {
            // "Alle / Keine" schaltet um, ohne den Dialog zu schließen
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                val all = !checked.all { it }
                for (i in checked.indices) {
                    checked[i] = all
                    dialog.listView.setItemChecked(i, all)
                }
            }
        }
        dialog.show()
    }

    private fun pickPlaylistGenre() {
        val keys = arrayOf("auto") + GENRES.keys.toTypedArray()
        val labels = arrayOf("Auto (erkennen)") + GENRES.values.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Musikrichtung der gewählten Playlists")
            .setItems(labels) { _, which -> DjRepo.send("setPlaylistGenre", mapOf("genre" to keys[which])) }
            .show()
    }

    private fun renderQueue(s: JSONObject) {
        val q = s.optJSONArray("queue") ?: return
        val editableFrom = s.optInt("editableFrom", 0)
        v.queueTitle.text = "Queue · ${s.optInt("remaining")} übrig"
        v.queueList.removeAllViews()
        for (k in 0 until q.length()) {
            val t = q.optJSONObject(k) ?: continue
            val index = t.optInt("i")
            val current = t.optBoolean("current")
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(20, 22, 20, 22)
                setBackgroundResource(R.drawable.card)
            }
            val num = TextView(this).apply {
                text = if (current) "▶" else "${index - s.optJSONArray("queue")!!.optJSONObject(0).optInt("i")}"
                setTextColor(getColor(if (current) R.color.accent else R.color.faint))
                typeface = Typeface.MONOSPACE
                width = 70
            }
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            col.addView(TextView(this).apply {
                text = t.optString("title")
                setTextColor(getColor(if (current) R.color.accent else R.color.text))
                textSize = 15f
                maxLines = 1
            })
            col.addView(TextView(this).apply {
                text = listOf(t.optString("artist"), meta(t)).filter { it.isNotBlank() }.joinToString(" · ")
                setTextColor(getColor(R.color.muted))
                textSize = 12f
                maxLines = 1
            })
            row.addView(num)
            row.addView(col, LinearLayout.LayoutParams(0, -2, 1f))
            if (index >= editableFrom && !current) row.setOnClickListener { queueMenu(index, t.optString("title"), editableFrom) }
            v.queueList.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 6 })
        }
    }

    private fun queueMenu(index: Int, title: String, editableFrom: Int) {
        val items = arrayOf("Als Nächstes spielen", "Nach oben", "Nach unten", "Aus der Queue entfernen")
        AlertDialog.Builder(this)
            .setTitle(title)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> DjRepo.send("playNext", mapOf("index" to index))
                    1 -> if (index > editableFrom) DjRepo.send("move", mapOf("from" to index, "to" to index - 1))
                    2 -> DjRepo.send("move", mapOf("from" to index, "to" to index + 1))
                    3 -> DjRepo.send("remove", mapOf("index" to index))
                }
            }
            .show()
    }

    private fun askReason() {
        val keys = arrayOf("early", "late", "hard", "long", "short", "vocals", "offbeat", "mismatch")
        val labels = arrayOf("zu früh", "zu spät", "zu hart", "zu lang", "zu kurz", "Gesang überlappt", "nicht im Takt", "passt nicht zusammen")
        AlertDialog.Builder(this)
            .setTitle("Was war nicht gut?")
            .setItems(labels) { _, which ->
                DjRepo.send("rate", mapOf("verdict" to "down", "reason" to keys[which]))
                v.rateRow.visibility = View.GONE
            }
            .show()
    }

    private fun askLaserReason() {
        val keys = arrayOf("hectic", "boring", "mismatch")
        val labels = arrayOf("zu hektisch", "zu langweilig", "passt nicht zur Musik")
        AlertDialog.Builder(this)
            .setTitle("Was stört am Laser-Effekt?")
            .setItems(labels) { _, which -> DjRepo.send("rateLaser", mapOf("verdict" to "down", "reason" to keys[which])) }
            .show()
    }

    private fun bindSwitch(sw: SwitchMaterial, cmd: String) {
        sw.setOnCheckedChangeListener { _, on -> if (!suppressSwitch) DjRepo.send(cmd, mapOf("on" to on)) }
    }

    private fun meta(t: JSONObject): String {
        val parts = mutableListOf<String>()
        if (t.has("bpm") && !t.isNull("bpm")) parts.add("${t.optDouble("bpm").toInt()} BPM")
        if (t.has("key") && !t.isNull("key")) parts.add(t.optString("key"))
        if (t.has("genre") && !t.isNull("genre")) parts.add(GENRES[t.optString("genre")] ?: t.optString("genre"))
        return parts.joinToString(" · ")
    }

    private fun time(sec: Int): String {
        val s = sec.coerceAtLeast(0)
        return "%d:%02d".format(s / 60, s % 60)
    }

    companion object {
        val GENRES = mapOf("pop" to "Pop", "rap" to "Rap", "edm" to "House/EDM", "hardstyle" to "Hardstyle", "uptempo" to "Uptempo")
    }

    /** Alle Views an einem Ort. */
    private class Views(a: AppCompatActivity) {
        val root: View = a.findViewById(R.id.root)
        val connectView: View = a.findViewById(R.id.connectView)
        val controlView: View = a.findViewById(R.id.controlView)
        val editHost: EditText = a.findViewById(R.id.editHost)
        val editPin: EditText = a.findViewById(R.id.editPin)
        val btnConnect: MaterialButton = a.findViewById(R.id.btnConnect)
        val btnSearch: MaterialButton = a.findViewById(R.id.btnSearch)
        val foundList: LinearLayout = a.findViewById(R.id.foundList)
        val connectStatus: TextView = a.findViewById(R.id.connectStatus)
        val connDot: TextView = a.findViewById(R.id.connDot)
        val btnDisconnect: TextView = a.findViewById(R.id.btnDisconnect)
        val warnBanner: TextView = a.findViewById(R.id.warnBanner)
        val nowLabel: TextView = a.findViewById(R.id.nowLabel)
        val nowTitle: TextView = a.findViewById(R.id.nowTitle)
        val nowMeta: TextView = a.findViewById(R.id.nowMeta)
        val nowProgress: ProgressBar = a.findViewById(R.id.nowProgress)
        val nowTime: TextView = a.findViewById(R.id.nowTime)
        val btnPlay: MaterialButton = a.findViewById(R.id.btnPlay)
        val btnMixNow: MaterialButton = a.findViewById(R.id.btnMixNow)
        val btnExtend: MaterialButton = a.findViewById(R.id.btnExtend)
        val planText: TextView = a.findViewById(R.id.planText)
        val nextText: TextView = a.findViewById(R.id.nextText)
        val rateRow: View = a.findViewById(R.id.rateRow)
        val rateText: TextView = a.findViewById(R.id.rateText)
        val btnUp: MaterialButton = a.findViewById(R.id.btnUp)
        val btnDown: MaterialButton = a.findViewById(R.id.btnDown)
        val learnedText: TextView = a.findViewById(R.id.learnedText)
        val plCard: View = a.findViewById(R.id.plCard)
        val orderRow: View = a.findViewById(R.id.orderRow)
        val orderText: TextView = a.findViewById(R.id.orderText)
        val orderUp: MaterialButton = a.findViewById(R.id.orderUp)
        val orderDown: MaterialButton = a.findViewById(R.id.orderDown)
        val plSummary: TextView = a.findViewById(R.id.plSummary)
        val btnPlaylists: MaterialButton = a.findViewById(R.id.btnPlaylists)
        val btnPlGenre: MaterialButton = a.findViewById(R.id.btnPlGenre)
        val trickRow: View = a.findViewById(R.id.trickRow)
        val trickText: TextView = a.findViewById(R.id.trickText)
        val trickUp: MaterialButton = a.findViewById(R.id.trickUp)
        val trickDown: MaterialButton = a.findViewById(R.id.trickDown)
        val laserRateRow: View = a.findViewById(R.id.laserRateRow)
        val laserText: TextView = a.findViewById(R.id.laserText)
        val laserUp: MaterialButton = a.findViewById(R.id.laserRateUp)
        val laserDown: MaterialButton = a.findViewById(R.id.laserRateDown)
        val swAutomix: SwitchMaterial = a.findViewById(R.id.swAutomix)
        val swAutopilot: SwitchMaterial = a.findViewById(R.id.swAutopilot)
        val swFreestyle: SwitchMaterial = a.findViewById(R.id.swFreestyle)
        val seekMaster: SeekBar = a.findViewById(R.id.seekMaster)
        val btnLaser: MaterialButton = a.findViewById(R.id.btnLaser)
        val btnBlackout: MaterialButton = a.findViewById(R.id.btnBlackout)
        val queueTitle: TextView = a.findViewById(R.id.queueTitle)
        val btnReorder: TextView = a.findViewById(R.id.btnReorder)
        val btnReshuffle: TextView = a.findViewById(R.id.btnReshuffle)
        val queueList: LinearLayout = a.findViewById(R.id.queueList)
        val engineHost: android.widget.FrameLayout = a.findViewById(R.id.engineHost)
        val modeGroupA: MaterialButtonToggleGroup = a.findViewById(R.id.modeGroupA)
        val modeGroupB: MaterialButtonToggleGroup = a.findViewById(R.id.modeGroupB)
        val syncCard: View = a.findViewById(R.id.syncCard)
        val syncStatus: TextView = a.findViewById(R.id.syncStatus)
        val btnSync: MaterialButton = a.findViewById(R.id.btnSync)
        val btnMixerBack: MaterialButton = a.findViewById(R.id.btnMixerBack)
        val wishCard: View = a.findViewById(R.id.wishCard)
        val wishInput: EditText = a.findViewById(R.id.wishInput)
        val wishSend: MaterialButton = a.findViewById(R.id.wishSend)
        val wishResult: TextView = a.findViewById(R.id.wishResult)
        val wishUndo: MaterialButton = a.findViewById(R.id.wishUndo)
    }
}
