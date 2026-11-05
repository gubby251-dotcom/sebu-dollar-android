package com.gubby251.sebudollarai

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Source
import com.google.firebase.messaging.FirebaseMessaging

import org.json.JSONArray
import org.json.JSONObject

import java.lang.ref.WeakReference


class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private var snrListener: ListenerRegistration? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var latestSnrPayload: String? = null

    private val ADMIN_UID =
        "ilhY96UDI3W9n4Qir4v78nu8G9X2"

    companion object {

        private const val TOPIC =
            "sebu_signal_users"

        private const val PREFS =
            "sebu_reliable_signal"

        private const val QUEUE_KEY =
            "pending_signals"

        private var activeInstance:
            WeakReference<MainActivity>? = null


        /*
         * Dipanggil langsung oleh SignalMessagingService.
         *
         * Signal TIDAK divalidasi ulang di sini.
         * Nilai Entry / SL / TP berasal langsung
         * dari scanner/reliable-index.mjs.
         */
        @JvmStatic
        fun receiveNativeSignal(
            data: Map<String, String>
        ) {

            val activity =
                activeInstance?.get()

            if (activity != null) {

                activity.receiveSignalOnUi(
                    data
                )

            } else {

                enqueueSignal(
                    data
                )
            }
        }

        @JvmStatic
        fun receiveNativeSignalStatusUpdate(
            data: Map<String, String>
        ) {
            activeInstance?.get()?.receiveStatusUpdateOnUi(data)
        }


        /*
         * Simpan signal kalau Activity belum hidup.
         */
        private fun enqueueSignal(
            data: Map<String, String>
        ) {

            try {

                val context =
                    AppContextHolder.context
                        ?: return

                val prefs =
                    context.getSharedPreferences(
                        PREFS,
                        Context.MODE_PRIVATE
                    )

                val array =
                    JSONArray(
                        prefs.getString(
                            QUEUE_KEY,
                            "[]"
                        ) ?: "[]"
                    )

                val obj =
                    JSONObject()

                for ((key, value) in data) {
                    obj.put(
                        key,
                        value
                    )
                }

                val key =
                    signalKey(obj)

                /*
                 * Jangan masukkan signal yang sama
                 * dua kali.
                 */
                for (i in 0 until array.length()) {

                    val old =
                        array.optJSONObject(i)

                    if (
                        old != null &&
                        signalKey(old) == key
                    ) {
                        return
                    }
                }

                array.put(obj)

                /*
                 * Simpan maksimal 20 signal.
                 */
                while (array.length() > 20) {
                    array.remove(0)
                }

                prefs.edit()
                    .putString(
                        QUEUE_KEY,
                        array.toString()
                    )
                    .apply()

            } catch (e: Exception) {

                e.printStackTrace()
            }
        }


        private fun signalKey(obj: JSONObject): String {
            val setup = obj.optString("setup", obj.optString("setupNumber"))
            return obj.optString("timeframe") + "_" + setup + "_" +
                obj.optString("type") + "_" + obj.optString("candleTime")
        }
    }


    override fun onCreate(
        savedInstanceState: Bundle?
    ) {

        super.onCreate(
            savedInstanceState
        )

        AppContextHolder.context =
            applicationContext

        activeInstance =
            WeakReference(this)

        auth =
            FirebaseAuth.getInstance()

        firestore =
            FirebaseFirestore.getInstance()

        continueWithCurrentUser()
    }


    override fun onNewIntent(
        intent: Intent?
    ) {

        super.onNewIntent(intent)

        setIntent(intent)

        /*
         * Kalau user membuka APK dari
         * notifikasi FCM, data signal ada
         * di Intent.
         */
        if (intent != null) {

            val signal =
                extractSignalFromIntent(
                    intent
                )

            if (signal.isNotEmpty()) {

                receiveNativeSignal(
                    signal
                )
            }
        }
    }


    private fun continueWithCurrentUser() {

        val user =
            auth.currentUser

        if (user == null) {

            showLoginScreen()

        } else {

            checkMemberAccess(
                user.uid
            )
        }
    }


    private fun showLoginScreen(
        message: String? = null
    ) {

        val scroll =
            ScrollView(this)

        val root =
            LinearLayout(this).apply {

                orientation =
                    LinearLayout.VERTICAL

                gravity =
                    Gravity.CENTER_HORIZONTAL

                setPadding(
                    40,
                    70,
                    40,
                    40
                )

                setBackgroundColor(
                    Color.rgb(
                        18,
                        18,
                        18
                    )
                )
            }


        val title =
            TextView(this).apply {

                text =
                    "SEBU DOLLAR AI"

                textSize =
                    26f

                setTextColor(
                    Color.WHITE
                )

                gravity =
                    Gravity.CENTER
            }


        root.addView(
            title,
            LinearLayout.LayoutParams(
                -1,
                -2
            )
        )


        val subtitle =
            TextView(this).apply {

                text =
                    "Member Access"

                textSize =
                    18f

                setTextColor(
                    Color.LTGRAY
                )

                gravity =
                    Gravity.CENTER

                setPadding(
                    0,
                    10,
                    0,
                    35
                )
            }


        root.addView(
            subtitle,
            LinearLayout.LayoutParams(
                -1,
                -2
            )
        )


        val email =
            EditText(this).apply {

                hint =
                    "Email member"

                textSize =
                    16f

                setSingleLine(true)

                inputType =
                    InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS

                setTextColor(
                    Color.WHITE
                )

                setHintTextColor(
                    Color.GRAY
                )

                setPadding(
                    25,
                    0,
                    25,
                    0
                )
            }


        root.addView(
            email,
            LinearLayout.LayoutParams(
                -1,
                58.dp()
            ).apply {

                bottomMargin =
                    18.dp()
            }
        )


        val password =
            EditText(this).apply {

                hint =
                    "Password"

                textSize =
                    16f

                setSingleLine(true)

                inputType =
                    InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_PASSWORD

                setTextColor(
                    Color.WHITE
                )

                setHintTextColor(
                    Color.GRAY
                )

                setPadding(
                    25,
                    0,
                    25,
                    0
                )
            }


        root.addView(
            password,
            LinearLayout.LayoutParams(
                -1,
                58.dp()
            ).apply {

                bottomMargin =
                    18.dp()
            }
        )


        val button =
            Button(this).apply {

                text =
                    "LOGIN"

                textSize =
                    15f

                isAllCaps =
                    false
            }


        root.addView(
            button,
            LinearLayout.LayoutParams(
                -1,
                58.dp()
            ).apply {

                bottomMargin =
                    18.dp()
            }
        )


        val info =
            TextView(this).apply {

                text =
                    message
                        ?: "Gunakan email dan password yang diberikan admin."

                textSize =
                    14f

                setTextColor(
                    Color.LTGRAY
                )

                gravity =
                    Gravity.CENTER

                setPadding(
                    10,
                    10,
                    10,
                    10
                )
            }


        root.addView(
            info,
            LinearLayout.LayoutParams(
                -1,
                -2
            )
        )


        button.setOnClickListener {

            val address =
                email.text
                    .toString()
                    .trim()

            val pass =
                password.text
                    .toString()


            if (
                address.isEmpty() ||
                !android.util.Patterns.EMAIL_ADDRESS
                    .matcher(address)
                    .matches()
            ) {

                email.error =
                    "Masukkan email yang valid"

                return@setOnClickListener
            }


            if (pass.isEmpty()) {

                password.error =
                    "Password wajib diisi"

                return@setOnClickListener
            }


            button.isEnabled =
                false

            info.text =
                "Memeriksa login..."


            auth
                .signInWithEmailAndPassword(
                    address,
                    pass
                )
                .addOnCompleteListener { task ->

                    if (task.isSuccessful) {

                        val uid =
                            auth.currentUser?.uid

                        if (uid != null) {

                            checkMemberAccess(
                                uid
                            )

                        } else {

                            button.isEnabled =
                                true

                            info.text =
                                "Login gagal: UID tidak ditemukan."
                        }

                    } else {

                        button.isEnabled =
                            true

                        info.text =
                            task.exception
                                ?.localizedMessage
                                ?: "Email atau password salah."

                        Toast.makeText(
                            this,
                            "Login gagal",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
        }


        scroll.addView(
            root
        )

        setContentView(
            scroll
        )
    }


    private fun checkMemberAccess(
        uid: String
    ) {

        if (uid == ADMIN_UID) {
            preparePersistentHistoryBoundary(uid) { enterAi() }
            return
        }


        firestore
            .collection("members")
            .document(uid)
            .get(Source.SERVER)
            .addOnSuccessListener { doc ->

                val status =
                    doc.get("status")
                        ?.toString()
                        ?.trim()

                val active =
                    doc.exists() &&
                    status.equals(
                        "ACTIVE",
                        ignoreCase = true
                    )


                if (active) {
                    preparePersistentHistoryBoundary(uid) { enterAi() }
                } else {

                    FirebaseMessaging
                        .getInstance()
                        .unsubscribeFromTopic(
                            TOPIC
                        )

                    auth.signOut()

                    showLoginScreen(
                        "Akun belum mendapat akses ACTIVE dari admin."
                    )
                }
            }
            .addOnFailureListener { error ->

                FirebaseMessaging
                    .getInstance()
                    .unsubscribeFromTopic(
                        TOPIC
                    )

                auth.signOut()

                showLoginScreen(
                    "Tidak dapat memeriksa akses member.\n" +
                    (
                        error.localizedMessage
                            ?: "Periksa koneksi Firebase."
                    )
                )
            }
    }


    /**
     * Server-persistent history boundary.
     * If app data was cleared, the local marker disappears while this server
     * document remains. Move the boundary forward before opening History.
     */
    private fun preparePersistentHistoryBoundary(uid: String, onReady: () -> Unit) {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val markerKey = "history_boundary_initialized_$uid"
        val boundaryKey = "history_boundary_ms_$uid"

        if (prefs.getBoolean(markerKey, false)) {
            onReady()
            return
        }

        val stateRef = firestore.collection("history_state").document(uid)
        val now = System.currentTimeMillis()
        stateRef.get(Source.SERVER).addOnSuccessListener { doc ->
            val oldBoundary = doc.getLong("boundaryMs") ?: 0L
            val nextBoundary = maxOf(now, oldBoundary)
            stateRef.set(mapOf("boundaryMs" to nextBoundary))
                .addOnSuccessListener {
                    prefs.edit()
                        .putBoolean(markerKey, true)
                        .putLong(boundaryKey, nextBoundary)
                        .apply()
                    onReady()
                }
                .addOnFailureListener { error ->
                    android.util.Log.e("SEBU_HISTORY", "Gagal menyimpan batas riwayat", error)
                    showLoginScreen("Gagal menyiapkan riwayat aman. Periksa koneksi lalu coba login kembali.")
                }
        }.addOnFailureListener { error ->
            android.util.Log.e("SEBU_HISTORY", "Gagal membaca batas riwayat", error)
            showLoginScreen("Gagal memeriksa batas riwayat. Periksa koneksi lalu coba login kembali.")
        }
    }


    private fun enterAi() {

        FirebaseMessaging
            .getInstance()
            .subscribeToTopic(
                TOPIC
            )


        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {

            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.POST_NOTIFICATIONS
                ),
                100
            )
        }


        webView =
            WebView(this)


        setContentView(
            webView
        )


        webView.settings.apply {

            javaScriptEnabled =
                true

            domStorageEnabled =
                true

            // Keep normal HTTP cache between app launches; do not force reloads.
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            databaseEnabled = true

            loadsImagesAutomatically =
                true

            javaScriptCanOpenWindowsAutomatically =
                true

            mediaPlaybackRequiresUserGesture =
                false
        }


        webView.webViewClient =
            object : WebViewClient() {

                override fun onPageFinished(
                    view: WebView?,
                    url: String?
                ) {

                    super.onPageFinished(
                        view,
                        url
                    )

                    /*
                     * Setelah index.html selesai,
                     * kirim semua signal FCM yang
                     * sempat menunggu.
                     */
                    flushPendingSignals()

                    // Sinkronkan riwayat dan SNR M5/H4 setelah halaman siap.
                    syncSignalHistoryFromFirestore()
                    syncMarketSnrFromFirestore()

                    /*
                     * Kalau Activity dibuka melalui
                     * notifikasi, proses Intent juga.
                     */
                    val signal =
                        extractSignalFromIntent(
                            intent
                        )

                    if (signal.isNotEmpty()) {

                        receiveSignalOnUi(
                            signal
                        )
                    }
                }
            }


        webView.addJavascriptInterface(
            HistoryBridge(),
            "SEBUHistory"
        )

        webView.webChromeClient =
            WebChromeClient()


        webView.loadUrl(
            "file:///android_asset/index.html"
        )
    }


    /**
     * Persist the CLEAR HISTORY timestamp in Firestore. This bridge is
     * limited to history cleanup and does not change scanner signal logic.
     */
    private inner class HistoryBridge {
        @JavascriptInterface
        fun saveHistoryClearBoundary(boundaryMs: Long) {
            val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            val stateRef = FirebaseFirestore.getInstance()
                .collection("history_state")
                .document(uid)

            stateRef.get(Source.SERVER)
                .addOnSuccessListener { doc ->
                    val nextBoundary = maxOf(
                        boundaryMs,
                        doc.getLong("boundaryMs") ?: 0L
                    )
                    stateRef.set(
                        mapOf("boundaryMs" to nextBoundary),
                        com.google.firebase.firestore.SetOptions.merge()
                    ).addOnSuccessListener {
                        prefs.edit()
                            .putBoolean("history_boundary_initialized_$uid", true)
                            .putLong("history_boundary_ms_$uid", nextBoundary)
                            .apply()
                        runOnUiThread {
                            if (::webView.isInitialized) {
                                webView.evaluateJavascript(
                                    "if(window.setServerHistoryBoundary) window.setServerHistoryBoundary($nextBoundary);",
                                    null
                                )
                            }
                        }
                    }.addOnFailureListener { error ->
                        android.util.Log.e("SEBU_HISTORY", "Failed to persist CLEAR HISTORY boundary", error)
                    }
                }
                .addOnFailureListener { error ->
                    android.util.Log.e("SEBU_HISTORY", "Failed to read CLEAR HISTORY boundary", error)
                }
        }
    }



    private fun syncMarketSnrFromFirestore() {
        snrListener?.remove()
        snrListener = FirebaseFirestore.getInstance()
            .collection("market_analysis")
            .document("xauusd_snr")
            .addSnapshotListener { doc, error ->
                if (error != null) {
                    android.util.Log.e("SEBU_SNR", "Gagal memantau SNR H4/M5", error)
                    return@addSnapshotListener
                }
                if (doc == null || !doc.exists()) {
                    android.util.Log.w("SEBU_SNR", "Dokumen market_analysis/xauusd_snr belum ada")
                    return@addSnapshotListener
                }
                val payload = JSONObject()
                payload.put("timeframe", doc.getString("timeframe") ?: "M5")
                for (key in listOf("h4Resistance", "h4Support", "m5Resistance", "m5Support")) {
                    val value = doc.get(key)
                    if (value is Number) payload.put(key, value) else payload.put(key, JSONObject.NULL)
                }
                latestSnrPayload = payload.toString()
                deliverMarketSnrToWebView(latestSnrPayload!!, 0)
            }
    }

    private fun deliverMarketSnrToWebView(payload: String, attempt: Int) {
        if (!::webView.isInitialized || isFinishing || isDestroyed) return
        val argument = JSONObject.quote(payload)
        webView.evaluateJavascript(
            "(function(){if(typeof window.updateMarketSnr!=='function')return 'NOT_READY';return window.updateMarketSnr($argument);})();"
        ) { result ->
            val value = result?.trim('"') ?: "NO_RESULT"
            if (value == "NOT_READY" && attempt < 8) {
                mainHandler.postDelayed({ deliverMarketSnrToWebView(payload, attempt + 1) }, 400L)
            } else if (value == "UPDATED") {
                android.util.Log.d("SEBU_SNR", "Empat nilai SNR berhasil dikirim ke WebView")
            } else {
                android.util.Log.w("SEBU_SNR", "Hasil pengiriman SNR ke WebView: $value")
            }
        }
    }

    /*
     * Dipanggil saat signal masuk ketika
     * MainActivity sedang hidup.
     */
    private fun syncSignalHistoryFromFirestore() {
        val currentUser = FirebaseAuth.getInstance().currentUser ?: return
        val db = FirebaseFirestore.getInstance()

        db.collection("sent_signals")
            .get(Source.SERVER)
            .addOnSuccessListener { snapshot ->
                try {
                    val rows = org.json.JSONArray()

                    for (doc in snapshot.documents) {
                        val row = org.json.JSONObject()

                        fun putValue(target: String, vararg candidates: String) {
                            for (candidate in candidates) {
                                val value = doc.get(candidate)
                                if (value != null) {
                                    when (value) {
                                        is com.google.firebase.Timestamp ->
                                            row.put(target, value.toDate().time)
                                        is java.util.Date ->
                                            row.put(target, value.time)
                                        else -> row.put(target, value.toString())
                                    }
                                    return
                                }
                            }
                        }

                        putValue("type", "type")
                        putValue("timeframe", "timeframe")
                        putValue("timeframeMinutes", "timeframeMinutes")
                        putValue("setupNumber", "setupNumber", "setup")
                        putValue("entry", "entry")
                        putValue("sl", "sl")
                        putValue("tp", "tp")
                        // Utamakan status hasil akhir jika tersedia.
                        putValue("status", "resultStatus", "status")
                        putValue("resultStatus", "resultStatus", "status")
                        putValue("candleTime", "candleTime")

                        // Mendukung candleTime yang disimpan sebagai Firestore Timestamp/Date.
                        if (!row.has("candleTime")) {
                            val idPrefix = doc.id.substringBefore("_")
                            idPrefix.toLongOrNull()?.let { row.put("candleTime", it) }
                        }

                        putValue("candleCloseTime", "candleCloseTime")
                        putValue("entryTouched", "entryTouched")
                        putValue("entryTouchedAt", "entryTouchedAt")
                        putValue("closePrice", "closePrice")
                        putValue("closedAt", "closedAt")
                        putValue("statusUpdatedAt", "statusUpdatedAt")
                        putValue("setupName", "setupName")

                        val timeframe = row.optString("timeframe", "").uppercase()
                        if (timeframe != "M5") continue
                        if (!row.has("timeframeMinutes")) row.put("timeframeMinutes", 5)
                        if (row.optInt("timeframeMinutes", 0) != 5) continue

                        if (row.has("type") && row.has("entry") &&
                            row.has("sl") && row.has("tp") &&
                            row.has("candleTime")) {
                            rows.put(row)
                        }
                    }

                    val payload = org.json.JSONObject.quote(rows.toString())
                    val boundary = getSharedPreferences(PREFS, MODE_PRIVATE)
                        .getLong("history_boundary_ms_${currentUser.uid}", 0L)
                    runOnUiThread {
                        val js = "(function(){ if(window.setServerHistoryBoundary) window.setServerHistoryBoundary($boundary); if(window.mergeFirestoreSignalHistory) return window.mergeFirestoreSignalHistory($payload); return 'NOT_READY'; })();"
                        if (::webView.isInitialized) {
                            webView.evaluateJavascript(js, null)
                        }
                    }
                } catch (e: Exception) {
                    android.util.Log.e("SEBU_HISTORY", "Gagal membentuk riwayat Firestore", e)
                }
            }
            .addOnFailureListener { error ->
                android.util.Log.e("SEBU_HISTORY", "Gagal membaca sent_signals untuk ${currentUser.uid}", error)
            }
    }

    private fun receiveStatusUpdateOnUi(data: Map<String, String>) {
        runOnUiThread {
            try {
                if (!::webView.isInitialized) return@runOnUiThread
                val json = JSONObject()
                for ((key, value) in data) json.put(key, value)
                val jsArgument = JSONObject.quote(json.toString())
                webView.evaluateJavascript(
                    """
                    (function() {
                      if (typeof window.receiveNativeSignalStatusUpdate !== 'function') {
                        return 'NOT_READY';
                      }
                      return window.receiveNativeSignalStatusUpdate($jsArgument);
                    })();
                    """.trimIndent(),
                    null
                )
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun receiveSignalOnUi(
        data: Map<String, String>,
        fromQueue: Boolean = false
    ) {

        runOnUiThread {

            try {

                if (!::webView.isInitialized) {
                    if (!fromQueue) enqueueSignal(data)
                    return@runOnUiThread
                }

                val json = JSONObject()
                for ((key, value) in data) {
                    json.put(key, value)
                }

                /*
                 * Jangan hapus signal dari antrean sebelum fungsi
                 * penerima di index.html tersedia dan dipanggil.
                 * Entry, SL, dan TP tetap menggunakan payload scanner.
                 */
                val jsArgument = JSONObject.quote(json.toString())

                webView.evaluateJavascript(
                    """
                    (function() {
                      if (typeof window.receiveNativeSignal !== 'function') {
                        return 'NOT_READY';
                      }
                      const accepted = window.receiveNativeSignal($jsArgument);
                      return (accepted === 'ACCEPTED' || accepted === true)
                        ? 'DELIVERED'
                        : 'NOT_ACCEPTED';
                    })();
                    """.trimIndent()
                ) { result ->
                    if (result == "\"DELIVERED\"") {
                        if (fromQueue) removeQueuedSignal(data)
                    } else if (!fromQueue) {
                        enqueueSignal(data)
                    }
                }

            } catch (e: Exception) {
                e.printStackTrace()
                if (!fromQueue) enqueueSignal(data)
            }
        }
    }


    /*
     * Hapus hanya signal yang sudah dikirim ke fungsi penerima
     * JavaScript; jangan pernah mengosongkan antrean sekaligus.
     */
    private fun removeQueuedSignal(
        data: Map<String, String>
    ) {
        try {
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            val array = JSONArray(
                prefs.getString(QUEUE_KEY, "[]") ?: "[]"
            )
            val target = JSONObject()
            for ((key, value) in data) target.put(key, value)
            val targetKey = signalKey(target)
            val remaining = JSONArray()

            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (signalKey(item) != targetKey) remaining.put(item)
            }

            prefs.edit().putString(QUEUE_KEY, remaining.toString()).apply()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }


    /*
     * Kirim signal tertunda setelah halaman selesai dimuat.
     * Setiap item tetap berada di antrean sampai JavaScript
     * mengonfirmasi penerimaan.
     */
    private fun flushPendingSignals() {
        try {
            val raw = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(QUEUE_KEY, "[]") ?: "[]"
            val array = JSONArray(raw)

            for (i in 0 until array.length()) {
                val obj = array.optJSONObject(i) ?: continue
                val map = mutableMapOf<String, String>()
                val keys = obj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    map[key] = obj.optString(key)
                }
                receiveSignalOnUi(map, true)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }


    /*
     * Ambil data signal dari Intent
     * yang dibawa notification FCM.
     */
    private fun extractSignalFromIntent(
        intent: Intent?
    ): Map<String, String> {

        val result =
            mutableMapOf<String, String>()

        if (intent == null) {
            return result
        }


        val extras =
            intent.extras
                ?: return result


        val keys =
            extras.keySet()

        for (key in keys) {

            val value =
                extras.get(key)

            if (value != null) {

                result[key] =
                    value.toString()
            }
        }


        /*
         * Pastikan ini memang signal scanner.
         */
        val type =
            result["type"]
                ?.uppercase()

        val setup =
            result["setup"]
                ?: result["setupNumber"]

        val timeframe =
            result["timeframe"]


        if (
            type !in listOf(
                "BUY",
                "SELL"
            ) ||
            setup.isNullOrBlank() ||
            timeframe.isNullOrBlank()
        ) {

            result.clear()
        }


        return result
    }


    override fun onSaveInstanceState(
        outState: Bundle
    ) {

        if (
            ::webView.isInitialized
        ) {

            webView.saveState(
                outState
            )
        }


        super.onSaveInstanceState(
            outState
        )
    }


    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.resumeTimers()
            // Reuse an existing TradingView widget; only retry if it did not initialize.
            webView.postDelayed({
                if (::webView.isInitialized && !isFinishing) {
                    webView.evaluateJavascript(
                        "if(typeof updateChart==='function') updateChart();",
                        null
                    )
                    latestSnrPayload?.let { deliverMarketSnrToWebView(it, 0) }
                }
            }, 250L)
        }
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {

        snrListener?.remove()
        snrListener = null
        mainHandler.removeCallbacksAndMessages(null)

        if (
            activeInstance?.get() === this
        ) {

            activeInstance =
                null
        }

        super.onDestroy()
    }


    @Deprecated(
        "Deprecated in Java"
    )
    override fun onBackPressed() {

        if (
            ::webView.isInitialized &&
            webView.canGoBack()
        ) {

            webView.goBack()

        } else {

            super.onBackPressed()
        }
    }


    private fun Int.dp(): Int {

        return (
            this *
            resources.displayMetrics.density
        ).toInt()
    }


    /*
     * Context sederhana untuk FCM service.
     */
    private object AppContextHolder {

        var context: Context? =
            null
    }
}
