package com.gubby251.sebudollarai

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
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
import com.google.firebase.firestore.Source
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        auth = FirebaseAuth.getInstance()
        firestore = FirebaseFirestore.getInstance()

        continueWithCurrentUser()
    }

    private fun continueWithCurrentUser() {

        val user = auth.currentUser

        if (user == null) {
            showLoginScreen()
        } else {
            checkMemberAccess(user.uid)
        }
    }

    private fun showLoginScreen(message: String? = null) {

        val scroll = ScrollView(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(40, 70, 40, 40)
            setBackgroundColor(Color.rgb(18, 18, 18))
        }

        val title = TextView(this).apply {
            text = "SEBU DOLLAR AI"
            textSize = 26f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }

        root.addView(
            title,
            LinearLayout.LayoutParams(-1, -2)
        )

        val subtitle = TextView(this).apply {
            text = "Member Access"
            textSize = 18f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, 10, 0, 35)
        }

        root.addView(
            subtitle,
            LinearLayout.LayoutParams(-1, -2)
        )

        val email = EditText(this).apply {
            hint = "Email member"
            textSize = 16f
            setSingleLine(true)

            inputType =
                InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS

            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setPadding(25, 0, 25, 0)
        }

        root.addView(
            email,
            LinearLayout.LayoutParams(-1, 58.dp()).apply {
                bottomMargin = 18.dp()
            }
        )

        val password = EditText(this).apply {
            hint = "Password"
            textSize = 16f
            setSingleLine(true)

            inputType =
                InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_PASSWORD

            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setPadding(25, 0, 25, 0)
        }

        root.addView(
            password,
            LinearLayout.LayoutParams(-1, 58.dp()).apply {
                bottomMargin = 18.dp()
            }
        )

        val button = Button(this).apply {
            text = "LOGIN"
            textSize = 15f
            isAllCaps = false
        }

        root.addView(
            button,
            LinearLayout.LayoutParams(-1, 58.dp()).apply {
                bottomMargin = 18.dp()
            }
        )

        val info = TextView(this).apply {
            text =
                message
                    ?: "Gunakan email dan password yang diberikan admin."

            textSize = 14f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(10, 10, 10, 10)
        }

        root.addView(
            info,
            LinearLayout.LayoutParams(-1, -2)
        )

        button.setOnClickListener {

            val address = email.text.toString().trim()
            val pass = password.text.toString()

            if (
                address.isEmpty() ||
                !android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()
            ) {
                email.error = "Masukkan email yang valid"
                return@setOnClickListener
            }

            if (pass.isEmpty()) {
                password.error = "Password wajib diisi"
                return@setOnClickListener
            }

            button.isEnabled = false
            info.text = "Memeriksa login..."

            auth.signInWithEmailAndPassword(
                address,
                pass
            ).addOnCompleteListener { task ->

                if (task.isSuccessful) {

                    val uid = auth.currentUser?.uid

                    if (uid != null) {

                        checkMemberAccess(uid)

                    } else {

                        button.isEnabled = true
                        info.text =
                            "Login gagal: UID tidak ditemukan."
                    }

                } else {

                    button.isEnabled = true

                    info.text =
                        task.exception?.localizedMessage
                            ?: "Email atau password salah."

                    Toast.makeText(
                        this,
                        "Login gagal",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        scroll.addView(root)

        setContentView(scroll)
    }

    private fun checkMemberAccess(uid: String) {

        val currentUser = auth.currentUser

        if (currentUser == null) {

            showLoginScreen(
                "Sesi login tidak ditemukan."
            )

            return
        }

        /*
         * Pastikan UID yang dipakai benar-benar UID
         * dari akun Firebase yang sedang login.
         */
        val realUid = currentUser.uid

        if (realUid != uid) {

            FirebaseMessaging
                .getInstance()
                .unsubscribeFromTopic(
                    "sebu_signal_users"
                )

            auth.signOut()

            showLoginScreen(
                "UID akun tidak cocok."
            )

            return
        }

        /*
         * Refresh token Firebase terlebih dahulu.
         * Ini mencegah token lama menyebabkan Firestore
         * membaca akses yang salah.
         */
        currentUser
            .getIdToken(true)
            .addOnCompleteListener { tokenTask ->

                if (!tokenTask.isSuccessful) {

                    FirebaseMessaging
                        .getInstance()
                        .unsubscribeFromTopic(
                            "sebu_signal_users"
                        )

                    auth.signOut()

                    showLoginScreen(
                        "Token Firebase gagal diperbarui."
                    )

                    return@addOnCompleteListener
                }

                readMemberFromServer(realUid)
            }
    }

    private fun readMemberFromServer(uid: String) {

        firestore
            .collection("members")
            .document(uid)
            .get(Source.SERVER)
            .addOnSuccessListener { document ->

                /*
                 * Dokumen benar-benar ada.
                 */
                if (!document.exists()) {

                    FirebaseMessaging
                        .getInstance()
                        .unsubscribeFromTopic(
                            "sebu_signal_users"
                        )

                    auth.signOut()

                    showLoginScreen(
                        "Member belum terdaftar.\n\n" +
                        "UID:\n$uid\n\n" +
                        "Dokumen yang dicari:\n" +
                        "members/$uid"
                    )

                    return@addOnSuccessListener
                }

                /*
                 * Ambil status tanpa bergantung pada tipe
                 * object tertentu.
                 */
                val status =
                    document
                        .get("status")
                        ?.toString()
                        ?.trim()
                        ?.uppercase()

                /*
                 * HANYA ACTIVE yang boleh masuk.
                 */
                if (status == "ACTIVE") {

                    enterAi()

                } else {

                    FirebaseMessaging
                        .getInstance()
                        .unsubscribeFromTopic(
                            "sebu_signal_users"
                        )

                    auth.signOut()

                    showLoginScreen(
                        "Akun belum mendapat akses ACTIVE dari admin.\n\n" +
                        "Status saat ini: " +
                        (status ?: "NULL")
                    )
                }
            }
            .addOnFailureListener { error ->

                /*
                 * Jangan menganggap error sebagai
                 * member tidak ada.
                 *
                 * Tampilkan error sebenarnya agar
                 * penyebab bisa diketahui dengan jelas.
                 */
                FirebaseMessaging
                    .getInstance()
                    .unsubscribeFromTopic(
                        "sebu_signal_users"
                    )

                auth.signOut()

                val detail =
                    error.localizedMessage
                        ?: error.message
                        ?: "Unknown Firestore error."

                showLoginScreen(
                    "Gagal membaca akses member.\n\n" +
                    "UID:\n$uid\n\n" +
                    "Path:\nmembers/$uid\n\n" +
                    "Error:\n$detail"
                )
            }
    }

    private fun enterAi() {

        FirebaseMessaging
            .getInstance()
            .subscribeToTopic(
                "sebu_signal_users"
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

        webView = WebView(this)

        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = true
        webView.settings.mediaPlaybackRequiresUserGesture = false

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        webView.loadUrl(
            "file:///android_asset/index.html"
        )
    }

    override fun onSaveInstanceState(
        outState: Bundle
    ) {

        if (::webView.isInitialized) {
            webView.saveState(outState)
        }

        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Java")
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
}
