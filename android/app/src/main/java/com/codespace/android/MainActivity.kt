package com.codespace.android

import android.app.Activity
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.os.Environment
import android.util.Log
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.view.Gravity
import android.view.KeyEvent
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.webkit.*
import android.widget.*
import android.content.Context
import android.provider.OpenableColumns
import android.provider.MediaStore
import android.provider.Settings
import androidx.documentfile.provider.DocumentFile
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import java.net.URL
import java.net.HttpURLConnection
import java.net.URLConnection
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.errors.GitAPIException
import org.eclipse.jgit.diff.DiffFormatter
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.storage.file.FileRepositoryBuilder
import org.eclipse.jgit.treewalk.filter.PathFilter
import org.eclipse.jgit.util.io.DisabledOutputStream
import org.eclipse.jgit.transport.URIish
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider

class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var workspaceFrame: FrameLayout
    private lateinit var appWeb: WebView
    private lateinit var browserHost: FrameLayout
    private lateinit var address: EditText
    private lateinit var status: TextView
    private lateinit var sandbox: Spinner
    private val browserTabs = mutableListOf<WebView>()
    private var activeTab = 0
    private var bridgeConfigSeeded = false
    private val browserAgentHandler = Handler(Looper.getMainLooper())
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWorkspaceTree = false
    private val prefs by lazy { getSharedPreferences("codespace", MODE_PRIVATE) }
    private val executor = Executors.newFixedThreadPool(4)
    // Dedicated pool for native bridge tool calls so long-running background tasks
    // (build/tests/crawl on `executor`) can never starve them and cause API timeouts.
    private val bridgeExecutor = Executors.newFixedThreadPool(8)
    private val pythonExecutor = Executors.newSingleThreadExecutor()
    private val pythonExecutionLock = Any()
    @Volatile private var pythonReady = false
    @Volatile private var pythonStartupError: String? = null

    // UWB Bridge
    private var uwbBridgeService: UWBBridgeService? = null
    private var uwbServiceBound = false
    private val uwbServiceConnection = object : android.content.ServiceConnection {
        override fun onServiceConnected(name: android.content.ComponentName, service: IBinder) {
            val binder = service as UWBBridgeService.UWBBinder
            uwbBridgeService = binder.getService()
            uwbServiceBound = true
            Log.i("MainActivity", "UWB Bridge Service connected")
            // If we have a SAF workspace AND we're in a remote mode, start the bridge
            if (hasSafWorkspace() && isRemoteMode() && uwbBridgeService != null) {
                startUWBBridgeForCurrentWorkspace()
            }
        }
        override fun onServiceDisconnected(name: android.content.ComponentName) {
            uwbBridgeService = null
            uwbServiceBound = false
        }
    }

    /** True if current sandbox mode is Render (1) or GitHub (2) */
    private fun isRemoteMode(): Boolean {
        val mode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
        return mode == 1 || mode == 2
    }
    private data class NativeTerminalSession(
        val id: String,
        val command: String,
        val cwd: String,
        val process: Process? = null,
        @Volatile var ptyFd: Int = -1,
        val ptyPid: Int = -1,
        val shell: String = "sh",
        val startedAt: Long = System.currentTimeMillis(),
        val output: StringBuilder = StringBuilder(),
        val stdout: StringBuilder = StringBuilder(),
        val stderr: StringBuilder = StringBuilder(),
        var baseOffset: Int = 0,
        @Volatile var exited: Boolean = false,
        @Volatile var exitCode: Int? = null
    )
    private val nativeTerminals = ConcurrentHashMap<String, NativeTerminalSession>()
    private val nativeHttpJobs = ConcurrentHashMap<String, HttpURLConnection>()
    private val nativeHttpCancelled = ConcurrentHashMap<String, AtomicBoolean>()
    private val browserConsoleEvents = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
    private val browserNetworkEvents = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
    private val browserCdpNetworkRows = ConcurrentHashMap<String, JSONObject>()
    @Volatile private var browserNetworkCursor = 0L
    @Volatile private var browserConsoleCursor = 0L
    private val appWorkspaceRoot by lazy { File(filesDir, "workspace").apply { mkdirs() } }
    /** The active Local workspace root: the app-private default, or a folder the user picked on shared storage. */
    private val localRoot: File get() = customWorkspaceDir() ?: appWorkspaceRoot
    private fun customWorkspaceDir(): File? =
        prefs.getString("workspace_dir", "")?.takeIf { it.isNotBlank() }?.let { File(it) }?.takeIf { it.isDirectory }
    private fun usesDeviceStorageWorkspace(): Boolean = customWorkspaceDir() != null
    private val renderBase get() = prefs.getString("render_url", "")!!.trim().trimEnd('/')
    private val renderToken get() = (prefs.getString("render_token", "") ?: "").trim()
    private val renderCredentialsPresent get() = renderBase.startsWith("https://") && renderToken.isNotBlank()
    private val renderConfigured get() = renderCredentialsPresent && prefs.getBoolean("render_verified", true)
    private val githubBase get() = prefs.getString("github_url", "")!!.trim().trimEnd('/')
    private val githubToken get() = (prefs.getString("github_token", "") ?: "").trim()
    private val githubCredentialsPresent get() = githubBase.startsWith("https://") && githubToken.isNotBlank()
    private val githubConfigured get() = githubCredentialsPresent && prefs.getBoolean("github_verified", true)
    // 0 = Local, 1 = Render, 2 = GitHub Codespace. Auto is intentionally gone: a sandbox
    // provider must be explicit so the header never claims a remote that is not connected.
    private val sandboxModes = listOf("Local", "Render", "GitHub")
    private var syncingSandboxSpinner = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.write(this, "startup", "MainActivity.onCreate begin")
        
        // Start Python initialization on background thread to avoid ANR on slow devices
        pythonExecutor.execute {
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(this@MainActivity))
                pythonReady = true
                CrashLog.write(this@MainActivity, "startup", "Python available")
            } catch (t: Throwable) {
                pythonStartupError = (t.message ?: t.javaClass.simpleName).take(500)
                CrashLog.write(this@MainActivity, "startup", "Python start failed: ${android.util.Log.getStackTraceString(t).take(4000)}")
            }
        }
        
        try {
            CookieManager.getInstance().setAcceptCookie(true)
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            CrashLog.write(this, "startup", "buildShell begin")
            buildShell()
            CrashLog.write(this, "startup", "buildShell done; loading UI")
            appWeb.loadUrl("file:///android_asset/codespace-web/index.html")
            restoreBrowserTabs()
            CrashLog.write(this, "startup", "onCreate complete")
        } catch (t: Throwable) {
            CrashLog.write(this, "startup", "CRASH during onCreate: ${android.util.Log.getStackTraceString(t).take(20000)}")
            showStartupFailure(t)
        }
    }

    private fun showStartupFailure(error: Throwable) {
        val details = android.util.Log.getStackTraceString(error)
        runCatching {
            val view = TextView(this).apply {
                text = "CodeSpace could not start.\n\n$details"
                setTextColor(0xFFFF6B6B.toInt())
                setBackgroundColor(0xFF10131A.toInt())
                textSize = 11f
                setPadding(24, 72, 24, 24)
                setTextIsSelectable(true)
            }
            setContentView(view)
        }
    }

    private val browserSelectionAttach = java.util.Collections.synchronizedMap(java.util.WeakHashMap<WebView, (String) -> Unit>())

    /**
     * android.webkit.WebView has no public custom selection ActionMode API
     * (setCustomSelectionActionModeCallback exists on TextView only), so the
     * selection actions are offered from the long-press handler in newWebView().
     */
    private fun installSelectionActionMode(web: WebView, attachSelection: (String) -> Unit) {
        browserSelectionAttach[web] = attachSelection
    }

    private fun showSelectionMenu(anchor: View, web: WebView) {
        val selectionJs = "(()=>{const e=document.activeElement;if(e&&/^(INPUT|TEXTAREA)$/.test(e.tagName))return e.value.slice(e.selectionStart||0,e.selectionEnd||0);return String(window.getSelection?window.getSelection().toString():'')})()"
        web.evaluateJavascript(selectionJs) { raw ->
            val selected = runCatching { JSONTokener(raw ?: "\"\"").nextValue() as? String }.getOrNull().orEmpty()
            if (selected.isBlank()) return@evaluateJavascript
            val popup = android.widget.PopupMenu(this, anchor)
            popup.menu.add(Menu.NONE, 0x4353, 0, "Attach to chat").setOnMenuItemClickListener {
                copyToClipboard(selected)
                browserSelectionAttach[web]?.invoke(selected)
                popup.dismiss()
                true
            }
            popup.menu.add(Menu.NONE, 0x4354, 1, "Copy").setOnMenuItemClickListener {
                copyToClipboard(selected)
                popup.dismiss()
                true
            }
            popup.show()
        }
    }

    private fun newWebView(): WebView = WebView(this).apply {
        // Keep native touch scrolling and Android's standard selection handles/context actions.
        isVerticalScrollBarEnabled = true
        isHorizontalScrollBarEnabled = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        isNestedScrollingEnabled = true
        setBackgroundColor(0xFFFFFFFF.toInt())
        installSelectionActionMode(this) { selected -> attachBrowserSelection(selected, url.orEmpty(), title.orEmpty()) }
        var touchX = 0f
        var touchY = 0f
        setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) { touchX = event.x; touchY = event.y }
            false
        }
        setOnLongClickListener { view ->
            val web = view as? WebView
            if (web == null || web.hitTestResult.type != WebView.HitTestResult.UNKNOWN_TYPE) false
            else {
                val density = resources.displayMetrics.density.coerceAtLeast(1f)
                val x = (touchX / density).toInt().coerceIn(0, 10000)
                val y = (touchY / density).toInt().coerceIn(0, 10000)
                val inspect = "(()=>{try{const s=String(window.getSelection?window.getSelection().toString():'');if(s.trim())return JSON.stringify({selected:true});const e=document.elementFromPoint($x,$y);if(!e)return JSON.stringify({error:'No element at this position'});const path=[];for(let n=e;n&&n.nodeType===1&&path.length<7;n=n.parentElement){let q=n.tagName.toLowerCase();if(n.id){q+='#'+CSS.escape(n.id);path.unshift(q);break}const c=[...n.parentElement?.children||[]].filter(v=>v.tagName===n.tagName);if(c.length>1)q+=':nth-of-type('+(c.indexOf(n)+1)+')';path.unshift(q)}const a={};for(const z of [...e.attributes].slice(0,20))a[z.name]=z.value.slice(0,500);const r=e.getBoundingClientRect();return JSON.stringify({kind:'element',page:{url:location.href,title:document.title},selector:path.join(' > '),tag:e.tagName,label:(e.getAttribute('aria-label')||e.getAttribute('title')||e.tagName).slice(0,160),text:(e.innerText||e.textContent||'').trim().slice(0,5000),html:(e.outerHTML||'').slice(0,5000),htmlTruncated:(e.outerHTML||'').length>5000,attrs:a,href:e.href||'',value:('value'in e?String(e.value):'').slice(0,2000),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},ancestors:path})}catch(e){return JSON.stringify({error:String(e)})}})()"
                web.evaluateJavascript(inspect) { raw ->
                    val payload = runCatching { JSONObject(JSONTokener(raw ?: "{}")) }.getOrNull()
                    if (payload != null && payload.optBoolean("selected")) showSelectionMenu(view, web)
                    else if (payload != null && !payload.has("error")) showBrowserElementMenu(web, payload)
                }
                false
            }
        }
        setOnCreateContextMenuListener { menu, view, _ ->
            val web = view as? WebView ?: return@setOnCreateContextMenuListener
            val hit = web.hitTestResult ?: return@setOnCreateContextMenuListener
            val hitUrl = hit.extra.orEmpty()
            if (hitUrl.isBlank()) return@setOnCreateContextMenuListener
            val isImage = hit.type == WebView.HitTestResult.IMAGE_TYPE || hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
            val isLink = hit.type == WebView.HitTestResult.ANCHOR_TYPE || hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE
            if (!isImage && !isLink) return@setOnCreateContextMenuListener
            menu.setHeaderTitle(if (isImage) "Image" else "Link")
            menu.add("Attach to chat").setOnMenuItemClickListener {
                val payload = JSONObject().put("kind", "element").put("page", JSONObject().put("url", web.url ?: "").put("title", web.title ?: ""))
                    .put("selector", if (isImage) "img[src=${JSONObject.quote(hitUrl)}]" else "a[href=${JSONObject.quote(hitUrl)}]")
                    .put("tag", if (isImage) "IMG" else "A").put("label", if (isImage) "Image" else "Link")
                    .put("href", hitUrl).put("text", hitUrl).put("html", "").put("rect", JSONObject().put("x", 0).put("y", 0).put("width", 0).put("height", 0))
                attachBrowserElement(payload)
                true
            }
            menu.add("Copy address").setOnMenuItemClickListener { copyToClipboard(hitUrl); true }
            if (isImage) menu.add("Open image").setOnMenuItemClickListener { web.loadUrl(hitUrl); true }
        }
        settings.javaScriptEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.loadsImagesAutomatically = true
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.userAgentString = settings.userAgentString
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                recordBrowserNetwork(request.method, request.url.toString(), request.isForMainFrame, null, null, 0)
                return super.shouldInterceptRequest(view, request)
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                recordBrowserNetwork(request.method, request.url.toString(), request.isForMainFrame, errorResponse.statusCode, "HTTP ${errorResponse.statusCode}", 0)
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                recordBrowserNetwork(request.method, request.url.toString(), request.isForMainFrame, null, error.description?.toString()?.take(300), 0)
                if (request.isForMainFrame && view === currentBrowser()) browserLoading = false
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase()
                if (scheme != "https" && scheme != "http") return true
                return false
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (view === currentBrowser()) {
                    browserLoading = true; browserLoadGeneration++
                    lastBrowserUrl = url ?: ""; lastBrowserVisible = browserHost.visibility == View.VISIBLE
                    address.setText(url ?: ""); status.text = "Loading"; updateBrowserUi(url.orEmpty(), view.title.orEmpty(), true)
                }
            }
            override fun onPageFinished(view: WebView, url: String?) {
                installBrowserNetworkProbe(view)
                if (view === currentBrowser()) {
                    browserLoading = false
                    lastBrowserUrl = url ?: ""; lastBrowserVisible = browserHost.visibility == View.VISIBLE
                    address.setText(url ?: ""); status.text = "Ready"; updateBrowserUi(url.orEmpty(), view.title.orEmpty(), false)
                }
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val text = message.message()
                if (text.startsWith("__CODESPACE_NET__")) {
                    try {
                        val row = JSONObject(text.removePrefix("__CODESPACE_NET__"))
                        recordBrowserNetwork(row.optString("method", "GET"), row.optString("url", ""), false,
                            row.optInt("status", 0).takeIf { it in 0..599 }, row.optString("error", "").ifBlank { null }, row.optInt("durationMs", 0))
                    } catch (_: Exception) { }
                    return true
                }
                val row = JSONObject().put("level", message.messageLevel().name.lowercase()).put("message", text.take(2000))
                    .put("source", message.sourceId().take(1000)).put("line", message.lineNumber()).put("time", System.currentTimeMillis())
                synchronized(browserConsoleEvents) { browserConsoleEvents.add(row); while (browserConsoleEvents.size > 300) browserConsoleEvents.removeAt(0) }
                return true
            }
            override fun onShowFileChooser(webView: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                if (params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                startActivityForResult(Intent.createChooser(intent, "Choose file"), REQ_FILE)
                return true
            }
            override fun onPermissionRequest(request: PermissionRequest?) {
                // Websites do not receive camera/microphone permissions automatically.
                request?.deny()
            }
        }
        setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = mimeType ?: "application/octet-stream"
                putExtra(Intent.EXTRA_TITLE, URLUtil.guessFileName(url, contentDisposition, mimeType))
            }
            pendingDownloadUrl = url
            startActivityForResult(intent, REQ_SAVE)
        }
    }

    private fun safeDiagnosticUrl(raw: String): String = try {
        val u = Uri.parse(raw)
        val b = u.buildUpon().clearQuery()
        val names = u.queryParameterNames
        names.forEach { key ->
            val lower = key.lowercase()
            b.appendQueryParameter(key, if (lower.contains("token") || lower.contains("key") || lower.contains("auth") || lower.contains("secret") || lower.contains("password")) "[redacted]" else u.getQueryParameter(key) ?: "")
        }
        b.build().toString().take(3000)
    } catch (_: Exception) { raw.take(3000) }

    private fun recordBrowserNetwork(method: String, rawUrl: String, mainFrame: Boolean, statusCode: Int?, error: String?, durationMs: Int) {
        if (!(rawUrl.startsWith("https://", true) || rawUrl.startsWith("http://", true))) return
        val row = JSONObject().put("method", method.take(16)).put("url", safeDiagnosticUrl(rawUrl)).put("mainFrame", mainFrame)
            .put("time", System.currentTimeMillis()).put("durationMs", durationMs.coerceAtLeast(0))
        if (statusCode != null) row.put("status", statusCode)
        if (!error.isNullOrBlank()) row.put("error", error.take(300))
        synchronized(browserNetworkEvents) { browserNetworkEvents.add(row); while (browserNetworkEvents.size > 500) browserNetworkEvents.removeAt(0) }
    }

    private fun installBrowserNetworkProbe(web: WebView) {
        val js = """(()=>{if(window.__codespaceNetProbe)return;window.__codespaceNetProbe=true;const send=(m,u,s,d,e)=>{try{console.debug('__CODESPACE_NET__'+JSON.stringify({method:String(m||'GET'),url:String(u||location.href),status:Number(s||0),durationMs:Math.min(300000,Number(d||0)),error:String(e||'')}))}catch(_){}};const f=window.fetch;if(f)window.fetch=function(...a){const q=a[0],u=typeof q==='string'?q:(q&&q.url)||location.href,m=(a[1]&&a[1].method)||(q&&q.method)||'GET',t=performance.now();return f.apply(this,a).then(r=>{send(m,u,r.status,performance.now()-t,'');return r},e=>{send(m,u,0,performance.now()-t,String(e));throw e})};const xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u,...r){this.__csM=m;this.__csU=u;return xo.call(this,m,u,...r)};XMLHttpRequest.prototype.send=function(...a){const t=performance.now();this.addEventListener('loadend',()=>send(this.__csM,this.__csU,this.status,performance.now()-t,this.status>=400?'HTTP '+this.status:(this.status?'':'XHR failed')),{once:true});return xs.apply(this,a)}})()"""
        runOnUiThread { try { if (web.isAttachedToWindow) web.evaluateJavascript(js, null) } catch (_: Exception) { } }
    }

    private fun browserDiagnostics(args: JSONObject): JSONObject {
        val network = JSONArray(); val console = JSONArray()
        // Drain native Chromium CDP events when the user has explicitly connected DevTools.
        val cdpBatch = runCatching { AndroidWebViewCdp.drain(350, includeBodies = args.optBoolean("include_bodies", false)) }.getOrNull()
        val cdpEvents = cdpBatch?.optJSONArray("events") ?: JSONArray()
        for (i in 0 until cdpEvents.length()) {
            val event = cdpEvents.optJSONObject(i) ?: continue
            val method = event.optString("method")
            val params = event.optJSONObject("params") ?: JSONObject()
            val req = params.optJSONObject("request") ?: JSONObject()
            val res = params.optJSONObject("response") ?: JSONObject()
            val record = event.optJSONObject("requestRecord") ?: JSONObject()
            if (method == "Network.requestWillBeSent" || method == "Network.responseReceived" || method == "Network.loadingFinished" || method == "Network.loadingFailed" || method.startsWith("Network.webSocket")) {
                val url = record.optString("url", req.optString("url", res.optString("url", params.optString("url", ""))))
                val requestId = record.optString("requestId", params.optString("requestId", ""))
                val existing = if (requestId.isNotBlank()) browserCdpNetworkRows[requestId] else null
                val row = existing ?: JSONObject().put("time", System.currentTimeMillis()).put("source", "CDP")
                row.put("method", record.optString("method", req.optString("method", row.optString("method", "GET"))))
                    .put("url", safeDiagnosticUrl(url.ifBlank { row.optString("url", "") }))
                    .put("type", params.optString("type", if (method.startsWith("Network.webSocket")) "WebSocket" else row.optString("type", "Network")))
                    .put("cdpMethod", method)
                if (requestId.isNotBlank()) row.put("requestId", requestId)
                if (record.has("status")) row.put("status", record.optInt("status")) else if (res.has("status")) row.put("status", res.optInt("status"))
                if (record.has("requestHeaders")) row.put("requestHeaders", record.optJSONObject("requestHeaders"))
                if (record.has("responseHeaders")) row.put("responseHeaders", record.optJSONObject("responseHeaders"))
                if (record.has("postData")) row.put("requestBody", record.optString("postData").take(64 * 1024))
                if (record.has("responseBody")) row.put("responseBody", record.optString("responseBody").take(512 * 1024))
                if (record.has("responseBodyOmitted")) row.put("responseBodyOmitted", record.optString("responseBodyOmitted"))
                if (record.has("error")) row.put("error", record.optString("error"))
                if (method.startsWith("Network.webSocket")) {
                    row.put("webSocket", true)
                    val handshakeRequest = params.optJSONObject("request") ?: JSONObject()
                    val handshakeResponse = params.optJSONObject("response") ?: JSONObject()
                    if (handshakeRequest.has("headers")) row.put("requestHeaders", handshakeRequest.optJSONObject("headers"))
                    if (handshakeResponse.has("headers")) row.put("responseHeaders", handshakeResponse.optJSONObject("headers"))
                    if (handshakeResponse.has("payloadData")) row.put("frame", handshakeResponse.optString("payloadData").take(64 * 1024))
                    if (handshakeResponse.has("opcode")) row.put("frameOpcode", handshakeResponse.optInt("opcode"))
                    if (handshakeResponse.has("mask")) row.put("frameMask", handshakeResponse.optBoolean("mask"))
                }
                if (requestId.isNotBlank()) {
                    browserCdpNetworkRows[requestId] = row
                    if (browserCdpNetworkRows.size > 1200) browserCdpNetworkRows.keys.firstOrNull()?.let { browserCdpNetworkRows.remove(it) }
                }
                if (existing == null) synchronized(browserNetworkEvents) { browserNetworkEvents.add(row); while (browserNetworkEvents.size > 1000) browserNetworkEvents.removeAt(0) }
            } else if (method == "Runtime.consoleAPICalled" || method == "Runtime.exceptionThrown" || method == "Log.entryAdded") {
                val message = if (method == "Runtime.consoleAPICalled") {
                    val parts = params.optJSONArray("args") ?: JSONArray()
                    (0 until parts.length()).mapNotNull { n -> parts.optJSONObject(n)?.let { it.optString("value", it.optString("description", "[object]")) } }.joinToString(" ")
                } else if (method == "Runtime.exceptionThrown") params.optJSONObject("exceptionDetails")?.optJSONObject("exception")?.optString("description", "JavaScript exception") ?: "JavaScript exception"
                else params.optJSONObject("entry")?.optString("text", "Browser log entry") ?: "Browser log entry"
                val row = JSONObject().put("level", params.optString("type", if (method == "Runtime.exceptionThrown") "error" else "log").lowercase())
                    .put("message", message.take(4000)).put("source", "CDP:${method}").put("time", System.currentTimeMillis())
                synchronized(browserConsoleEvents) { browserConsoleEvents.add(row); while (browserConsoleEvents.size > 600) browserConsoleEvents.removeAt(0) }
            }
        }
        synchronized(browserNetworkEvents) {
            val filter = args.optString("filter", "").lowercase()
            val failedOnly = args.optBoolean("failed_only", false)
            browserNetworkEvents.filter { row ->
                val url = row.optString("url", "").lowercase()
                (args.optBoolean("all", false) || row.optLong("time", 0) > browserNetworkCursor) &&
                    (filter.isBlank() || url.contains(filter)) && (!failedOnly || row.optInt("status", 0) >= 400 || row.has("error"))
            }.takeLast(200).forEach { network.put(JSONObject(it.toString())) }
            browserNetworkCursor = maxOf(browserNetworkCursor, browserNetworkEvents.maxOfOrNull { it.optLong("time", 0) } ?: 0L)
            if (args.optBoolean("clear", false)) { browserNetworkEvents.clear(); browserCdpNetworkRows.clear(); browserNetworkCursor = System.currentTimeMillis() }
        }
        synchronized(browserConsoleEvents) {
            browserConsoleEvents.filter { args.optBoolean("all", false) || it.optLong("time", 0) > browserConsoleCursor }.takeLast(200).forEach { console.put(JSONObject(it.toString())) }
            browserConsoleCursor = maxOf(browserConsoleCursor, browserConsoleEvents.maxOfOrNull { it.optLong("time", 0) } ?: 0L)
            if (args.optBoolean("clear", false)) { browserConsoleEvents.clear(); browserConsoleCursor = System.currentTimeMillis() }
        }
        return JSONObject().put("ok", true).put("url", lastBrowserUrl).put("network", network).put("console", console)
            .put("cdp", cdpBatch?.optBoolean("connected", false) ?: false)
            .put("networkCapture", if (cdpBatch?.optBoolean("connected", false) == true) "Chrome DevTools Protocol: request/response headers, bounded request/response bodies, WebSocket handshake and frames, failures; body capture is capped per poll" else "fetch/XHR and WebView callbacks only; connect browser_devtools first for CDP headers, bodies and WebSocket events" )
    }

    private fun browserUpload(args: JSONObject): JSONObject {
        val selector = args.optString("selector", "input[type=file]").ifBlank { "input[type=file]" }
        require(selector.length <= 1000 && !selector.contains('\u0000')) { "Invalid file-input selector" }
        val files = args.optJSONArray("files") ?: JSONArray()
        require(files.length() in 1..10) { "Choose between 1 and 10 workspace files" }
        val rows = JSONArray(); var total = 0L
        fun readBounded(input: java.io.InputStream): ByteArray = input.use { stream ->
            val out = ByteArrayOutputStream(); val buffer = ByteArray(64 * 1024); var count = 0
            while (true) { val n = stream.read(buffer); if (n < 0) break; count += n; require(count <= 10 * 1024 * 1024) { "Each browser upload file is limited to 10 MB" }; out.write(buffer, 0, n) }
            out.toByteArray()
        }
        for (i in 0 until files.length()) {
            val rel = files.optString(i, "")
            require(rel.isNotBlank() && !rel.startsWith("/") && !rel.contains('\u0000')) { "Invalid workspace-relative file path" }
            val name: String; val bytes: ByteArray
            if (hasSafWorkspace()) {
                val doc = safDocument(rel)
                require(doc.isFile) { "Upload target is not a file: $rel" }
                name = doc.name ?: rel.substringAfterLast('/')
                val stream = contentResolver.openInputStream(doc.uri) ?: throw IllegalStateException("Cannot read workspace file: $rel")
                bytes = readBounded(stream)
            } else {
                val file = safeFile(rel).canonicalFile
                require(file.isFile && file.path.startsWith(localRoot.canonicalPath + File.separator)) { "Upload file is outside the Local workspace or is not a file: $rel" }
                require(file.length() <= 10L * 1024L * 1024L) { "Each browser upload file is limited to 10 MB" }
                name = file.name; bytes = readBounded(FileInputStream(file))
            }
            total += bytes.size; require(total <= 20L * 1024L * 1024L) { "Combined browser upload is limited to 20 MB" }
            val mime = URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"
            rows.put(JSONObject().put("name", name).put("type", mime).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
        val payload = JSONObject().put("selector", selector).put("files", rows)
        val script = "(()=>{try{const p=${JSONObject.quote(payload.toString())};const e=document.querySelector(p.selector);if(!e||e.type!=='file')return JSON.stringify({ok:false,error:'File input not found'});const dt=new DataTransfer();for(const f of p.files){const bin=atob(f.base64),a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);dt.items.add(new File([a],f.name,{type:f.type}))}e.files=dt.files;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,url:location.href,uploaded:[...e.files].map(x=>({name:x.name,size:x.size,type:x.type})),count:e.files.length})}catch(x){return JSON.stringify({ok:false,error:String(x).slice(0,400)})}})()"
        val result = browserAgentParse(browserEvaluate(script, 15000)); require(result.optBoolean("ok")) { result.optString("error", "Browser file upload failed") }
        return result
    }

    private var pendingDownloadUrl: String? = null

    private fun buildShell() {
        // Android starts in the actual CodeSpace IDE. The standalone browser remains an
        // internal browser surface and is never the app's home screen.
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF10131A.toInt())
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(8, 2, 8, 2)
        }
        val brand = TextView(this).apply {
            text = "CodeSpace"
            setTextColor(-1)
            textSize = 13.5f
            setPadding(2, 0, 8, 0)
        }
        sandbox = Spinner(this).apply {
            adapter = object : ArrayAdapter<String>(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, sandboxModes) {
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val view = super.getView(position, convertView, parent)
                    (view as? TextView)?.apply { textSize = 10f; setPadding(2, 0, 2, 0) }
                    return view
                }
                override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val view = super.getDropDownView(position, convertView, parent)
                    (view as? TextView)?.apply { textSize = 11.5f; setPadding(10, 5, 10, 5) }
                    return view
                }
            }
            // A saved remote mode without verified URL/token must not strand the app on
            // the Local adapter while the header claims that server is active.
            val storedMode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
            val initialMode = when {
                storedMode == 1 && !renderConfigured -> 0
                storedMode == 2 && !githubConfigured -> 0
                else -> storedMode
            }
            if (initialMode != storedMode) prefs.edit().putInt("sandbox_mode", initialMode).apply()
            setSelection(initialMode)
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
                override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    if (syncingSandboxSpinner) return
                    // A remote provider needs a URL and token; ask for them instead of
                    // switching to a blank bridge.
                    if (!applySandboxMode(pos, syncSpinner = false)) {
                        syncingSandboxSpinner = true
                        setSelection(prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex))
                        syncingSandboxSpinner = false
                        openProviderDialogSoon(pos)
                    }
                }
            }
        }
        header.addView(brand)
        header.addView(sandbox, LinearLayout.LayoutParams(0, 22, 0.5f))
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // Retained as the native browser's internal address state; the visible address bar
        // is rendered by the CodeSpace Browser panel inside the IDE.
        address = EditText(this).apply { setSingleLine(true) }

        workspaceFrame = FrameLayout(this).apply { clipChildren = true }
        browserHost = FrameLayout(this).apply {
            setBackgroundColor(0xFFFFFFFF.toInt())
            elevation = 8f
            visibility = View.GONE
            isClickable = true
            clipChildren = true
        }

        appWeb = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            addJavascriptInterface(NativeAgentBridge(), "CodeSpaceNative")
            installSelectionActionMode(this) { selected -> attachEditorCodeSelection(selected) }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    val level = message.messageLevel()
                    val text = message.message()
                    if (level == ConsoleMessage.MessageLevel.ERROR || text.contains("Uncaught", true)) {
                        CrashLog.write(this@MainActivity, "web-console",
                            "${level.name}: ${text.take(4000)} (${message.sourceId().take(600)}:${message.lineNumber()})")
                    }
                    return false
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    if (view === appWeb && !bridgeConfigSeeded) {
                        bridgeConfigSeeded = true
                        syncBridgeConfig(true)
                    }
                }
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url.toString()
                    if (u.startsWith("file:///android_asset/")) return false
                    navigate(u)
                    return true
                }
            }
        }
        workspaceFrame.addView(appWeb, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        workspaceFrame.addView(browserHost, FrameLayout.LayoutParams(0, 0, Gravity.TOP or Gravity.LEFT))
        root.addView(workspaceFrame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        status = TextView(this).apply {
            text = "CodeSpace ready"
            setTextColor(0xFF9AA4B2.toInt())
            textSize = 9f
            setPadding(8, 1, 8, 2)
        }
        root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(root)
        appWeb.visibility = View.VISIBLE
        browserHost.visibility = View.GONE
    }

    private fun setAndroidBrowserBounds(x: Int, y: Int, width: Int, height: Int, visible: Boolean) {
        runOnUiThread {
            if (!::browserHost.isInitialized || !::workspaceFrame.isInitialized) return@runOnUiThread
            if (!visible || width < 2 || height < 2 || currentBrowser() == null) {
                lastBrowserVisible = false
                browserHost.visibility = View.GONE
                return@runOnUiThread
            }
            lastBrowserVisible = true
            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            // The JS rectangle is in WebView CSS pixels. Convert it to this view's
            // pixels and clamp it to the workspace so a stale/oversized rect can never
            // draw the native page over the chat, terminal or Android header.
            val frameW = workspaceFrame.width.takeIf { it > 0 }
            val frameH = workspaceFrame.height.takeIf { it > 0 }
            var left = (x * density).toInt().coerceAtLeast(0)
            var top = (y * density).toInt().coerceAtLeast(0)
            if (frameW != null) left = left.coerceAtMost((frameW - 1).coerceAtLeast(0))
            if (frameH != null) top = top.coerceAtMost((frameH - 1).coerceAtLeast(0))
            var w = (width * density).toInt().coerceAtLeast(1)
            var h = (height * density).toInt().coerceAtLeast(1)
            if (frameW != null) w = w.coerceAtMost((frameW - left).coerceAtLeast(0))
            if (frameH != null) h = h.coerceAtMost((frameH - top).coerceAtLeast(0))
            if (w < 2 || h < 2) {
                lastBrowserVisible = false
                browserHost.visibility = View.GONE
                return@runOnUiThread
            }
            val params = (browserHost.layoutParams as? FrameLayout.LayoutParams)
                ?: FrameLayout.LayoutParams(w, h, Gravity.TOP or Gravity.LEFT)
            params.width = w
            params.height = h
            params.leftMargin = left
            params.topMargin = top
            browserHost.layoutParams = params
            browserHost.visibility = View.VISIBLE
            browserHost.bringToFront()
        }
    }

    private fun showBrowserElementMenu(web: WebView, payload: JSONObject) {
        runOnUiThread {
            val popup = PopupMenu(this, web)
            popup.menu.add("Attach element to chat").setOnMenuItemClickListener { attachBrowserElement(payload); true }
            val text = payload.optString("text").take(100000)
            if (text.isNotBlank()) popup.menu.add("Copy text").setOnMenuItemClickListener { copyToClipboard(text); true }
            val html = payload.optString("html").take(100000)
            if (html.isNotBlank()) popup.menu.add("Copy element HTML").setOnMenuItemClickListener { copyToClipboard(html); true }
            val href = payload.optString("href")
            if (href.isNotBlank()) popup.menu.add("Copy link address").setOnMenuItemClickListener { copyToClipboard(href); true }
            popup.show()
        }
    }

    private fun updateBrowserUi(url: String, title: String, loading: Boolean) {
        if (!::appWeb.isInitialized) return
        val u = JSONObject.quote(url)
        val t = JSONObject.quote(title)
        val state = if (loading) "Native Android browser · loading" else "Native Android browser · page loaded"
        val st = JSONObject.quote(state)
        appWeb.evaluateJavascript("(()=>{const a=document.getElementById('bAddr'),t=document.getElementById('bTabTitle'),i=document.getElementById('bInfo'),s=document.getElementById('bStreamStatus'),e=document.getElementById('bEmpty');if(a&&document.activeElement!==a)a.value=$u;if(t)t.textContent=$t||'Website';if(i)i.textContent=($t?$t+' · ':'')+$u;if(s)s.textContent=$st;if(e)e.hidden=true})()", null)
    }

    private fun copyToClipboard(value: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("CodeSpace", value))
        status.text = "Copied to clipboard"
    }

    private fun attachEditorCodeSelection(text: String) {
        if (!::appWeb.isInitialized) return
        val encoded = JSONObject.quote(text.take(30000))
        appWeb.evaluateJavascript("if(window.CodeSpaceReceiveEditorSelection)window.CodeSpaceReceiveEditorSelection($encoded)", null)
    }

    private fun attachBrowserSelection(text: String, pageUrl: String, pageTitle: String) {
        val payload = JSONObject().put("kind", "selection").put("text", text.take(30000))
            .put("page", JSONObject().put("url", pageUrl).put("title", pageTitle))
        attachBrowserElement(payload)
    }

    private fun attachBrowserElement(payload: JSONObject) {
        runOnUiThread {
            if (!::appWeb.isInitialized) return@runOnUiThread
            val encoded = JSONObject.quote(payload.toString())
            appWeb.evaluateJavascript("(()=>{try{const p=JSON.parse($encoded);if(window.CodeSpaceReceiveBrowserAttachment)window.CodeSpaceReceiveBrowserAttachment(p);return true}catch(e){return false}})()", null)
            status.text = "Browser content attached to chat"
        }
    }

    private fun currentBrowser(): WebView? = browserTabs.getOrNull(activeTab)
    private fun navigate(raw: String) {
        val value = raw.trim(); if (value.isEmpty()) return
        val url = if (value.matches(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://.*"))) value else if (value.contains('.') && !value.contains(' ')) "https://$value" else "https://www.google.com/search?q=" + Uri.encode(value)
        if (!url.startsWith("https://") && !url.startsWith("http://")) { status.text = "Only HTTP(S) pages are supported"; return }
        lastBrowserUrl = url
        val web = currentBrowser()
        if (web == null) addBrowserTab(url) else web.loadUrl(url)
    }
    /** Destroy every native browser tab so the agent no longer sees a page after the user closes it. */
    private fun closeAllBrowserTabs() {
        runOnUiThread {
            browserTabs.forEach { w ->
                try { browserHost.removeView(w); w.stopLoading(); w.destroy() } catch (_: Exception) {}
            }
            browserTabs.clear(); activeTab = -1
            lastBrowserUrl = ""; lastBrowserVisible = false
            prefs.edit().remove("browser_tabs").remove("browser_active_tab").apply()
            if (::browserHost.isInitialized) browserHost.visibility = View.GONE
            if (::address.isInitialized) address.setText("")
            updateTabBar()
            status.text = "Browser closed"
        }
    }
    private fun addBrowserTab(url: String) {
        if (browserTabs.size >= 8) { status.text = "Maximum 8 browser tabs"; return }
        val web = newWebView(); browserTabs.add(web); activeTab = browserTabs.lastIndex
        browserHost.addView(web, FrameLayout.LayoutParams(-1, -1)); showTab(activeTab); web.loadUrl(url)
        updateTabBar(); saveBrowserTabs()
    }
    private fun showTab(index: Int) {
        if (index !in browserTabs.indices) return
        activeTab = index
        browserLoading = false; browserLoadGeneration++
        browserTabs.forEachIndexed { i, w -> w.visibility = if (i == index) View.VISIBLE else View.GONE }
        address.setText(currentBrowser()?.url ?: ""); updateTabBar(); saveBrowserTabs()
    }
    private fun restoreBrowserTabs() {
        val raw = prefs.getString("browser_tabs", "") ?: ""
        val urls = try { val a = org.json.JSONArray(raw); (0 until a.length()).mapNotNull { a.optString(it).takeIf { u -> u.startsWith("https://") || u.startsWith("http://") } }.take(8) } catch (_: Exception) { emptyList() }
        if (urls.isEmpty()) addBrowserTab("about:blank") else {
            val savedActive = prefs.getInt("browser_active_tab", urls.lastIndex)
            urls.forEach { addBrowserTab(it) }
            showTab(savedActive.coerceIn(0, browserTabs.lastIndex))
        }
    }

    private fun saveBrowserTabs() {
        if (!::address.isInitialized) return
        val array = org.json.JSONArray()
        browserTabs.take(8).forEach { w -> array.put(w.url ?: "about:blank") }
        prefs.edit().putString("browser_tabs", array.toString()).putInt("browser_active_tab", activeTab.coerceAtLeast(0)).apply()
    }

    private fun updateTabBar() {
        // The refreshed layout has no native tab strip; the IDE renders tabs itself.
        val bar = root.findViewById<LinearLayout>(ID_TABBAR) ?: return
        bar.removeAllViews()
        browserTabs.forEachIndexed { i, w ->
            val label = (w.title ?: w.url ?: "Tab ${i+1}").take(18)
            val b = TextView(this).apply { text = if (i == activeTab) "● $label" else label; textSize = 11f; setTextColor(if (i == activeTab) 0xFFFFFFFF.toInt() else 0xFF9AA4B2.toInt()); setPadding(8, 6, 8, 6); setOnClickListener { showTab(i) }; setOnLongClickListener { if (browserTabs.size > 1) { browserHost.removeView(w); w.destroy(); browserTabs.removeAt(i); activeTab = (activeTab.coerceAtMost(browserTabs.lastIndex)).coerceAtLeast(0); showTab(activeTab); saveBrowserTabs() }; true } }
            bar.addView(b)
        }
    }
    private fun showTabs() { val labels = browserTabs.mapIndexed { i, w -> "${i+1}. ${(w.title ?: w.url ?: "New tab").take(50)}" }.toTypedArray(); AlertDialogBuilder.show(this, "Browser tabs", labels) { showTab(it) } }

    private fun browserEvaluate(script: String, timeoutMs: Long = 8_000): String {
        require(script.length <= 64_000) { "Browser script exceeds 64 KB" }
        val latch = CountDownLatch(1)
        val result = AtomicReference<String>("null")
        runOnUiThread {
            val web = currentBrowser()
            if (web == null) { result.set("null"); latch.countDown() }
            else web.evaluateJavascript(script) { value -> result.set(value ?: "null"); latch.countDown() }
        }
        if (!latch.await(timeoutMs.coerceIn(500, 15_000), TimeUnit.MILLISECONDS)) throw java.util.concurrent.TimeoutException("Browser operation timed out")
        return result.get()
    }

    private fun browserPageInfo(): JSONObject = browserAgentParse(browserEvaluate("JSON.stringify({ok:true,url:location.href,title:document.title,readyState:document.readyState,body:(document.body?.innerText||'').slice(0,12000)})"))

    /**
     * Wait for a real page transition instead of returning the previous page's DOM. The
     * JavaScript bridge is synchronous, so this is bounded and never waits for a whole
     * slow network load: after the timeout the caller gets a clear "still loading" result.
     */
    private fun waitForBrowserLoad(targetUrl: String, generationBefore: Long, timeoutMs: Long = 8_000): JSONObject {
        val started = android.os.SystemClock.uptimeMillis()
        val deadline = started + timeoutMs.coerceIn(500, 15_000)
        var last = JSONObject().put("ok", true).put("url", lastBrowserUrl.ifBlank { targetUrl }).put("title", "Loading")
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            val info = runCatching { browserPageInfo() }.getOrNull()
            if (info != null && info.optBoolean("ok", false)) {
                last = info
                val href = info.optString("url", "")
                val ready = info.optString("readyState", "")
                val navigated = browserLoadGeneration != generationBefore
                val elapsed = android.os.SystemClock.uptimeMillis() - started
                val sameTarget = href.isNotBlank() && href == targetUrl
                if (!browserLoading && href.isNotBlank() && href != "about:blank" &&
                    (ready == "interactive" || ready == "complete") &&
                    (navigated || (sameTarget && elapsed >= 350))) return info
            }
            try { Thread.sleep(120) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); break }
        }
        return last.put("ok", true).put("loading", true)
            .put("note", "Page is still loading; call browser_wait or browser_read again.")
    }

    private fun browserWaitForNavigation(generationBefore: Long, fallbackUrl: String, timeoutMs: Long = 6_000): JSONObject? {
        if (browserLoadGeneration == generationBefore && !browserLoading) {
            try { Thread.sleep(180) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); return null }
            if (browserLoadGeneration == generationBefore && !browserLoading) return null
        }
        return waitForBrowserLoad(fallbackUrl, generationBefore, timeoutMs)
    }

    private fun browserHistoryAction(action: String): JSONObject {
        val generation = browserLoadGeneration
        val available = AtomicBoolean(false)
        val latch = CountDownLatch(1)
        runOnUiThread {
            try {
                val web = currentBrowser()
                if (web != null) when (action) {
                    "back" -> { available.set(web.canGoBack()); if (available.get()) web.goBack() }
                    "forward" -> { available.set(web.canGoForward()); if (available.get()) web.goForward() }
                    "reload" -> {
                        val url = web.url.orEmpty()
                        if (url.isBlank() || url == "about:blank") available.set(false)
                        else { available.set(true); web.reload() }
                    }
                }
            } finally { latch.countDown() }
        }
        require(latch.await(2, TimeUnit.SECONDS)) { "The browser did not respond" }
        require(available.get()) {
            when (action) {
                "back" -> "There is no previous page in this browser tab"
                "forward" -> "There is no next page in this browser tab"
                else -> "Open a page before reloading it"
            }
        }
        return waitForBrowserLoad(lastBrowserUrl, generation)
    }

    /**
     * Runs browserDiagnostics on the UI thread because it accesses currentBrowser().url
     * and WebView methods must be called on the main thread.
     */
    private fun browserDiagnosticsOnUiThread(args: JSONObject): JSONObject {
        val latch = CountDownLatch(1)
        val result = AtomicReference<JSONObject>()
        runOnUiThread {
            try {
                result.set(browserDiagnostics(args))
            } catch (e: Exception) {
                result.set(JSONObject().put("ok", false).put("error", e.message ?: "browserDiagnostics failed"))
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(5, TimeUnit.SECONDS)) {
            return JSONObject().put("ok", false).put("error", "browserDiagnostics timed out")
        }
        return result.get()
    }

    private fun localBrowserBridgeCall(body: JSONObject): JSONObject {
        val action = body.optString("action", "").trim()
        val args = body.optJSONObject("args") ?: JSONObject()
        require(action in setOf("open", "back", "forward", "reload", "read", "tabs", "screenshot", "click", "type", "scroll", "eval", "wait", "console", "network", "upload", "dom_snapshot", "a11y_tree", "cdp_enable", "cdp_status", "cdp_targets", "cdp_request", "cdp_events", "cdp_disconnect", "press_key", "hover", "select", "download")) { "Unsupported Android browser action: $action" }
        when (action) {
            "cdp_status" -> return AndroidWebViewCdp.status()
            "cdp_targets" -> return AndroidWebViewCdp.targets()
            "cdp_enable" -> {
                WebView.setWebContentsDebuggingEnabled(true)
                Thread.sleep(180)
                require(currentBrowser() != null) { "Open a browser tab before connecting DevTools" }
                val connected = AndroidWebViewCdp.connect(lastBrowserUrl)
                return connected.put("ok", true).put("warning", "WebView remote debugging is enabled for this app process. Disable it when finished to close the local DevTools socket.")
            }
            "cdp_disconnect" -> {
                AndroidWebViewCdp.disconnect()
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                return JSONObject().put("ok", true).put("connected", false)
            }
            "cdp_request" -> {
                val method = args.optString("method", "")
                val params = args.optJSONObject("params") ?: JSONObject()
                require(method.isNotBlank() && method.length <= 128) { "A valid CDP method is required" }
                val result = AndroidWebViewCdp.command(method, params, args.optLong("timeoutMs", 8000))
                return JSONObject().put("ok", true).put("method", method).put("result", result)
            }
            "cdp_events" -> return AndroidWebViewCdp.drain(args.optInt("limit", 250), args.optBoolean("include_bodies", false)).put("ok", true)
            "console", "network" -> return browserDiagnosticsOnUiThread(args).let { if (action == "console") JSONObject().put("ok", true).put("url", it.optString("url")).put("console", it.optJSONArray("console")) else it }
            "upload" -> return browserUpload(args)
            "dom_snapshot" -> {
                val max = args.optInt("max_nodes", 250).coerceIn(20, 500)
                val js = "(()=>{const out=[];const walk=(e,d)=>{if(!e||out.length>=$max||d>12)return;const tag=e.tagName.toLowerCase(),id=e.id?'#'+e.id:'',cl=typeof e.className==='string'&&e.className.trim()?'.'+e.className.trim().split(/\\s+/).slice(0,3).join('.'):'';const txt=(e.innerText||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,100);out.push({level:d,tag,id,classes:cl,role:e.getAttribute('role')||'',text:txt});for(const c of e.children)walk(c,d+1)};walk(document.body,0);return JSON.stringify({ok:true,url:location.href,snapshot:out.map(x=>'  '.repeat(x.level)+x.tag+x.id+x.classes+(x.role?' [role='+x.role+']':'')+(x.text?' '+x.text:'')).join('\\n'),count:out.length})})()"
                return browserAgentParse(browserEvaluate(js))
            }
            "a11y_tree" -> {
                val js = "(()=>{const out=[];const name=e=>{const a=e.getAttribute('aria-label');if(a)return a;const by=e.getAttribute('aria-labelledby');if(by)return by.split(/\\s+/).map(id=>document.getElementById(id)?.innerText||'').join(' ').trim();if(e.labels?.length)return [...e.labels].map(x=>x.innerText).join(' ').trim();return (e.getAttribute('alt')||e.getAttribute('title')||e.innerText||e.value||'').trim().replace(/\\s+/g,' ').slice(0,180)};const role=e=>e.getAttribute('role')||({A:'link',BUTTON:'button',INPUT:(e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':e.type==='submit'?'button':'textbox'),TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',H1:'heading',H2:'heading',H3:'heading',NAV:'navigation',MAIN:'main',FORM:'form',UL:'list',OL:'list',LI:'listitem'}[e.tagName]||'generic');for(const e of document.querySelectorAll('body *')){if(out.length>=350)break;const r=role(e),n=name(e),rect=e.getBoundingClientRect(),visible=!!(rect.width&&rect.height&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');if(!visible||(!n&&!['main','navigation','form','list','listitem'].includes(r)))continue;out.push({role:r,name:n,value:(e.value||'').slice(0,160),disabled:!!e.disabled,checked:!!e.checked,level:Math.min(10,(e.parentElement?(()=>{let d=0,p=e.parentElement;while(p&&p!==document.body&&d<10){d++;p=p.parentElement}return d})():0)})}return JSON.stringify({ok:true,url:location.href,count:out.length,nodes:out})})()"
                return browserAgentParse(browserEvaluate(js))
            }
            "open" -> {
                val raw = args.optString("url", "").trim(); val uri = try { java.net.URI(raw) } catch (_: Exception) { null }
                require(uri != null && !uri.host.isNullOrBlank() && (uri.scheme.equals("https", true) || (uri.scheme.equals("http", true) && (uri.host.equals("localhost", true) || uri.host == "127.0.0.1")))) { "Android browser agent opens HTTPS sites and HTTP localhost only" }
                val generation = browserLoadGeneration
                runOnUiThread { navigate(raw) }
                return waitForBrowserLoad(raw, generation)
            }
            "back" -> return browserHistoryAction("back")
            "forward" -> return browserHistoryAction("forward")
            "reload" -> return browserHistoryAction("reload")
            "tabs" -> {
                val use=args.optInt("use",-1); if(use>=0){require(use in browserTabs.indices){"Browser tab index is unavailable"};runOnUiThread{showTab(use)}}
                val rows = browserTabsSnapshot()
                return JSONObject().put("tabs", rows).put("count", rows.length())
            }
            "read" -> {
                val page = browserAgentParse(browserEvaluate("JSON.stringify({ok:true,url:location.href,title:document.title,readyState:document.readyState,text:(document.body?.innerText||'').slice(0,16000),scrollY:window.scrollY,pageHeight:document.documentElement.scrollHeight,vw:innerWidth,vh:innerHeight,links:[...document.links].slice(0,80).map(a=>({text:(a.innerText||'').trim().slice(0,160),url:a.href})),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')].slice(0,100).map((e,i)=>({index:i,tag:e.tagName,role:e.getAttribute('role')||'',text:(e.innerText||e.value||'').trim().slice(0,160),selector:e.id?'#'+CSS.escape(e.id):e.getAttribute('name')?e.tagName.toLowerCase()+'[name=\"'+CSS.escape(e.getAttribute('name'))+'\"]':e.tagName.toLowerCase(),type:e.type||'',href:e.href||'',disabled:!!e.disabled}))})"))
                page.put("console", browserDiagnostics(JSONObject()).optJSONArray("console") ?: JSONArray())
                return page
            }
            "click" -> {
                val selector = args.optString("selector", ""); val x = args.optInt("x", -1); val y = args.optInt("y", -1)
                val hasCoordinates = x >= 0 && y >= 0
                require((selector.isNotBlank() && selector.length <= 1000) || hasCoordinates) { "A CSS selector or viewport coordinates are required" }
                val target = if (hasCoordinates) "document.elementFromPoint(${x.coerceIn(0,10000)},${y.coerceIn(0,10000)})" else "document.querySelector(${JSONObject.quote(selector)})"
                val generation = browserLoadGeneration
                val raw = browserEvaluate("(()=>{const e=$target;if(!e)return JSON.stringify({ok:false,error:'Element not found'});e.scrollIntoView({block:'center'});e.click();return JSON.stringify({ok:true,url:location.href,title:document.title,text:(e.innerText||'').slice(0,250)})})()")
                val result = browserAgentParse(raw); require(result.optBoolean("ok")) { result.optString("error", "Browser click failed") }
                return browserWaitForNavigation(generation, result.optString("url", lastBrowserUrl)) ?: result
            }
            "type" -> {
                val selector=args.optString("selector", ""); val value=args.optString("text", ""); require(selector.length in 1..1000 && value.length<=20000) { "Invalid browser type arguments" }
                val clear=args.optBoolean("clear",false);val submit=args.optBoolean("submit",false)
                val js="(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)return JSON.stringify({ok:false,error:'Element not found'});e.scrollIntoView({block:'center'});e.focus();const old=(e.value!==undefined?e.value:(e.textContent||''));const v=${JSONObject.quote(value)};const next=${if(clear) "v" else "String(old)+v"};if(e.tagName==='INPUT'||e.tagName==='TEXTAREA'){const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(e,next);else e.value=next}else if(e.isContentEditable)e.textContent=next;else return JSON.stringify({ok:false,error:'Target is not an editable field'});for(let i=0;i<v.length;i++)e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v[i]}));e.dispatchEvent(new Event('change',{bubbles:true}));${if(submit) "e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));e.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));" else ""}return JSON.stringify({ok:true,url:location.href,title:document.title,length:next.length})})()"
                val generation = browserLoadGeneration
                val result=browserAgentParse(browserEvaluate(js)); require(result.optBoolean("ok")) { result.optString("error", "Browser typing failed") }
                return browserWaitForNavigation(generation, result.optString("url", lastBrowserUrl)) ?: result
            }
            "scroll" -> {
                val dy=args.optInt("pixels", args.optInt("dy", 600)).coerceIn(-5000,5000)
                val to=args.optString("to","")
                val selector=args.optString("selector", "")
                val script=when(to.lowercase()) { "top" -> if(selector.isBlank()) "window.scrollTo({top:0,behavior:'smooth'})" else "document.querySelector(${JSONObject.quote(selector)})?.scrollTo({top:0,behavior:'smooth'})"; "bottom" -> if(selector.isBlank()) "window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})" else "(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(e)e.scrollTo({top:e.scrollHeight,behavior:'smooth'})})()"; else -> if(selector.isBlank()) "window.scrollBy({top:$dy,behavior:'smooth'})" else "(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(e)e.scrollBy({top:$dy,behavior:'smooth'})})()" }
                browserEvaluate("$script;JSON.stringify({ok:true,url:location.href,scrollY:window.scrollY,pageHeight:document.documentElement.scrollHeight})")
                return JSONObject().put("ok",true).put("url",lastBrowserUrl)
            }
            "wait" -> {
                val selector=args.optString("selector", ""); val text=args.optString("text", "")
                require((selector.isNotBlank() && selector.length<=1000) || (text.isNotBlank() && text.length<=4000)) { "A CSS selector or visible text is required" }
                val timeout=args.optInt("timeoutMs",5000).coerceIn(250,15000); val end=android.os.SystemClock.uptimeMillis()+timeout
                val probe = if (selector.isNotBlank()) "(()=>{try{return !!document.querySelector(${JSONObject.quote(selector)})}catch(_){return false}})()"
                    else "(()=>{try{return ((document.body&&document.body.innerText)||'').includes(${JSONObject.quote(text)})}catch(_){return false}})()"
                while(android.os.SystemClock.uptimeMillis()<end) {
                    if(browserEvaluate(probe) == "true") return JSONObject().put("ok",true).put("found",true).put("selector",selector).put("text",text)
                    Thread.sleep(200)
                }
                return JSONObject().put("ok",false).put("found",false).put("timedOut",true).put("selector",selector).put("text",text)
            }
            "press_key" -> {
                val key=args.optString("key", ""); require(key.length in 1..32 && key.none { it.isISOControl() }) { "A valid key is required" }
                val modifiers=args.optJSONObject("modifiers") ?: JSONObject()
                val js="(()=>{const e=document.activeElement||document.body;const init={key:${JSONObject.quote(key)},bubbles:true,cancelable:true,ctrlKey:${modifiers.optBoolean("ctrl")},altKey:${modifiers.optBoolean("alt")},shiftKey:${modifiers.optBoolean("shift")},metaKey:${modifiers.optBoolean("meta")}};for(const type of ['keydown','keypress','keyup'])e.dispatchEvent(new KeyboardEvent(type,init));return JSON.stringify({ok:true,key:init.key,activeTag:e.tagName||'BODY'})})()"
                return browserAgentParse(browserEvaluate(js))
            }
            "hover" -> {
                val selector=args.optString("selector", ""); val hx=args.optInt("x",-1); val hy=args.optInt("y",-1)
                val hasCoordinates=hx>=0 && hy>=0
                require((selector.isNotBlank() && selector.length<=1000) || hasCoordinates) { "A CSS selector or viewport coordinates are required" }
                val target=if(hasCoordinates) "document.elementFromPoint(${hx.coerceIn(0,10000)},${hy.coerceIn(0,10000)})" else "document.querySelector(${JSONObject.quote(selector)})"
                val js="(()=>{const e=$target;if(!e)return JSON.stringify({ok:false,error:'Element not found'});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;for(const type of ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove'])e.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,pointerType:'mouse'}));return JSON.stringify({ok:true,tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,200)})})()"
                val result=browserAgentParse(browserEvaluate(js)); require(result.optBoolean("ok")) { result.optString("error", "Hover failed") }; return result
            }
            "select" -> {
                val selector=args.optString("selector", ""); val value=args.optString("value", "")
                require(selector.isNotBlank() && selector.length<=1000 && value.length<=4000) { "A selector and select value are required" }
                val js="(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)return JSON.stringify({ok:false,error:'Element not found'});if(e.tagName!=='SELECT')return JSON.stringify({ok:false,error:'Target is not a SELECT element'});const v=${JSONObject.quote(value)};const option=[...e.options].find(o=>o.value===v||o.text.trim()===v);if(!option)return JSON.stringify({ok:false,error:'No matching option',options:[...e.options].slice(0,80).map(o=>({value:o.value,text:o.text.trim()}))});e.value=option.value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,value:e.value,text:option.text.trim()})})()"
                val result=browserAgentParse(browserEvaluate(js)); require(result.optBoolean("ok")) { result.optString("error", "Select failed") }; return result
            }
            "download" -> {
                val rawUrl=args.optString("url", "").trim()
                val selector=args.optString("selector", "").trim()
                if(rawUrl.isNotBlank()) {
                    val uri=try { java.net.URI(rawUrl) } catch (_: Exception) { null }
                    require(uri!=null && !uri.host.isNullOrBlank() && (uri.scheme.equals("https",true) || (uri.scheme.equals("http",true) && (uri.host.equals("localhost",true) || uri.host=="127.0.0.1")))) { "Downloads must use HTTPS or localhost HTTP" }
                    require(currentBrowser() != null) { "No active browser tab" }
                    runOnUiThread { navigate(rawUrl) }
                    return JSONObject().put("ok",true).put("started",true).put("url",rawUrl).put("note","If the response is a downloadable file, Android will show its system Save As picker.")
                }
                require(selector.isNotBlank() && selector.length<=1000) { "Provide a download URL or link selector" }
                val js="(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)return JSON.stringify({ok:false,error:'Download link not found'});const href=e.href||e.getAttribute('href')||'';e.click();return JSON.stringify({ok:true,href:href||null,text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,180)})})()"
                val result=browserAgentParse(browserEvaluate(js)); require(result.optBoolean("ok")) { result.optString("error", "Download click failed") }
                return result.put("started",true).put("note","If the link triggers a file download, Android will show its system Save As picker.")
            }
            "eval" -> {
                val code=args.optString("code", "")
                require(code.isNotBlank() && code.length<=16_000) { "JavaScript must be between 1 and 16000 characters" }
                val timeoutMs=args.optInt("timeout_ms", 30_000).coerceIn(1_000, 60_000)
                val runId="cs_${java.util.UUID.randomUUID().toString().replace("-", "")}" 
                val quotedCode=JSONObject.quote(code)
                // Run inside the page's own async context. The result is stored on that page
                // and polled from Android because evaluateJavascript cannot await a Promise.
                val start="""(()=>{const id=${JSONObject.quote(runId)},src=$quotedCode;window.__codespaceAsyncRuns=window.__codespaceAsyncRuns||{};const slot={done:false};window.__codespaceAsyncRuns[id]=slot;(async()=>{try{let value;try{value=await (new Function('return ('+src+')')).call(window)}catch(expressionError){value=await (new Function('return (async function(){'+src+'\n}).call(window)')).call(window)}let encoded;try{encoded=JSON.stringify(value===undefined?null:value)}catch(serialError){encoded=JSON.stringify(String(value))}slot.result=encoded===undefined?null:JSON.parse(encoded);slot.ok=true}catch(error){slot.ok=false;slot.error=String(error&&error.stack||error).slice(0,4000)}finally{slot.url=location.href;slot.title=document.title;slot.done=true}})();return JSON.stringify({ok:true,started:true,id:id})})()"""
                val startResult=browserAgentParse(browserEvaluate(start, 8_000))
                require(startResult.optBoolean("started")) { startResult.optString("error", "Could not start asynchronous page script") }
                val deadline=android.os.SystemClock.uptimeMillis()+timeoutMs
                var completed: JSONObject?=null
                while(android.os.SystemClock.uptimeMillis()<deadline) {
                    val poll="(()=>{const all=window.__codespaceAsyncRuns||{},x=all[${JSONObject.quote(runId)}];if(!x)return JSON.stringify({ok:false,error:'Page context was replaced or navigated before the script completed'});if(!x.done)return JSON.stringify({pending:true});delete all[${JSONObject.quote(runId)}];return JSON.stringify({ok:!!x.ok,result:x.result,error:x.error||null,url:x.url||location.href,title:x.title||document.title})})()"
                    val state=browserAgentParse(browserEvaluate(poll, 8_000))
                    if(!state.optBoolean("pending",false)) { completed=state; break }
                    Thread.sleep(100)
                }
                val result=completed ?: run {
                    // Drop the page-visible result slot even though arbitrary page JS cannot be forcibly cancelled.
                    runCatching { browserEvaluate("(()=>{if(window.__codespaceAsyncRuns)delete window.__codespaceAsyncRuns[${JSONObject.quote(runId)}];return true})()", 2_000) }
                    JSONObject().put("ok",false).put("timedOut",true).put("error","JavaScript did not finish within ${timeoutMs} ms. The page task may still be running.")
                }
                result.put("console", browserDiagnostics(JSONObject()).optJSONArray("console") ?: JSONArray())
                return result
            }
            "screenshot" -> {
                val latch=CountDownLatch(1);val result=AtomicReference<JSONObject>(JSONObject().put("ok",false).put("error","Screenshot failed"))
                runOnUiThread { try { val web=currentBrowser() ?: throw IllegalStateException("No active browser tab"); val w=web.width.coerceAtLeast(1);val h=web.height.coerceAtLeast(1);val scale=minOf(1f,1280f/w,1280f/h);val bitmap=Bitmap.createBitmap((w*scale).toInt().coerceAtLeast(1),(h*scale).toInt().coerceAtLeast(1),Bitmap.Config.RGB_565);val canvas=Canvas(bitmap);canvas.scale(scale,scale);web.draw(canvas);val out=ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.JPEG,68,out);bitmap.recycle();val bytes=out.toByteArray();require(bytes.size<=2_000_000){"Screenshot exceeds 2 MB"};result.set(JSONObject().put("ok",true).put("source","browser").put("mimeType","image/jpeg").put("url",web.url?:"").put("title",web.title?:"").put("image","data:image/jpeg;base64,"+Base64.encodeToString(bytes,Base64.NO_WRAP))) } catch(e:Exception){result.set(JSONObject().put("ok",false).put("error",e.message?:"Screenshot failed"))} finally {latch.countDown()} }
                if(!latch.await(8,TimeUnit.SECONDS))throw java.util.concurrent.TimeoutException("Screenshot timed out");return result.get()
            }
        }
        throw IllegalStateException("Unsupported browser action")
    }

    private fun browserAgentId(id: String): Boolean = id.matches(Regex("^[A-Za-z0-9_-]{1,80}$"))
    private fun browserAgentArgs(id: String, selector: String): Boolean = browserAgentId(id) && selector.isNotBlank() && selector.length <= 1000 && !selector.contains('\u0000')
    private fun browserAgentParse(raw: String?): JSONObject = try {
        val decoded = JSONTokener(raw ?: "null").nextValue()
        when (decoded) { is String -> JSONObject(decoded); is JSONObject -> decoded; else -> JSONObject().put("ok", false).put("error", "Browser returned an invalid result") }
    } catch (_: Exception) { JSONObject().put("ok", false).put("error", "Could not decode browser result") }
    private fun emitBrowserAgent(id: String, payload: JSONObject) {
        if (!::appWeb.isInitialized || !browserAgentId(id)) return
        val detail=JSONObject(payload.toString()).put("id",id)
        runOnUiThread { if(::appWeb.isInitialized) appWeb.evaluateJavascript("window.dispatchEvent(new CustomEvent('codespace-browser-agent-result',{detail:${detail}}))",null) }
    }

    private fun emitNativeHttp(id: String, type: String, payload: JSONObject = JSONObject()) {
        if (!::appWeb.isInitialized) return
        val detail = JSONObject(payload.toString()).put("id", id).put("type", type)
        val js = "window.dispatchEvent(new CustomEvent('codespace-native-http',{detail:${detail}}))"
        runOnUiThread { if (::appWeb.isInitialized) appWeb.evaluateJavascript(js, null) }
    }

    private fun startNativeHttp(id: String, rawUrl: String, headersJson: String, body: String) {
        require(id.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "Invalid request id" }
        require(rawUrl.length <= 4096 && body.length <= 12 * 1024 * 1024) { "Request is too large" }
        val target = URL(rawUrl)
        val protocol = target.protocol.lowercase()
        require(protocol == "https" || (protocol == "http" && (target.host.equals("localhost", true) || target.host == "127.0.0.1" || target.host == "::1" || target.host == "[::1]"))) { "Native HTTP allows HTTPS providers and HTTP loopback only" }
        cancelNativeHttp(id)
        val cancelled = AtomicBoolean(false)
        nativeHttpCancelled[id] = cancelled
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                val h = JSONObject(headersJson.ifBlank { "{}" })
                connection = target.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 30000
                connection.readTimeout = 300000
                connection.doOutput = true
                connection.setRequestProperty("Accept", "text/event-stream, application/json")
                val keys = h.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key.length <= 128 && !key.equals("Host", true) && !key.equals("Content-Length", true) && !key.equals("Connection", true) && !key.equals("Transfer-Encoding", true)) connection.setRequestProperty(key, h.optString(key))
                }
                nativeHttpJobs[id] = connection
                if (cancelled.get()) throw java.io.InterruptedIOException("Request cancelled")
                connection.outputStream.use { out -> out.write(body.toByteArray(Charsets.UTF_8)); out.flush() }
                if (cancelled.get()) throw java.io.InterruptedIOException("Request cancelled")
                val statusCode = connection.responseCode
                val responseHeaders = JSONObject()
                connection.headerFields.forEach { (key, values) -> if (key != null && !values.isNullOrEmpty()) responseHeaders.put(key.lowercase(), values.joinToString(", ")) }
                emitNativeHttp(id, "headers", JSONObject().put("status", statusCode).put("statusText", connection.responseMessage ?: "").put("headers", responseHeaders))
                val stream = try { if (statusCode >= 400) connection.errorStream else connection.inputStream } catch (_: Exception) { connection.errorStream }
                if (stream != null) stream.use { input ->
                    val buffer = ByteArray(8192)
                    while (!cancelled.get()) {
                        val n = input.read(buffer); if (n < 0) break
                        val bytes = if (n == buffer.size) buffer.copyOf() else buffer.copyOf(n)
                        emitNativeHttp(id, "chunk", JSONObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                    }
                }
                if (cancelled.get()) emitNativeHttp(id, "cancelled") else emitNativeHttp(id, "done")
            } catch (e: Exception) {
                if (!cancelled.get()) emitNativeHttp(id, "error", JSONObject().put("message", (e.message ?: "Native network error").take(500)))
            } finally {
                nativeHttpJobs.remove(id); nativeHttpCancelled.remove(id); connection?.disconnect()
            }
        }
    }

    private fun cancelNativeHttp(id: String) {
        nativeHttpCancelled[id]?.set(true)
        nativeHttpJobs.remove(id)?.disconnect()
    }


    // Android-native configuration, project analysis, lexical index and bounded task manager.
    // Command/test/build/lint jobs require an explicit approval and run only in the app-private Local workspace.
    private val localConfigFile by lazy { File(filesDir, "config/app.json") }
    private val localIndexFile by lazy { File(filesDir, "index/workspace-index.json") }
    private val localTaskFile by lazy { File(filesDir, "tasks/tasks.json") }
    // OpenCode CLI state is kept app-private. The Android Local sandbox cannot execute the
    // glibc/Bun OpenCode binary, but the status/auth endpoints stay functional so Settings
    // and the chat engine selector report a clear state instead of "not implemented".
    private val openCodeAuthFile by lazy { File(filesDir, "opencode/auth.json") }
    // v46: cached dynamic model discovery (timestamp -> result). The list comes from the real
    // installed CLI (`opencode models`), never a hardcoded provider list.
    @Volatile private var openCodeModelsCache: Pair<Long, JSONObject>? = null
    private val openCodeProviderLabels = linkedMapOf(
        "opencode" to "OpenCode Zen",
        "anthropic" to "Anthropic (Claude)",
        "openai" to "OpenAI",
        "openrouter" to "OpenRouter",
        "google" to "Google Gemini",
        "groq" to "Groq",
        "deepseek" to "DeepSeek",
        "mistral" to "Mistral",
        "xai" to "xAI"
    )
    private val localTasks = ConcurrentHashMap<String, JSONObject>()
    private val localTaskCancels = ConcurrentHashMap<String, AtomicBoolean>()
    private val localTaskProcesses = ConcurrentHashMap<String, Process>()
    private val localTaskLock = Any()

    private fun localConfigGet(): JSONObject {
        val app = if (localConfigFile.isFile && localConfigFile.length() <= 1_000_000L) try { JSONObject(localConfigFile.readText(Charsets.UTF_8)) } catch (_: Exception) { JSONObject() } else JSONObject()
        return JSONObject().put("app", if (app.length() == 0) JSONObject.NULL else app).put("file", "app-private/config/app.json")
    }

    private fun localConfigSet(body: JSONObject): JSONObject {
        val app = body.optJSONObject("app") ?: throw IllegalArgumentException("Missing config object")
        val encoded = app.toString()
        require(encoded.toByteArray(Charsets.UTF_8).size <= 1_000_000) { "Config is too large (1 MB maximum)" }
        // Provider credentials remain in CodeSpace's existing app config. The file is private to this app.
        localConfigFile.parentFile?.mkdirs()
        val tmp = File(localConfigFile.parentFile, "app.json.tmp")
        tmp.writeText(encoded, Charsets.UTF_8)
        if (localConfigFile.exists()) require(localConfigFile.delete()) { "Could not replace config" }
        require(tmp.renameTo(localConfigFile)) { "Could not persist config" }
        return JSONObject().put("saved", true).put("file", "app-private/config/app.json")
    }

    private data class WorkspaceItem(val path: String, val directory: Boolean, val size: Long, val modified: Long)
    private fun localWorkspaceInventory(maxFiles: Int = 1800): Pair<List<WorkspaceItem>, Boolean> {
        val out = ArrayList<WorkspaceItem>()
        var truncated = false
        val excluded = setOf(".git", "node_modules", ".gradle", ".agent", "build", "dist", "target", ".next")
        if (hasSafWorkspace()) {
            fun walk(dir: DocumentFile, prefix: String, depth: Int) {
                if (depth > 18 || out.size >= maxFiles) { truncated = true; return }
                val children = try { dir.listFiles().sortedBy { it.name?.lowercase() ?: "" } } catch (_: Exception) { emptyList() }
                for (child in children) {
                    if (out.size >= maxFiles) { truncated = true; return }
                    val name = child.name ?: continue
                    if (name in excluded || name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key")) continue
                    val rel = if (prefix.isEmpty()) name else "$prefix/$name"
                    val isDir = child.isDirectory
                    out.add(WorkspaceItem(rel, isDir, if (isDir) 0L else child.length(), child.lastModified()))
                    if (isDir) walk(child, rel, depth + 1)
                }
            }
            walk(safRoot(), "", 0)
        } else {
            fun walk(dir: File, prefix: String, depth: Int) {
                if (depth > 18 || out.size >= maxFiles) { truncated = true; return }
                val children = dir.listFiles()?.sortedBy { it.name.lowercase() } ?: return
                for (child in children) {
                    if (out.size >= maxFiles) { truncated = true; return }
                    if (child.isSymbolicLinkCompat() || child.name in excluded || child.name.startsWith(".env") || child.name.endsWith(".pem") || child.name.endsWith(".key")) continue
                    val rel = if (prefix.isEmpty()) child.name else "$prefix/${child.name}"
                    out.add(WorkspaceItem(rel, child.isDirectory, if (child.isFile) child.length() else 0L, child.lastModified()))
                    if (child.isDirectory) walk(child, rel, depth + 1)
                }
            }
            walk(localRoot, "", 0)
        }
        return out to truncated
    }

    private fun localWorkspaceRead(rel: String, maxBytes: Int = 180_000): String? = try {
        if (hasSafWorkspace()) {
            val doc = safDocument(rel)
            if (!doc.isFile || doc.length() > maxBytes) null else contentResolver.openInputStream(doc.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText().take(maxBytes) }
        } else {
            val f = safeFile(rel)
            if (!f.isFile || f.length() > maxBytes) null else f.readText(Charsets.UTF_8).take(maxBytes)
        }
    } catch (_: Exception) { null }

    /**
     * Developer-intelligence endpoints for the Android Local/SAF workspace. Desktop builds
     * run tsc/eslint/ruff/npm here, but Android cannot spawn those tools. We still return
     * the exact response shapes the shared Web UI expects, with real workspace-derived data
     * where possible (manifests, scripts, basic health) and honest "unavailable" notes
     * elsewhere, so the tools report facts instead of a 501 stub error.
     */
    private fun localDevEndpoint(pathname: String, body: JSONObject): JSONObject {
        val notes = JSONArray().put("Android Local workspace: desktop linters/type-checkers/test runners are not available on-device.")
        return when (pathname) {
            "/dev/health" -> {
                val items = localWorkspaceInventory(1800).first.map { it.path }.toSet()
                val checks = JSONObject()
                    .put("hasManifest", items.any { it == "package.json" || it == "pyproject.toml" || it == "build.gradle" || it == "build.gradle.kts" })
                    .put("hasReadme", items.any { it.startsWith("README", true) })
                    .put("hasGit", items.any { it == ".git" })
                    .put("hasTests", items.any { it.startsWith("test", true) || it.startsWith("src/test", true) || it.contains("__tests__") })
                val issues = JSONArray()
                if (!checks.optBoolean("hasManifest")) issues.put("No recognized project manifest found")
                val good = listOf("hasManifest", "hasReadme", "hasGit", "hasTests").count { checks.optBoolean(it) }
                JSONObject().put("score", good * 25).put("issues", issues).put("checks", checks)
            }
            "/dev/deps" -> {
                val manifests = JSONObject()
                val deps = JSONArray(); val devDeps = JSONArray()
                val pkg = localWorkspaceRead("package.json", 180_000)
                if (pkg != null) {
                    try {
                        val obj = JSONObject(pkg)
                        manifests.put("package.json", true)
                        obj.optJSONObject("dependencies")?.let { d -> d.keys().forEach { deps.put(JSONObject().put("name", it).put("spec", d.opt(it)).put("ecosystem", "npm")) } }
                        obj.optJSONObject("devDependencies")?.let { d -> d.keys().forEach { devDeps.put(JSONObject().put("name", it).put("spec", d.opt(it)).put("ecosystem", "npm")) } }
                    } catch (_: Exception) { }
                }
                val req = localWorkspaceRead("requirements.txt", 180_000)
                if (req != null) {
                    manifests.put("requirements.txt", true)
                    req.lineSequence().map { it.trim() }.filter { it.isNotBlank() && !it.startsWith("#") }.forEach {
                        deps.put(JSONObject().put("name", it).put("ecosystem", "pypi"))
                    }
                }
                val pyproj = localWorkspaceRead("pyproject.toml", 180_000)
                if (pyproj != null) manifests.put("pyproject.toml", true)
                JSONObject().put("manifests", manifests).put("dependencies", deps).put("devDependencies", devDeps)
                    .put("counts", JSONObject().put("dependencies", deps.length()).put("devDependencies", devDeps.length()))
                    .put("notes", notes)
            }
            "/dev/tests" -> {
                val commands = JSONArray()
                val pkg = localWorkspaceRead("package.json", 180_000)
                if (pkg != null) {
                    try {
                        val scripts = JSONObject(pkg).optJSONObject("scripts")
                        if (scripts?.has("test") == true) commands.put(JSONObject().put("command", "npm test").put("source", "package.json").put("script", "test"))
                    } catch (_: Exception) { }
                }
                JSONObject().put("ran", false).put("commands", commands).put("note", "Test commands can be detected but not executed in the Android Local workspace. Run them in a desktop/Codespace workspace.")
            }
            "/dev/lint" -> JSONObject().put("toolsUsed", JSONArray()).put("count", 0).put("issues", JSONArray()).put("notes", notes)
            "/dev/diagnostics" -> JSONObject().put("toolsUsed", JSONArray()).put("diagnostics", JSONArray()).put("notes", notes)
            "/dev/format" -> JSONObject().put("formatted", false).put("command", "").put("exitCode", -1)
                .put("output", "Formatting tools are not available in the Android Local workspace.").put("notes", notes)
            "/dev/unused" -> JSONObject().put("unused", JSONArray()).put("scannedSymbols", 0)
                .put("note", "Unused-symbol analysis is not available in the Android Local workspace.")
            "/ext/package/inspect" -> JSONObject().put("name", body.optString("name", ""))
                .put("note", "Package inspection is not available in the Android Local workspace.")
            else -> JSONObject().put("note", "Unknown dev endpoint")
        }
    }

    private fun localProjectUnderstand(): JSONObject {
        val (items, truncated) = localWorkspaceInventory()
        val files = items.filter { !it.directory }
        val langs = JSONObject()
        files.forEach { item ->
            val ext = item.path.substringAfterLast('.', "").lowercase().let { if (it.isEmpty()) "[no extension]" else ".$it" }
            langs.put(ext, langs.optInt(ext) + 1)
        }
        val top = org.json.JSONArray()
        items.map { it.path.substringBefore('/') }.distinct().take(80).forEach { top.put(it) }
        val manifests = listOf("package.json", "pyproject.toml", "requirements.txt", "Pipfile", "Cargo.toml", "go.mod", "composer.json", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "pubspec.yaml", "index.html", "README.md", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs", "angular.json", "manage.py", "artisan", "Dockerfile")
        val present = org.json.JSONArray()
        val texts = JSONObject()
        manifests.filter { f -> files.any { it.path == f } }.forEach { f -> present.put(f); localWorkspaceRead(f, 24_000)?.let { texts.put(f, it) } }
        val packageJson = try { JSONObject(texts.optString("package.json", "{}")) } catch (_: Exception) { JSONObject() }
        val deps = JSONObject().apply { packageJson.optJSONObject("dependencies")?.let { d -> d.keys().forEach { put(it, d.opt(it)) } }; packageJson.optJSONObject("devDependencies")?.let { d -> d.keys().forEach { put(it, d.opt(it)) } } }
        val frameworks = linkedSetOf<String>()
        val frameworkMap = listOf("react" to "React", "vue" to "Vue", "svelte" to "Svelte", "next" to "Next.js", "vite" to "Vite", "@angular/core" to "Angular", "express" to "Express", "fastify" to "Fastify", "electron" to "Electron", "typescript" to "TypeScript")
        frameworkMap.forEach { (dep, label) -> if (deps.has(dep)) frameworks.add(label) }
        if (texts.has("composer.json")) {
            val composer = try { JSONObject(texts.optString("composer.json")) } catch (_: Exception) { JSONObject() }
            val cdeps = composer.optJSONObject("require") ?: JSONObject()
            if (cdeps.has("laravel/framework")) frameworks.add("Laravel")
            if (cdeps.has("symfony/framework-bundle")) frameworks.add("Symfony")
        }
        if (texts.has("requirements.txt") || texts.has("pyproject.toml")) frameworks.add("Python project")
        if (texts.has("Cargo.toml")) frameworks.add("Rust")
        if (texts.has("go.mod")) frameworks.add("Go")
        if (texts.has("pubspec.yaml")) frameworks.add("Flutter/Dart")
        if (texts.has("pom.xml") || texts.has("build.gradle") || texts.has("build.gradle.kts")) frameworks.add("Java/JVM")
        val scripts = JSONObject(); packageJson.optJSONObject("scripts")?.let { src -> src.keys().asSequence().take(40).forEach { scripts.put(it, src.optString(it).take(300)) } }
        val entries = org.json.JSONArray()
        files.map { it.path }.filter { it.matches(Regex("^(src/)?(main|index|app|server)\\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rs)$", RegexOption.IGNORE_CASE)) || it in listOf("artisan", "manage.py", "main.dart") }.take(50).forEach { entries.put(it) }
        val recommended = org.json.JSONArray()
        if (scripts.has("test")) recommended.put(JSONObject().put("kind", "test").put("command", "npm test").put("reason", "package.json defines a test script"))
        if (scripts.has("build")) recommended.put(JSONObject().put("kind", "build").put("command", "npm run build").put("reason", "package.json defines a build script"))
        if (scripts.has("lint")) recommended.put(JSONObject().put("kind", "lint").put("command", "npm run lint").put("reason", "package.json defines a lint script"))
        val important = org.json.JSONArray()
        files.map { it.path }.filter { it.matches(Regex("(^|/)(src|app|pages|routes|api|server|backend|frontend|tests?|components|lib|config)(/|$)", RegexOption.IGNORE_CASE)) || it.substringAfterLast('/').startsWith("README", true) }.take(160).forEach { important.put(it) }
        return JSONObject().put("ok", true).put("root", activeWorkspacePath()).put("scannedAt", java.time.Instant.now().toString())
            .put("limits", JSONObject().put("maxFiles", 1800).put("manifestBytes", 180000)).put("fileCount", files.size).put("truncated", truncated)
            .put("topLevel", top).put("languageCounts", langs).put("frameworks", org.json.JSONArray(frameworks.toList()))
            .put("entryCandidates", entries).put("importantFiles", important).put("manifests", present).put("scripts", scripts)
            .put("recommendedCommands", recommended).put("projectType", frameworks.joinToString(", ").ifBlank { "Unknown / mixed project" })
            .put("notes", org.json.JSONArray().put("Scan uses filenames and selected manifest/config files only.").put("Secret-like files and source file contents are not included in this report.").put("Detected commands are suggestions only; none were executed."))
    }

    private fun localProjectUnderstandDraft(): JSONObject {
        val scan = localProjectUnderstand()
        val entries = org.json.JSONArray()
        fun add(category: String, text: String) { entries.put(JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("category", category).put("text", text.take(2000)).put("updatedAt", System.currentTimeMillis())) }
        add("architecture", "Project type/frameworks detected: ${scan.optString("projectType")}. Top-level folders: ${scan.optJSONArray("topLevel")?.let { a -> (0 until a.length()).joinToString(", ") { a.optString(it) } } ?: ""}.")
        val candidates = scan.optJSONArray("entryCandidates")
        if (candidates != null && candidates.length() > 0) add("entry-points", "Likely entry points: ${(0 until minOf(candidates.length(), 25)).joinToString(", ") { candidates.optString(it) }}. Verify before relying on this heuristic.")
        val scripts = scan.optJSONObject("scripts") ?: JSONObject()
        if (scripts.length() > 0) add("commands", "package.json scripts detected: ${scripts.keys().asSequence().take(20).joinToString("; ") { "$it=${scripts.optString(it)}" }}")
        return JSONObject().put("ok", true).put("scan", scan).put("proposedEntries", entries)
    }

    private fun localIndexRead(): JSONObject = if (localIndexFile.isFile && localIndexFile.length() <= 8L * 1024L * 1024L) try { JSONObject(localIndexFile.readText(Charsets.UTF_8)) } catch (_: Exception) { JSONObject() } else JSONObject()
    private fun localWorkspaceFingerprint(items: List<WorkspaceItem>): String = items.joinToString("\n") { "${it.path}|${it.directory}|${it.size}|${it.modified}" }.hashCode().toString(16)
    private fun localIndexStatus(): JSONObject {
        val index = localIndexRead(); val stats = index.optJSONObject("stats") ?: JSONObject()
        val indexed = index.optBoolean("indexed", false)
        val currentFingerprint = if (indexed) localWorkspaceFingerprint(localWorkspaceInventory(2400).first) else ""
        val stale = indexed && currentFingerprint != index.optString("fingerprint", "")
        return JSONObject().put("indexed", indexed).put("stale", stale).put("staleReason", if (stale) "Workspace files changed since the last index build" else "")
            .put("stats", stats).put("updatedAt", index.optLong("updatedAt", 0L))
    }
    private fun localIndexRebuild(): JSONObject {
        val (items, truncated) = localWorkspaceInventory(2400)
        val supported = items.filter { !it.directory && it.size <= 180_000L && it.path.substringAfterLast('.', "").lowercase() in setOf("js","jsx","ts","tsx","mjs","cjs","py","java","kt","go","rs","php","html","css","scss","json","md","yml","yaml","toml","xml","sh","bat","ps1","sql","dart","swift","c","h","cpp","hpp") }
        val rows = org.json.JSONArray(); val importRows = org.json.JSONArray(); var symbols = 0; var imports = 0
        val symbolRe = Regex("^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|public\\s+class)\\s+([A-Za-z_$][\\w$]*)")
        val importRe = Regex("(?:import\\s+(?:.*?\\s+from\\s+)?|from\\s+|require\\s*\\()\\s*['\"]([^'\"]+)['\"]")
        supported.take(1200).forEach { item ->
            val content = localWorkspaceRead(item.path, 180_000) ?: return@forEach
            val lineRows = org.json.JSONArray(); content.lineSequence().take(5000).forEachIndexed { i, line ->
                val m = symbolRe.find(line); if (m != null && lineRows.length() < 300) { lineRows.put(JSONObject().put("name", m.groupValues[1]).put("kind", line.trim().substringBefore(' ').take(24)).put("line", i + 1).put("text", line.trim().take(240))); symbols++ }
                val imp = importRe.find(line)
                if (imp != null) { imports++; importRows.put(JSONObject().put("from", item.path).put("specifier", imp.groupValues[1].take(300)).put("line", i + 1)) }
            }
            rows.put(JSONObject().put("path", item.path).put("size", item.size).put("symbols", lineRows))
        }
        val knownPaths = supported.map { it.path }.toSet(); var resolvedImports = 0
        for (i in 0 until importRows.length()) {
            val imp = importRows.optJSONObject(i) ?: continue; val spec = imp.optString("specifier")
            if (!spec.startsWith(".")) continue
            val parent = imp.optString("from").substringBeforeLast('/', "")
            val base = if (parent.isEmpty()) spec.removePrefix("./") else "$parent/${spec.removePrefix("./")}"
            val candidates = listOf(base, "$base.js", "$base.jsx", "$base.ts", "$base.tsx", "$base.mjs", "$base.cjs", "$base.py", "$base/index.js", "$base/index.ts", "$base/index.tsx")
            val resolved = candidates.firstOrNull { it in knownPaths }
            if (resolved != null) { imp.put("to", resolved); resolvedImports++ } else imp.put("to", JSONObject.NULL)
        }
        val stats = JSONObject().put("fileCount", rows.length()).put("symbolCount", symbols).put("importCount", imports).put("resolvedImportCount", resolvedImports).put("complete", !truncated && supported.size <= 1200).put("truncated", truncated)
        val index = JSONObject().put("indexed", true).put("stale", false).put("fingerprint", localWorkspaceFingerprint(items)).put("updatedAt", System.currentTimeMillis()).put("stats", stats).put("files", rows).put("imports", importRows)
        localIndexFile.parentFile?.mkdirs(); localIndexFile.writeText(index.toString(), Charsets.UTF_8)
        return JSONObject().put("ok", true).put("stats", stats)
    }
    private fun localIndexSearch(body: JSONObject): JSONObject {
        val index = localIndexRead(); require(index.optBoolean("indexed")) { "Build the code index first" }
        val q = body.optString("query", "").trim(); require(q.isNotEmpty() && q.length <= 200) { "Search query must contain 1–200 characters" }
        val terms = q.lowercase().split(Regex("[^a-z0-9_$]+") ).filter { it.length > 1 }
        val results = org.json.JSONArray(); val files = index.optJSONArray("files") ?: org.json.JSONArray()
        for (i in 0 until files.length()) {
            val file = files.optJSONObject(i) ?: continue; val path = file.optString("path"); if (body.has("path") && body.optString("path").isNotBlank() && !path.contains(body.optString("path"), true)) continue
            val content = localWorkspaceRead(path, 180_000) ?: continue
            content.lineSequence().forEachIndexed { lineNo, line ->
                val lower = line.lowercase(); val score = terms.count { lower.contains(it) }
                if (score > 0 && results.length() < body.optInt("limit", 30).coerceIn(1, 100)) results.put(JSONObject().put("path", path).put("line", lineNo + 1).put("score", score).put("symbol", "").put("text", line.trim().take(300)))
            }
        }
        return JSONObject().put("query", q).put("results", results).put("indexed", index.optJSONObject("stats") ?: JSONObject())
    }
    private fun localIndexSymbols(body: JSONObject): JSONObject {
        val index = localIndexRead(); require(index.optBoolean("indexed")) { "Build the code index first" }
        val q = body.optString("query", "").trim(); val rows = org.json.JSONArray(); val files = index.optJSONArray("files") ?: org.json.JSONArray()
        for (i in 0 until files.length()) { val f = files.optJSONObject(i) ?: continue; val syms = f.optJSONArray("symbols") ?: continue
            for (j in 0 until syms.length()) { val x = syms.optJSONObject(j) ?: continue; if (q.isBlank() || x.optString("name").contains(q, true)) rows.put(JSONObject(x.toString()).put("path", f.optString("path"))) }
        }
        return JSONObject().put("symbols", rows)
    }
    private fun localIndexReferences(body: JSONObject): JSONObject {
        val symbol = body.optString("symbol", "").trim(); require(symbol.matches(Regex("[A-Za-z_$][\\w$]{0,100}"))) { "Invalid symbol name" }
        val (items, _) = localWorkspaceInventory(2400); val refs = org.json.JSONArray(); val defs = org.json.JSONArray(); var truncated = false
        val indexFiles = localIndexRead().optJSONArray("files") ?: org.json.JSONArray()
        for (i in 0 until indexFiles.length()) { val f = indexFiles.optJSONObject(i) ?: continue; val syms = f.optJSONArray("symbols") ?: continue
            for (j in 0 until syms.length()) { val x = syms.optJSONObject(j) ?: continue; if (x.optString("name") == symbol) defs.put(JSONObject().put("path", f.optString("path")).put("line", x.optInt("line")).put("text", x.optString("text"))) }
        }
        items.filter { !it.directory && it.size <= 180_000L && it.path.substringAfterLast('.', "").lowercase() in setOf("js","jsx","ts","tsx","py","java","kt","go","rs","php","dart") }.forEach { item ->
            val content = localWorkspaceRead(item.path, 180_000) ?: return@forEach
            content.lineSequence().forEachIndexed { n, line -> if (Regex("\\b${Regex.escape(symbol)}\\b").containsMatchIn(line)) { if (refs.length() < body.optInt("limit", 100).coerceIn(1, 300)) refs.put(JSONObject().put("path", item.path).put("line", n + 1).put("text", line.trim().take(240))) else truncated = true } }
        }
        return JSONObject().put("symbol", symbol).put("definitions", defs).put("references", refs).put("truncated", truncated).put("note", "Text-based reference search; comments and strings may match.")
    }


    private fun localIndexRelated(body: JSONObject): JSONObject {
        val rel = body.optString("path", "").replace('\\', '/').removePrefix("./")
        require(rel.isNotBlank() && !rel.startsWith("/") && !rel.split('/').contains("..")) { "A safe project-relative file path is required" }
        val index = localIndexRead(); require(index.optBoolean("indexed")) { "Build the code index first" }
        val files = index.optJSONArray("files") ?: org.json.JSONArray(); val file = (0 until files.length()).mapNotNull { files.optJSONObject(it) }.firstOrNull { it.optString("path").equals(rel, true) } ?: throw IllegalArgumentException("File is not in the current code index: $rel")
        val imports = index.optJSONArray("imports") ?: org.json.JSONArray(); val outgoing = org.json.JSONArray(); val incoming = org.json.JSONArray(); val sameDir = org.json.JSONArray()
        for (i in 0 until imports.length()) { val x = imports.optJSONObject(i) ?: continue
            if (x.optString("from") == rel) outgoing.put(JSONObject().put("path", x.opt("to")).put("specifier", x.optString("specifier")).put("line", x.optInt("line")).put("resolved", !x.isNull("to")))
            if (x.optString("to") == rel) incoming.put(JSONObject().put("path", x.optString("from")).put("specifier", x.optString("specifier")).put("line", x.optInt("line")).put("resolved", true))
        }
        val dir = rel.substringBeforeLast('/', "")
        for (i in 0 until files.length()) { val x = files.optJSONObject(i) ?: continue; val path = x.optString("path"); if (path != rel && path.substringBeforeLast('/', "") == dir && sameDir.length() < 20) sameDir.put(path) }
        return JSONObject().put("path", rel).put("language", rel.substringAfterLast('.', "")).put("symbols", file.optJSONArray("symbols") ?: org.json.JSONArray()).put("imports", outgoing).put("importedBy", incoming).put("sameDirectory", sameDir)
    }
    private fun localIndexMap(): JSONObject {
        val index = localIndexRead(); require(index.optBoolean("indexed")) { "Build the code index first" }
        val files = index.optJSONArray("files") ?: org.json.JSONArray(); val dirs = linkedMapOf<String, Int>(); val symbols = org.json.JSONArray()
        for (i in 0 until files.length()) { val f = files.optJSONObject(i) ?: continue; val path = f.optString("path"); val dir = path.substringBeforeLast('/', "") ; dirs[dir] = (dirs[dir] ?: 0) + 1
            val syms = f.optJSONArray("symbols") ?: continue
            for (j in 0 until syms.length()) { val x = syms.optJSONObject(j) ?: continue; if (symbols.length() < 50) symbols.put(JSONObject(x.toString()).put("path", path).put("exported", false)) }
        }
        val top = org.json.JSONArray(); dirs.entries.sortedByDescending { it.value }.take(30).forEach { top.put(JSONObject().put("path", it.key).put("count", it.value)) }
        return JSONObject().put("root", activeWorkspacePath()).put("stats", index.optJSONObject("stats") ?: JSONObject()).put("topDirectories", top).put("symbols", symbols)
    }

    private fun localTaskSave() {
        synchronized(localTaskLock) { localTaskFile.parentFile?.mkdirs(); val arr = org.json.JSONArray(); localTasks.values.sortedByDescending { it.optLong("createdAt") }.take(50).forEach { arr.put(it) }; localTaskFile.writeText(JSONObject().put("tasks", arr).toString(), Charsets.UTF_8) }
    }
    private fun localTaskLoad() {
        if (localTasks.isNotEmpty() || !localTaskFile.isFile || localTaskFile.length() > 2_000_000L) return
        try {
            val arr = JSONObject(localTaskFile.readText()).optJSONArray("tasks") ?: return
            for (i in 0 until arr.length()) {
                val x = arr.optJSONObject(i) ?: continue
                if (x.optString("status") == "running" || x.optString("status") == "pending") {
                    x.put("status", "error").put("error", "App stopped before the task completed").put("endedAt", System.currentTimeMillis()).put("cancellable", false)
                    val retryableKind = x.optString("kind") in setOf("command", "tests", "test", "build", "lint", "web_crawl")
                    val retryablePayload = if (x.optString("kind") == "web_crawl") x.optJSONObject("params")?.optString("url", "").orEmpty().startsWith("https://", true) else x.optString("command").isNotBlank()
                    x.put("retryable", retryableKind && retryablePayload && x.optInt("attempts", 1) < 3)
                }
                localTasks[x.optString("id")] = x
            }
            localTaskSave()
        } catch (_: Exception) {}
    }
    private fun localTaskList(): JSONObject {
        localTaskLoad(); val rows = localTasks.values.sortedByDescending { it.optLong("createdAt") }.take(50)
        val tasks = org.json.JSONArray(); rows.forEach { tasks.put(it) }
        return JSONObject().put("tasks", tasks).put("counts", JSONObject().put("running", rows.count { it.optString("status") == "running" }).put("pending", rows.count { it.optString("status") == "pending" }).put("done", rows.count { it.optString("status") == "done" }).put("error", rows.count { it.optString("status") == "error" }))
    }
    private fun localTaskRetry(body: JSONObject): JSONObject {
        localTaskLoad()
        val sourceId = body.optString("id", body.optString("taskId", ""))
        val previous = localTasks[sourceId] ?: throw IllegalArgumentException("Task not found: $sourceId")
        require(previous.optString("status") in setOf("error", "cancelled")) { "Only failed or cancelled tasks can be retried" }
        require(previous.optString("kind") in setOf("command", "tests", "test", "build", "lint", "web_crawl")) { "This local task type cannot be retried" }
        val previousAttempts = previous.optInt("attempts", 1)
        require(previousAttempts < 3) { "This task has reached the three-attempt retry limit" }
        val result = previous.optJSONObject("result")
        val retryCommand = result?.optString("command", "").orEmpty().ifBlank { previous.optString("command", "") }
        val retryKind = previous.optString("kind")
        if (retryKind != "web_crawl") require(retryCommand.isNotBlank()) { "The previous task has no saved command to retry" }
        val retryRequest = JSONObject().put("kind", retryKind)
            .put("label", "Retry: ${previous.optString("label", retryKind)}")
            .put("command", retryCommand)
            .put("cwd", result?.optString("cwd", "").orEmpty().ifBlank { previous.optString("cwd", ".") })
            .put("timeout", previous.optInt("timeout", 600))
        if (retryKind == "web_crawl") {
            val savedParams = previous.optJSONObject("params") ?: JSONObject()
            require(savedParams.optString("url").startsWith("https://", true)) { "The previous web-crawl task has no saved HTTPS URL" }
            retryRequest.put("params", savedParams)
        }
        val created = localTaskCreate(retryRequest)
        val newId = created.optString("id")
        localTasks[newId]?.put("attempts", previousAttempts + 1)?.put("retryOf", sourceId)
        localTaskSave()
        return localTasks[newId]?.let { JSONObject(it.toString()) } ?: created
    }

    private fun localTaskCreate(body: JSONObject): JSONObject {
        localTaskLoad()
        val kind = body.optString("kind", "")
        val supported = setOf("index_rebuild", "diagnostics", "command", "tests", "test", "build", "lint", "web_crawl")
        require(kind in supported) { "Unsupported Android Local background task type: $kind" }
        if (localTasks.values.count { it.optString("status") == "running" } >= 1) throw IllegalStateException("One Android Local background task is already running")
        val params = body.optJSONObject("params") ?: JSONObject()
        val command = body.optString("command", params.optString("command", "")).trim()
        if (kind in setOf("command", "tests", "test", "build", "lint")) {
            require(!hasSafWorkspace()) { "Background command tasks require the app-private Local workspace; SAF workspaces are file-only for process execution." }
            require(command.isNotEmpty() && command.length <= 1000 && !command.contains('\u0000')) { "Task command must contain 1–1000 characters" }
        }
        val cwd = if (kind in setOf("command", "tests", "test", "build", "lint")) safeFile(body.optString("cwd", params.optString("cwd", "."))).canonicalFile else localRoot.canonicalFile
        require(cwd.isDirectory && (cwd.path == localRoot.canonicalPath || cwd.path.startsWith(localRoot.canonicalPath + File.separator))) { "Task working directory must be inside the Local workspace" }
        if (kind in setOf("command", "tests", "test", "build", "lint")) {
            val timeout = body.optInt("timeout", params.optInt("timeout_seconds", params.optInt("timeout", 600))).coerceIn(1, 600)
            if (!requestLocalApproval("Start Android background task: $kind", "Folder: ${cwd.path}\nTimeout: ${timeout}s\n\n$ $command")) throw SecurityException("Background task execution was denied or timed out")
        }
        if (kind == "web_crawl") {
            val url = params.optString("url", body.optString("url", ""))
            require(url.startsWith("https://", true) && url.length <= 2048) { "Web-crawl task requires an HTTPS URL" }
            if (!requestLocalApproval("Crawl public website", "$url\nMaximum pages: ${params.optInt("max_pages", params.optInt("maxPages", 5)).coerceIn(1,20)}\nSame host only: ${params.optBoolean("sameHostOnly", true)}")) throw SecurityException("Web-crawl task was denied")
        }
        val id = "and_" + java.util.UUID.randomUUID().toString().replace("-", "").take(16)
        val savedParams = JSONObject(params.toString())
        if (kind == "web_crawl") {
            if (!savedParams.has("url")) savedParams.put("url", body.optString("url", ""))
            if (!savedParams.has("max_pages")) savedParams.put("max_pages", body.optInt("max_pages", 5))
            if (!savedParams.has("max_depth")) savedParams.put("max_depth", body.optInt("max_depth", 1))
            if (!savedParams.has("same_host_only")) savedParams.put("same_host_only", body.optBoolean("same_host_only", true))
        }
        val task = JSONObject().put("id", id).put("kind", kind).put("label", body.optString("label", kind).take(120)).put("status", "running")
            .put("createdAt", System.currentTimeMillis()).put("startedAt", System.currentTimeMillis()).put("attempts", 1).put("cancellable", true)
            .put("command", command).put("cwd", cwd.absolutePath).put("timeout", body.optInt("timeout", params.optInt("timeout_seconds", params.optInt("timeout", 600))).coerceIn(1,600))
            .put("params", savedParams)
            .put("progress", JSONObject().put("done", 0).put("total", 1).put("message", if (command.isBlank()) "starting" else "starting command"))
        localTasks[id] = task
        val cancel = AtomicBoolean(false)
        localTaskCancels[id] = cancel
        localTaskSave()
        executor.execute {
            var process: Process? = null
            try {
                if (cancel.get()) throw java.util.concurrent.CancellationException()
                val result = when (kind) {
                    "index_rebuild" -> localIndexRebuild()
                    "diagnostics" -> JSONObject()
                        .put("project", localProjectUnderstand())
                        .put("index", localIndexStatus())
                        .put("runtime", JSONObject().put("platform", "android").put("workspace", activeWorkspacePath()).put("safWorkspace", hasSafWorkspace()).put("ptyAvailable", true).put("gitAvailable", !hasSafWorkspace()).put("nodeAvailable", BuildConfig.NODE_RUNTIME_INCLUDED && !hasSafWorkspace()).put("pythonAvailable", pythonReady && !hasSafWorkspace()).put("browser", "Android WebView"))
                    "web_crawl" -> AndroidLocalWebCrawler.crawl(params.optString("url", body.optString("url", "")), params.optInt("max_pages", params.optInt("maxPages", 5)), params.optInt("max_depth", params.optInt("depth", 1)), params.optBoolean("same_host_only", params.optBoolean("sameHostOnly", true))) { cancel.get() }
                    else -> {
                        process = ProcessBuilder("/system/bin/sh", "-c", command).directory(cwd).redirectErrorStream(true).apply {
                            environment()["HOME"] = localRoot.absolutePath
                            environment()["TMPDIR"] = cacheDir.absolutePath
                            environment()["PWD"] = cwd.absolutePath
                        }.start()
                        localTaskProcesses[id] = process!!
                        val output = StringBuilder()
                        val taskProcess = process!!
                        val reader = Thread({
                            try { taskProcess.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines -> lines.forEach { line -> synchronized(output) { output.append(line).append('\n'); if (output.length > 240_000) output.delete(0, output.length - 240_000) } } } } catch (_: Exception) { }
                        }, "codespace-task-output-${id.take(8)}").apply { isDaemon = true; start() }
                        val timeout = body.optInt("timeout", params.optInt("timeout_seconds", params.optInt("timeout", 600))).coerceIn(1, 600)
                        val finished = process!!.waitFor(timeout.toLong(), TimeUnit.SECONDS)
                        if (!finished) {
                            process!!.destroy()
                            if (!process!!.waitFor(1200, TimeUnit.MILLISECONDS)) process!!.destroyForcibly()
                        }
                        reader.join(1500)
                        if (cancel.get()) throw java.util.concurrent.CancellationException()
                        val code = if (finished) process!!.exitValue() else -1
                        val commandResult = JSONObject().put("command", command).put("cwd", cwd.absolutePath).put("exitCode", code)
                            .put("timedOut", !finished).put("output", synchronized(output) { output.toString() })
                            .put("ok", finished && code == 0)
                        if (!finished || code != 0) {
                            task.put("result", commandResult)
                            throw IllegalStateException(if (!finished) "Task timed out after ${timeout}s" else "Task exited with code $code")
                        }
                        commandResult
                    }
                }
                if (cancel.get()) throw java.util.concurrent.CancellationException()
                task.put("status", "done").put("result", result).put("progress", JSONObject().put("done", 1).put("total", 1).put("message", "completed"))
            } catch (e: Exception) {
                val cancelled = e is java.util.concurrent.CancellationException || cancel.get()
                task.put("status", if (cancelled) "cancelled" else "error").put("error", (e.message ?: "Task failed").take(500))
            } finally {
                localTaskProcesses.remove(id)
                localTaskCancels.remove(id)
                if (task.optString("status") == "running") task.put("status", "error").put("error", "Task exited without a final state")
                val failed = task.optString("status") == "error"
                val stopped = task.optString("status") == "cancelled"
                val attempts = task.optInt("attempts", 1)
                task.put("cancellable", false)
                    .put("retryable", ((failed && task.optString("kind") in setOf("command", "tests", "test", "build", "lint") && task.optJSONObject("result") != null || stopped && task.optString("kind") in setOf("command", "tests", "test", "build", "lint") && task.optString("command").isNotBlank()) || (task.optString("kind") == "web_crawl" && (failed || stopped) && task.optJSONObject("params")?.optString("url", "").orEmpty().startsWith("https://", true))) && attempts < 3)
                    .put("endedAt", System.currentTimeMillis())
                localTaskSave()
            }
        }
        return JSONObject(task.toString())
    }
    private fun localTaskCancel(id: String): JSONObject {
        localTaskLoad(); val task = localTasks[id] ?: throw IllegalArgumentException("Task not found: $id")
        if (task.optString("status") == "running") {
            localTaskCancels[id]?.set(true)
            localTaskProcesses.remove(id)?.let { process ->
                process.destroy()
                try { if (!process.waitFor(800, TimeUnit.MILLISECONDS)) process.destroyForcibly() } catch (_: Exception) { process.destroyForcibly() }
            }
            task.put("status", "cancelled").put("cancellable", false)
                .put("retryable", (task.optString("kind") in setOf("command", "tests", "test", "build", "lint") && task.optString("command").isNotBlank() || task.optString("kind") == "web_crawl" && task.optJSONObject("params")?.optString("url", "").orEmpty().startsWith("https://", true)) && task.optInt("attempts", 1) < 3)
                .put("endedAt", System.currentTimeMillis()).put("error", "Cancelled by user")
            localTaskSave()
        }
        return JSONObject(task.toString())
    }


    inner class NativeAgentBridge {
        @JavascriptInterface fun startNativeHttp(id: String, url: String, headersJson: String, body: String) {
            try { this@MainActivity.startNativeHttp(id, url, headersJson, body) }
            catch (e: Exception) { emitNativeHttp(id, "error", JSONObject().put("message", (e.message ?: "Invalid native request").take(500))) }
        }
        @JavascriptInterface fun cancelNativeHttp(id: String) { this@MainActivity.cancelNativeHttp(id) }
        @JavascriptInterface fun clipboardWrite(value: String) { runOnUiThread { copyToClipboard(value.take(100000)) } }
        @JavascriptInterface fun clipboardRead(): String {
            return runCatching {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString()?.take(100000).orEmpty()
            }.getOrDefault("")
        }
        @JavascriptInterface fun browserNavigate(url: String) { runOnUiThread { navigate(url) } }
        @JavascriptInterface fun browserBack() { runOnUiThread { currentBrowser()?.let { if (it.canGoBack()) it.goBack() } } }
        @JavascriptInterface fun browserForward() { runOnUiThread { currentBrowser()?.let { if (it.canGoForward()) it.goForward() } } }
        @JavascriptInterface fun browserReload() { runOnUiThread { currentBrowser()?.reload() } }
        @JavascriptInterface fun browserClear() { runOnUiThread { currentBrowser()?.loadUrl("about:blank"); status.text = "Browser tab cleared" } }
        @JavascriptInterface fun browserClose() { closeAllBrowserTabs() }
        @JavascriptInterface fun browserClick(selector: String) { browserAgentClick("legacy", selector) }
        @JavascriptInterface fun browserType(selector: String, value: String) { browserAgentType("legacy", selector, value) }
        @JavascriptInterface fun browserScroll(x: Int, y: Int) { val sx=x.coerceIn(-5000,5000); val sy=y.coerceIn(-5000,5000); runOnUiThread { currentBrowser()?.evaluateJavascript("window.scrollBy(${sx},${sy})", null) } }
        @JavascriptInterface fun browserInspect() { browserAgentInspect("legacy") }
        @JavascriptInterface fun browserScreenshot() { runOnUiThread { saveScreenshot() } }
        // Result-bearing browser-agent methods. They operate only on the currently selected
        // WebView and return structured events to the CodeSpace app origin; external pages
        // never receive this JavaScript interface.
        @JavascriptInterface fun browserAgentClick(id: String, selector: String) {
            if (!browserAgentArgs(id, selector)) return
            runOnUiThread { val web=currentBrowser(); if(web==null){emitBrowserAgent(id, JSONObject().put("ok",false).put("error","No active browser tab"));return@runOnUiThread}
                val js="(()=>{try{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)return JSON.stringify({ok:false,error:'Element not found'});e.scrollIntoView({block:'center',inline:'nearest'});e.click();return JSON.stringify({ok:true,tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,300)})}catch(x){return JSON.stringify({ok:false,error:String(x).slice(0,400)})}})()"
                web.evaluateJavascript(js){ raw -> emitBrowserAgent(id, browserAgentParse(raw)) }
            }
        }
        @JavascriptInterface fun browserAgentType(id: String, selector: String, value: String) {
            if (!browserAgentArgs(id, selector) || value.length > 20000) return
            runOnUiThread { val web=currentBrowser(); if(web==null){emitBrowserAgent(id,JSONObject().put("ok",false).put("error","No active browser tab"));return@runOnUiThread}
                val js="(()=>{try{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)return JSON.stringify({ok:false,error:'Element not found'});e.scrollIntoView({block:'center'});e.focus();const v=${JSONObject.quote(value)};const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='INPUT'?HTMLInputElement.prototype:null;const d=p&&Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(e,v);else if(e.isContentEditable)e.textContent=v;else e.value=v;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v}));e.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,tag:e.tagName,length:v.length})}catch(x){return JSON.stringify({ok:false,error:String(x).slice(0,400)})}})()"
                web.evaluateJavascript(js){ raw -> emitBrowserAgent(id,browserAgentParse(raw)) }
            }
        }
        @JavascriptInterface fun browserAgentKey(id: String, key: String) {
            if (!browserAgentId(id) || key.length !in 1..32 || key.any { it.isISOControl() }) return
            runOnUiThread { currentBrowser()?.evaluateJavascript("(()=>{const e=document.activeElement||document.body;for(const type of ['keydown','keyup'])e.dispatchEvent(new KeyboardEvent(type,{key:${JSONObject.quote(key)},bubbles:true,cancelable:true}));return JSON.stringify({ok:true,key:${JSONObject.quote(key)}})})()") { raw -> emitBrowserAgent(id,browserAgentParse(raw)) } }
        }
        @JavascriptInterface fun browserAgentWaitFor(id: String, selector: String, timeoutMs: Int) {
            if (!browserAgentArgs(id,selector)) return
            val timeout=timeoutMs.coerceIn(250,15000); val deadline=android.os.SystemClock.uptimeMillis()+timeout
            val finished=AtomicBoolean(false)
            val poll=object:Runnable{ override fun run(){ if(finished.get())return; val web=currentBrowser(); if(web==null){if(finished.compareAndSet(false,true))emitBrowserAgent(id,JSONObject().put("ok",false).put("error","No active browser tab"));return}
                web.evaluateJavascript("(()=>{try{return !!document.querySelector(${JSONObject.quote(selector)})}catch(e){return false}})()") { raw ->
                    if(finished.get())return@evaluateJavascript
                    val found=raw=="true"
                    if(found || android.os.SystemClock.uptimeMillis()>=deadline){if(finished.compareAndSet(false,true))emitBrowserAgent(id,JSONObject().put("ok",found).put("found",found).put("selector",selector).put("timedOut",!found))}
                    else browserAgentHandler.postDelayed(this,200)
                }
            }}
            runOnUiThread { browserAgentHandler.post(poll) }
        }
        @JavascriptInterface fun browserAgentInspect(id: String) {
            if(!browserAgentId(id))return
            runOnUiThread { currentBrowser()?.evaluateJavascript("JSON.stringify({title:document.title,url:location.href,readyState:document.readyState,body:(document.body?.innerText||'').slice(0,16000),links:[...document.links].slice(0,80).map(a=>({text:(a.innerText||'').trim().slice(0,200),url:a.href})),inputs:[...document.querySelectorAll('input,textarea,select,button,[contenteditable=true]')].slice(0,100).map(e=>({tag:e.tagName,type:e.type||'',name:e.name||'',placeholder:e.placeholder||'',ariaLabel:e.getAttribute('aria-label')||'',text:(e.innerText||'').slice(0,200),disabled:!!e.disabled}))})") { raw -> emitBrowserAgent(id,browserAgentParse(raw)) } ?: emitBrowserAgent(id,JSONObject().put("ok",false).put("error","No active browser tab")) }
        }
        @JavascriptInterface fun browserAgentScreenshot(id: String) {
            if(!browserAgentId(id))return
            runOnUiThread { val web=currentBrowser(); if(web==null){emitBrowserAgent(id,JSONObject().put("ok",false).put("error","No active browser tab"));return@runOnUiThread}
                try { val w=web.width.coerceAtLeast(1);val h=web.height.coerceAtLeast(1);val scale=minOf(1f,1280f/w,1280f/h);val bitmap=Bitmap.createBitmap((w*scale).toInt().coerceAtLeast(1),(h*scale).toInt().coerceAtLeast(1),Bitmap.Config.RGB_565);val canvas=Canvas(bitmap);canvas.scale(scale,scale);web.draw(canvas);val out=ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.JPEG,68,out);bitmap.recycle();val bytes=out.toByteArray();if(bytes.size>2_000_000)throw IllegalStateException("Screenshot exceeds 2 MB");emitBrowserAgent(id,JSONObject().put("ok",true).put("source","browser").put("mimeType","image/jpeg").put("base64",Base64.encodeToString(bytes,Base64.NO_WRAP)).put("width",(w*scale).toInt()).put("height",(h*scale).toInt())) } catch(e:Exception){emitBrowserAgent(id,JSONObject().put("ok",false).put("error",(e.message?:"Screenshot failed").take(300)))}
            }
        }
        @JavascriptInterface fun setRenderUrl(url: String) { val safe = url.trim().trimEnd('/'); if (safe.startsWith("https://")) prefs.edit().putString("render_url", safe).apply() }
        @JavascriptInterface fun setBrowserBounds(x: Int, y: Int, width: Int, height: Int, visible: Boolean) {
            setAndroidBrowserBounds(x.coerceIn(0, 10000), y.coerceIn(0, 10000), width.coerceIn(0, 10000), height.coerceIn(0, 10000), visible)
        }
        @JavascriptInterface fun pickWorkspaceFolder() { runOnUiThread { chooseWorkspaceFolder() } }
        @JavascriptInterface fun localWorkspacePath(): String = activeWorkspacePath()
        @JavascriptInterface fun localWrite(path: String, content: String): String {
            if (hasSafWorkspace()) return safFsWrite(path, content).toString()
            require(content.length <= 1_000_000) { "Write exceeds 1 MB limit" }
            val target = safeFile(path)
            if (!usesDeviceStorageWorkspace()) require(workspaceSizeBytes() - (if (target.isFile) target.length() else 0L) + content.toByteArray(Charsets.UTF_8).size <= 250L * 1024L * 1024L) { "Local workspace quota is 250 MB" }
            val approved = requestLocalApproval("Write file", path)
            if (!approved) return "DENIED: user did not approve this file write"
            return target.let { f -> f.parentFile?.mkdirs(); f.writeText(content); "saved:${f.name}" }
        }
        @JavascriptInterface fun localRead(path: String): String = if (hasSafWorkspace()) safFsRead(path).optString("content") else safeFile(path).let { if (it.isFile && it.length() < 1_000_000) it.readText() else "" }
        @JavascriptInterface fun localList(path: String): String = if (hasSafWorkspace()) safFsList(path, false).optJSONArray("entries")?.let { a -> (0 until a.length()).joinToString("\n") { a.optString(it) } } ?: "" else safeFile(path).listFiles()?.map { it.name + if (it.isDirectory) "/" else "" }?.sorted()?.joinToString("\n") ?: ""
        @JavascriptInterface fun sandboxMode(): String = sandboxModes[prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)]
        @JavascriptInterface fun bridgeConfig(): String {
            // The native preferences are the source of truth. The page also mirrors this into
            // localStorage, but a stale localStorage value must never win after a mode switch.
            val mode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
            val isRemote = mode == 1 || mode == 2
            val remote = when (mode) {
                1 -> if (renderConfigured) renderBase to renderToken else null
                2 -> if (githubConfigured) githubBase to githubToken else null
                else -> null
            }
            
            // In Local mode, don't query UWB service status (avoids IPC calls)
            val uwb = if (isRemote) uwbBridgeService?.getStatus() ?: JSONObject().put("running", false)
            else JSONObject().put("running", false)
            
            return JSONObject()
                .put("bridgeUrl", remote?.first ?: "codespace-native://local")
                .put("bridgeToken", remote?.second ?: "android-local-native")
                .put("sandboxMode", sandboxModes[mode])
                .put("remote", remote != null)
                .put("uwbBridge", JSONObject()
                    .put("running", uwb.optBoolean("running"))
                    .put("port", uwb.optInt("port", 8080))
                    .put("workspaceUri", uwb.optString("workspaceUri"))
                    .put("deviceToken", uwb.optString("deviceToken"))
                    .put("hasPermission", uwb.optBoolean("hasPermission"))
                )
                .toString()
        }
        @JavascriptInterface fun setSandboxMode(mode: String): String {
            val raw = mode.trim().lowercase()
            if (raw in setOf("configure", "render-configure", "settings")) {
                openRenderDialogSoon()
                return JSONObject().put("ok", false).put("reason", "render-configure")
                    .put("mode", sandboxModes[prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)]).toString()
            }
            if (raw in setOf("configure-github", "github-configure", "codespace-configure", "github-settings")) {
                openGithubDialogSoon()
                return JSONObject().put("ok", false).put("reason", "github-configure")
                    .put("mode", sandboxModes[prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)]).toString()
            }
            val idx = when (raw) {
                "local", "on-device", "device", "0" -> 0
                "render", "server", "free", "free-server", "remote", "1" -> 1
                "github", "github-codespace", "codespace", "gh", "2" -> 2
                // v20 saved Auto as index 2. Preserve the old intent without adding a
                // fourth provider: prefer Render when it is configured, otherwise Local.
                "auto" -> if (renderConfigured) 1 else 0
                else -> -1
            }
            if (idx < 0) return JSONObject().put("ok", false).put("error", "Unknown sandbox mode: $mode").toString()
            if (idx == 1 && !renderConfigured) {
                openRenderDialogSoon()
                return JSONObject().put("ok", false).put("reason", "render-unconfigured")
                    .put("mode", sandboxModes[prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)]).toString()
            }
            if (idx == 2 && !githubConfigured) {
                openGithubDialogSoon()
                return JSONObject().put("ok", false).put("reason", "github-unconfigured")
                    .put("mode", sandboxModes[prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)]).toString()
            }
            runOnUiThread { applySandboxMode(idx) }
            return JSONObject().put("ok", true).put("mode", sandboxModes[idx]).put("reloading", true).toString()
        }
        @JavascriptInterface fun renderEndpoint(): String = renderBase
        @JavascriptInterface fun githubEndpoint(): String = githubBase
        @JavascriptInterface fun testRemoteBridge(url: String, token: String): String {
            // Settings > Bridge uses this instead of browser fetch: the WebView origin is
            // file://, so a remote POST can fail with "Failed to fetch" because of CORS even
            // when the server is healthy. This reports the real HTTP error instead.
            return try {
                val safe = url.trim().trimEnd('/')
                val info = remoteRequest(safe, token.trim(), "/info", "{}")
                JSONObject().put("ok", true).put("info", JSONObject(info)).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
            }
        }
        @JavascriptInterface fun setRemoteBridge(url: String, token: String): String {
            val safe = url.trim().trimEnd('/')
            val tok = token.trim()
            if (safe == "codespace-native://local" || safe == "http://127.0.0.1:8787" || safe == "http://localhost:8787") {
                runOnUiThread { applySandboxMode(0, syncSpinner = true, reload = true) }
                return JSONObject().put("ok", true).put("mode", "Local").toString()
            }
            if (!safe.startsWith("https://") || tok.isBlank()) {
                return JSONObject().put("ok", false).put("error", "Enter an HTTPS bridge URL and its token").toString()
            }
            val host = try { Uri.parse(safe).host ?: "" } catch (_: Exception) { "" }
            if (host.isBlank()) return JSONObject().put("ok", false).put("error", "Enter a valid HTTPS URL").toString()
            return when {
                host.endsWith(".app.github.dev") -> {
                    prefs.edit().putString("github_url", safe).putString("github_token", tok).putBoolean("github_verified", true).apply()
                    runOnUiThread { applySandboxMode(2, syncSpinner = true, reload = true) }
                    JSONObject().put("ok", true).put("mode", "GitHub").toString()
                }
                host.endsWith(".onrender.com") -> {
                    prefs.edit().putString("render_url", safe).putString("render_token", tok).putBoolean("render_verified", true).apply()
                    runOnUiThread { applySandboxMode(1, syncSpinner = true, reload = true) }
                    JSONObject().put("ok", true).put("mode", "Render").toString()
                }
                else -> JSONObject().put("ok", false)
                    .put("error", "Use Sandbox → Configure GitHub… for this agent server").toString()
            }
        }
        
        // ============================================================
        // UWB (Universal Workspace Bridge) JavaScriptInterface
        // ============================================================
        
        @JavascriptInterface fun uwbGetStatus(): String {
            return uwbBridgeService?.getStatus()?.toString() ?: JSONObject().put("running", false).toString()
        }
        
        @JavascriptInterface fun uwbGetDeviceToken(): String {
            return uwbBridgeService?.getDeviceToken() ?: ""
        }
        
        @JavascriptInterface fun uwbCreateSessionToken(clientId: String): String {
            return uwbBridgeService?.createSessionToken(clientId)?.toString() 
                ?: JSONObject().put("ok", false).put("error", "UWB bridge not running").toString()
        }
        
        @JavascriptInterface fun uwbStartBridge(): String {
            if (!hasSafWorkspace()) {
                return JSONObject().put("ok", false).put("error", "No SAF workspace selected").toString()
            }
            if (!isRemoteMode()) {
                return JSONObject().put("ok", false).put("error", "UWB bridge only runs in remote modes (Render/GitHub). Switch sandbox mode first.").toString()
            }
            startUWBBridgeForCurrentWorkspace()
            return JSONObject().put("ok", true).put("message", "UWB bridge starting").toString()
        }
        
        @JavascriptInterface fun uwbStopBridge(): String {
            val intent = Intent(this@MainActivity, UWBBridgeService::class.java).apply {
                action = UWBBridgeService.ACTION_STOP
            }
            startService(intent)
            return JSONObject().put("ok", true).put("message", "UWB bridge stopping").toString()
        }
        
        @JavascriptInterface fun uwbGetConnectionInfo(): String {
            val service = uwbBridgeService
            if (service == null || !service.isRunning()) {
                return JSONObject().put("running", false).toString()
            }
            val deviceToken = service.getDeviceToken()
            val port = service.getPort()
            val localIp = getLocalIpAddress()
            return JSONObject().put("running", true)
                .put("deviceToken", deviceToken)
                .put("port", port)
                .put("localIp", localIp)
                .put("wsUrl", "ws://$localIp:$port/uws")
                .put("workspaceLabel", service.getWorkspaceUri()?.let { DocumentFile.fromTreeUri(this@MainActivity, it)?.name } ?: "")
                .toString()
        }

        @JavascriptInterface fun runLocal(command: String): String = runLocalCommand(command)

        /**
         * Async variant of localApiCall. Runs on a background executor so the WebView's
         * JavaScript thread is never blocked while a tool executes. This is critical for
         * browser tools: browserEvaluate() injects JS on that same thread via
         * evaluateJavascript(), so a synchronous bridge call would deadlock the tool.
         * When finished, calls window.__csNativeCb(callbackId, replyJson) on the UI thread.
         */
        @JavascriptInterface fun localApiCallAsync(pathname: String, bodyJson: String, callbackId: String) {
            bridgeExecutor.execute {
                val reply: String = try {
                    localApiCall(pathname, bodyJson)
                } catch (t: Throwable) {
                    JSONObject().put("status", 500)
                        .put("error", (t.message ?: t.javaClass.simpleName).take(1000)).toString()
                }
                val safeId = JSONObject.quote(callbackId)
                val safeReply = JSONObject.quote(reply)
                val js = "try{window.__csNativeCb&&window.__csNativeCb($safeId,$safeReply)}catch(e){}"
                runOnUiThread {
                    try {
                        if (::appWeb.isInitialized) appWeb.evaluateJavascript(js, null)
                    } catch (_: Exception) { }
                }
            }
        }

        @JavascriptInterface fun localApiCall(pathname: String, bodyJson: String): String {
            return try {
                val body = JSONObject(bodyJson.ifBlank { "{}" })
                val data = when (pathname) {
                    "/bridge/status" -> JSONObject().put("connected", true).put("mode", "android-webview").put("browser", browserPageOpen()).put("browserTabs", browserTabs.size).put("tabs", browserTabs.size)
                    "/bridge/call" -> localBrowserBridgeCall(body)
                    "/browser/close" -> { closeAllBrowserTabs(); JSONObject().put("ok", true).put("closed", true) }
                    "/info" -> JSONObject()
                        .put("root", activeWorkspacePath())
                        .put("platform", "android")
                        .put("shell", "/system/bin/sh")
                        .put("commandExecution", true)
                        .put("node", localRuntimeStatus().optJSONObject("node"))
                        .put("nodePackages", !hasSafWorkspace())
                        .put("toolInstallers", if (hasSafWorkspace()) JSONArray() else JSONArray().put("npm").put("pypi"))
                        .put("toolInstallLimitations", "Android Local: npm registry packages with lifecycle scripts disabled; PyPI py3-none-any wheels only; no apt/apk/pkg/sudo or arbitrary system binaries. Shell: /system/bin/sh plus bundled GNU Bash 5.2.37 for arm64-v8a and x86_64 when the APK runtime is present.")
                        .put("installedToolsManager", !hasSafWorkspace())
                        .put("python", localRuntimeStatus().optJSONObject("python"))
                        .put("git", !hasSafWorkspace())
                        .put("browser", true)
                        .put("browserShown", browserOverlayVisible())
                        .put("browserOpen", browserPageOpen())
                        .put("browserTabs", browserTabs.size)
                        .put("browserUrl", lastBrowserUrl)
                        .put("workspaceKind", if (hasSafWorkspace()) "saf" else if (usesDeviceStorageWorkspace()) "device" else "app-private")
                        .put("workspaceId", workspaceIdentity())
                        .put("provider", "android-native-bridge")
                        .put("safWorkspace", hasSafWorkspace())
                        .put("workspaceLabel", if (hasSafWorkspace()) "Selected folder" else if (usesDeviceStorageWorkspace()) shortStoragePath(localRoot) else "App workspace")
                        // File tools ALWAYS operate on the Android folder via the native bridge.
                        // Shell (/run) execution is a separate concern: it is disabled for SAF
                        // workspaces and, in remote sandbox mode, runs on the REMOTE server. The
                        // AI is told this explicitly in its system prompt (buildSystem).
                        .put("fileProvider", "android-native-bridge")
                        .put("shells", androidShellInventory())
                        .put("ptyAvailable", true)
                        .put("terminalEmulator", true)
                        .put("localConfig", true)
                        .put("projectUnderstanding", true)
                        .put("codeIndex", true)
                        .put("backgroundTasks", "index_rebuild,diagnostics,command,tests,build,lint,web_crawl,retry")
                        .put("localSkills", true).put("mcpHttpTransport", true).put("mcpStdioTransport", true).put("sqliteDatabase", !hasSafWorkspace())
                        .put("checkpoints", true)
                        .put("checkpointLimits", JSONObject().put("maxFiles", checkpointMaxFiles).put("maxFileBytes", checkpointMaxFileBytes).put("maxTotalBytes", checkpointMaxTotalBytes))
                        .put("dataDir", filesDir.absolutePath)
                        .put("configFile", "")
                        .put("mysql", false)
                        // UWB Bridge info
                        .put("uwbBridge", JSONObject().apply {
                            put("running", uwbBridgeService?.isRunning() ?: false)
                            put("port", uwbBridgeService?.getPort() ?: 8080)
                            put("workspaceUri", uwbBridgeService?.getWorkspaceUri()?.toString() ?: "")
                            put("deviceToken", uwbBridgeService?.getDeviceToken() ?: "")
                            put("hasPermission", uwbBridgeService?.getStatus()?.optBoolean("hasPermission") ?: false)
                        })
                    // The sandbox tools are advertised by the shared Web UI. Android Local has no
                    // Docker/Podman/Wasmtime runtime, so report that honestly instead of returning
                    // a 501 that looks like a broken bridge. No provider is auto-selected and
                    // commands never silently fall back to an unisolated host sandbox.
                    "/sandbox/capabilities" -> localSandboxCapabilities()
                    "/sandbox/profiles" -> JSONObject().put("manifestVersion", 0).put("profiles", JSONArray())
                    "/sandbox/list" -> JSONObject().put("sandboxes", JSONArray())
                        .put("counts", JSONObject().put("active", 0).put("max", 0))
                    "/codespace/install-location" -> localInstallLocation()
                    "/workflow/diagnostics" -> localWorkflowDiagnostics()
                    "/workspace/set" -> {
                        require(!hasSafWorkspace()) { "Use the app's folder picker to change a system-folder workspace" }
                        val dir = File(body.optString("path", "").trim())
                        val canonical = dir.canonicalFile
                        require(canonical.path != "/" && canonical.isDirectory && canonical.canRead()) { "Not a readable folder: ${body.optString("path", "")}" }
                        prefs.edit().putString("workspace_dir", canonical.path).apply()
                        status.text = "Workspace: ${canonical.name}"
                        return localApiCall("/info", "{}")
                    }
                    "/workspace/close" -> {
                        prefs.edit().remove("workspace_dir").remove("workspace_tree_uri").apply()
                        status.text = "Workspace: app storage"
                        return localApiCall("/info", "{}")
                    }
                    "/browser/diagnostics" -> {
                        // Panel/tool diagnostics must not consume rows other callers have not read yet.
                        val savedNetwork = browserNetworkCursor
                        val savedConsole = browserConsoleCursor
                        val diag = try {
                            browserDiagnosticsOnUiThread(JSONObject().put("all", true))
                        } finally {
                            browserNetworkCursor = savedNetwork
                            browserConsoleCursor = savedConsole
                        }
                        JSONObject().put("ok", diag.optBoolean("ok", true)).put("url", diag.optString("url"))
                            .put("requests", diag.optJSONArray("network") ?: JSONArray())
                            .put("console", diag.optJSONArray("console") ?: JSONArray())
                            .put("cdp", diag.optBoolean("cdp", false))
                            .put("networkCapture", diag.optString("networkCapture"))
                    }
                    "/diag/log" -> {
                        // Lets the web UI drop breadcrumbs into the same on-device diagnostics
                        // file as the startup log (workspace/explorer debugging).
                        CrashLog.write(this@MainActivity, "web", body.optString("msg", "").take(4000))
                        JSONObject().put("ok", true)
                    }
                    "/opencode/status" -> openCodeStatus()
                    "/opencode/termux/permission" -> {
                        AndroidOpenCodeRuntime.requestTermuxPermission(this@MainActivity)
                        JSONObject().put("ok", true)
                            .put("granted", AndroidOpenCodeRuntime.termuxPermissionGranted(this@MainActivity))
                    }
                    "/opencode/models" -> openCodeModels(body)
                    "/opencode/auth/get" -> openCodeAuthView()
                    "/opencode/auth/set" -> openCodeAuthSet(body)
                    "/opencode/keys/list" -> openCodeKeysList()
                    "/opencode/keys/add" -> openCodeKeysAdd(body)
                    "/opencode/keys/select" -> openCodeKeysSelect(body)
                    "/opencode/keys/remove" -> openCodeKeysRemove(body)
                    "/opencode/keys/rotate" -> openCodeKeysRotate(body)
                    "/opencode/install" -> openCodeInstall(body)
                    "/opencode/run" -> openCodeRun(body)
                    "/opencode/run/read" -> AndroidOpenCodeRuntime.readSession(body.optString("sessionId", ""), body.optLong("since", 0))
                    "/opencode/run/cancel" -> AndroidOpenCodeRuntime.cancel(this@MainActivity, body.optString("sessionId", ""))
                    "/opencode/run/probe" -> AndroidOpenCodeRuntime.probeSession(this@MainActivity, body.optString("sessionId", ""))
                    "/opencode/run/timeout" -> {
                        val ms = body.optLong("timeoutMs", 0L)
                        if (ms > 0) {
                            AndroidOpenCodeRuntime.setRunTimeoutMs(ms)
                            prefs.edit().putLong("opencode_run_timeout_ms", AndroidOpenCodeRuntime.runTimeoutMs()).apply()
                        }
                        JSONObject().put("ok", true).put("timeoutMs", AndroidOpenCodeRuntime.runTimeoutMs())
                    }
                    "/opencode/run/watchdog" -> {
                        val ms = body.optLong("watchdogMs", 0L)
                        if (ms > 0) {
                            AndroidOpenCodeRuntime.setNoOutputWatchdogMs(ms)
                            prefs.edit().putLong("opencode_no_output_watchdog_ms", ms).apply()
                        }
                        JSONObject().put("ok", true).put("watchdogMs", AndroidOpenCodeRuntime.noOutputWatchdogMs())
                    }
                    "/opencode/workspace/sync-in" -> openCodeSyncIn()
                    "/opencode/workspace/sync-out" -> openCodeSyncOut()
                    "/workspace/state" -> activeWorkspaceState()
                    "/workspace/active" -> activeWorkspaceState()
                    "/workspace/dirs" -> if (hasSafWorkspace()) safWorkspaceDirs(body.optString("path", activeWorkspacePath())) else localWorkspaceDirs(body.optString("path", localRoot.absolutePath))
                    "/fs/list" -> if (hasSafWorkspace()) safFsList(body.optString("path", activeWorkspacePath()), body.optBoolean("recursive", false)) else localFsList(body.optString("path", ""), body.optBoolean("recursive", false))
                    "/fs/read" -> if (hasSafWorkspace()) safFsRead(body.optString("path", "")) else localFsRead(body.optString("path", ""))
                    "/fs/write" -> if (hasSafWorkspace()) safFsWrite(body.optString("path", ""), body.optString("content", ""), body.optString("b64", "")) else localFsWrite(body.optString("path", ""), body.optString("content", ""), body.optString("b64", ""))
                    "/apk/inspect" -> localApkInspect(body.optString("path", ""))
                    "/apk/extract" -> localApkExtract(body.optString("path", ""), body.optString("destination", ""))
                    "/fs/mkdir" -> if (hasSafWorkspace()) safFsMkdir(body.optString("path", "")) else localFsMkdir(body.optString("path", ""))
                    "/fs/delete" -> if (hasSafWorkspace()) safFsDelete(body.optString("path", ""), body.optBoolean("recursive", false)) else localFsDelete(body.optString("path", ""), body.optBoolean("recursive", false))
                    "/fs/rename" -> if (hasSafWorkspace()) safFsRename(body.optString("path", ""), body.optString("to", "")) else localFsRename(body.optString("path", ""), body.optString("to", ""))
                    "/fs/search" -> if (hasSafWorkspace()) safFsSearch(body.optString("path", activeWorkspacePath()), body.optString("query", "")) else localFsSearch(body.optString("path", "."), body.optString("query", ""))
                    "/fs/stat" -> if (hasSafWorkspace()) safFsStat(body.optString("path", "")) else localFsStat(body.optString("path", ""))
                    "/fs/history" -> localFsHistory(body.optString("path", ""))
                    "/fs/undo" -> localFsUndoRedo(body.optString("path", ""), "undo")
                    "/fs/redo" -> localFsUndoRedo(body.optString("path", ""), "redo")
                    "/sessions/save" -> localSessionSave(body)
                    "/sessions/list" -> localSessionList()
                    "/sessions/get" -> localSessionGet(body.optString("id", ""))
                    "/sessions/delete" -> localSessionDelete(body.optString("id", ""))
                    "/project-memory/get" -> localProjectMemoryGet()
                    "/project-memory/set" -> localProjectMemorySet(body)
                    "/config/get" -> localConfigGet()
                    "/config/set" -> localConfigSet(body)
                    "/project/understand" -> localProjectUnderstand()
                    "/project/understand/draft-memory" -> localProjectUnderstandDraft()
                    "/index/status" -> localIndexStatus()
                    "/index/rebuild" -> localIndexRebuild()
                    "/index/search" -> localIndexSearch(body)
                    "/index/symbols" -> localIndexSymbols(body)
                    "/index/references" -> localIndexReferences(body)
                    "/index/related" -> localIndexRelated(body)
                    "/index/map" -> localIndexMap()
                    "/task/list" -> localTaskList()
                    "/task/create" -> localTaskCreate(body)
                    "/task/retry" -> localTaskRetry(body)
                    "/task/cancel" -> localTaskCancel(body.optString("id", ""))
                    "/skills/list" -> AndroidLocalSkills.list(File(filesDir, "skills"), File(localRoot, ".agent/skills"))
                    "/skills/get" -> AndroidLocalSkills.get(File(filesDir, "skills"), File(localRoot, ".agent/skills"), body.optString("name", ""), body.optString("file", ""))
                    "/skills/install" -> localSkillInstall(body)
                    "/skills/remove" -> localSkillRemove(body)
                    "/mcp/list" -> AndroidLocalMcp.list()
                    "/mcp/connect" -> localMcpConnect(body)
                    "/mcp/connect-stdio" -> localMcpStdioConnect(body)
                    "/mcp/tools/list" -> AndroidLocalMcp.listTools(body.optString("id", ""))
                    "/mcp/tools/call" -> localMcpToolCall(body)
                    "/mcp/disconnect" -> AndroidLocalMcp.disconnect(body.optString("id", ""))
                    "/database/list" -> { require(!hasSafWorkspace()) { "Local SQLite database tools require the app-private workspace" }; AndroidLocalDatabase.list(localRoot) }
                    "/database/open" -> localDatabaseOpen(body)
                    "/database/close" -> { require(!hasSafWorkspace()) { "Local SQLite database tools require the app-private workspace" }; AndroidLocalDatabase.close(localRoot, body.optString("name", "")) }
                    "/database/query" -> localDatabaseQuery(body)
                    "/database/schema" -> { require(!hasSafWorkspace()) { "Local SQLite database tools require the app-private workspace" }; AndroidLocalDatabase.schema(localRoot, body.optString("name", "")) }
                    "/web/crawl" -> {
                        val url = body.optString("url", "")
                        require(url.startsWith("https://", true)) { "Android Local crawler accepts HTTPS URLs only" }
                        val pages = body.optInt("max_pages", body.optInt("maxPages", 5)).coerceIn(1, 20)
                        val depth = body.optInt("max_depth", body.optInt("depth", 1)).coerceIn(0, 2)
                        val sameHost = body.optBoolean("same_host_only", body.optBoolean("sameHostOnly", true))
                        if (!requestLocalApproval("Crawl public website", "$url\nMaximum pages: $pages\nMaximum depth: $depth\nSame host only: $sameHost")) throw SecurityException("Web crawl was denied")
                        AndroidLocalWebCrawler.crawl(url, pages, depth, sameHost)
                    }
                    "/tools/installed" -> { require(!hasSafWorkspace()) { "Installed Tools manager requires the app-private Local workspace" }; AndroidInstalledTools.list(localRoot) }
                    "/tools/record" -> { require(!hasSafWorkspace()) { "Installed Tools manager requires the app-private Local workspace" }; AndroidInstalledTools.record(localRoot, body) }
                    "/tools/update-status" -> { require(!hasSafWorkspace()) { "Installed Tools manager requires the app-private Local workspace" }; AndroidInstalledTools.updateStatus(localRoot, body) }
                    "/tools/remove-record" -> { require(!hasSafWorkspace()) { "Installed Tools manager requires the app-private Local workspace" }; AndroidInstalledTools.remove(localRoot, body) }
                    "/runtime/status" -> localRuntimeStatus()
                    "/runtime/python/run" -> localPythonRun(body, true)
                    "/runtime/python/exec" -> localPythonRun(body, false)
                    "/runtime/python/packages/list" -> { require(!hasSafWorkspace()) { "Python package management requires the app-private Local workspace; SAF package installs are unavailable." }; AndroidPythonPackageManager.list(localRoot) }
                    "/runtime/python/packages/install" -> {
                        require(!hasSafWorkspace()) { "Python package management requires the app-private Local workspace; SAF package installs are unavailable." }
                        val rows = body.optJSONArray("packages") ?: JSONArray()
                        val specs = (0 until rows.length()).map { rows.optString(it, "") }.filter { it.isNotBlank() }
                        if (!requestLocalApproval("Install Python packages (verified pure-Python wheels)", "Packages: ${specs.joinToString(", ")}\nProject: ${localRoot.absolutePath}\nTransitive dependencies are resolved with bounded version constraints. Only verified py3-none-any wheels from official PyPI hosts are accepted; build/install scripts and native extensions are rejected.")) throw SecurityException("Python package installation was denied")
                        AndroidPythonPackageManager.install(localRoot, specs)
                    }
                    "/runtime/python/packages/remove" -> {
                        require(!hasSafWorkspace()) { "Python package management requires the app-private Local workspace; SAF package installs are unavailable." }
                        val name = body.optString("name", "")
                        if (!requestLocalApproval("Remove Python package", "$name\nProject: ${localRoot.absolutePath}")) throw SecurityException("Python package removal was denied")
                        AndroidPythonPackageManager.remove(localRoot, name)
                    }
                    "/runtime/node/status" -> localRuntimeStatus().optJSONObject("node") ?: JSONObject()
                    "/runtime/node/packages/status" -> { require(!hasSafWorkspace()) { "Node package management requires the app-private Local workspace; SAF package installs are unavailable." }; AndroidNodePackageManager.status(localRoot) }
                    "/runtime/node/packages/list" -> { require(!hasSafWorkspace()) { "Node package management requires the app-private Local workspace; SAF package installs are unavailable." }; AndroidNodePackageManager.list(localRoot) }
                    "/runtime/node/packages/install" -> {
                        require(!hasSafWorkspace()) { "Node package management requires the app-private Local workspace; SAF package installs are unavailable." }
                        val rows = body.optJSONArray("packages") ?: JSONArray()
                        val specs = (0 until rows.length()).map { rows.optString(it, "") }.filter { it.isNotBlank() }
                        if (!requestLocalApproval("Install Node.js packages (lifecycle scripts disabled)", "Packages: ${specs.joinToString(", ")}\nProject: ${localRoot.absolutePath}\nOnly public npm registry tarballs are accepted. Package scripts will not run.")) throw SecurityException("Node package installation was denied")
                        AndroidNodePackageManager.install(localRoot, specs)
                    }
                    "/runtime/node/packages/remove" -> {
                        require(!hasSafWorkspace()) { "Node package management requires the app-private Local workspace; SAF package installs are unavailable." }
                        val name = body.optString("name", "")
                        if (!requestLocalApproval("Remove Node.js package", "$name\nProject: ${localRoot.absolutePath}")) throw SecurityException("Node package removal was denied")
                        AndroidNodePackageManager.remove(localRoot, name)
                    }
                    "/runtime/node/run", "/runtime/node/exec" -> localNodeRun(body)
                    "/runtime/node/debug/start" -> localNodeRun(JSONObject(body.toString()).put("debug", true).put("background", true))
                    "/runtime/node/debug/targets" -> AndroidNodeInspector.targets(body.optInt("port", 0))
                    "/runtime/node/debug/connect" -> {
                        val id = body.optString("id", "node-debug")
                        val port = body.optInt("port", 0)
                        if (!requestLocalApproval("Attach Node debugger", "Connect to local Node inspector at 127.0.0.1:$port")) throw SecurityException("Debugger attach was denied")
                        AndroidNodeInspector.connect(id, port)
                    }
                    "/runtime/node/debug/request" -> {
                        val id = body.optString("id", "")
                        val method = body.optString("method", "")
                        val params = body.optJSONObject("params") ?: JSONObject()
                        if (!requestLocalApproval("Send Node debugger command", "Session: $id\nMethod: $method\nParameters: ${params.toString().take(1200)}")) throw SecurityException("Debugger request was denied")
                        AndroidNodeInspector.request(id, method, params, body.optLong("timeout_ms", 10_000))
                    }
                    "/runtime/node/debug/events" -> AndroidNodeInspector.events(body.optString("id", ""), body.optInt("limit", 100))
                    "/runtime/node/debug/disconnect" -> AndroidNodeInspector.disconnect(body.optString("id", ""))
                    "/runtime/node/dap/initialize" -> AndroidNodeDapAdapter.initialize()
                    "/runtime/node/dap/attach" -> {
                        val id = body.optString("id", "node-dap")
                        val port = body.optInt("port", 0)
                        if (!requestLocalApproval("Attach Node DAP debugger", "Connect to Node Inspector at 127.0.0.1:$port")) throw SecurityException("DAP debugger attach was denied")
                        AndroidNodeDapAdapter.attach(id, port)
                    }
                    "/runtime/node/dap/request" -> {
                        val id = body.optString("id", "")
                        val command = body.optString("command", "")
                        val args = body.optJSONObject("arguments") ?: JSONObject()
                        if (command !in setOf("threads", "stackTrace", "scopes", "variables", "loadedSources")) {
                            if (!requestLocalApproval("Node debugger: $command", "DAP session: $id\nArguments: ${args.toString().take(1000)}")) throw SecurityException("DAP request was denied")
                        }
                        AndroidNodeDapAdapter.request(id, body.optInt("seq", 1), command, args)
                    }
                    "/runtime/node/dap/events" -> AndroidNodeDapAdapter.events(body.optString("id", ""), body.optInt("limit", 100))
                    "/runtime/node/dap/disconnect" -> AndroidNodeDapAdapter.disconnect(body.optString("id", ""))
                    "/lsp/list" -> AndroidLanguageServerHost.list()
                    "/lsp/status" -> AndroidLanguageServerHost.status(body.optString("id", ""))
                    "/lsp/start" -> localLanguageServerStart(body)
                    "/lsp/autostart" -> localLanguageServerAutoStart(body)
                    "/lsp/setup-baseline" -> localLanguageServerSetupBaseline()
                    "/lsp/initialize" -> AndroidLanguageServerHost.initialize(body.optString("id", ""))
                    "/lsp/initialized" -> AndroidLanguageServerHost.initialized(body.optString("id", ""))
                    "/lsp/send" -> AndroidLanguageServerHost.send(body.optString("id", ""), body.optJSONObject("message") ?: JSONObject())
                    "/lsp/request" -> AndroidLanguageServerHost.request(body.optString("id", ""), body.optString("method", ""), body.optJSONObject("params") ?: JSONObject())
                    "/lsp/notify" -> AndroidLanguageServerHost.notify(body.optString("id", ""), body.optString("method", ""), body.optJSONObject("params") ?: JSONObject())
                    "/lsp/read" -> AndroidLanguageServerHost.read(body.optString("id", ""), body.optInt("limit", 50), body.optInt("waitMs", 0))
                    "/lsp/response" -> AndroidLanguageServerHost.response(body.optString("id", ""), body.optString("requestId", ""), body.optBoolean("remove", true))
                    "/lsp/diagnostics" -> AndroidLanguageServerHost.diagnostics(body.optString("id", ""), body.optString("uri", "").ifBlank { null })
                    "/lsp/document/open" -> AndroidLanguageServerHost.openDocument(body.optString("id", ""), localRoot, body.optString("path", ""), body.optString("languageId", "plaintext"), body.optString("text", ""))
                    "/lsp/document/change" -> AndroidLanguageServerHost.changeDocument(body.optString("id", ""), localRoot, body.optString("path", ""), body.optString("text", ""))
                    "/lsp/document/save" -> AndroidLanguageServerHost.saveDocument(body.optString("id", ""), localRoot, body.optString("path", ""), body.optBoolean("includeText", false))
                    "/lsp/document/close" -> AndroidLanguageServerHost.closeDocument(body.optString("id", ""), localRoot, body.optString("path", ""))
                    "/lsp/completion" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/completion", body.optInt("line", 0), body.optInt("character", 0), body.optJSONObject("context") ?: JSONObject())
                    "/lsp/hover" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/hover", body.optInt("line", 0), body.optInt("character", 0))
                    "/lsp/definition" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/definition", body.optInt("line", 0), body.optInt("character", 0))
                    "/lsp/references" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/references", body.optInt("line", 0), body.optInt("character", 0), JSONObject().put("context", JSONObject().put("includeDeclaration", body.optBoolean("includeDeclaration", true))))
                    "/lsp/document-symbols" -> AndroidLanguageServerHost.request(body.optString("id", ""), "textDocument/documentSymbol", JSONObject().put("textDocument", JSONObject().put("uri", AndroidLanguageServerHost.documentUri(localRoot, body.optString("path", "")))))
                    "/lsp/formatting" -> AndroidLanguageServerHost.request(body.optString("id", ""), "textDocument/formatting", JSONObject().put("textDocument", JSONObject().put("uri", AndroidLanguageServerHost.documentUri(localRoot, body.optString("path", "")))).put("options", JSONObject().put("tabSize", body.optInt("tabSize", 2).coerceIn(1, 8)).put("insertSpaces", body.optBoolean("insertSpaces", true))))
                    "/lsp/rename" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/rename", body.optInt("line", 0), body.optInt("character", 0), JSONObject().put("newName", body.optString("newName", "")))
                    "/lsp/signature-help" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/signatureHelp", body.optInt("line", 0), body.optInt("character", 0))
                    "/lsp/code-actions" -> AndroidLanguageServerHost.request(body.optString("id", ""), "textDocument/codeAction", JSONObject().put("textDocument", JSONObject().put("uri", AndroidLanguageServerHost.documentUri(localRoot, body.optString("path", "")))).put("range", JSONObject().put("start", JSONObject().put("line", body.optInt("line", 0)).put("character", body.optInt("character", 0))).put("end", JSONObject().put("line", body.optInt("line", 0)).put("character", body.optInt("character", 0)))).put("context", JSONObject().put("diagnostics", JSONArray())))
                    "/lsp/document-highlights" -> AndroidLanguageServerHost.documentRequest(body.optString("id", ""), localRoot, body.optString("path", ""), "textDocument/documentHighlight", body.optInt("line", 0), body.optInt("character", 0))
                    "/lsp/stop" -> AndroidLanguageServerHost.stop(body.optString("id", ""))
                    "/run" -> localTerminalRun(body)
                    "/term/start" -> localTerminalStart(body)
                    "/term/read" -> localTerminalRead(body)
                    "/term/write" -> localTerminalWrite(body)
                    "/term/resize" -> localTerminalResize(body)
                    "/term/stop", "/term/close", "/term/kill" -> localTerminalStop(body.optString("id", ""))
                    "/term/list" -> localTerminalList()
                    "/checkpoints/list" -> localCheckpointList()
                    "/checkpoints/create" -> localCheckpointCreate(body.optString("note", ""))
                    "/checkpoints/compare" -> localCheckpointCompare(body.optString("id", ""))
                    "/checkpoints/restore" -> localCheckpointRestore(body.optString("id", ""), body.optBoolean("removeAdded", false))
                    "/checkpoints/delete" -> localCheckpointDelete(body.optString("id", ""))
                    "/git/status" -> localGitStatus()
                    "/git/diff" -> localGitDiff(body)
                    "/git/stage" -> localGitStage(body)
                    "/git/unstage" -> localGitUnstage(body)
                    "/git/discard" -> localGitDiscard(body)
                    "/git/commit" -> localGitCommit(body)
                    "/git/log" -> localGitLog(body)
                    "/git/branches" -> localGitBranches()
                    "/git/init" -> localGitInit()
                    "/git/checkout" -> localGitCheckout(body)
                    "/git/remotes" -> localGitRemotes()
                    "/git/remote/add" -> localGitRemoteAdd(body)
                    "/git/remote/remove" -> localGitRemoteRemove(body)
                    "/git/fetch" -> localGitFetch(body)
                    "/git/push" -> localGitPush(body)
                    "/git/pull" -> localGitPull(body)
                    "/dev/health", "/dev/diagnostics", "/dev/tests", "/dev/lint", "/dev/deps", "/dev/format", "/dev/unused", "/ext/package/inspect" -> localDevEndpoint(pathname, body)
                    else -> throw UnsupportedOperationException("${pathname} is not implemented in the Android Local sandbox yet")
                }
                JSONObject().put("status", 200).put("data", data).toString()
            } catch (e: UnsupportedOperationException) {
                JSONObject().put("status", 501).put("error", e.message ?: "Not implemented locally").toString()
            } catch (e: SecurityException) {
                JSONObject().put("status", 403).put("error", e.message ?: "Local access denied").toString()
            } catch (e: Exception) {
                JSONObject().put("status", 400).put("error", e.message ?: "Local API request failed").toString()
            }
        }
        /**
         * True when the user has picked ANY local folder — SAF tree picker (workspace_tree_uri)
         * or the built-in device-storage browser (workspace_dir, used for internal-storage
         * folders). Must live on NativeAgentBridge so the WebUI sees
         * window.CodeSpaceNative.hasLocalWorkspace and routes file/workspace calls to the device
         * in remote modes (otherwise /info hits the remote server with root:null).
         */
        @JavascriptInterface fun hasLocalWorkspace(): Boolean = hasSafWorkspace() || usesDeviceStorageWorkspace()

        /** Permission mode synced from the Web UI so native file approvals match the UI setting. */
        @JavascriptInterface fun setPermissionMode(mode: String) {
            val safe = when (mode.trim().lowercase()) {
                "all", "ask", "smart", "auto" -> mode.trim().lowercase()
                else -> return
            }
            prefs.edit().putString("uwb_perm_mode", safe).apply()
        }
    }


    private fun localSkillInstall(body: JSONObject): JSONObject {
        val scope = body.optString("scope", "user")
        val name = body.optString("name", "").take(64)
        val source = body.optString("source", "").take(2048)
        val content = body.optString("content", "")
        require(content.length <= 1_000_000) { "Skill content exceeds 1 MB" }
        val target = if (scope == "project") File(localRoot, ".agent/skills/$name") else File(filesDir, "skills/$name")
        if (!requestLocalApproval("Install or replace local skill", "Scope: $scope\nName: $name\nSource: ${source.take(400)}\nTarget: ${target.absolutePath}")) throw SecurityException("Skill installation was denied")
        return AndroidLocalSkills.install(File(filesDir, "skills"), File(localRoot, ".agent/skills"), name, content, source, scope)
    }

    private fun localSkillRemove(body: JSONObject): JSONObject {
        val name = body.optString("name", "")
        if (!requestLocalApproval("Remove local skill", name)) throw SecurityException("Skill removal was denied")
        return AndroidLocalSkills.remove(File(filesDir, "skills"), File(localRoot, ".agent/skills"), name)
    }

    private fun localMcpConnect(body: JSONObject): JSONObject {
        val id = body.optString("id", "").ifBlank { "mcp_" + java.util.UUID.randomUUID().toString().replace("-", "").take(12) }
        val endpoint = body.optString("endpoint", body.optString("url", ""))
        val label = body.optString("name", body.optString("label", id))
        if (!requestLocalApproval("Connect to MCP server", "$label\n$endpoint\nCredentials are held in memory only and are not saved to workspace files.")) throw SecurityException("MCP connection was denied")
        return AndroidLocalMcp.connect(id, label, endpoint, body.optString("token", ""))
    }

    private fun localMcpStdioConnect(body: JSONObject): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Local MCP stdio servers require the app-private workspace")
        val id = body.optString("id", "").ifBlank { "mcp_" + java.util.UUID.randomUUID().toString().replace("-", "").take(12) }
        val executable = body.optString("executable", "")
        val name = body.optString("name", id)
        val argsArray = body.optJSONArray("args") ?: org.json.JSONArray()
        val args = (0 until argsArray.length()).map { argsArray.optString(it) }
        val cwd = safeFile(body.optString("cwd", ".")).canonicalPath
        if (!requestLocalApproval("Start local MCP stdio server", "Name: $name\nExecutable: $executable\nArguments: ${args.joinToString(" ").take(600)}\nWorking folder: $cwd\nThe server process runs with the CodeSpace Android app's permissions.")) throw SecurityException("MCP stdio launch was denied")
        return AndroidLocalMcp.connectStdio(id, name, executable, args, cwd, localRoot)
    }

    private fun localMcpToolCall(body: JSONObject): JSONObject {
        val id = body.optString("id", "")
        val name = body.optString("name", "")
        val tools = AndroidLocalMcp.listTools(id).optJSONArray("tools") ?: org.json.JSONArray()
        val metadata = (0 until tools.length()).mapNotNull { tools.optJSONObject(it) }.firstOrNull { it.optString("name") == name }
        require(metadata != null) { "MCP tool was not advertised by the connected server" }
        val args = body.optJSONObject("arguments") ?: JSONObject()
        val description = metadata.optString("description", "").take(500)
        if (!requestLocalApproval("Run MCP tool: $name", "Server: $id\n$description\nArguments: ${args.toString().take(1200)}")) throw SecurityException("MCP tool execution was denied")
        return AndroidLocalMcp.callTool(id, name, args)
    }

    private fun localDatabaseOpen(body: JSONObject): JSONObject {
        require(!hasSafWorkspace()) { "Local SQLite database tools require the app-private workspace" }
        val name = body.optString("name", "")
        val create = body.optBoolean("create", false)
        if (create && !requestLocalApproval("Create local SQLite database", name)) throw SecurityException("Database creation was denied")
        return AndroidLocalDatabase.open(localRoot, name, create)
    }

    private fun localDatabaseQuery(body: JSONObject): JSONObject {
        require(!hasSafWorkspace()) { "Local SQLite database tools require the app-private workspace" }
        val sql = body.optString("sql", "")
        val readOnly = sql.trimStart().startsWith("SELECT", true) || sql.trimStart().startsWith("WITH", true) || sql.trimStart().startsWith("EXPLAIN", true) || Regex("^PRAGMA\\s+(table_info|table_xinfo|table_list|index_list|index_info|foreign_key_list|database_list|compile_options|foreign_key_check)\\b", RegexOption.IGNORE_CASE).containsMatchIn(sql.trim())
        if (!readOnly && !requestLocalApproval("Execute SQLite write statement", "Database: ${body.optString("name")}\nSQL: ${sql.take(1000)}")) throw SecurityException("Database write was denied")
        return AndroidLocalDatabase.query(localRoot, body.optString("name", ""), sql)
    }

    private fun localLanguageServerResolveBin(packageName: String, commandName: String): String? {
        val root = localRoot.canonicalFile
        val modules = File(root, "node_modules")
        if (!modules.isDirectory || java.nio.file.Files.isSymbolicLink(modules.toPath())) return null
        val rawPackageDir = File(modules, packageName)
        if (java.nio.file.Files.isSymbolicLink(rawPackageDir.toPath())) return null
        val packageDir = rawPackageDir.canonicalFile
        val modulesRoot = modules.canonicalFile
        if (!packageDir.path.startsWith(modulesRoot.path + File.separator) || !packageDir.isDirectory) return null
        val manifest = File(packageDir, "package.json")
        if (!manifest.isFile || manifest.length() > 1_000_000L || java.nio.file.Files.isSymbolicLink(manifest.toPath())) return null
        val packageJson = runCatching { JSONObject(manifest.readText(Charsets.UTF_8)) }.getOrNull() ?: return null
        val bin = packageJson.opt("bin")
        val raw = when (bin) {
            is String -> bin
            is JSONObject -> bin.optString(commandName, "")
            else -> ""
        }.trim()
        if (raw.isBlank() || raw.length > 1024 || raw.contains('\\') || raw.contains('\u0000')) return null
        val relative = raw.removePrefix("./")
        if (File(relative).isAbsolute || relative.split('/').any { it.isBlank() || it == "." || it == ".." }) return null
        var rawTarget = packageDir
        for (part in relative.split('/')) {
            rawTarget = File(rawTarget, part)
            if (java.nio.file.Files.isSymbolicLink(rawTarget.toPath())) return null
        }
        val target = rawTarget.canonicalFile
        if (!target.path.startsWith(packageDir.path + File.separator) || !target.isFile) return null
        val extension = target.extension.lowercase()
        val nodeShebang = if (extension.isBlank()) runCatching {
            target.bufferedReader().use { it.readLine()?.trim()?.let { line -> line.startsWith("#!") && line.contains("node", true) } == true }
        }.getOrDefault(false) else false
        if (extension !in setOf("js", "cjs", "mjs") && !nodeShebang) return null
        return root.toPath().relativize(target.toPath()).toString().replace(File.separatorChar, '/')
    }

    @Synchronized
    private fun localLanguageServerSetupBaseline(): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Language-server setup requires the app-private Local workspace.")
        val root = localRoot.canonicalFile
        val toolsDir = File(root, ".codespace-tools")
        val rawConfigFile = File(toolsDir, "lsp.json")
        require(!java.nio.file.Files.isSymbolicLink(toolsDir.toPath()) && !java.nio.file.Files.isSymbolicLink(rawConfigFile.toPath())) {
            "LSP configuration path cannot contain a symbolic link"
        }
        require(!toolsDir.exists() || toolsDir.isDirectory) { "LSP tools path is not a directory" }
        val configFile = rawConfigFile.canonicalFile
        require(configFile.path.startsWith(root.path + File.separator)) { "Invalid LSP configuration location" }
        require(!rawConfigFile.exists() || rawConfigFile.isFile) { "LSP configuration path is not a regular file" }
        val currentConfig = if (configFile.isFile) {
            require(configFile.length() <= 32_000L) { "LSP configuration exceeds 32 KB" }
            JSONObject(configFile.readText(Charsets.UTF_8))
        } else JSONObject()
        require(!currentConfig.has("servers") || currentConfig.optJSONArray("servers") != null) { "LSP configuration 'servers' must be an array" }
        val currentServers = currentConfig.optJSONArray("servers") ?: JSONArray()
        require(currentServers.length() <= 64) { "LSP configuration contains too many server entries" }

        val baselinePackages = listOf(
            "typescript-language-server" to listOf("typescript-language-server"),
            "pyright" to listOf("pyright-langserver"),
            "vscode-langservers-extracted" to listOf("vscode-html-language-server", "vscode-css-language-server", "vscode-json-language-server")
        )
        val beforeRows = AndroidNodePackageManager.list(localRoot).optJSONArray("packages") ?: JSONArray()
        val beforeNames = (0 until beforeRows.length()).mapNotNull { beforeRows.optJSONObject(it)?.optString("name") }.toSet()
        val specs = baselinePackages.filter { (name, bins) -> name !in beforeNames || bins.any { localLanguageServerResolveBin(name, it) == null } }
            .map { it.first }.distinct().let { missing -> if ("typescript" !in beforeNames) missing + "typescript" else missing }
        if (!requestLocalApproval(
                if (specs.isEmpty()) "Configure baseline language servers" else "Install baseline language servers",
                "Packages to install or repair: ${if (specs.isEmpty()) "none" else specs.joinToString(", ")}\nLanguages: JavaScript, TypeScript, Python, HTML, CSS/SCSS and JSON\nProject: ${localRoot.absolutePath}\nDownloads use the official npm registry. Lifecycle scripts remain disabled; native add-ons and peer-dependency conflict solving are not supported."
            )) throw SecurityException("Language-server setup was denied")
        if (!toolsDir.exists()) require(toolsDir.mkdirs()) { "Could not create the Local language-server configuration directory" }

        val install = if (specs.isEmpty()) JSONObject().put("installed", JSONArray()).put("failed", JSONArray())
            else AndroidNodePackageManager.install(localRoot, specs)
        val installedRows = install.optJSONArray("installed") ?: JSONArray()
        val installedPackages = AndroidNodePackageManager.list(localRoot).optJSONArray("packages") ?: JSONArray()
        val installedNames = (0 until installedPackages.length()).mapNotNull { installedPackages.optJSONObject(it)?.optString("name") }.toSet()
        val existingLanguages = mutableSetOf<String>()
        val merged = JSONArray()
        val unavailable = JSONArray()
        for (i in 0 until currentServers.length()) {
            val entry = currentServers.optJSONObject(i) ?: continue
            val language = entry.optString("language", "").trim().lowercase()
            val executable = entry.optString("executable", "").trim()
            val args = entry.optJSONArray("args") ?: JSONArray()
            val valid = runCatching {
                if (language.isBlank() || executable.isBlank()) false
                else if (executable == "node") {
                    if (args.length() == 0) false else {
                        val raw = args.optString(0)
                        val script = (if (File(raw).isAbsolute) File(raw) else File(root, raw)).canonicalFile
                        script.isFile && script.path.startsWith(root.path + File.separator) && script.extension.lowercase() in setOf("js", "cjs", "mjs")
                    }
                } else {
                    val binRoot = File(root, ".codespace-tools/bin").canonicalFile
                    val bin = (if (File(executable).isAbsolute) File(executable) else File(root, executable)).canonicalFile
                    bin.isFile && bin.canExecute() && bin.path.startsWith(binRoot.path + File.separator)
                }
            }.getOrDefault(false)
            if (valid) { merged.put(JSONObject(entry.toString())); existingLanguages.add(language) }
            else unavailable.put(JSONObject().put("language", language).put("reason", "Removed stale language-server configuration; the executable or entrypoint is missing or outside the trusted tools/workspace directory"))
        }
        val added = JSONArray()

        fun addServer(language: String, packageName: String, binName: String) {
            if (language in existingLanguages) return
            val missingTypeScriptPeer = packageName == "typescript-language-server" && "typescript" !in installedNames
            if (packageName !in installedNames || missingTypeScriptPeer) {
                unavailable.put(JSONObject().put("language", language)
                    .put("package", if (missingTypeScriptPeer) "typescript" else packageName)
                    .put("reason", if (missingTypeScriptPeer) "TypeScript peer package was not installed" else "Package was not installed"))
                return
            }
            val entrypoint = localLanguageServerResolveBin(packageName, binName)
            if (entrypoint == null) {
                unavailable.put(JSONObject().put("language", language).put("package", packageName).put("reason", "Could not resolve a safe JavaScript entrypoint from package.json"))
                return
            }
            val server = JSONObject().put("language", language).put("executable", "node")
                .put("args", JSONArray().put(entrypoint).put("--stdio"))
            merged.put(server); added.put(server); existingLanguages.add(language)
        }

        addServer("javascript", "typescript-language-server", "typescript-language-server")
        addServer("typescript", "typescript-language-server", "typescript-language-server")
        addServer("python", "pyright", "pyright-langserver")
        addServer("html", "vscode-langservers-extracted", "vscode-html-language-server")
        addServer("css", "vscode-langservers-extracted", "vscode-css-language-server")
        addServer("scss", "vscode-langservers-extracted", "vscode-css-language-server")
        addServer("json", "vscode-langservers-extracted", "vscode-json-language-server")

        currentConfig.put("servers", merged)
        val temporary = File(toolsDir, "lsp.json.codespace.tmp")
        try {
            temporary.writeText(currentConfig.toString(2) + "\n", Charsets.UTF_8)
            try {
                java.nio.file.Files.move(
                    temporary.toPath(), configFile.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE
                )
            } catch (_: Exception) {
                java.nio.file.Files.move(temporary.toPath(), configFile.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        return JSONObject().put("installed", installedRows).put("installFailures", install.optJSONArray("failed") ?: JSONArray())
            .put("configured", added).put("unavailable", unavailable).put("config", ".codespace-tools/lsp.json")
            .put("scriptsRun", false).put("message", if (unavailable.length() == 0) "Baseline language servers are installed and configured. Open a supported file to start its server." else "Some language servers could not be configured; see unavailable entries.")
    }

    private fun localLanguageServerAutoStart(body: JSONObject): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Language servers currently require the app-private Local workspace.")
        val language = body.optString("language", "").trim().lowercase()
        require(language.matches(Regex("^[a-z0-9_+.-]{1,64}$"))) { "Invalid language ID" }
        val configFile = File(localRoot, ".codespace-tools/lsp.json").canonicalFile
        require(configFile.path.startsWith(localRoot.canonicalPath + File.separator)) { "Invalid LSP configuration location" }
        if (!configFile.isFile) return JSONObject().put("configured", false).put("available", false).put("reason", "Create .codespace-tools/lsp.json to configure a language server")
        require(configFile.length() <= 32_000L) { "LSP configuration exceeds 32 KB" }
        val config = JSONObject(configFile.readText(Charsets.UTF_8))
        val entries = config.optJSONArray("servers") ?: org.json.JSONArray()
        val entry = (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
            .firstOrNull { it.optString("language", "").equals(language, true) }
            ?: return JSONObject().put("configured", true).put("available", false).put("reason", "No server configured for $language")
        val executableRaw = entry.optString("executable", "").trim()
        require(executableRaw.isNotBlank() && executableRaw.length <= 2048) { "Language server executable is missing" }
        val executable = if (executableRaw == "node") "node" else if (File(executableRaw).isAbsolute) File(executableRaw).canonicalPath else File(localRoot, executableRaw).canonicalPath
        val rawArgs = entry.optJSONArray("args") ?: org.json.JSONArray()
        require(rawArgs.length() <= 32) { "Too many language-server arguments" }
        val args = (0 until rawArgs.length()).map { rawArgs.optString(it) }
        val id = "lsp_${java.util.UUID.randomUUID().toString().replace("-", "").take(16)}"
        if (!requestLocalApproval("Start $language language server", "$executable\nArguments: ${args.joinToString(" ").take(500)}\nConfiguration: .codespace-tools/lsp.json")) {
            throw SecurityException("Starting the language server was denied")
        }
        return AndroidLanguageServerHost.start(localRoot, id, language, executable, args, File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so")).put("configured", true)
    }

    private fun localLanguageServerStart(body: JSONObject): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Language servers currently require the app-private Local workspace.")
        val id = body.optString("id", "").trim()
        val language = body.optString("language", "").trim()
        val executable = body.optString("executable", "").trim()
        val rawArgs = body.optJSONArray("args") ?: org.json.JSONArray()
        require(rawArgs.length() <= 32) { "Too many language-server arguments" }
        val args = (0 until rawArgs.length()).map { rawArgs.optString(it) }
        require(requestLocalApproval("Start language server ($language)", executable + if (args.isEmpty()) "" else "\nArguments: ${args.joinToString(" ").take(500)}")) { "Starting the language server was denied" }
        return AndroidLanguageServerHost.start(localRoot, id, language, executable, args, File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so"))
    }

    // Native workspace checkpoints. Snapshots are stored in app-private storage and use the
    // same exclusion/size policy for app-private and SAF workspaces. Restore always creates a
    // safety snapshot first; files added later are preserved unless the caller explicitly opts in.
    private val checkpointRoot by lazy { File(filesDir, "checkpoints").apply { mkdirs() } }
    private val checkpointMaxFiles = 5000
    private val checkpointMaxFileBytes = 8L * 1024L * 1024L
    private val checkpointMaxTotalBytes = 100L * 1024L * 1024L
    private fun checkpointId(raw: String): String {
        require(raw.matches(Regex("^[A-Za-z0-9_-]{8,64}$"))) { "Invalid checkpoint ID" }
        return raw
    }
    private fun checkpointMeta(id: String): File = File(File(checkpointRoot, checkpointId(id)), "meta.json")
    private fun checkpointZip(id: String): File = File(File(checkpointRoot, checkpointId(id)), "workspace.zip")
    private fun checkpointReadBytes(path: String, max: Long): ByteArray? {
        return if (hasSafWorkspace()) {
            val doc = try { safDocument(path) } catch (_: Exception) { null } ?: return null
            if (!doc.isFile || doc.length() > max) return null
            contentResolver.openInputStream(doc.uri)?.use { input -> input.readBytes().takeIf { it.size.toLong() <= max } }
        } else {
            val file = safeFile(path)
            if (!file.isFile || file.length() > max || file.isSymbolicLinkCompat()) return null
            file.inputStream().use { it.readBytes().takeIf { it.size.toLong() <= max } }
        }
    }
    private fun checkpointHash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun checkpointExcluded(path: String): Boolean {
        val n = path.substringAfterLast('/').lowercase()
        return path.split('/').any { it in setOf(".git", "node_modules", ".gradle", "build", "dist", "target", ".next", "vendor", "__pycache__") } ||
            n.startsWith(".env") || n.endsWith(".pem") || n.endsWith(".key") || n.endsWith(".p12") || n.endsWith(".pfx") || n in setOf("id_rsa", "id_ed25519", "credentials.json")
    }
    private fun localCheckpointCreate(note: String, internal: Boolean = false): JSONObject {
        val (items, inventoryTruncated) = localWorkspaceInventory(checkpointMaxFiles + 1)
        val id = "cp_" + java.util.UUID.randomUUID().toString().replace("-", "")
        val dir = File(checkpointRoot, id).apply { mkdirs() }
        val zipFile = File(dir, "workspace.zip")
        val skipped = JSONObject().put("tooLarge", 0).put("unreadable", 0).put("excluded", 0).put("totalLimit", 0)
        var count = 0; var total = 0L; var complete = !inventoryTruncated
        try {
            ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
                for (item in items) {
                    if (item.directory) continue
                    if (checkpointExcluded(item.path)) { skipped.put("excluded", skipped.optInt("excluded") + 1); complete = false; continue }
                    if (count >= checkpointMaxFiles) { skipped.put("totalLimit", skipped.optInt("totalLimit") + 1); complete = false; break }
                    if (item.size > checkpointMaxFileBytes) { skipped.put("tooLarge", skipped.optInt("tooLarge") + 1); complete = false; continue }
                    val bytes = try { checkpointReadBytes(item.path, checkpointMaxFileBytes) } catch (_: Exception) { null }
                    if (bytes == null) { skipped.put("unreadable", skipped.optInt("unreadable") + 1); complete = false; continue }
                    if (total + bytes.size > checkpointMaxTotalBytes) { skipped.put("totalLimit", skipped.optInt("totalLimit") + 1); complete = false; break }
                    val entry = ZipEntry(item.path).apply { time = item.modified.takeIf { it > 0 } ?: System.currentTimeMillis() }
                    zip.putNextEntry(entry); zip.write(bytes); zip.closeEntry()
                    total += bytes.size; count++
                }
            }
            val meta = JSONObject().put("id", id).put("note", note.take(200)).put("createdAt", System.currentTimeMillis())
                .put("fileCount", count).put("totalBytes", total).put("complete", complete).put("checkpointSkipped", skipped)
                .put("workspace", if (hasSafWorkspace()) "saf" else "app-private")
            checkpointMeta(id).writeText(meta.toString(), Charsets.UTF_8)
            checkpointTrim(id)
            return meta
        } catch (e: Exception) {
            dir.deleteRecursively(); throw e
        }
    }
    private fun checkpointTrim(keepId: String) {
        val dirs = checkpointRoot.listFiles()?.filter { it.isDirectory && checkpointMeta(it.name).isFile }?.sortedByDescending { it.lastModified() } ?: return
        var total = 0L
        dirs.forEachIndexed { index, dir ->
            val size = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
            total += size
            if (dir.name != keepId && (index >= 20 || total > 500L * 1024L * 1024L)) dir.deleteRecursively()
        }
    }
    private fun localCheckpointList(): JSONObject {
        val rows = org.json.JSONArray()
        checkpointRoot.listFiles()?.filter { it.isDirectory && checkpointMeta(it.name).isFile && checkpointZip(it.name).isFile }
            ?.sortedByDescending { checkpointMeta(it.name).lastModified() }?.take(50)?.forEach { dir ->
                try { rows.put(JSONObject(checkpointMeta(dir.name).readText(Charsets.UTF_8))) } catch (_: Exception) { }
            }
        return JSONObject().put("checkpoints", rows)
    }
    private fun checkpointReadEntry(zip: ZipInputStream, limit: Long): ByteArray {
        val out = ByteArrayOutputStream(); val buffer = ByteArray(16 * 1024); var count = 0L
        while (true) { val n = zip.read(buffer); if (n < 0) break; count += n; require(count <= limit) { "Checkpoint entry exceeds per-file limit" }; out.write(buffer, 0, n) }
        return out.toByteArray()
    }
    private fun checkpointEntries(id: String): LinkedHashMap<String, ByteArray> {
        val zipFile = checkpointZip(id); require(zipFile.isFile && zipFile.length() <= checkpointMaxTotalBytes + 2_000_000L) { "Checkpoint archive is missing or exceeds limits" }
        val out = linkedMapOf<String, ByteArray>(); var total = 0L
        ZipInputStream(zipFile.inputStream().buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (entry.isDirectory) { zip.closeEntry(); continue }
                val name = entry.name.replace('\\', '/')
                require(name.isNotBlank() && !name.startsWith('/') && !name.split('/').any { it == ".." || it.isBlank() } && !checkpointExcluded(name)) { "Unsafe path in checkpoint" }
                require(!out.containsKey(name) && out.size < checkpointMaxFiles) { "Checkpoint contains duplicate or too many files" }
                val bytes = checkpointReadEntry(zip, checkpointMaxFileBytes)
                require(total + bytes.size <= checkpointMaxTotalBytes) { "Checkpoint exceeds restore limits" }
                out[name] = bytes; total += bytes.size; zip.closeEntry()
            }
        }
        return out
    }
    private fun localCheckpointCompare(rawId: String): JSONObject {
        val id = checkpointId(rawId); val metaFile = checkpointMeta(id); require(metaFile.isFile) { "Checkpoint not found" }
        val meta = JSONObject(metaFile.readText(Charsets.UTF_8)); val saved = checkpointEntries(id)
        val (items, currentTruncated) = localWorkspaceInventory(checkpointMaxFiles + 1)
        val current = items.filter { !it.directory && !checkpointExcluded(it.path) }.associateBy { it.path }
        val modified = org.json.JSONArray(); val missing = org.json.JSONArray(); val added = org.json.JSONArray()
        for ((path, bytes) in saved) {
            val now = current[path]
            if (now == null) missing.put(path) else {
                val actual = checkpointReadBytes(path, checkpointMaxFileBytes)
                if (actual == null || checkpointHash(actual) != checkpointHash(bytes)) modified.put(path)
            }
        }
        current.keys.filter { !saved.containsKey(it) }.sorted().forEach { added.put(it) }
        val skipped = meta.optJSONObject("checkpointSkipped") ?: JSONObject()
        return JSONObject().put("id", id).put("modified", modified).put("missing", missing).put("added", added)
            .put("modifiedCount", modified.length()).put("missingCount", missing.length()).put("addedCount", added.length())
            .put("complete", meta.optBoolean("complete", false) && !currentTruncated)
            .put("checkpointSkipped", skipped)
    }
    private fun localCheckpointRestore(rawId: String, removeAdded: Boolean): JSONObject {
        val id = checkpointId(rawId); val meta = JSONObject(checkpointMeta(id).readText(Charsets.UTF_8))
        val cmp = localCheckpointCompare(id); val modified = cmp.optJSONArray("modified")!!; val missing = cmp.optJSONArray("missing")!!; val added = cmp.optJSONArray("added")!!
        require(modified.length() + missing.length() + (if (removeAdded) added.length() else 0) > 0) { "Workspace already matches this checkpoint" }
        if (removeAdded) require(cmp.optBoolean("complete")) { "Cannot delete later-added files because the checkpoint or current scan is incomplete" }
        if (!requestLocalApproval("Restore workspace checkpoint", "${modified.length()} modified, ${missing.length()} missing${if (removeAdded) ", ${added.length()} added files to delete" else "; later-added files will be kept"}")) throw SecurityException("Checkpoint restore was denied")
        val safety = localCheckpointCreate("Safety before restore of $id", true)
        val saved = checkpointEntries(id); var restored = 0; var removed = 0
        val targets = linkedSetOf<String>()
        for (i in 0 until modified.length()) targets.add(modified.getString(i))
        for (i in 0 until missing.length()) targets.add(missing.getString(i))
        targets.forEach { path ->
            val bytes = saved[path] ?: return@forEach
            if (hasSafWorkspace()) {
                val rel = safRelative(path); val parts = rel.split('/'); var parent = safRoot()
                for (part in parts.dropLast(1)) parent = parent.findFile(part) ?: parent.createDirectory(part) ?: throw IllegalStateException("Could not recreate folder for $path")
                val name = parts.last(); val existing = parent.findFile(name)
                require(existing == null || existing.isFile) { "Cannot overwrite a directory: $path" }
                val doc = existing ?: parent.createFile("application/octet-stream", name) ?: throw IllegalStateException("Could not recreate $path")
                contentResolver.openOutputStream(doc.uri, "wt")?.use { it.write(bytes) } ?: throw IllegalStateException("Could not write $path")
            } else {
                val target = safeFile(path); target.parentFile?.mkdirs(); target.outputStream().use { it.write(bytes) }
            }
            restored++
        }
        if (removeAdded) for (i in 0 until added.length()) {
            val path = added.getString(i)
            val ok = if (hasSafWorkspace()) {
                val doc = try { safDocument(path) } catch (_: Exception) { null }
                doc != null && doc.isFile && doc.delete()
            } else {
                val f = safeFile(path); f.isFile && !f.isSymbolicLinkCompat() && f.delete()
            }
            if (ok) removed++
        }
        return JSONObject().put("ok", true).put("restoredCount", restored).put("removedAddedCount", removed)
            .put("safetyCheckpointId", safety.optString("id")).put("safetyCheckpointComplete", safety.optBoolean("complete"))
            .put("incompleteCheckpoint", !meta.optBoolean("complete", false) || !cmp.optBoolean("complete", false))
    }
    private fun localCheckpointDelete(rawId: String): JSONObject {
        val id = checkpointId(rawId); require(checkpointMeta(id).isFile) { "Checkpoint not found" }
        if (!requestLocalApproval("Delete workspace checkpoint", id)) throw SecurityException("Checkpoint deletion was denied")
        val dir = File(checkpointRoot, id); require(dir.canonicalPath.startsWith(checkpointRoot.canonicalPath + File.separator))
        require(dir.deleteRecursively()) { "Could not delete checkpoint" }
        return JSONObject().put("ok", true).put("id", id)
    }

    // Native JGit support for the app-private workspace. SAF document trees are intentionally
    // excluded because JGit requires random-access filesystem semantics that DocumentFile does not provide.
    private fun localGitRequireWorkspace(): File {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Native Git currently supports the app-private Local workspace. SAF folder Git is not available yet.")
        val rootDir = localRoot.canonicalFile
        require(rootDir.isDirectory) { "Local workspace is unavailable" }
        return rootDir
    }

    private fun localGitOpen(): Git {
        val rootDir = localGitRequireWorkspace()
        val gitDir = File(rootDir, ".git")
        if (!gitDir.exists() || !gitDir.isDirectory) throw IllegalStateException("This workspace is not a standard Git repository. Initialize a repository first; linked worktrees are not supported yet.")
        return Git.open(rootDir)
    }

    private fun localGitPath(raw: String): String {
        val value = raw.replace('\\', '/').trim()
        require(value.isNotEmpty() && value.length <= 1024 && !value.startsWith('/') && !value.matches(Regex("^[A-Za-z]:.*"))) { "Invalid Git path" }
        val parts = value.split('/')
        require(parts.none { it.isBlank() || it == "." || it == ".." }) { "Git path must stay inside the workspace" }
        require(parts.firstOrNull() != ".git") { "Direct .git access is not allowed" }
        return parts.joinToString("/")
    }

    private fun localGitStatus(): JSONObject {
        val rootDir = localGitRequireWorkspace()
        val gitDir = File(rootDir, ".git")
        if (!gitDir.exists()) return JSONObject().put("isRepo", false)
        localGitOpen().use { git ->
            val st = git.status().call()
            val branch = try { git.repository.branch ?: "" } catch (_: Exception) { "" }
            val remote = try { git.repository.config.getString("branch", branch, "remote") ?: "" } catch (_: Exception) { "" }
            val mergeRef = try { git.repository.config.getString("branch", branch, "merge") ?: "" } catch (_: Exception) { "" }
            val trackingRef = if (remote == ".") mergeRef else if (remote.isNotBlank() && mergeRef.startsWith("refs/heads/")) "refs/remotes/$remote/${mergeRef.removePrefix("refs/heads/")}" else ""
            val upstream = if (trackingRef.isNotBlank()) trackingRef.removePrefix("refs/remotes/") else ""
            val (ahead, behind) = try {
                val head = git.repository.resolve(Constants.HEAD)
                val base = if (trackingRef.isNotBlank()) git.repository.resolve(trackingRef) else null
                if (head != null && base != null) Pair(git.log().addRange(base, head).call().count(), git.log().addRange(head, base).call().count()) else Pair(0, 0)
            } catch (_: Exception) { Pair(0, 0) }
            val files = org.json.JSONArray()
            fun add(paths: Set<String>, index: String, work: String, untracked: Boolean = false) {
                paths.sorted().take(800 - files.length()).forEach { path -> files.put(JSONObject().put("path", path).put("index", index).put("work", work).put("untracked", untracked)) }
            }
            add(st.added, "A", "")
            add(st.changed, "M", "")
            add(st.removed, "D", "")
            add(st.missing, "", "D")
            add(st.modified, "", "M")
            add(st.conflicting, "U", "U")
            add(st.untracked, "", "U", true)
            return JSONObject().put("isRepo", true).put("branch", branch).put("upstream", upstream)
                .put("ahead", ahead).put("behind", behind).put("files", files)
        }
    }

    private fun localGitDiff(body: JSONObject): JSONObject {
        localGitOpen().use { git ->
            val out = ByteArrayOutputStream()
            val path = if (body.optBoolean("all")) "" else localGitPath(body.optString("path", ""))
            DiffFormatter(out).use { fmt ->
                fmt.setRepository(git.repository)
                fmt.setDetectRenames(true)
                val cmd = git.diff().setShowNameAndStatusOnly(false)
                if (body.optBoolean("staged")) cmd.setCached(true)
                if (path.isNotEmpty()) cmd.setPathFilter(PathFilter.create(path))
                fmt.format(cmd.call())
            }
            var patch = out.toString(Charsets.UTF_8.name())
            if (!body.optBoolean("staged") && body.optBoolean("untracked") && path.isNotEmpty()) {
                val f = File(localGitRequireWorkspace(), path).canonicalFile
                require(f.path.startsWith(localGitRequireWorkspace().canonicalPath + File.separator)) { "Git path escapes workspace" }
                if (f.isFile && f.length() <= 1_000_000L) {
                    val lines = f.readLines(Charsets.UTF_8).take(12000)
                    patch = "--- /dev/null\n+++ b/$path\n@@ -0,0 +1,${lines.size} @@\n" + lines.joinToString("\n") { "+$it" } + if (lines.isEmpty()) "" else "\n"
                }
            }
            return JSONObject().put("patch", patch.take(body.optInt("max", 300000).coerceIn(1000, 300000)))
        }
    }

    private fun localGitPaths(body: JSONObject): List<String> {
        val arr = body.optJSONArray("paths")
        val raw = if (arr != null) (0 until arr.length()).map { arr.optString(it) } else listOf(body.optString("path", ""))
        require(raw.isNotEmpty() && raw.size <= 200) { "Select between 1 and 200 paths" }
        return raw.map { localGitPath(it) }.distinct()
    }

    private fun localGitStage(body: JSONObject): JSONObject {
        val paths = localGitPaths(body)
        if (!requestLocalApproval("Stage Git changes", paths.joinToString(", ").take(700))) throw SecurityException("Git staging was denied")
        localGitOpen().use { git -> paths.forEach { git.add().addFilepattern(it).call() } }
        return JSONObject().put("ok", true).put("staged", org.json.JSONArray(paths))
    }

    private fun localGitUnstage(body: JSONObject): JSONObject {
        val paths = localGitPaths(body)
        if (!requestLocalApproval("Unstage Git changes", paths.joinToString(", ").take(700))) throw SecurityException("Git unstage was denied")
        localGitOpen().use { git -> paths.forEach { git.reset().addPath(it).call() } }
        return JSONObject().put("ok", true)
    }

    private fun localGitDiscard(body: JSONObject): JSONObject {
        val path = localGitPath(body.optString("path", ""))
        if (!requestLocalApproval("Discard Git changes", path)) throw SecurityException("Git discard was denied")
        val target = File(localGitRequireWorkspace(), path).canonicalFile
        require(target.path.startsWith(localGitRequireWorkspace().canonicalPath + File.separator)) { "Git path escapes workspace" }
        localGitOpen().use { git ->
            if (body.optBoolean("untracked")) {
                if (target.isDirectory) target.deleteRecursively() else if (target.exists()) target.delete()
            } else {
                val repoPath = git.repository.workTree.canonicalFile.toPath().relativize(target.toPath()).toString().replace('\\', '/')
                git.checkout().addPath(repoPath).call()
                git.reset().addPath(repoPath).call()
            }
        }
        return JSONObject().put("ok", true)
    }

    private fun localGitCommit(body: JSONObject): JSONObject {
        val message = body.optString("message", "").trim()
        require(message.isNotEmpty() && message.length <= 500) { "Write a commit message (maximum 500 characters)" }
        if (!requestLocalApproval("Create Git commit", message)) throw SecurityException("Git commit was denied")
        val name = prefs.getString("git_user_name", "CodeSpace Android")!!.trim().ifEmpty { "CodeSpace Android" }
        val email = prefs.getString("git_user_email", "codespace@localhost")!!.trim().ifEmpty { "codespace@localhost" }
        require(email.length <= 254 && email.contains('@')) { "Set a valid Git author email in Android settings" }
        localGitOpen().use { git ->
            if (body.optBoolean("all")) git.add().addFilepattern(".").setUpdate(false).call()
            val commit = git.commit().setMessage(message).setAuthor(PersonIdent(name.take(100), email)).call()
            return JSONObject().put("ok", true).put("out", "[${commit.name.take(7)}] ${commit.shortMessage}").put("hash", commit.name)
        }
    }

    private fun localGitLog(body: JSONObject): JSONObject {
        val rows = org.json.JSONArray()
        try {
            localGitOpen().use { git ->
                git.log().setMaxCount(body.optInt("n", 15).coerceIn(1, 50)).call().forEach { c ->
                    rows.put(JSONObject().put("hash", c.name.take(7)).put("subject", c.shortMessage)
                        .put("author", c.authorIdent?.name ?: "Unknown").put("when", android.text.format.DateUtils.getRelativeTimeSpanString(c.commitTime * 1000L).toString()))
                }
            }
        } catch (e: IllegalStateException) { if (!e.message.orEmpty().contains("not a Git repository")) throw e }
        return JSONObject().put("commits", rows)
    }

    private fun localGitBranches(): JSONObject {
        val branches = org.json.JSONArray()
        localGitOpen().use { git ->
            git.branchList().setListMode(org.eclipse.jgit.api.ListBranchCommand.ListMode.ALL).call()
                .filter { it.name.startsWith("refs/heads/") }.forEach { branches.put(it.name.removePrefix("refs/heads/")) }
        }
        return JSONObject().put("branches", branches)
    }

    private fun localGitInit(): JSONObject {
        val rootDir = localGitRequireWorkspace()
        if (!requestLocalApproval("Initialize Git repository", rootDir.name)) throw SecurityException("Git initialization was denied")
        Git.init().setDirectory(rootDir).call().use { }
        return JSONObject().put("ok", true)
    }

    private fun localGitCheckout(body: JSONObject): JSONObject {
        val branch = body.optString("branch", "").trim()
        require(branch.matches(Regex("^[A-Za-z0-9_./-]{1,100}$")) && !branch.startsWith("-") && !branch.contains("..")) { "Invalid branch name" }
        if (!requestLocalApproval(if (body.optBoolean("create")) "Create Git branch" else "Switch Git branch", branch)) throw SecurityException("Git checkout was denied")
        localGitOpen().use { git ->
            val cmd = git.checkout().setName(branch)
            if (body.optBoolean("create")) cmd.setCreateBranch(true)
            cmd.call()
        }
        return JSONObject().put("ok", true).put("branch", branch)
    }


    private fun localGitRemoteName(raw: String): String {
        val name = raw.trim()
        require(name.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")) && !name.endsWith(".")) { "Invalid Git remote name" }
        return name
    }

    private fun localGitBranchName(git: Git, raw: String = ""): String {
        val branch = raw.trim().ifBlank { git.repository.branch ?: "" }
        require(branch.isNotBlank() && branch != "HEAD" && branch.matches(Regex("^[A-Za-z0-9_./-]{1,120}$")) &&
            !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/") &&
            !branch.contains("..") && !branch.contains("//") && !branch.endsWith(".lock")) { "A valid checked-out branch is required; detached HEAD is not supported" }
        return branch
    }

    private fun localGitSafeRemoteUrl(raw: String): String {
        return try {
            val uri = java.net.URI(raw)
            if (uri.host != null) java.net.URI(uri.scheme, null, uri.host, uri.port, uri.path, null, null).toASCIIString().take(1000)
            else raw.replace(Regex("(?i)(https?://)[^/@]+@"), "$1•••@").take(1000)
        } catch (_: Exception) {
            raw.replace(Regex("(?i)(https?://)[^/@]+@"), "$1•••@").take(1000)
        }
    }

    private fun localGitRequireHttpsRemote(git: Git, nameRaw: String): String {
        val name = localGitRemoteName(nameRaw)
        val remote = git.remoteList().call().firstOrNull { it.name == name }
            ?: throw IllegalArgumentException("Git remote '$name' was not found")
        val fetchUris = remote.getURIs()
        require(fetchUris.isNotEmpty()) { "Git remote '$name' has no fetch URL" }
        fetchUris.forEach { fetchUri ->
            val fetch = try { java.net.URI(fetchUri.toString()) } catch (_: Exception) { throw IllegalArgumentException("Remote '$name' has an invalid fetch URL") }
            require(fetch.scheme.equals("https", true) && !fetch.host.isNullOrBlank() && fetch.rawUserInfo == null && fetch.query == null && fetch.fragment == null) {
                "Android Local Git supports HTTPS remotes without embedded credentials. Remove and re-add this remote using clean HTTPS URLs."
            }
        }
        remote.getPushURIs().forEach { pushUri ->
            val push = try { java.net.URI(pushUri.toString()) } catch (_: Exception) { throw IllegalArgumentException("Remote '$name' has an invalid push URL") }
            require(push.scheme.equals("https", true) && !push.host.isNullOrBlank() && push.rawUserInfo == null && push.query == null && push.fragment == null) {
                "Android Local Git only pushes to clean HTTPS URLs. Remove the remote's unsupported push URL before continuing."
            }
        }
        return name
    }

    private fun localGitCredentials(body: JSONObject): UsernamePasswordCredentialsProvider? {
        val secret = body.optString("token", "")
        require(secret.length <= 4096 && secret.none { it == '\n' || it == '\r' || it == '\u0000' }) { "Git credential is too long or contains invalid characters" }
        if (secret.isBlank()) return null
        val username = body.optString("username", "").trim().ifBlank { "x-access-token" }
        require(username.length in 1..256 && username.none { it.isISOControl() }) { "Invalid Git HTTPS username" }
        return UsernamePasswordCredentialsProvider(username, secret.toCharArray())
    }

    private fun localGitSetUpstream(git: Git, branch: String, remote: String, remoteBranch: String) {
        val config = git.repository.config
        config.setString("branch", branch, "remote", remote)
        config.setString("branch", branch, "merge", "refs/heads/$remoteBranch")
        config.save()
    }

    private fun localGitRemotes(): JSONObject {
        val rows = org.json.JSONArray()
        localGitOpen().use { git ->
            git.remoteList().call().forEach { remote ->
                val urls = remote.getURIs()
                val pushUrls = remote.getPushURIs()
                rows.put(JSONObject().put("name", remote.name)
                    .put("url", urls.firstOrNull()?.toString()?.let { localGitSafeRemoteUrl(it) } ?: "")
                    .put("pushUrl", pushUrls.firstOrNull()?.toString()?.let { localGitSafeRemoteUrl(it) } ?: "")
                    .put("fetchUrls", urls.size).put("pushUrls", pushUrls.size))
            }
        }
        return JSONObject().put("remotes", rows)
    }

    private fun localGitRemoteAdd(body: JSONObject): JSONObject {
        val name = localGitRemoteName(body.optString("name", "origin"))
        val rawUrl = body.optString("url", "").trim()
        require(rawUrl.length in 12..2048) { "Enter an HTTPS Git remote URL" }
        val parsed = try { java.net.URI(rawUrl) } catch (_: Exception) { throw IllegalArgumentException("The Git remote URL is invalid") }
        require(parsed.scheme.equals("https", true) && !parsed.host.isNullOrBlank() && parsed.rawUserInfo == null && parsed.query == null && parsed.fragment == null && !parsed.path.isNullOrBlank()) {
            "Use a clean HTTPS URL, for example https://github.com/owner/repository.git. Do not put a token in the URL."
        }
        if (!requestLocalApproval("Add HTTPS Git remote", "$name → ${localGitSafeRemoteUrl(rawUrl)}")) throw SecurityException("Adding the Git remote was denied")
        localGitOpen().use { git ->
            require(git.remoteList().call().none { it.name == name }) { "A Git remote named '$name' already exists" }
            git.remoteAdd().setName(name).setUri(URIish(rawUrl)).call()
        }
        return JSONObject().put("ok", true).put("remote", name).put("url", localGitSafeRemoteUrl(rawUrl))
    }

    private fun localGitRemoteRemove(body: JSONObject): JSONObject {
        val name = localGitRemoteName(body.optString("name", ""))
        if (!requestLocalApproval("Remove Git remote", name)) throw SecurityException("Removing the Git remote was denied")
        localGitOpen().use { git ->
            require(git.repository.config.getString("remote", name, "url") != null) { "Git remote '$name' was not found" }
            val config = git.repository.config
            config.getSubsections("branch").toList().forEach { branch ->
                if (config.getString("branch", branch, "remote") == name) {
                    config.unset("branch", branch, "remote")
                    config.unset("branch", branch, "merge")
                }
            }
            config.save()
            git.remoteRemove().apply { setName(name) }.call()
        }
        return JSONObject().put("ok", true).put("removed", name)
    }

    private fun localGitResolveRemote(git: Git, body: JSONObject, branch: String): String {
        val configured = git.repository.config.getString("branch", branch, "remote") ?: ""
        val requested = body.optString("remote", "").trim()
        val name = localGitRemoteName(requested.ifBlank { configured.ifBlank { "origin" } })
        return localGitRequireHttpsRemote(git, name)
    }

    private fun localGitResolveRemoteBranch(git: Git, body: JSONObject, branch: String): String {
        val configured = git.repository.config.getString("branch", branch, "merge")
            ?.removePrefix("refs/heads/").orEmpty()
        val name = body.optString("remoteBranch", "").trim().ifBlank { configured.ifBlank { branch } }
        require(name.matches(Regex("^[A-Za-z0-9_./-]{1,120}$")) && !name.startsWith("-") && !name.startsWith("/") &&
            !name.endsWith("/") && !name.contains("..") && !name.contains("//") && !name.endsWith(".lock")) { "Invalid remote branch name" }
        return name
    }

    private fun localGitFetch(body: JSONObject): JSONObject {
        localGitOpen().use { git ->
            val branch = localGitBranchName(git)
            val remote = localGitResolveRemote(git, body, branch)
            if (!requestLocalApproval("Fetch Git remote", "Remote: $remote\nBranch: ${body.optString("remoteBranch", branch)}\nOnly remote-tracking refs will be updated")) throw SecurityException("Git fetch was denied")
            val credentials = localGitCredentials(body)
            try {
                val result = git.fetch().setRemote(remote).setTimeout(45).also { if (credentials != null) it.setCredentialsProvider(credentials) }.call()
                val updates = org.json.JSONArray()
                result.getTrackingRefUpdates().take(100).forEach { update ->
                    updates.put(JSONObject().put("remoteRef", update.getRemoteName()).put("result", update.getResult()?.name ?: "UNKNOWN"))
                }
                return JSONObject().put("ok", true).put("remote", remote).put("updated", result.getTrackingRefUpdates().size)
                    .put("updates", updates).put("out", result.getMessages().trim().take(2000))
            } finally { credentials?.clear() }
        }
    }

    private fun localGitPull(body: JSONObject): JSONObject {
        localGitOpen().use { git ->
            val branch = localGitBranchName(git)
            require(git.status().call().isClean) { "Pull is blocked while the workspace has staged, modified or untracked files. Commit or safely back up those changes first." }
            val remote = localGitResolveRemote(git, body, branch)
            val remoteBranch = localGitResolveRemoteBranch(git, body, branch)
            if (!requestLocalApproval("Pull Git changes (fast-forward only)", "${remote}/${remoteBranch} → ${branch}\nThe Local working tree is clean")) throw SecurityException("Git pull was denied")
            val credentials = localGitCredentials(body)
            try {
                val command = git.pull().setRemote(remote).setRemoteBranchName(remoteBranch)
                    .setRebase(false).setFastForward(org.eclipse.jgit.api.MergeCommand.FastForwardMode.FF_ONLY).setTimeout(45)
                if (credentials != null) command.setCredentialsProvider(credentials)
                val result = command.call()
                val mergeStatus = result.getMergeResult()?.getMergeStatus()?.name ?: "FETCHED"
                require(result.isSuccessful) { "Git pull did not complete cleanly (status: $mergeStatus). No automatic merge commit or force operation was attempted." }
                localGitSetUpstream(git, branch, remote, remoteBranch)
                return JSONObject().put("ok", true).put("remote", remote).put("branch", branch).put("remoteBranch", remoteBranch)
                    .put("mergeStatus", mergeStatus).put("out", if (mergeStatus == "ALREADY_UP_TO_DATE") "Already up to date" else "Fast-forwarded to ${remote}/${remoteBranch}")
            } finally { credentials?.clear() }
        }
    }

    private fun localGitPush(body: JSONObject): JSONObject {
        localGitOpen().use { git ->
            val branch = localGitBranchName(git)
            require(git.repository.resolve(Constants.HEAD) != null) { "Create the first commit before pushing this repository" }
            val remote = localGitResolveRemote(git, body, branch)
            val remoteBranch = localGitResolveRemoteBranch(git, body, branch)
            if (!requestLocalApproval("Push Git commit(s) to remote", "${branch} → ${remote}/${remoteBranch}\nOnly committed objects are sent. Uncommitted files are not included.")) throw SecurityException("Git push was denied")
            val credentials = localGitCredentials(body)
            try {
                val refSpec = RefSpec("refs/heads/$branch:refs/heads/$remoteBranch")
                val results = git.push().setRemote(remote).setRefSpecs(refSpec).setForce(false).setTimeout(45)
                    .also { if (credentials != null) it.setCredentialsProvider(credentials) }.call()
                val updates = org.json.JSONArray()
                var updateCount = 0
                var allAccepted = true
                results.forEach { result ->
                    result.getRemoteUpdates().forEach { update ->
                        updateCount++
                        val state = update.getStatus().name
                        if (state != "OK" && state != "UP_TO_DATE") allAccepted = false
                        updates.put(JSONObject().put("ref", update.getRemoteName()).put("status", state)
                            .put("message", update.getMessage().orEmpty().take(500)))
                    }
                }
                require(updateCount > 0 && allAccepted) { "The remote rejected the push or did not confirm the ref update. Review the returned Git status before retrying." }
                localGitSetUpstream(git, branch, remote, remoteBranch)
                return JSONObject().put("ok", true).put("remote", remote).put("branch", branch).put("remoteBranch", remoteBranch)
                    .put("updates", updates).put("out", "Pushed $branch to $remote/$remoteBranch")
            } finally { credentials?.clear() }
        }
    }


    private val localHistoryDir: File by lazy { File(filesDir, "file-history").apply { mkdirs() } }
    private fun localHistoryFile(path: String): File {
        val identity = (if (hasSafWorkspace()) prefs.getString("workspace_tree_uri", "") else localRoot.canonicalPath) + "|" + path
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
        val key = digest.joinToString("") { "%02x".format(it) }
        return File(localHistoryDir, "$key.json")
    }
    private fun localHistoryData(path: String): JSONObject {
        val file = localHistoryFile(path)
        return if (file.isFile && file.length() <= 6L * 1024L * 1024L) try { JSONObject(file.readText(Charsets.UTF_8)) } catch (_: Exception) { JSONObject() } else JSONObject()
    }
    private fun localHistorySave(path: String, data: JSONObject) {
        val target = localHistoryFile(path); val tmp = File(localHistoryDir, target.name + ".tmp")
        tmp.writeText(data.toString(), Charsets.UTF_8); if (target.exists()) target.delete(); require(tmp.renameTo(target)) { "Could not persist file history" }
    }
    private fun localHistoryPush(path: String, existed: Boolean, content: String?) {
        if (content != null && content.toByteArray(Charsets.UTF_8).size > 400_000) return
        if (existed && content == null) return
        val data = localHistoryData(path); val undo = data.optJSONArray("undo") ?: org.json.JSONArray(); val row = JSONObject().put("t", System.currentTimeMillis()).put("exists", existed).put("size", content?.toByteArray(Charsets.UTF_8)?.size ?: 0)
        if (content != null) row.put("content", Base64.encodeToString(content.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
        undo.put(row); while (undo.length() > 10) undo.remove(0)
        data.put("undo", undo).put("redo", org.json.JSONArray()); localHistorySave(path, data)
    }
    private fun localHistoryContent(path: String): Pair<Boolean, String?> {
        return if (hasSafWorkspace()) {
            val doc = try { safDocument(path) } catch (_: Exception) { null }
            if (doc == null || !doc.exists()) false to null else {
                require(doc.isFile && doc.length() <= 400_000L) { "File history supports text files up to 400 KB" }
                true to (contentResolver.openInputStream(doc.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "")
            }
        } else {
            val f = safeFile(path)
            if (!f.exists()) false to null else { require(f.isFile && f.length() <= 400_000L) { "File history supports text files up to 400 KB" }; true to f.readText(Charsets.UTF_8) }
        }
    }
    private fun localHistoryWrite(path: String, existed: Boolean, content: String?) {
        if (hasSafWorkspace()) {
            val doc = try { safDocument(path) } catch (_: Exception) { null }
            if (!existed) { if (doc != null && doc.exists()) require(doc.delete()) { "Could not remove file during history restore" }; return }
            val (parent, name) = safParentAndName(path)
            val target = doc ?: parent.createFile("text/plain", name) ?: throw IllegalStateException("Could not recreate file")
            contentResolver.openOutputStream(target.uri, "wt")?.bufferedWriter(Charsets.UTF_8)?.use { it.write(content ?: "") } ?: throw IllegalStateException("Could not restore file")
        } else {
            val f = safeFile(path)
            if (!existed) { if (f.exists()) require(f.delete()) { "Could not remove file during history restore" }; return }
            f.parentFile?.mkdirs(); f.writeText(content ?: "", Charsets.UTF_8)
        }
    }
    private fun localFsHistory(path: String): JSONObject {
        require(path.isNotBlank()) { "Missing file path" }
        if (hasSafWorkspace()) safRelative(path) else safeFile(path)
        val data = localHistoryData(path)
        fun metadata(name: String): org.json.JSONArray {
            val out = org.json.JSONArray(); val src = data.optJSONArray(name) ?: org.json.JSONArray()
            for (i in 0 until src.length()) { val x = src.optJSONObject(i) ?: continue; out.put(JSONObject().put("t", x.optLong("t")).put("size", x.optInt("size"))) }
            return out
        }
        return JSONObject().put("path", path).put("undo", metadata("undo")).put("redo", metadata("redo"))
    }
    private fun localFsUndoRedo(path: String, mode: String): JSONObject {
        require(path.isNotBlank() && mode in setOf("undo", "redo")) { "Invalid file history request" }
        if (hasSafWorkspace()) safRelative(path) else safeFile(path)
        if (!requestLocalApproval(if (mode == "undo") "Undo file change" else "Redo file change", path)) throw SecurityException("File history action was denied")
        val data = localHistoryData(path); val fromName = if (mode == "undo") "undo" else "redo"; val toName = if (mode == "undo") "redo" else "undo"
        val from = data.optJSONArray(fromName) ?: org.json.JSONArray(); val to = data.optJSONArray(toName) ?: org.json.JSONArray()
        require(from.length() > 0) { "No $mode history for this file" }
        val current = localHistoryContent(path); val version = from.optJSONObject(from.length() - 1) ?: throw IllegalStateException("Invalid history record")
        val restoreExists = version.optBoolean("exists", true)
        val restored = if (version.has("content")) String(Base64.decode(version.optString("content"), Base64.DEFAULT), Charsets.UTF_8) else null
        val currentText = current.second
        val currentRow = JSONObject().put("t", System.currentTimeMillis()).put("exists", current.first).put("size", currentText?.toByteArray(Charsets.UTF_8)?.size ?: 0)
        if (currentText != null) currentRow.put("content", Base64.encodeToString(currentText.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
        from.remove(from.length() - 1); to.put(currentRow); while (to.length() > 10) to.remove(0)
        localHistoryWrite(path, restoreExists, restored)
        data.put(fromName, from).put(toName, to); localHistorySave(path, data)
        return JSONObject().put("ok", true).put("path", path).put("restoredBytes", restored?.toByteArray(Charsets.UTF_8)?.size ?: 0).put("remaining", from.length())
    }

    private val localSessionsDir: File by lazy { File(filesDir, "sessions").apply { mkdirs() } }

    private fun localSessionId(raw: String): String {
        require(raw.matches(Regex("^[A-Za-z0-9_-]{4,64}$"))) { "Invalid session id" }
        return raw
    }

    private fun localSessionSave(body: JSONObject): JSONObject {
        val id = localSessionId(body.optString("id", ""))
        val session = body.optJSONObject("session") ?: throw IllegalArgumentException("Missing session data")
        val encoded = session.toString()
        require(encoded.toByteArray(Charsets.UTF_8).size <= 8 * 1024 * 1024) { "Session exceeds 8 MB" }
        val target = File(localSessionsDir, "$id.json")
        val temp = File(localSessionsDir, "$id.json.tmp")
        temp.writeText(encoded, Charsets.UTF_8)
        if (target.exists()) target.delete()
        require(temp.renameTo(target)) { "Could not persist session" }
        return JSONObject().put("saved", true)
    }

    private fun localSessionList(): JSONObject {
        val rows = org.json.JSONArray()
        localSessionsDir.listFiles()?.filter { it.isFile && it.name.matches(Regex("^[A-Za-z0-9_-]{4,64}\\.json$")) }
            ?.mapNotNull { f -> try { f to JSONObject(f.readText(Charsets.UTF_8)) } catch (_: Exception) { null } }
            ?.sortedByDescending { it.second.optLong("updated", 0L) }
            ?.take(300)?.forEach { (file, session) ->
                rows.put(JSONObject().put("id", file.name.removeSuffix(".json"))
                    .put("title", session.optString("title", "Untitled"))
                    .put("updated", session.optLong("updated", 0L))
                    .put("count", session.optJSONArray("messages")?.length() ?: 0))
            }
        return JSONObject().put("sessions", rows)
    }

    private fun localSessionGet(rawId: String): JSONObject {
        val file = File(localSessionsDir, localSessionId(rawId) + ".json")
        require(file.isFile && file.length() <= 8L * 1024L * 1024L) { "Session not found or too large" }
        return JSONObject().put("session", JSONObject(file.readText(Charsets.UTF_8)))
    }

    private fun localSessionDelete(rawId: String): JSONObject {
        val file = File(localSessionsDir, localSessionId(rawId) + ".json")
        if (file.exists()) require(file.delete()) { "Could not delete session" }
        return JSONObject().put("deleted", true)
    }

    private fun localProjectMemoryFile(): File = File(localRoot, ".agent/project-memory.json").canonicalFile.also {
        require(it.path.startsWith(localRoot.canonicalPath + File.separator)) { "Project memory path escapes workspace" }
    }

    private fun localProjectMemoryGet(): JSONObject {
        val file = localProjectMemoryFile()
        val data = if (file.isFile && file.length() <= 256 * 1024L) JSONObject(file.readText(Charsets.UTF_8)) else JSONObject()
        val source = data.optJSONArray("entries") ?: org.json.JSONArray()
        val entries = org.json.JSONArray()
        for (i in 0 until minOf(source.length(), 80)) {
            val x = source.optJSONObject(i) ?: continue
            entries.put(JSONObject().put("id", x.optString("id", ""))
                .put("text", x.optString("text", "").take(2000))
                .put("category", x.optString("category", "note").take(40))
                .put("updatedAt", x.optLong("updatedAt", 0L)))
        }
        return JSONObject().put("ok", true).put("file", ".agent/project-memory.json")
            .put("updatedAt", data.opt("updatedAt")).put("entries", entries)
    }

    private fun localProjectMemorySet(body: JSONObject): JSONObject {
        val incoming = body.optJSONArray("entries") ?: org.json.JSONArray()
        require(incoming.length() <= 80) { "Project memory is limited to 80 entries" }
        val entries = org.json.JSONArray()
        for (i in 0 until incoming.length()) {
            val x = incoming.optJSONObject(i) ?: continue
            val note = x.optString("text", "").trim().take(2000)
            if (note.isNotEmpty()) entries.put(JSONObject().put("id", x.optString("id", java.util.UUID.randomUUID().toString()))
                .put("text", note).put("category", x.optString("category", "note").take(40)).put("updatedAt", System.currentTimeMillis()))
        }
        val target = localProjectMemoryFile()
        if (!requestLocalApproval("Save project memory", "${entries.length()} notes in .agent/project-memory.json"))
            throw SecurityException("Project memory save was denied")
        target.parentFile?.mkdirs()
        val data = JSONObject().put("version", 1).put("updatedAt", System.currentTimeMillis()).put("entries", entries)
        require(data.toString().toByteArray(Charsets.UTF_8).size <= 256 * 1024) { "Project memory exceeds 256 KB" }
        target.writeText(data.toString(), Charsets.UTF_8)
        return JSONObject().put("ok", true).put("count", entries.length()).put("updatedAt", data.getLong("updatedAt"))
    }

    private fun localFsSearch(path: String, query: String): JSONObject {
        val q = query.trim().lowercase()
        require(q.isNotEmpty() && q.length <= 200) { "Search query must contain 1–200 characters" }
        val base = safeFile(path)
        require(base.isDirectory) { "Folder not found" }
        val matches = org.json.JSONArray()
        var scanned = 0
        var stopped = false
        fun walk(dir: File, relative: String) {
            val children = dir.listFiles()?.sortedBy { it.name.lowercase() } ?: return
            for (child in children) {
                if (child.name in setOf(".git", "node_modules", ".gradle", ".agent")) continue
                if (child.isSymbolicLinkCompat()) continue
                if (child.isDirectory) walk(child, if (relative.isEmpty()) child.name else "$relative/${child.name}")
                else if (child.isFile && child.length() <= 1_000_000L && !child.name.lowercase().matches(Regex(".*\\.(png|jpe?g|gif|webp|pdf|zip|7z|exe|dll|so|apk|mp[34]|gguf|bin)$"))) {
                    if (++scanned > 400) { stopped = true; return }
                    val lines = try { child.readLines(Charsets.UTF_8) } catch (_: Exception) { emptyList() }
                    lines.forEachIndexed { index, line -> if (matches.length() < 60 && line.lowercase().contains(q)) {
                        val name = if (relative.isEmpty()) child.name else "$relative/${child.name}"
                        matches.put("$name:${index + 1}: ${line.trim().take(200)}")
                    } }
                }
                if (matches.length() >= 60 || stopped) return
            }
        }
        walk(base, "")
        if (stopped || matches.length() >= 60) matches.put("…(search limit reached)")
        return JSONObject().put("matches", matches)
    }

    private fun localWorkspaceDirs(path: String): JSONObject {
        val dir = safeFile(path).canonicalFile
        require(dir.isDirectory) { "Folder not found: $path" }
        val dirs = org.json.JSONArray()
        dir.listFiles()?.filter { it.isDirectory && !it.isSymbolicLinkCompat() }?.sortedBy { it.name.lowercase() }?.take(500)?.forEach { dirs.put(it.name) }
        val parent = if (dir == localRoot.canonicalFile) JSONObject.NULL else (dir.parentFile?.path ?: JSONObject.NULL)
        val places = org.json.JSONArray().put(JSONObject().put("name", "Local workspace").put("path", localRoot.canonicalPath))
        return JSONObject().put("path", dir.path).put("sep", File.separator).put("parent", parent)
            .put("dirs", dirs).put("truncated", (dir.listFiles()?.count { it.isDirectory } ?: 0) > 500)
            .put("places", places).put("recent", org.json.JSONArray().put(localRoot.canonicalPath)).put("current", localRoot.canonicalPath)
    }

    private fun openCodeAuthRead(): JSONObject {
        return try {
            if (openCodeAuthFile.isFile) JSONObject(openCodeAuthFile.readText(Charsets.UTF_8)) else JSONObject()
        } catch (_: Exception) { JSONObject() }
    }

    private fun openCodeAuthKeys(auth: JSONObject = openCodeAuthRead()): JSONObject =
        auth.optJSONObject("keys") ?: JSONObject()

    private fun openCodeAuthView(): JSONObject {
        val auth = openCodeAuthRead()
        val keys = openCodeAuthKeys(auth)
        val rows = JSONArray()
        openCodeProviderLabels.forEach { (id, label) ->
            val saved = keys.optString(id, "").isNotBlank()
            rows.put(JSONObject().put("id", id).put("label", label).put("saved", saved)
                .put("hint", if (saved) "…" + keys.optString(id).takeLast(4) else ""))
        }
        keys.keys().asSequence().filter { it !in openCodeProviderLabels }.forEach { id ->
            val key = keys.optString(id, "")
            if (key.isNotBlank()) rows.put(JSONObject().put("id", id).put("label", id).put("saved", true).put("hint", "…" + key.takeLast(4)))
        }
        return JSONObject().put("providers", rows).put("model", auth.optString("model", ""))
    }

    private fun openCodeAuthSet(body: JSONObject): JSONObject {
        openCodeModelsCache = null // v46: keys/model changed → the discovered model list may differ
        val auth = openCodeAuthRead()
        if (body.has("model")) {
            val model = body.optString("model", "").trim()
            require(model.isEmpty() || model.matches(Regex("^[A-Za-z0-9._\\-/:+]{1,120}$"))) {
                "The model name has characters OpenCode does not accept. Use provider/model, for example opencode/big-pickle."
            }
            auth.put("model", model)
        }
        if (body.has("provider")) {
            val id = body.optString("provider", "").trim().lowercase()
            require(id.matches(Regex("^[a-z0-9][a-z0-9_-]{0,40}$"))) {
                "Provider ids use lowercase letters, digits, - and _ (for example opencode or anthropic)."
            }
            val keys = openCodeAuthKeys(auth)
            if (body.optBoolean("clear", false)) keys.remove(id)
            else {
                val raw = body.opt("key")
                require(raw == null || raw == JSONObject.NULL || raw is String) { "The API key must be text." }
                if (raw is String && raw.trim().isNotEmpty()) {
                    val key = raw.trim()
                    require(key.length in 8..500 && key.none { it.isWhitespace() || it == '\u0000' }) {
                        "That does not look like an API key (no spaces, 8 to 500 characters)."
                    }
                    keys.put(id, key)
                }
            }
            auth.put("keys", keys)
        }
        openCodeAuthFile.parentFile?.mkdirs()
        val text = auth.toString(2)
        val temp = File(openCodeAuthFile.parentFile, "auth.json.new")
        temp.writeText(text, Charsets.UTF_8)
        if (!temp.renameTo(openCodeAuthFile)) { openCodeAuthFile.writeText(text, Charsets.UTF_8); temp.delete() }
        // Keep the saved keys owner-only (0600); best effort on FUSE-backed storage.
        runCatching {
            openCodeAuthFile.setReadable(false, false)
            openCodeAuthFile.setWritable(false, false)
            openCodeAuthFile.setReadable(true, true)
            openCodeAuthFile.setWritable(true, true)
        }
        return openCodeAuthView()
    }

    // ---- Multiple OpenCode API keys (profiles) -------------------------------------------
    // Stored in auth.json under "key_profiles": [{id, provider, key, label}] with "active_key_id".
    // One can be active at a time; the active key is written into the CLI config on each run so
    // exhausting one key's quota is handled by selecting the next one — no provider switching.

    private fun openCodeKeyProfiles(auth: JSONObject): org.json.JSONArray =
        auth.optJSONArray("key_profiles") ?: org.json.JSONArray()

    private fun saveOpenCodeAuth(auth: JSONObject) {
        openCodeModelsCache = null // v46: keys/model changed → the discovered model list may differ
        openCodeAuthFile.parentFile?.mkdirs()
        val text = auth.toString(2)
        val temp = File(openCodeAuthFile.parentFile, "auth.json.new")
        temp.writeText(text, Charsets.UTF_8)
        if (!temp.renameTo(openCodeAuthFile)) { openCodeAuthFile.writeText(text, Charsets.UTF_8); temp.delete() }
        runCatching {
            openCodeAuthFile.setReadable(false, false); openCodeAuthFile.setWritable(false, false)
            openCodeAuthFile.setReadable(true, true); openCodeAuthFile.setWritable(true, true)
        }
    }

    private fun openCodeKeysList(): JSONObject {
        val auth = openCodeAuthRead()
        val arr = openCodeKeyProfiles(auth)
        val active = auth.optString("active_key_id", "")
        val out = JSONArray()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val key = p.optString("key", "")
            out.put(JSONObject()
                .put("id", p.optString("id", ""))
                .put("provider", p.optString("provider", ""))
                .put("label", p.optString("label", ""))
                .put("hint", if (key.length >= 4) "…" + key.takeLast(4) else "")
                .put("active", p.optString("id", "") == active))
        }
        return JSONObject().put("ok", true).put("keys", out).put("activeId", active)
    }

    private fun openCodeKeysAdd(body: JSONObject): JSONObject {
        val provider = body.optString("provider", "").trim().lowercase()
        require(provider.matches(Regex("^[a-z0-9][a-z0-9_-]{0,40}$"))) { "Invalid provider id" }
        val key = body.optString("key", "").trim()
        require(key.length in 8..500 && key.none { it.isWhitespace() || it == '\u0000' }) { "Invalid API key (no spaces, 8-500 chars)" }
        var label = body.optString("label", "").trim().take(80)
        if (label.isBlank()) label = "$provider …" + key.takeLast(4)
        val auth = openCodeAuthRead()
        val arr = openCodeKeyProfiles(auth)
        val id = "key_" + java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        arr.put(JSONObject().put("id", id).put("provider", provider).put("key", key).put("label", label))
        auth.put("key_profiles", arr)
        if (!auth.has("active_key_id") || auth.optString("active_key_id", "").isBlank()) auth.put("active_key_id", id)
        saveOpenCodeAuth(auth)
        return openCodeKeysList().put("added", id)
    }

    private fun openCodeKeysSelect(body: JSONObject): JSONObject {
        val id = body.optString("id", "").trim()
        val auth = openCodeAuthRead()
        val arr = openCodeKeyProfiles(auth)
        var found = false
        for (i in 0 until arr.length()) if (arr.optJSONObject(i)?.optString("id", "") == id) { found = true; break }
        require(found) { "Unknown key id" }
        auth.put("active_key_id", id)
        saveOpenCodeAuth(auth)
        // Mirror into the legacy keys map so the active provider key is used by the CLI config.
        val active = (0 until arr.length()).map { arr.optJSONObject(it) }.first { it?.optString("id", "") == id }
        val keys = openCodeAuthKeys(auth)
        keys.put(active!!.optString("provider", ""), active.optString("key", ""))
        auth.put("keys", keys)
        saveOpenCodeAuth(auth)
        return openCodeKeysList().put("selected", id)
    }

    private fun openCodeKeysRemove(body: JSONObject): JSONObject {
        val id = body.optString("id", "").trim()
        val auth = openCodeAuthRead()
        val arr = openCodeKeyProfiles(auth)
        val kept = org.json.JSONArray()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            if (p.optString("id", "") != id) kept.put(p)
        }
        auth.put("key_profiles", kept)
        if (auth.optString("active_key_id", "") == id) {
            auth.put("active_key_id", if (kept.length() > 0) kept.optJSONObject(0)?.optString("id", "") ?: "" else "")
        }
        saveOpenCodeAuth(auth)
        return openCodeKeysList().put("removed", id)
    }

    /** Select the next saved key (round-robin). Used for automatic fallback when a key is
     *  rate-limited / exhausted. Returns rotated=false when no alternative exists. */
    private fun openCodeKeysRotate(body: JSONObject): JSONObject {
        val auth = openCodeAuthRead()
        val arr = openCodeKeyProfiles(auth)
        if (arr.length() <= 1) return openCodeKeysList().put("rotated", false)
        val current = auth.optString("active_key_id", "")
        var currentIdx = -1
        for (i in 0 until arr.length()) if (arr.optJSONObject(i)?.optString("id", "") == current) { currentIdx = i; break }
        val nextIdx = ((currentIdx + 1) % arr.length() + arr.length()) % arr.length()
        val next = arr.optJSONObject(nextIdx) ?: return openCodeKeysList().put("rotated", false)
        if (next.optString("id", "") == current) return openCodeKeysList().put("rotated", false)
        val select = JSONObject().put("id", next.optString("id", ""))
        return openCodeKeysSelect(select).put("rotated", true).put("label", next.optString("label", ""))
    }

    private fun openCodeSavedKeys(): JSONArray {
        val saved = JSONArray()
        openCodeAuthKeys(openCodeAuthRead()).keys().forEach { saved.put(it) }
        return saved
    }

    private fun openCodeStatus(): JSONObject {
        return AndroidOpenCodeRuntime.status(this, activeWorkspacePath(), openCodeSavedKeys())
    }

    /**
     * v46: DYNAMIC OpenCode model discovery. The list is produced by the real installed CLI
     * (`opencode models`), parsed as one `provider/model` id per line, and grouped Free/Paid by the
     * model id itself (Free when the id ends with "-free", case-insensitive). Never a hardcoded
     * provider list, and CodeSpace providers are never included. On a discovery failure the caller
     * gets `ok=false` + a clear error so the UI can report it and keep the current selection.
     */
    private fun openCodeModels(body: JSONObject = JSONObject()): JSONObject {
        val auth = openCodeAuthRead()
        val configured = auth.optString("model", "").trim()
        val force = body.optBoolean("refresh", false)
        val cached = openCodeModelsCache
        if (!force && cached != null && System.currentTimeMillis() - cached.first < 5 * 60 * 1000L) {
            // Refresh the configured model from auth (it may have changed) without re-running the CLI.
            return JSONObject(cached.second.toString()).put("configured", configured).put("cached", true)
        }
        val discovered = discoverOpenCodeModels()
        val stdout = discovered.optString("stdout", "")
        val ids = stdout.split('\n')
            .map { it.trim() }
            .filter { it.length in 3..200 && it.contains('/') && it.matches(Regex("^[A-Za-z0-9._\\-/:+]+$")) }
            .distinct()
        if (!discovered.optBoolean("ok", false) || ids.isEmpty()) {
            val err = discovered.optString("stderr", "").ifBlank { discovered.optString("error", "") }
                .ifBlank { "OpenCode CLI did not return a model list." }
                .replace(Regex("\\s+"), " ").take(240)
            AndroidOpenCodeRuntime.logDiag(this, "models-discovery failed state=${discovered.optString("state")} exit=${discovered.optInt("exitCode")} stdoutLines=${stdout.split('\n').size}")
            return JSONObject().put("ok", false).put("error", err)
                .put("models", org.json.JSONArray()).put("free", org.json.JSONArray()).put("paid", org.json.JSONArray())
                .put("configured", configured).put("default", configured).put("source", "cli")
        }
        val models = org.json.JSONArray()
        val free = org.json.JSONArray()
        val paid = org.json.JSONArray()
        ids.forEach { id ->
            models.put(id)
            if (id.lowercase().endsWith("-free")) free.put(id) else paid.put(id)
        }
        val result = JSONObject().put("ok", true)
            .put("models", models).put("free", free).put("paid", paid)
            .put("configured", configured)
            .put("default", if (configured.isNotBlank() && ids.contains(configured)) configured else (ids.firstOrNull() ?: ""))
            .put("source", "cli").put("error", JSONObject.NULL)
        openCodeModelsCache = System.currentTimeMillis() to result
        AndroidOpenCodeRuntime.logDiag(this, "models-discovery ok count=${ids.size} free=${free.length()} paid=${paid.length()}")
        return result
    }

    /** Run the real `opencode models` through Termux with the saved provider keys applied. */
    private fun discoverOpenCodeModels(): JSONObject {
        val auth = openCodeAuthRead()
        val keys = openCodeAuthKeys(auth)
        val cfg = writeOpenCodeConfig(keys, auth.optString("model", ""), "off")
        // v47: --standalone starts a private server for this one command. The managed background
        // service is not reliable from a one-shot Termux shell and was the source of zero-byte
        // stdout/stderr runs. Verified with the installed v2.0.32-android-termux.1 binary.
        val cmd = "env OPENCODE_CONFIG=${shQuote(cfg.absolutePath)} '${AndroidOpenCodeRuntime.TERMUX_OPCODE_PATH}' models --standalone"
        return AndroidOpenCodeRuntime.execCapture(this, cmd, 60_000)
    }

    /**
     * Installation guidance + best-effort setup. A normal Linux CLI binary cannot execute on
     * stock Android (bionic libc); a real runtime is Termux or a bundled Android-compatible
     * binary. This never reports success unless a subsequent --version probe succeeds.
     */
    private fun openCodeInstall(body: JSONObject): JSONObject {
        val treeUri = prefs.getString("workspace_tree_uri", "")
        val deviceDir = prefs.getString("workspace_dir", "")
        val resolved = AndroidOpenCodeWorkspace.resolve(this, treeUri, deviceDir)
        val msg = if (AndroidOpenCodeRuntime.termuxInstalled(this)) {
            "Termux is installed. In Termux run: pkg install nodejs-lts && npm i -g opencode-ai, then enable Termux settings → External apps → 'Allow external apps to run commands'. Then press Recheck in Settings → OpenCode CLI."
        } else {
            "Install Termux (F-Droid), then in Termux run: pkg install nodejs-lts && npm i -g opencode-ai, enable Termux settings → External apps → 'Allow external apps to run commands', and place an Android-compatible opencode binary in CodeSpace files/opencode/bin/ if you prefer bundled execution. Then press Recheck."
        }
        return JSONObject().put("ok", true).put("installed", false)
            .put("message", msg)
            .put("workspaceReady", resolved.posixPath != null || resolved.mirror)
            .put("workspacePath", resolved.posixPath ?: AndroidOpenCodeWorkspace.mirrorPath(this))
    }

    private fun openCodeSyncIn(): JSONObject {
        val treeUri = prefs.getString("workspace_tree_uri", "") ?: ""
        if (treeUri.isBlank()) return JSONObject().put("ok", true).put("skipped", true)
        return AndroidOpenCodeWorkspace.syncIn(this, treeUri)
    }

    private fun openCodeSyncOut(): JSONObject {
        val treeUri = prefs.getString("workspace_tree_uri", "") ?: ""
        if (treeUri.isBlank()) return JSONObject().put("ok", true).put("skipped", true)
        return AndroidOpenCodeWorkspace.syncOut(this, treeUri)
    }

    /**
     * POSIX single-quote escaping for values interpolated into the Termux shell command.
     * Wrapping in single quotes makes every character literal; an embedded single quote is
     * closed, escaped and reopened, so prompts/paths can never inject shell syntax.
     */
    private fun shQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    /** Launch the real OpenCode CLI against the selected Android workspace. */
    private fun openCodeRun(body: JSONObject): JSONObject {
        // Apply any user-configured execution timeout before launching.
        prefs.getLong("opencode_run_timeout_ms", 0L).takeIf { it > 0L }?.let { AndroidOpenCodeRuntime.setRunTimeoutMs(it) }
        prefs.getLong("opencode_no_output_watchdog_ms", 0L).takeIf { it > 0L }?.let { AndroidOpenCodeRuntime.setNoOutputWatchdogMs(it) }
        val probe = AndroidOpenCodeRuntime.probe(this)
        if (!probe.available) {
            return JSONObject().put("ok", false)
                .put("error", probe.error ?: "OpenCode CLI is not installed or not executable on this device.")
                .put("needsInstall", true)
        }
        val prompt = body.optString("prompt", "").trim()
        if (prompt.isBlank() || prompt.length > 100000) throw IllegalArgumentException("Prompt must be 1–100000 characters")

        // Use the SINGLE canonical workspace state (validated path + permission + SAF sync).
        // This is the same state the chat and file tools use, so OpenCode can never run against a
        // remote/empty workspace while an Android folder is selected.
        val state = activeWorkspaceState()
        var workDir = state.optString("posixPath", "")
        var mirrored = state.optBoolean("mirrored", false)
        if (!state.optBoolean("available", false) || workDir.isBlank()) {
            return JSONObject().put("ok", false)
                .put("error", state.optString("error", "No workspace folder is open. Select a project folder first."))
                .put("workspaceState", state)
        }
        val treeUri = prefs.getString("workspace_tree_uri", "") ?: ""

        // v44: Termux validates the RUN_COMMAND working directory and silently runs nothing when it
        // is not writable (RunCommandService → validateDirectoryFileExistenceAndPermissions → return
        // stopService). Probe the selected folder from Termux's own process; when a directly-mapped
        // SAF folder is not usable, run against the managed mirror (the SAME folder, synced) instead
        // of leaving the task stuck. The CLI process cwd is always a Termux-owned dir, so the shell
        // is guaranteed to start.
        var termuxAccessible = AndroidOpenCodeRuntime.workspaceAccessible(this, workDir)
        if (!termuxAccessible && treeUri.isNotBlank()) {
            AndroidOpenCodeRuntime.logDiag(this, "workspace not Termux-accessible; switching to SAF mirror for $workDir")
            val synced = AndroidOpenCodeWorkspace.syncIn(this, treeUri)
            if (synced.optBoolean("ok", false)) {
                workDir = AndroidOpenCodeWorkspace.mirrorPath(this)
                mirrored = true
                termuxAccessible = AndroidOpenCodeRuntime.workspaceAccessible(this, workDir)
            }
        }
        if (!termuxAccessible) {
            AndroidOpenCodeRuntime.logDiag(this, "workspace inaccessible from Termux: $workDir")
            return JSONObject().put("ok", false)
                .put("error", "Termux cannot access the selected folder ($workDir). In Termux run `termux-setup-storage`, and allow all files for Termux (Android Settings → Apps → Termux → Files and media), then try again — or choose a folder under shared storage.")
                .put("workspaceState", state)
        }

        // OpenCode auth/config: keys are written to OpenCode's own config via OPENCODE_CONFIG_CONTENT;
        // never logged or echoed. Reuse the existing auth store.
        val auth = openCodeAuthRead()
        val keys = openCodeAuthKeys(auth)
        val model = body.optString("model", "").ifBlank { auth.optString("model", "") }
        val sessionId = body.optString("sessionId", "").let {
            if (it.matches(Regex("^ses_[A-Za-z0-9_-]{4,200}$"))) it
            else "ses_" + java.util.UUID.randomUUID().toString().replace("-", "").take(24)
        }

        // Approval gate: OpenCode can read/write files and run commands in the workspace.
        if (!requestLocalApproval("Run OpenCode CLI", "$workDir\n\n${prompt.take(400)}")) {
            return JSONObject().put("ok", false).put("error", "OpenCode CLI execution was denied")
        }

        // Build the real CLI invocation. Config/auth is written to the shared Termux-readable
        // staging dir (app-private filesDir is inaccessible to Termux's different UID). The
        // explicit OpenCode binary path is used, never a bare `opencode` resolved from PATH.
        val cfgFile = writeOpenCodeConfig(keys, model, body.optString("thinkLevel", "off"))
        // The installed OpenCode v2 CLI has NO `--dir` flag (verified with `opencode run --help`).
        // The selected workspace is the CLI's working directory. The RUN_COMMAND process cwd is a
        // Termux-owned dir (so Termux never aborts the launch); AndroidOpenCodeRuntime.startRun()
        // performs the explicit `cd` into the workspace and reports a distinct exit code if it fails.
        val autoFlag = if (body.optBoolean("autoApprove", false)) "--auto" else ""
        val sessionFlag = if (sessionId.isNotBlank()) "--session ${shQuote(sessionId)}" else ""
        val modelFlag = if (model.isNotBlank()) "--model ${shQuote(model)}" else ""
        // v47: `env` prefix (instead of a bare shell assignment) so the launcher can `exec` the
        // command directly; after `exec env …`, $! IS the real OpenCode CLI PID. `--standalone`
        // uses a private server instead of the managed background service: the latter produced
        // zero-byte stdout/stderr from a one-shot Termux shell (confirmed on the installed binary).
        val command = "env OPENCODE_CONFIG=${shQuote(cfgFile.absolutePath)} '${AndroidOpenCodeRuntime.TERMUX_OPCODE_PATH}' run --standalone --format json $modelFlag $sessionFlag $autoFlag -- ${shQuote(prompt)}"

        AndroidOpenCodeRuntime.logDiag(this, "dispatch session=$sessionId runtime=${probe.kind.name} workspace=$workDir " +
            "mirrored=$mirrored model=$model think=${body.optString("thinkLevel", "off")} promptLen=${prompt.length} keys=${keys.length()} timeoutMs=${AndroidOpenCodeRuntime.runTimeoutMs()}")
        val session = AndroidOpenCodeRuntime.startRun(this, probe.kind, command, workDir, sessionId)
        return JSONObject()
            .put("ok", true)
            .put("sessionId", session.id)
            .put("engine", "opencode-cli-android-local")
            .put("runtime", probe.kind.name)
            .put("mirrored", mirrored)
            .put("model", model)
            .put("posixPath", workDir)
            .put("workspaceId", state.optString("workspaceId", ""))
            .put("started", session.started)
            .put("state", session.state)
            .put("timeoutMs", AndroidOpenCodeRuntime.runTimeoutMs())
    }

    /**
     * Write OpenCode config to the Termux-readable shared staging dir. The config holds provider
     * API keys — never logged or echoed to chat. It lives in the hidden Downloads/.codespace-opencode
     * dir so the Termux process (different UID, with storage permission) can read it. Restrict to
     * owner where the filesystem permits; keys are never placed in the command string or logs.
     */
    private fun writeOpenCodeConfig(keys: JSONObject, model: String, thinkLevel: String): File {
        val cfg = JSONObject()
        val providers = JSONObject()
        keys.keys().forEach { id ->
            val key = keys.optString(id, "")
            if (key.isBlank()) return@forEach
            providers.put(id, JSONObject().put("apiKey", key).put("name", openCodeProviderLabels[id] ?: id))
        }
        if (providers.length() > 0) cfg.put("provider", providers)
        if (model.isNotBlank()) cfg.put("model", model)
        val effort = when (thinkLevel.lowercase()) {
            "low", "fast" -> "low"
            "medium", "balanced" -> "medium"
            "high", "deep" -> "high"
            else -> ""
        }
        if (effort.isNotBlank()) cfg.put("reasoningEffort", effort)
        val f = File(AndroidOpenCodeRuntime.stagingDir(this), "opencode-config.json")
        f.writeText(cfg.toString(), Charsets.UTF_8)
        try { f.setReadable(true, false); f.setReadable(true, true); f.setWritable(true, true) } catch (_: Throwable) {}
        return f
    }

    private fun localFsList(path: String, recursive: Boolean): JSONObject {
        val dir = safeFile(path)
        require(dir.isDirectory) { "Folder not found: $path" }
        // listFiles() returns null when Android blocks directory reads (no “All files access”).
        require(dir.listFiles() != null) { "Android blocked reading this folder. Allow “All files access” for CodeSpace in Settings → Apps → CodeSpace → Special app access, then reopen the folder." }
        val entries = org.json.JSONArray()
        var count = 0
        fun walk(folder: File, prefix: String) {
            folder.listFiles()?.sortedBy { it.name.lowercase() }?.forEach { child ->
                if (child.name in setOf(".git", "node_modules", ".gradle")) return@forEach
                if (count >= 300) return
                val rel = if (prefix.isEmpty()) child.name else "$prefix/${child.name}"
                entries.put(rel + if (child.isDirectory) "/" else "")
                count++
                if (recursive && child.isDirectory && !child.isSymbolicLinkCompat()) walk(child, rel)
            }
        }
        walk(dir, "")
        return JSONObject().put("entries", entries)
    }

    private fun localFsMkdir(path: String): JSONObject {
        require(path.isNotBlank()) { "Missing folder path" }
        val dir = safeFile(path)
        if (!requestLocalApproval("Create folder", path)) throw SecurityException("Folder creation was denied or timed out")
        require(dir.mkdirs() || dir.isDirectory) { "Could not create folder" }
        return JSONObject().put("created", true)
    }

    private fun localFsDelete(path: String, recursive: Boolean): JSONObject {
        require(path.isNotBlank()) { "Missing path" }
        val target = safeFile(path)
        require(target != localRoot.canonicalFile) { "Cannot delete the Local workspace root" }
        require(target.exists()) { "Path not found" }
        if (!requestLocalApproval("Delete ${if (target.isDirectory) "folder" else "file"}", path)) throw SecurityException("Delete was denied or timed out")
        if (target.isFile && target.length() <= 400_000L) localHistoryPush(path, true, target.readText(Charsets.UTF_8))
        if (target.isDirectory && !recursive) require(target.listFiles()?.isEmpty() != false) { "Folder is not empty" }
        if (target.isDirectory && recursive) target.deleteRecursively() else require(target.delete()) { "Could not delete path" }
        return JSONObject().put("deleted", true)
    }

    private fun localFsRename(path: String, to: String): JSONObject {
        require(path.isNotBlank() && to.isNotBlank()) { "Both source and destination paths are required" }
        val source = safeFile(path); val target = safeFile(to)
        require(source != localRoot.canonicalFile && source.exists()) { "Source path not found" }
        require(!target.exists()) { "Destination already exists" }
        if (!requestLocalApproval("Move or rename", "$path → $to")) throw SecurityException("Rename was denied or timed out")
        target.parentFile?.mkdirs()
        require(source.renameTo(target)) { "Could not move or rename path" }
        return JSONObject().put("renamed", true)
    }

    private fun localFsStat(path: String): JSONObject {
        val f = safeFile(path)
        require(f.exists()) { "Path not found: $path" }
        val mime = when {
            f.isDirectory -> "inode/directory"
            else -> contentResolver.getType(android.net.Uri.fromFile(f)) ?: "application/octet-stream"
        }
        return JSONObject().put("path", path).put("size", f.length()).put("mtime", f.lastModified())
            .put("isFile", f.isFile).put("isDirectory", f.isDirectory).put("mode", if (f.isDirectory) "0755" else "0644")
            .put("mimeType", mime)
    }

    private fun localFsRead(path: String): JSONObject {
        val file = safeFile(path)
        require(file.isFile) { "File not found: $path" }
        require(file.length() <= 1_000_000L) { "File is larger than 1 MB" }
        val lower = file.name.lowercase()
        require(!lower.matches(Regex(".*\\.(png|jpe?g|gif|webp|pdf|zip|7z|exe|dll|so|apk|mp[34]|gguf|bin)$"))) { "Refusing to read a binary file" }
        return JSONObject().put("content", file.readText(Charsets.UTF_8))
    }

    private fun localFsWrite(path: String, content: String, base64: String = ""): JSONObject {
        require(path.isNotBlank()) { "Missing file path" }
        require(!(content.isNotEmpty() && base64.isNotEmpty())) { "Send either text content or Base64 binary data, not both" }
        val bytes = if (base64.isNotEmpty()) {
            require(base64.length <= 11 * 1024 * 1024) { "Binary upload exceeds the 8 MB limit" }
            try { Base64.decode(base64, Base64.DEFAULT) } catch (_: IllegalArgumentException) { throw IllegalArgumentException("Invalid Base64 binary upload") }
        } else content.toByteArray(Charsets.UTF_8)
        require(bytes.size <= if (base64.isNotEmpty()) 8 * 1024 * 1024 else 1_000_000) { "Write exceeds the file size limit" }
        val file = safeFile(path)
        require(file != localRoot.canonicalFile) { "Missing file path" }
        if (!usesDeviceStorageWorkspace()) require(workspaceSizeBytes() - (if (file.isFile) file.length() else 0L) + bytes.size <= 250L * 1024L * 1024L) { "Local workspace quota is 250 MB" }
        if (!requestLocalApproval("Write ${if (base64.isNotEmpty()) "binary" else "text"} file", "$path (${bytes.size} bytes)")) throw SecurityException("Write permission was denied or timed out")
        if (file.exists()) localHistoryPush(path, true, if (base64.isEmpty() && file.isFile && file.length() <= 400_000L) file.readText(Charsets.UTF_8) else null) else localHistoryPush(path, false, null)
        file.parentFile?.mkdirs()
        file.outputStream().use { it.write(bytes) }
        return JSONObject().put("bytes", bytes.size).put("binary", base64.isNotEmpty())
    }

    /** Static APK metadata and archive inventory; never installs or executes the supplied APK. */
    private fun localApkInspect(path: String): JSONObject {
        require(!hasSafWorkspace()) { "APK inspection currently requires the app-private Local workspace" }
        val apk = safeFile(path)
        require(apk.isFile && apk.extension.equals("apk", true)) { "Select an APK file in the Local workspace" }
        require(apk.length() in 1..150L * 1024L * 1024L) { "APK must be between 1 byte and 150 MB" }
        val flags = android.content.pm.PackageManager.GET_ACTIVITIES or android.content.pm.PackageManager.GET_SERVICES or android.content.pm.PackageManager.GET_RECEIVERS or android.content.pm.PackageManager.GET_PROVIDERS or android.content.pm.PackageManager.GET_PERMISSIONS
        val info = packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
        val entries = JSONArray(); val dex = JSONArray(); var count = 0; var total = 0L
        java.util.zip.ZipFile(apk).use { zip ->
            val iterator = zip.entries()
            while (iterator.hasMoreElements() && count < 12000) {
                val entry = iterator.nextElement(); count++
                if (entry.isDirectory) continue
                total += entry.size.coerceAtLeast(0L)
                val row = JSONObject().put("name", entry.name.take(500)).put("size", entry.size)
                if (entry.name.matches(Regex("classes(?:[0-9]+)?\\.dex"))) dex.put(row)
                if (entries.length() < 250) entries.put(row)
            }
        }
        val permissions = JSONArray(); info?.requestedPermissions?.forEach { permissions.put(it) }
        val activities = JSONArray(); info?.activities?.forEach { activities.put(it.name) }
        return JSONObject().put("ok", true).put("kind", "android-apk").put("file", path).put("bytes", apk.length())
            .put("packageName", info?.packageName ?: JSONObject.NULL).put("versionName", info?.versionName ?: JSONObject.NULL)
            .put("versionCode", info?.longVersionCode ?: JSONObject.NULL).put("minSdk", info?.applicationInfo?.minSdkVersion ?: JSONObject.NULL)
            .put("targetSdk", info?.applicationInfo?.targetSdkVersion ?: JSONObject.NULL).put("permissions", permissions)
            .put("activities", activities).put("dexFiles", dex).put("archiveEntryCount", count).put("uncompressedBytes", total)
            .put("entriesPreview", entries).put("manifestParsed", info != null)
            .put("analysisNote", "PackageManager parsed APK manifest metadata and ZIP inventory. DEX bytecode and binary resources are not converted into Java/Kotlin source by this endpoint; full decompilation requires a compatible JADX/APKTool runtime.")
    }

    /** Safe APK ZIP extraction for AI-assisted inspection; traversal paths are rejected. */
    private fun localApkExtract(path: String, destination: String): JSONObject {
        require(!hasSafWorkspace()) { "APK extraction currently requires the app-private Local workspace" }
        val apk = safeFile(path); require(apk.isFile && apk.extension.equals("apk", true)) { "Select an APK file" }
        require(apk.length() in 1..150L * 1024L * 1024L) { "APK must be between 1 byte and 150 MB" }
        val out = safeFile(destination.ifBlank { apk.nameWithoutExtension + "-extracted" })
        require(out != localRoot.canonicalFile && !out.exists()) { "Extraction destination must be a new workspace folder" }
        val baseWorkspaceBytes = if (usesDeviceStorageWorkspace()) 0L else workspaceSizeBytes()
        if (!requestLocalApproval("Extract APK archive", "${apk.name} → ${out.relativeTo(localRoot).path}\nAPK contents will be extracted as files; no code will be executed.")) throw SecurityException("APK extraction was denied")
        require(out.mkdirs()) { "Could not create extraction folder" }
        var files = 0; var total = 0L; val dex = JSONArray()
        try {
            java.util.zip.ZipFile(apk).use { zip ->
                val it = zip.entries()
                while (it.hasMoreElements()) {
                    val entry = it.nextElement(); if (entry.isDirectory) continue
                    require(++files <= 5000) { "APK contains too many files (limit 5,000)" }
                    val name = entry.name.replace('\\', '/')
                    require(name.isNotBlank() && !name.startsWith('/') && name.split('/').none { it.isBlank() || it == "." || it == ".." }) { "Unsafe APK archive path rejected" }
                    val target = File(out, name).canonicalFile
                    require(target.path.startsWith(out.canonicalPath + File.separator)) { "APK archive path escaped extraction folder" }
                    target.parentFile?.mkdirs()
                    target.outputStream().use { output -> zip.getInputStream(entry).use { input ->
                        val buffer = ByteArray(64 * 1024); var written = 0L
                        while (true) { val n = input.read(buffer); if (n < 0) break; written += n; total += n
                            require(written <= 32L * 1024L * 1024L && total <= 180L * 1024L * 1024L && baseWorkspaceBytes + total <= 250L * 1024L * 1024L) { "APK extraction exceeds size limits or Local workspace quota" }
                            output.write(buffer, 0, n)
                        }
                    } }
                    if (name.matches(Regex("classes(?:[0-9]+)?\\.dex"))) dex.put(name)
                }
            }
        } catch (e: Exception) { out.deleteRecursively(); throw e }
        return JSONObject().put("ok", true).put("destination", out.relativeTo(localRoot).path).put("files", files)
            .put("bytes", total).put("dexFiles", dex).put("decompiled", false)
            .put("nextStep", "Inspect AndroidManifest.xml, resources, assets and DEX files. Full Java/Kotlin decompilation requires JADX; this extraction does not pretend to decompile bytecode.")
    }

    private fun workspaceSizeBytes(): Long {
        var total = 0L; var visited = 0
        fun walk(dir: File) {
            if (visited++ > 10000 || total > 250L * 1024L * 1024L) return
            dir.listFiles()?.forEach { f ->
                if (f.isDirectory && !f.isSymbolicLinkCompat()) walk(f)
                else if (f.isFile) total += f.length()
            }
        }
        walk(localRoot); return total
    }
    private fun File.isSymbolicLinkCompat(): Boolean = try { java.nio.file.Files.isSymbolicLink(toPath()) } catch (_: Exception) { false }

    private fun safeFile(relative: String): File {
        val rootPath = localRoot.canonicalPath
        val candidate = if (File(relative).isAbsolute) File(relative) else File(localRoot, relative.trimStart('/'))
        val f = candidate.canonicalFile
        require(f.path == rootPath || f.path.startsWith(rootPath + File.separator)) { "Path escapes Local workspace" }
        return f
    }
    // Non-PTY Android shell sessions. Commands run as the app UID (never root) and are
    // explicitly approved. The shell process is not an OS-level workspace sandbox: Android
    // app permissions still govern its filesystem/network access. SAF folders cannot be cwd.
    private fun localTerminalId(raw: String): String {
        require(raw.matches(Regex("^[A-Za-z0-9_-]{12,64}$"))) { "Invalid terminal ID" }
        return raw
    }

    private fun appendTerminalOutput(session: NativeTerminalSession, stream: String, chunk: String) {
        synchronized(session) {
            val target = if (stream == "stderr") session.stderr else session.stdout
            target.append(chunk)
            if (target.length > 120_000) target.delete(0, target.length - 120_000)
            session.output.append(chunk)
            if (session.output.length > 200_000) {
                val trim = session.output.length - 200_000
                session.output.delete(0, trim)
                session.baseOffset += trim
            }
        }
    }

    private fun startTerminalReader(session: NativeTerminalSession, input: java.io.InputStream, stream: String): Thread {
        return Thread({
            try {
                input.use { source ->
                    val buffer = ByteArray(4096)
                    while (true) {
                        val n = source.read(buffer)
                        if (n < 0) break
                        appendTerminalOutput(session, stream, String(buffer, 0, n, Charsets.UTF_8))
                    }
                }
            } catch (e: Exception) {
                appendTerminalOutput(session, "stderr", "\n[terminal stream error: ${(e.message ?: "read failed").take(180)}]\n")
            }
        }, "codespace-term-${stream}-${session.id.take(8)}").apply { isDaemon = true; start() }
    }

    // A real Android pseudo-terminal. forkpty() gives /system/bin/sh a controlling
    // terminal, so readline, job control, Ctrl-C, resize and full-screen programs
    // behave like a terminal rather than a pair of ordinary pipes.
    private fun startPtyReader(session: NativeTerminalSession): Thread {
        return Thread({
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPLACE)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPLACE)
            val inputBuffer = java.nio.ByteBuffer.allocate(16_384)
            val outputBuffer = java.nio.CharBuffer.allocate(8_192)
            fun emitDecoded(endOfInput: Boolean) {
                inputBuffer.flip()
                val result = decoder.decode(inputBuffer, outputBuffer, endOfInput)
                if (result.isError) result.throwException()
                inputBuffer.compact()
                outputBuffer.flip()
                if (outputBuffer.hasRemaining()) appendTerminalOutput(session, "stdout", outputBuffer.toString())
                outputBuffer.clear()
                if (endOfInput) {
                    val flushed = decoder.flush(outputBuffer)
                    if (flushed.isError) flushed.throwException()
                    outputBuffer.flip()
                    if (outputBuffer.hasRemaining()) appendTerminalOutput(session, "stdout", outputBuffer.toString())
                    outputBuffer.clear()
                }
            }
            try {
                while (!session.exited && session.ptyFd >= 0) {
                    val bytes = NativePty.read(session.ptyFd, 8192) ?: break
                    if (bytes.isNotEmpty()) {
                        if (inputBuffer.remaining() < bytes.size) emitDecoded(false)
                        inputBuffer.put(bytes)
                        emitDecoded(false)
                    }
                }
                emitDecoded(true)
            } catch (e: Exception) {
                if (!session.exited) appendTerminalOutput(session, "stderr", "\n[PTY read error: ${(e.message ?: "read failed").take(180)}]\n")
            } finally {
                var waitCode: Int? = null
                if (!session.exited && session.ptyPid > 0) {
                    val code = try { NativePty.waitForExit(session.ptyPid, 2000) } catch (_: Exception) { Int.MIN_VALUE }
                    if (code == Int.MIN_VALUE) {
                        // EOF without a reaped shell must not leave an invisible background process.
                        try { NativePty.stop(session.ptyFd, session.ptyPid) } catch (_: Exception) {}
                        waitCode = -1
                    } else waitCode = code
                    synchronized(session) {
                        if (!session.exited) {
                            session.exited = true
                            session.exitCode = waitCode
                        }
                    }
                }
                val fd = session.ptyFd
                if (fd >= 0) {
                    try { NativePty.closeFd(fd) } catch (_: Exception) {}
                    session.ptyFd = -1
                }
            }
        }, "codespace-pty-read-${session.id.take(8)}").apply { isDaemon = true; start() }
    }

    /** Returns the verified, ABI-matched GNU Bash runtime bundled in the APK. */
    private fun androidBashExecutable(): File? {
        if (hasSafWorkspace()) return null
        return AndroidBashRuntime.ensureInstalled(applicationContext, filesDir)
    }

    private fun androidShellExecutable(shell: String): File {
        return when (shell.trim().lowercase().ifBlank { "default" }) {
            "", "default", "sh" -> File("/system/bin/sh")
            "bash" -> androidBashExecutable()
                ?: throw UnsupportedOperationException("Bundled Android Bash is unavailable for this device ABI. Android Local provides /system/bin/sh; rebuild/install the APK with the Bash runtime task or choose shell=sh.")
            else -> throw UnsupportedOperationException("Android Local supports /system/bin/sh and the bundled Android Bash runtime when available for this ABI")
        }
    }

    private fun androidShellInventory(): JSONArray {
        val shells = JSONArray().put(JSONObject().put("id", "sh").put("label", "Android shell (/system/bin/sh)"))
        if (androidBashExecutable() != null) shells.put(JSONObject().put("id", "bash").put("label", "Bash (.codespace-tools/bin/bash)"))
        return shells
    }

    private fun localTerminalStart(body: JSONObject): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Interactive PTY is available only for the app-private Local workspace. SAF folders remain file-API only.")
        val shell = body.optString("shell", "sh").trim().lowercase().ifBlank { "sh" }
        val shellExecutable = androidShellExecutable(shell)
        require(nativeTerminals.values.count { !it.exited } < 8) { "Android Local allows at most 8 active terminal processes" }
        val cwd = safeFile(body.optString("cwd", ".").ifBlank { "." }).canonicalFile
        require(cwd.isDirectory) { "Terminal working folder does not exist" }
        val cols = body.optInt("cols", 80).coerceIn(20, 300)
        val rows = body.optInt("rows", 24).coerceIn(5, 120)
        if (!requestLocalApproval("Start interactive Android terminal", "Shell: ${shellExecutable.absolutePath}\nFolder: ${cwd.path}\nTerminal: ${cols}×${rows}")) {
            throw SecurityException("Terminal start was denied or timed out")
        }
        val result = NativePty.start(cwd.absolutePath, localRoot.absolutePath, cacheDir.absolutePath, shellExecutable.absolutePath, cols, rows)
        require(result.size >= 3) { "Android PTY native bridge returned an invalid result" }
        val fd = result[0]; val pid = result[1]; val errno = result[2]
        if (fd < 0 || pid <= 0) throw IllegalStateException("Could not create Android PTY (errno=$errno)")
        val id = "andterm_" + java.util.UUID.randomUUID().toString().replace("-", "").take(20)
        val session = NativeTerminalSession(id, "${shellExecutable.absolutePath} -i", cwd.absolutePath, null, fd, pid, shell)
        nativeTerminals[id] = session
        startPtyReader(session)
        trimNativeTerminals()
        return JSONObject().put("id", id).put("name", if (shell == "bash") "Android Bash" else "Android Shell").put("shell", shell)
            .put("cwd", cwd.absolutePath).put("pty", true).put("pid", pid)
            .put("startedAt", session.startedAt).put("exited", false).put("code", JSONObject.NULL)
    }

    private fun localTerminalWrite(body: JSONObject): JSONObject {
        val id = localTerminalId(body.optString("id", ""))
        val session = nativeTerminals[id] ?: throw IllegalArgumentException("Terminal session not found")
        val data = body.optString("data", "")
        val bytes = data.toByteArray(Charsets.UTF_8)
        require(bytes.size <= 16_384) { "Terminal input exceeds 16 KB" }
        require(!session.exited && session.ptyFd >= 0) { "Terminal is not running" }
        val written = if (session.ptyFd >= 0) NativePty.write(session.ptyFd, bytes) else {
            val out = session.process?.outputStream ?: throw IllegalStateException("Terminal input is unavailable")
            out.write(bytes); out.flush(); bytes.size
        }
        if (written < 0) throw IllegalStateException("Terminal input failed (errno=${-written})")
        return JSONObject().put("written", written).put("terminalId", id)
    }

    private fun localTerminalResize(body: JSONObject): JSONObject {
        val id = localTerminalId(body.optString("id", ""))
        val session = nativeTerminals[id] ?: throw IllegalArgumentException("Terminal session not found")
        require(!session.exited && session.ptyFd >= 0) { "Terminal is not running" }
        val cols = body.optInt("cols", 80).coerceIn(20, 300)
        val rows = body.optInt("rows", 24).coerceIn(5, 120)
        val rc = NativePty.resize(session.ptyFd, cols, rows)
        if (rc != 0) throw IllegalStateException("Terminal resize failed (errno=${-rc})")
        return JSONObject().put("resized", true).put("cols", cols).put("rows", rows)
    }

    private fun localTerminalRun(body: JSONObject): JSONObject {
        val command = body.optString("command", "").trim()
        require(command.isNotEmpty() && command.length <= 1000 && !command.contains('\u0000')) { "Command must contain 1–1000 characters" }
        val shell = body.optString("shell", "default").trim().lowercase()
        val firstToken = Regex("\"([^\"]*)\"|'([^']*)'|(\\S+)").find(command)?.let { m -> m.groupValues.drop(1).firstOrNull { it.isNotEmpty() } ?: m.value.trim('\"', '\'') } ?: ""
        if (shell in setOf("node", "nodejs") || firstToken in setOf("node", "nodejs")) return localNodeRun(JSONObject(body.toString()).put("command", command))
        val pythonInvocation = shell == "python" || shell == "python3" || shell == "python3.13" || Regex("^python(?:3(?:\\.13)?)?\\s+").containsMatchIn(command)
        if (pythonInvocation) {
            require(!body.optBoolean("background", false)) { "Python jobs currently run in the foreground; background Python sessions are not available yet" }
            val tokens = Regex("\"([^\"]*)\"|'([^']*)'|(\\S+)").findAll(command).map { m -> m.groupValues.firstOrNull { it.isNotEmpty() && it != m.value } ?: m.value.trim('"', '\'') }.filter { it.isNotEmpty() }.toList()
            require(tokens.isNotEmpty()) { "Provide a .py script path" }
            val startsWithInterpreter = tokens.first() in setOf("python", "python3", "python3.13")
            val scriptIndex = if (startsWithInterpreter) 1 else 0
            require(scriptIndex < tokens.size) { "Provide a .py script path" }
            val scriptPath = tokens[scriptIndex]
            require(scriptPath.endsWith(".py", true) && !scriptPath.startsWith("-")) { "Android Python terminal mode currently runs .py script files. Use /runtime/python/exec for inline source." }
            val args = org.json.JSONArray()
            tokens.drop(scriptIndex + 1).forEach { arg -> require(arg.length <= 1024); args.put(arg) }
            return localPythonRun(JSONObject().put("path", scriptPath).put("args", args)
                .put("cwd", body.optString("cwd", "")).put("timeout", body.optInt("timeout", body.optInt("timeout_seconds", 30))), true)
        }
        if (hasSafWorkspace()) throw UnsupportedOperationException("Android shell execution is available only for the app-private Local workspace. SAF folders remain file-API only.")
        val shellExecutable = androidShellExecutable(shell)
        val selectedShell = if (shell.isBlank() || shell == "default") "sh" else shell
        val cwdRaw = body.optString("cwd", "").ifBlank { "." }
        val cwd = safeFile(cwdRaw).canonicalFile
        require(cwd.isDirectory) { "Command working folder does not exist" }
        require(nativeTerminals.values.count { !it.exited } < 8) { "Android Local allows at most 8 active terminal processes" }
        if (!requestLocalApproval("Run Android shell command", "Folder: ${cwd.path}\n\n$ $command")) throw SecurityException("Command execution was denied or timed out")

        // Android 10+ blocks direct execve() of app-data files (W^X policy).
        // Start the Bionic-linked Bash through Android's system linker instead.
        val launchArgs = if (selectedShell == "bash")
            listOf("/system/bin/linker64", shellExecutable.absolutePath, "-c", command)
        else listOf(shellExecutable.absolutePath, "-c", command)
        val process = ProcessBuilder(launchArgs)
            .directory(cwd)
            .redirectErrorStream(false)
            .apply {
                val toolBin = File(localRoot, ".codespace-tools/bin").absolutePath
                environment()["PATH"] = toolBin + ":/system/bin:/system/xbin:/apex/com.android.runtime/bin"
                environment()["HOME"] = localRoot.absolutePath
                environment()["TMPDIR"] = cacheDir.absolutePath
                environment()["PWD"] = cwd.absolutePath
            }
            .start()
        val id = "andterm_" + java.util.UUID.randomUUID().toString().replace("-", "").take(20)
        val session = NativeTerminalSession(id, command, cwd.absolutePath, process, shell = selectedShell)
        nativeTerminals[id] = session
        val outReader = startTerminalReader(session, process.inputStream, "stdout")
        val errReader = startTerminalReader(session, process.errorStream, "stderr")
        trimNativeTerminals()

        if (body.optBoolean("background", false)) {
            Thread({
                try { val code = process.waitFor(); synchronized(session) { session.exited = true; session.exitCode = code } }
                catch (_: InterruptedException) { Thread.currentThread().interrupt() }
                finally { try { outReader.join(1000) } catch (_: Exception) {}; try { errReader.join(1000) } catch (_: Exception) {} }
            }, "codespace-term-wait-${id.take(8)}").apply { isDaemon = true; start() }
            return JSONObject().put("background", true).put("terminalId", id)
                .put("output", terminalSnapshot(session, 0).optString("data"))
                .put("exited", session.exited).put("code", session.exitCode ?: JSONObject.NULL)
        }

        val timeoutSeconds = body.optInt("timeout", body.optInt("timeout_seconds", 60)).coerceIn(1, 600)
        val finished = try { process.waitFor(timeoutSeconds.toLong(), TimeUnit.SECONDS) } catch (e: InterruptedException) {
            process.destroy(); Thread.currentThread().interrupt(); throw java.util.concurrent.CancellationException("Command wait interrupted")
        }
        if (!finished) {
            process.destroy()
            if (!process.waitFor(1500, TimeUnit.MILLISECONDS)) process.destroyForcibly()
        }
        val code = if (finished) process.exitValue() else -1
        synchronized(session) { session.exited = true; session.exitCode = code }
        try { outReader.join(1500) } catch (_: Exception) {}
        try { errReader.join(1500) } catch (_: Exception) {}
        val stdout: String; val stderr: String
        synchronized(session) { stdout = session.stdout.toString(); stderr = session.stderr.toString() }
        return JSONObject().put("exitCode", code).put("stdout", stdout).put("stderr", stderr)
            .put("timedOut", !finished).put("terminalId", id)
    }

    private fun terminalSnapshot(session: NativeTerminalSession, requestedSince: Int): JSONObject {
        synchronized(session) {
            val since = requestedSince.coerceAtLeast(0)
            val absoluteNext = session.baseOffset + session.output.length
            val effective = since.coerceIn(session.baseOffset, absoluteNext)
            val localStart = (effective - session.baseOffset).coerceIn(0, session.output.length)
            return JSONObject().put("data", session.output.substring(localStart))
                .put("next", absoluteNext).put("baseOffset", session.baseOffset)
                .put("truncated", since < session.baseOffset)
                .put("exited", session.exited)
                .put("code", session.exitCode ?: JSONObject.NULL)
        }
    }

    private fun localTerminalRead(body: JSONObject): JSONObject {
        val rawId = body.optString("id", "")
        if (rawId.startsWith("andnode_")) return localNodeTerminalSnapshot(rawId, body.optInt("since", 0))
        val id = localTerminalId(rawId)
        val session = nativeTerminals[id] ?: throw IllegalArgumentException("Terminal session not found or app process restarted")
        return terminalSnapshot(session, body.optInt("since", 0))
    }

    private fun localTerminalStop(rawId: String): JSONObject {
        if (rawId.startsWith("andnode_")) return localNodeTerminalStop(rawId)
        val id = localTerminalId(rawId)
        val session = nativeTerminals[id] ?: throw IllegalArgumentException("Terminal session not found")
        if (!session.exited) {
            if (session.ptyFd >= 0 && session.ptyPid > 0) {
                try { NativePty.stop(session.ptyFd, session.ptyPid) } catch (_: Exception) {}
                session.ptyFd = -1
            } else {
                session.process?.let { process ->
                    process.destroy()
                    if (!process.waitFor(1200, TimeUnit.MILLISECONDS)) process.destroyForcibly()
                }
            }
            synchronized(session) { session.exited = true; session.exitCode = -1 }
        }
        return JSONObject().put("stopped", true).put("terminalId", id)
    }

    private fun localTerminalList(): JSONObject {
        val rows = org.json.JSONArray()
        nativeTerminals.values.sortedByDescending { it.startedAt }.take(20).forEach { s ->
            synchronized(s) {
                rows.put(JSONObject().put("id", s.id).put("command", s.command)
                    .put("cwd", s.cwd).put("startedAt", s.startedAt)
                    .put("name", if (s.ptyPid > 0) "Android Shell" else s.command.take(80))
                    .put("exited", s.exited).put("code", s.exitCode ?: JSONObject.NULL)
                    .put("pty", s.ptyPid > 0).put("shell", s.shell)
                    .put("next", s.baseOffset + s.output.length))
            }
        }
        localNodeTerminalList().let { nodeRows -> for (i in 0 until nodeRows.length()) rows.put(nodeRows.optJSONObject(i)) }
        return JSONObject().put("terminals", rows)
    }

    /** Truthful sandbox capability report for Android Local. There is deliberately no
     *  unisolated "host process" fallback here: /run and terminal sessions are not sandboxes. */
    private fun localSandboxCapabilities(): JSONObject {
        fun unavailable(provider: String, reason: String): JSONObject =
            JSONObject().put("provider", provider).put("available", false).put("reason", reason)
        val providers = JSONObject()
            .put("docker", unavailable("docker", "Android Local has no Docker Engine, docker CLI, or /var/run/docker.sock."))
            .put("podman", unavailable("podman", "Podman is not installed; Android Local cannot run a container runtime."))
            .put("wasmtime", unavailable("wasmtime", "Wasmtime is not bundled with the Android app; WASI modules cannot be run locally."))
            .put("mock", unavailable("mock", "The test-only mock provider is disabled in Android Local."))
        val nodeVersion = localRuntimeStatus().optJSONObject("node")?.optString("version", "")
            ?.takeIf { it.isNotBlank() } ?: ""
        return JSONObject()
            .put("platform", "android")
            .put("architecture", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("node", if (nodeVersion.isBlank()) JSONObject.NULL else nodeVersion)
            .put("hostMemoryMb", (Runtime.getRuntime().maxMemory() / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
            .put("hostCpus", Runtime.getRuntime().availableProcessors())
            .put("providers", providers)
            .put("profiles", 0)
            .put("maxConcurrent", 0)
            .put("activeSandboxes", 0)
            .put("autoSelection", JSONObject()
                .put("policy", "Capability-based; no isolated sandbox provider is available in Android Local")
                .put("noFallbackToHost", true)
                .put("mockProvider", "disabled"))
            .put("generatedAt", java.time.Instant.now().toString())
            .put("note", "Android Local can run commands in the app UID through /run and terminal sessions, but that is NOT an isolated sandbox. Use a Linux host with Docker or Podman, or select Free server for the backend's container sandbox engine.")
    }

    private fun localInstallLocation(): JSONObject {
        val apk = File(applicationInfo.sourceDir)
        val nodeRunner = File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so")
        val sourceFiles = JSONObject()
            .put("agentServer", false)
            .put("appHtml", true)
            .put("packageManifest", false)
            .put("sourceFragments", false)
            .put("stylesheets", true)
            .put("desktopMain", false)
            .put("webBundle", true)
            .put("bundledNodeRuntime", nodeRunner.isFile)
        return JSONObject()
            .put("schemaVersion", 1)
            .put("ok", apk.isFile)
            .put("installType", "android-apk")
            .put("paths", JSONObject()
                .put("installRoot", apk.parentFile?.absolutePath ?: apk.absolutePath)
                .put("launcherExecutable", apk.absolutePath)
                .put("backendFile", JSONObject.NULL)
                .put("portableDirectory", JSONObject.NULL)
                .put("resourcesDirectory", filesDir.absolutePath)
                .put("bundledNodeRuntime", if (nodeRunner.isFile) nodeRunner.absolutePath else JSONObject.NULL))
            .put("source", JSONObject()
                .put("files", sourceFiles)
                .put("sourceTreePresent", false)
                .put("sourceTreeWritable", false)
                .put("note", "Android APK: the Web UI is bundled in assets and the bridge/backends run inside the app process. No editable server source tree is installed."))
            .put("access", JSONObject()
                .put("installRootExists", apk.isFile)
                .put("installRootWritable", false))
            .put("discovery", "Resolved from the active APK and app directories; no filesystem scan was performed.")
    }

    private fun localWorkflowDiagnostics(): JSONObject {
        val errorPattern = Regex("\\b(error|failed|failure|exception|traceback|ELIFECYCLE|ERR!|cannot find module|not found|syntaxerror|typeerror|referenceerror)\\b", RegexOption.IGNORE_CASE)
        val urlPattern = Regex("https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d{2,5})?(?:/[^\\s\"'<>]*)?", RegexOption.IGNORE_CASE)
        val sessions = JSONArray()
        var running = 0
        var failed = 0
        var withUrls = 0
        nativeTerminals.values.sortedByDescending { it.startedAt }.take(30).forEach { s ->
            val output = synchronized(s) { (s.stdout.toString() + "\n" + s.stderr.toString()).takeLast(30_000) }
            val errorLines = output.lineSequence().filter { errorPattern.containsMatchIn(it) }
                .distinct().toList().takeLast(30)
            val urls = urlPattern.findAll(output).map { it.value.trimEnd(')', ',', '.', ';') }
                .distinct().take(20).toList()
            val code = s.exitCode
            val status = when {
                !s.exited -> "running"
                code != null && code != 0 -> "failed"
                errorLines.isNotEmpty() -> "failed"
                else -> "stopped"
            }
            val result = when {
                status == "failed" -> "error detected"
                urls.isNotEmpty() -> "dev server"
                status == "running" -> "running"
                else -> "completed"
            }
            if (status == "running") running++
            if (status == "failed") failed++
            if (urls.isNotEmpty()) withUrls++
            sessions.put(JSONObject()
                .put("id", s.id)
                .put("name", if (s.ptyPid > 0) "Android Shell" else s.command.take(80))
                .put("cwd", s.cwd)
                .put("command", s.command)
                .put("status", status)
                .put("result", result)
                .put("running", !s.exited)
                .put("exited", s.exited)
                .put("exitCode", code ?: JSONObject.NULL)
                .put("urls", JSONArray(urls))
                .put("outputTail", output.takeLast(5000))
                .put("errorLines", JSONArray(errorLines)))
        }
        localNodeTerminalList().let { rows ->
            for (i in 0 until rows.length()) {
                val r = rows.optJSONObject(i) ?: continue
                val exited = r.optBoolean("exited", false)
                val rawCode = r.opt("code")
                val code = if (rawCode == null || rawCode == JSONObject.NULL) null else (rawCode as? Number)?.toInt()
                val status = if (!exited) "running" else if (code != null && code != 0) "failed" else "stopped"
                if (status == "running") running++
                if (status == "failed") failed++
                sessions.put(JSONObject()
                    .put("id", r.optString("id", ""))
                    .put("name", r.optString("command", "node").take(80))
                    .put("cwd", r.optString("cwd", ""))
                    .put("command", r.optString("command", "node"))
                    .put("status", status)
                    .put("result", if (status == "failed") "error detected" else if (status == "running") "running" else "completed")
                    .put("running", !exited)
                    .put("exited", exited)
                    .put("exitCode", code ?: JSONObject.NULL)
                    .put("urls", JSONArray())
                    .put("outputTail", "")
                    .put("errorLines", JSONArray()))
            }
        }
        return JSONObject()
            .put("root", activeWorkspacePath())
            .put("counts", JSONObject().put("running", running).put("failed", failed).put("withUrls", withUrls))
            .put("sessions", sessions)
            .put("generatedAt", java.time.Instant.now().toString())
            .put("note", "Android Local diagnostics report native terminal sessions. Error lines and URLs are heuristic; review before using them.")
    }

    // Chaquopy-backed, bundled Python 3.13 runtime. Python code runs under the Android
    // app UID and is NOT a separate OS sandbox. We serialize execution because this is
    // one embedded interpreter, and require a native approval for every invocation.
    private fun localRuntimeStatus(): JSONObject {
        val python = JSONObject()
            .put("available", pythonReady)
            .put("implementation", if (pythonReady) "Chaquopy" else JSONObject.NULL)
            .put("version", if (pythonReady) "3.13" else JSONObject.NULL)
            .put("error", pythonStartupError ?: JSONObject.NULL)
            .put("executionAvailable", pythonReady && !hasSafWorkspace())
            .put("requiresAppPrivateWorkspace", true)
            .put("supportsScriptFiles", pythonReady && !hasSafWorkspace())
            .put("supportsPipInstall", false)
            .put("supportsPurePythonWheelInstall", true)
            .put("supportsDependencyResolution", true)
            .put("dependencyResolver", "bounded-pep440-stable-subset")
            .put("pythonPackageDirectory", File(localRoot, ".codespace-python/site-packages").absolutePath)
            .put("supportsPty", false)
            .put("executionBoundary", "Android app UID; not an OS-level project sandbox")
        val node = JSONObject()
            .put("available", BuildConfig.NODE_RUNTIME_INCLUDED)
            .put("implementation", "nodejs-mobile")
            .put("version", BuildConfig.NODE_RUNTIME_VERSION)
            .put("release", "v24.22.1-0")
            .put("flavor", "full")
            .put("inspectorApiIncluded", true)
            .put("inspectorCdpBridgeAvailable", true)
            .put("debuggerAdapterAvailable", true)
            .put("debuggerEditorIntegrated", true)
            .put("debuggerRuntimes", "Node.js Local (.js, .cjs, .mjs)")
            .put("debuggerAdapter", "Editor-integrated DAP-compatible UI over the local Node Inspector CDP transport")
            .put("debuggerAdapterProtocol", "Android Local editor-integrated DAP-compatible launch, breakpoints, stack, variables, evaluation and control over Node Inspector")
            .put("sqliteAvailable", true)
            .put("executionAvailable", BuildConfig.NODE_RUNTIME_INCLUDED && !hasSafWorkspace())
            .put("requiresAppPrivateWorkspace", true)
            .put("supportsScriptFiles", true)
            .put("supportsInlineEval", true)
            .put("supportsNpmInstall", false)
            .put("supportsChildProcesses", File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so").let { it.isFile && it.canExecute() })
            .put("supportsFork", File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so").let { it.isFile && it.canExecute() })
            .put("supportsDetachedChildProcesses", false)
            .put("maxActiveChildProcessesPerNodeProcess", 8)
            .put("childProcessLifecycle", "non-detached children share the managed Node process group; Stop/timeout terminates the group")
            .put("childProcessExecutable", if (File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so").let { it.isFile && it.canExecute() }) File(applicationInfo.nativeLibraryDir, "libcodespace-node-runner.so").absolutePath else JSONObject.NULL)
            .put("supportsPty", false)
            .put("maxSourceBytes", 512 * 1024)
            .put("maxOutputBytes", 1_500_000)
            .put("maxTimeoutSeconds", 600)
            .put("executionBoundary", "Separate Android service process, same app UID; not an OS-level project sandbox")
        return JSONObject().put("platform", "android").put("python", python).put("node", node)
            .put("languageServers", AndroidLanguageServerHost.list())
            .put("languageServerSupervisorAvailable", true)
            .put("languageServerNodeRunnerBundled", BuildConfig.NODE_RUNTIME_INCLUDED)
            .put("languageServerExecutablesBundled", false)
            .put("maxPythonSourceBytes", 512 * 1024).put("maxPythonOutputChars", 60_000)
            .put("maxPythonTimeoutSeconds", 120).put("pythonConcurrency", 1)
    }

    private fun localPythonRun(body: JSONObject, fromFile: Boolean): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Python execution currently requires the app-private Local workspace. SAF folders remain available to the file APIs.")
        if (!pythonReady) throw IllegalStateException("The bundled Python runtime did not start: ${pythonStartupError ?: "unknown startup error"}")

        val rawPath = body.optString("path", "").trim()
        val source: String
        val filename: String
        val defaultCwd: File
        if (fromFile) {
            require(rawPath.isNotEmpty()) { "Select a Python script path" }
            val script = safeFile(rawPath).canonicalFile
            require(script.isFile && script.extension.equals("py", true)) { "Python script must be an existing .py file in the Local workspace" }
            require(script.length() <= 512L * 1024L) { "Python script exceeds the 512 KB limit" }
            source = script.readText(Charsets.UTF_8)
            filename = script.absolutePath
            defaultCwd = script.parentFile ?: localRoot
        } else {
            source = body.optString("source", "")
            require(source.isNotBlank() && source.toByteArray(Charsets.UTF_8).size <= 512 * 1024) { "Python source must contain 1–512 KB" }
            filename = body.optString("filename", "<codespace-inline>").take(180)
            defaultCwd = localRoot
        }

        val cwdRaw = body.optString("cwd", "").ifBlank { defaultCwd.absolutePath }
        val cwd = safeFile(cwdRaw).canonicalFile
        require(cwd.isDirectory) { "Python working folder does not exist" }
        val args = body.optJSONArray("args") ?: org.json.JSONArray()
        require(args.length() <= 64) { "Python accepts at most 64 arguments" }
        for (i in 0 until args.length()) require(args.opt(i) is String && args.optString(i).length <= 1024) { "Python arguments must be strings of at most 1024 characters" }
        val timeoutSeconds = body.optInt("timeout", 30).coerceIn(1, 120)
        val action = if (fromFile) "Run Python script" else "Execute Python code"
        if (!requestLocalApproval(action, "${filename.take(180)}\nWorking folder: ${cwd.path}\nTimeout: ${timeoutSeconds}s\n\n${source.take(900)}")) {
            throw SecurityException("Python execution was denied or timed out")
        }

        val future = pythonExecutor.submit<String> {
            synchronized(pythonExecutionLock) {
                val runtime = Python.getInstance().getModule("codespace_runtime")
                runtime.callAttr("set_site_packages", File(localRoot, ".codespace-python/site-packages").absolutePath)
                runtime.callAttr("run", source, filename, cwd.absolutePath, args.toString(), timeoutSeconds, 60_000)
                    .toString()
            }
        }
        val result = try {
            JSONObject(future.get((timeoutSeconds + 8).toLong(), TimeUnit.SECONDS))
        } catch (e: java.util.concurrent.TimeoutException) {
            future.cancel(true)
            throw IllegalStateException("Python execution did not return before the host timeout. A native extension or blocking system call may not respond to the Python line timer.")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw IllegalStateException("Python runtime failed: ${(e.cause?.message ?: e.message ?: "unknown error").take(1200)}")
        }
        result.put("filename", filename).put("cwd", cwd.absolutePath)
        return result
    }

    private val nodeSessionsRoot by lazy { File(filesDir, "node-runtime/sessions").apply { mkdirs() } }

    private fun nodeSessionId(raw: String): String {
        require(raw.matches(Regex("^andnode_[a-f0-9]{16}$"))) { "Invalid Node session ID" }
        return raw
    }

    private fun nodeSessionDir(id: String): File {
        val dir = File(nodeSessionsRoot, nodeSessionId(id)).canonicalFile
        require(dir.path.startsWith(nodeSessionsRoot.canonicalPath + File.separator)) { "Invalid Node session path" }
        return dir
    }

    private fun nodeStatusFile(id: String) = File(nodeSessionDir(id), "status.json")
    private fun nodeOutputFile(id: String) = File(nodeSessionDir(id), "output.log")
    private fun readNodeStatus(id: String): JSONObject {
        val f = nodeStatusFile(id)
        return try { if (f.isFile && f.length() <= 32_000) JSONObject(f.readText(Charsets.UTF_8)) else JSONObject() } catch (_: Exception) { JSONObject() }
    }

    private fun writeNodeStatus(id: String, value: JSONObject) {
        val f = nodeStatusFile(id); f.parentFile?.mkdirs(); val tmp = File(f.parentFile, "status.json.tmp")
        tmp.writeText(value.toString(), Charsets.UTF_8)
        if (f.exists()) f.delete()
        require(tmp.renameTo(f)) { "Could not persist Node session status" }
    }

    private fun splitNodeCommand(raw: String): List<String> {
        val out = mutableListOf<String>(); val token = StringBuilder(); var quote: Char? = null; var escaped = false
        for (ch in raw) {
            if (escaped) { token.append(ch); escaped = false; continue }
            if (ch == '\\' && quote != '\'') { escaped = true; continue }
            if (quote != null) { if (ch == quote) quote = null else token.append(ch); continue }
            if (ch == '\'' || ch == '"') { quote = ch; continue }
            if (ch.isWhitespace()) { if (token.isNotEmpty()) { out.add(token.toString()); token.setLength(0) }; continue }
            token.append(ch)
        }
        require(quote == null && !escaped) { "Unclosed quote or escape in Node command" }
        if (token.isNotEmpty()) out.add(token.toString())
        return out
    }

    private fun localNodeRun(body: JSONObject): JSONObject {
        if (hasSafWorkspace()) throw UnsupportedOperationException("Node.js execution requires the app-private Local workspace. SAF folders remain available through native file APIs.")
        val command = body.optString("command", "").trim()
        val shell = body.optString("shell", "").trim().lowercase()
        var tokens = if (command.isNotBlank()) splitNodeCommand(command) else emptyList()
        if (tokens.firstOrNull() in setOf("node", "nodejs")) tokens = tokens.drop(1)
        else require(shell in setOf("node", "nodejs") || command.isBlank()) { "Use the Node.js runtime command or the /runtime/node/run endpoint" }

        var source = body.optString("source", "")
        var scriptPath = body.optString("path", "").trim()
        val extraArgs = mutableListOf<String>()
        if (tokens.isNotEmpty()) {
            when (tokens.first()) {
                "-v", "--version" -> return JSONObject().put("version", BuildConfig.NODE_RUNTIME_VERSION).put("stdout", "v${BuildConfig.NODE_RUNTIME_VERSION}\n").put("exitCode", 0)
                "-e", "--eval", "-p", "--print" -> {
                    require(tokens.size >= 2) { "Provide JavaScript source after ${tokens.first()}" }
                    source = tokens[1]
                    extraArgs.addAll(tokens.drop(2))
                }
                else -> {
                    require(!tokens.first().startsWith("-")) { "Only script files, --version, and -e/--eval are supported by the Android Node launcher" }
                    scriptPath = tokens.first()
                    extraArgs.addAll(tokens.drop(1))
                }
            }
        }
        if (source.isNotBlank()) require(source.toByteArray(Charsets.UTF_8).size <= 512 * 1024) { "Node inline source exceeds 512 KB" }
        if (scriptPath.isNotBlank()) {
            val script = safeFile(scriptPath).canonicalFile
            require(script.isFile && script.extension.lowercase() in setOf("js", "cjs", "mjs")) { "Node script must be an existing .js, .cjs or .mjs file in the Local workspace" }
            require(script.length() <= 8L * 1024L * 1024L) { "Node script exceeds 8 MB" }
            scriptPath = script.absolutePath
        }
        require(source.isNotBlank() || scriptPath.isNotBlank()) { "Provide a JavaScript script path or inline source" }
        val argsArray = body.optJSONArray("args")
        if (argsArray != null) for (i in 0 until argsArray.length()) extraArgs.add(argsArray.optString(i))
        require(extraArgs.size <= 64 && extraArgs.all { it.length <= 1024 && !it.contains('\u0000') }) { "Node accepts at most 64 arguments, each up to 1024 characters" }

        val defaultCwd = if (scriptPath.isNotBlank()) File(scriptPath).parentFile ?: localRoot else localRoot
        val cwd = safeFile(body.optString("cwd", "").ifBlank { defaultCwd.absolutePath }).canonicalFile
        require(cwd.isDirectory) { "Node working folder does not exist" }
        val timeoutSeconds = body.optInt("timeout", body.optInt("timeout_seconds", 60)).coerceIn(1, 600)
        val debug = body.optBoolean("debug", false)
        val background = body.optBoolean("background", false) || debug
        val debugPort = if (debug) java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort } else 0
        val display = if (source.isNotBlank()) "node -e ${source.take(240)}" else "node ${scriptPath.removePrefix(localRoot.canonicalPath).trimStart('/') } ${extraArgs.joinToString(" ").take(200)}".trim()
        if (!requestLocalApproval(if (debug) "Run Node.js under debugger" else "Run Node.js code", "${display.take(500)}\nWorking folder: ${cwd.path}\nNode.js ${BuildConfig.NODE_RUNTIME_VERSION}; timeout ${timeoutSeconds}s${if (debug) "\nNode inspector: 127.0.0.1:$debugPort (paused at start)" else ""}")) throw SecurityException("Node.js execution was denied or timed out")

        val processName = "$packageName:node_runtime"
        val activityManager = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
        val nodeProcessAlive = activityManager.runningAppProcesses?.any { it.processName == processName } == true
        val sessionDirs = nodeSessionsRoot.listFiles()?.filter { it.isDirectory && it.name.matches(Regex("^andnode_[a-f0-9]{16}$")) } ?: emptyList()
        if (!nodeProcessAlive) {
            // Reconcile stale session flags after Android reclaimed the service
            // process while CodeSpace itself remained alive.
            sessionDirs.forEach { dir ->
                val old = readNodeStatus(dir.name)
                if (old.optString("status") == "running") {
                    writeNodeStatus(dir.name, JSONObject(old.toString()).put("status", "error")
                        .put("error", "Node runtime process ended before recording its exit status")
                        .put("endedAt", System.currentTimeMillis()))
                }
            }
        }
        val existingRun = sessionDirs.any { readNodeStatus(it.name).optString("status") == "running" }
        require(!nodeProcessAlive && !existingRun) { "Another Node.js session is still active. Stop or wait for it before starting another." }

        val id = "andnode_" + java.util.UUID.randomUUID().toString().replace("-", "").take(16)
        val dir = nodeSessionDir(id).apply { mkdirs() }
        val log = File(dir, "output.log")
        val status = File(dir, "status.json")
        val args = mutableListOf("node", "--max-old-space-size=384")
        if (debug) args.add("--inspect-brk=127.0.0.1:$debugPort")
        if (source.isNotBlank()) { args.add(if (tokens.firstOrNull() in setOf("-p", "--print")) "--print" else "--eval"); args.add(source); if (extraArgs.isNotEmpty()) { args.add("--"); args.addAll(extraArgs) } }
        else { args.add(scriptPath); args.addAll(extraArgs) }
        writeNodeStatus(id, JSONObject().put("id", id).put("command", display.take(1000)).put("cwd", cwd.absolutePath).put("status", "running").put("startedAt", System.currentTimeMillis()).put("pid", JSONObject.NULL).put("debugPort", if (debug) debugPort else JSONObject.NULL).put("debugPausedAtStart", debug))

        try {
            val intent = Intent(this, NodeRuntimeService::class.java).apply {
                action = NodeRuntimeService.ACTION_RUN
                putExtra(NodeRuntimeService.EXTRA_ID, id)
                putStringArrayListExtra(NodeRuntimeService.EXTRA_ARGS, ArrayList(args))
                putExtra(NodeRuntimeService.EXTRA_CWD, cwd.absolutePath)
                putExtra(NodeRuntimeService.EXTRA_LOG, log.absolutePath)
                putExtra(NodeRuntimeService.EXTRA_STATUS, status.absolutePath)
            }
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        } catch (e: Exception) {
            writeNodeStatus(id, JSONObject().put("id", id).put("status", "error").put("error", (e.message ?: "Could not start Node runtime service").take(1000)))
            throw IllegalStateException("Could not start the Android Node.js runtime: ${e.message}")
        }

        if (background) return JSONObject().put("background", true).put("terminalId", id).put("nodeVersion", BuildConfig.NODE_RUNTIME_VERSION).put("debug", debug).put("debugPort", if (debug) debugPort else JSONObject.NULL).put("debuggerEndpoint", if (debug) "127.0.0.1:$debugPort" else JSONObject.NULL)
        val deadline = System.currentTimeMillis() + timeoutSeconds * 1000L
        var state = readNodeStatus(id)
        while (state.optString("status") == "running" && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(120) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); break }
            state = readNodeStatus(id)
        }
        val snapshot = localNodeTerminalSnapshot(id, 0)
        state = readNodeStatus(id)
        if (state.optString("status") == "running") {
            // Foreground timeout means stop the process; only explicit
            // background:true requests are allowed to outlive this call.
            localNodeTerminalStop(id)
            return JSONObject().put("background", false).put("terminalId", id)
                .put("nodeVersion", BuildConfig.NODE_RUNTIME_VERSION).put("timedOut", true)
                .put("exitCode", -1).put("stdout", snapshot.optString("data"))
                .put("stderr", "Node.js execution timed out and was stopped")
        }
        return JSONObject().put("exitCode", state.optInt("exitCode", if (state.optString("status") == "done") 0 else -1))
            .put("stdout", snapshot.optString("data")).put("stderr", "").put("terminalId", id)
            .put("nodeVersion", BuildConfig.NODE_RUNTIME_VERSION).put("timedOut", false)
    }

    private fun localNodeTerminalSnapshot(idRaw: String, requestedSince: Int): JSONObject {
        val id = nodeSessionId(idRaw); val outputFile = nodeOutputFile(id)
        val state = readNodeStatus(id)
        val total = if (outputFile.isFile) outputFile.length() else 0L
        val maxRead = 1_800_000L
        val base = (total - maxRead).coerceAtLeast(0L).toInt()
        val since = requestedSince.coerceAtLeast(0)
        val effective = since.coerceIn(base, total.toInt())
        val start = effective.toLong()
        val count = (total - start).coerceIn(0L, 200_000L).toInt()
        val bytes = ByteArray(count)
        if (count > 0 && outputFile.isFile) java.io.RandomAccessFile(outputFile, "r").use { raf -> raf.seek(start); raf.readFully(bytes) }
        var stateName = state.optString("status", "running")
        if (stateName == "running" && state.optLong("pid", 0L) > 0L) {
            val am = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
            val alive = am.runningAppProcesses?.any { it.processName == "$packageName:node_runtime" } == true
            if (!alive) {
                stateName = "error"
                state.put("status", "error").put("error", "Node runtime process ended before recording an exit status").put("endedAt", System.currentTimeMillis())
                writeNodeStatus(id, state)
            }
        }
        return JSONObject().put("data", String(bytes, Charsets.UTF_8)).put("next", total.toInt()).put("baseOffset", base)
            .put("truncated", since < base).put("exited", stateName != "running")
            .put("code", if (state.has("exitCode")) state.optInt("exitCode") else JSONObject.NULL)
            .put("status", stateName).put("error", state.opt("error") ?: JSONObject.NULL)
    }

    private fun localNodeTerminalStop(idRaw: String): JSONObject {
        val id = nodeSessionId(idRaw); val state = readNodeStatus(id)
        if (state.optString("status") == "running") {
            writeNodeStatus(id, JSONObject(state.toString()).put("status", "cancelled").put("endedAt", System.currentTimeMillis()).put("error", "Stopped by user"))
            val nodePid = state.optInt("pid", -1)
            val groupStopped = nodePid > 0 && runCatching { NativePty.stopProcessGroup(nodePid) == 0 }.getOrDefault(false)
            if (!groupStopped) {
                try { startService(Intent(this, NodeRuntimeService::class.java).setAction(NodeRuntimeService.ACTION_STOP)) } catch (_: Exception) {}
            }
        }
        return JSONObject().put("stopped", true).put("terminalId", id)
    }

    private fun localNodeTerminalList(): org.json.JSONArray {
        val rows = org.json.JSONArray()
        nodeSessionsRoot.listFiles()?.filter { it.isDirectory && it.name.matches(Regex("^andnode_[a-f0-9]{16}$")) }
            ?.sortedByDescending { it.lastModified() }?.take(20)?.forEach { dir ->
                val id = dir.name; val state = readNodeStatus(id)
                rows.put(JSONObject().put("id", id).put("command", state.optString("command", "node")).put("cwd", state.optString("cwd", ""))
                    .put("startedAt", state.optLong("startedAt", dir.lastModified())).put("exited", state.optString("status") != "running")
                    .put("status", state.optString("status", "unknown")).put("code", state.opt("exitCode") ?: JSONObject.NULL)
                    .put("next", if (nodeOutputFile(id).isFile) nodeOutputFile(id).length() else 0L))
            }
        return rows
    }

    private fun trimNativeTerminals() {
        val closed = nativeTerminals.values.filter { it.exited }.sortedByDescending { it.startedAt }
        closed.drop(12).forEach { nativeTerminals.remove(it.id) }
    }

    private fun runLocalCommand(command: String): String {
        val raw = command.trim()
        if (raw.isEmpty() || raw.length > 1000 || raw.any { it in ";&|<>`$\n\r" }) return "DENIED: unsupported command syntax"
        val args = raw.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val op = args.firstOrNull() ?: return ""
        fun pathArg(i: Int): File = safeFile(args.getOrElse(i) { "." })
        return try {
            when (op) {
                "pwd" -> localRoot.absolutePath
                "whoami" -> "app_${applicationInfo.uid}"
                "date" -> java.util.Date().toString()
                "echo" -> args.drop(1).joinToString(" ").take(4000)
                "ls" -> (pathArg(1).listFiles()?.map { it.name + if (it.isDirectory) "/" else "" } ?: emptyList()).sorted().joinToString("\n")
                "cat" -> pathArg(1).let { if (it.isFile && it.length() <= 256_000) it.readText() else "DENIED: file missing or exceeds 256 KB" }
                "mkdir" -> { val rel = args.getOrElse(1) { "." }; if (!requestLocalApproval("Create folder", rel)) "DENIED: approval declined" else pathArg(1).let { if (it.mkdirs() || it.isDirectory) "created" else "mkdir failed" } }
                "touch" -> { val rel = args.getOrElse(1) { "" }; if (!requestLocalApproval("Create file", rel)) "DENIED: approval declined" else pathArg(1).let { it.parentFile?.mkdirs(); if (!it.exists()) it.createNewFile(); "touched" } }
                else -> "DENIED: $op is not enabled in the Local sandbox on Android"
            }
        } catch (e: Exception) { "Local sandbox error: ${e.message}" }
    }

    private fun requestLocalApproval(action: String, path: String): Boolean {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return false

        // Honor the permission mode chosen in the Web UI. The native file APIs previously
        // ignored it and prompted on every single write, making Local mode painfully slow.
        // "all" auto-approves everything; "smart"/"auto" auto-approve routine edits inside
        // the selected workspace but still ask for destructive/external actions; "ask"
        // always prompts. This mirrors the Web UI's permission semantics.
        when (prefs.getString("uwb_perm_mode", "smart") ?: "smart") {
            "all" -> return true
            "smart", "auto" -> {
                val routine = listOf("Write ", "Create ", "Move ", "Rename ", "Read ")
                    .any { action.startsWith(it, ignoreCase = true) }
                if (routine) return true
            }
        }

        val latch = java.util.concurrent.CountDownLatch(1)
        var approved = false
        runOnUiThread {
            try {
                android.app.AlertDialog.Builder(this)
                    .setTitle("Local workspace permission")
                    .setMessage("Allow $action?\n\n${path.take(240)}")
                    .setPositiveButton("Allow") { _, _ -> approved = true; latch.countDown() }
                    .setNegativeButton("Deny") { _, _ -> latch.countDown() }
                    .setOnCancelListener { latch.countDown() }
                    .show()
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        return try { latch.await(30, TimeUnit.SECONDS) && approved } catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
    }

    private fun activeWorkspacePath(): String = if (hasSafWorkspace()) "saf://workspace" else localRoot.canonicalPath
    private fun hasSafWorkspace(): Boolean = !prefs.getString("workspace_tree_uri", "").isNullOrBlank()

    /**
     * SINGLE canonical, validated workspace state shared by the chat, file tools and OpenCode CLI.
     * Returns the real POSIX path to use for a child process (device-storage path, SAF direct path,
     * or the managed SAF mirror path after a successful sync-in), plus the workspace identity,
     * permission status and an actionable error when the folder is missing/revoked/unavailable.
     */
    private fun activeWorkspaceState(): JSONObject {
        val treeUri = prefs.getString("workspace_tree_uri", "")?.takeIf { it.isNotBlank() }
        val deviceDir = prefs.getString("workspace_dir", "")?.takeIf { it.isNotBlank() }
        val kind = if (treeUri != null) "saf" else if (deviceDir != null) "device" else "app-private"

        // Validate permissions for the selected folder; a revoked grant is an actionable error.
        var permissionOk = true
        var permError = ""
        if (treeUri != null) {
            try {
                val u = android.net.Uri.parse(treeUri)
                permissionOk = contentResolver.persistedUriPermissions.any {
                    it.uri == u && it.isReadPermission && it.isWritePermission
                }
                if (!permissionOk) permError = "The selected folder's permission was revoked. Open Folder and select it again."
            } catch (_: Throwable) { permissionOk = false; permError = "The selected folder URI is invalid. Select it again." }
        } else if (deviceDir != null) {
            val f = File(deviceDir)
            permissionOk = f.isDirectory && f.canRead() && f.canWrite()
            if (!permissionOk) permError = "The selected folder is no longer available or writable. Select it again."
        }

        val resolved = AndroidOpenCodeWorkspace.resolve(this, treeUri, deviceDir)
        var posixPath: String? = resolved.posixPath
        var mirrored = false
        var syncError = ""
        if (permissionOk && resolved.mirror && treeUri != null) {
            // Wait for SAF mirror initialization/synchronization before exposing the path.
            val synced = AndroidOpenCodeWorkspace.syncIn(this, treeUri)
            if (synced.optBoolean("ok", false)) {
                posixPath = AndroidOpenCodeWorkspace.mirrorPath(this)
                mirrored = true
            } else {
                syncError = synced.optString("error", "Could not initialize the workspace mirror")
            }
        }

        val available = permissionOk && !posixPath.isNullOrBlank()
        val err = when {
            kind == "app-private" -> "No folder selected. Use File > Open Folder and choose a project folder."
            permError.isNotBlank() -> permError
            syncError.isNotBlank() -> syncError
            posixPath.isNullOrBlank() -> "The selected folder has no usable local path on this device."
            else -> ""
        }
        return JSONObject()
            .put("ok", true)
            .put("available", available)
            .put("kind", kind)
            .put("root", activeWorkspacePath())
            .put("workspaceId", workspaceIdentity())
            .put("posixPath", posixPath ?: JSONObject.NULL)
            .put("mirrored", mirrored)
            .put("permissionOk", permissionOk)
            .put("platform", "android")
            .put("error", err)
    }

    /** Stable identity for the currently selected Android folder UUID, for cross-referencing state. */
    private fun workspaceIdentity(): String {
        val raw = prefs.getString("workspace_tree_uri", "")?.takeIf { it.isNotBlank() }
            ?: prefs.getString("workspace_dir", "")?.takeIf { it.isNotBlank() }
            ?: return "app-private"
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(16)
    }
    // Cached so the JavaBridge thread never touches WebView/View methods (those must run on the UI thread).
    @Volatile private var lastBrowserUrl: String = ""
    @Volatile private var lastBrowserVisible: Boolean = false
    @Volatile private var browserLoading: Boolean = false
    @Volatile private var browserLoadGeneration: Long = 0L
    private fun browserPageOpen(): Boolean = lastBrowserUrl.isNotBlank() && lastBrowserUrl != "about:blank"
    private fun browserOverlayVisible(): Boolean = lastBrowserVisible
    /** Reads WebView titles/URLs on the UI thread; the JavaBridge thread must never touch them. */
    private fun browserTabsSnapshot(): JSONArray {
        val latch = CountDownLatch(1)
        val rows = JSONArray()
        runOnUiThread {
            try {
                browserTabs.forEachIndexed { i, web ->
                    rows.put(JSONObject().put("id", i.toString()).put("title", web.title ?: "New tab")
                        .put("url", if (i == activeTab) lastBrowserUrl.ifBlank { "about:blank" } else (web.url ?: "about:blank"))
                        .put("current", i == activeTab))
                }
            } catch (_: Exception) { } finally { latch.countDown() }
        }
        try { latch.await(3, TimeUnit.SECONDS) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        return rows
    }

    private var pendingStorageAccessPicker = false
    private var pendingStorageResumeDir: File? = null

    /**
     * Open the built-in device-storage folder browser. This deliberately avoids the system
     * DocumentsUI picker (which often starts on "Recent" and hides real storage folders).
     * Android 11+ requires the "All files access" special permission for this; the system
     * DocumentsUI picker remains available as a fallback.
     */
    private fun chooseWorkspaceFolder() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            android.app.AlertDialog.Builder(this)
                .setTitle("Device storage access")
                .setMessage("To browse your phone storage directly, allow CodeSpace “All files access” on the next screen, then come back and pick a folder.\n\nYou can also use the Android system folder picker instead.")
                .setPositiveButton("Allow access") { _, _ -> requestAllFilesAccess(Environment.getExternalStorageDirectory()) }
                .setNeutralButton("System picker") { _, _ -> pendingStorageAccessPicker = false; chooseWorkspaceFolderSaf() }
                .setNegativeButton("Cancel") { _, _ -> pendingStorageAccessPicker = false }
                .show()
            return
        }
        showDeviceFolderPicker(Environment.getExternalStorageDirectory())
    }

    private fun requestAllFilesAccess(resumeAt: File?) {
        pendingStorageAccessPicker = true
        pendingStorageResumeDir = resumeAt
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) } catch (_: Exception) {}
        }
    }

    override fun onResume() {
        super.onResume()
        
        // Ensure UWB bridge is stopped in Local mode (cleanup from previous runs)
        if (!isRemoteMode() && uwbBridgeService?.isRunning() == true) {
            stopUWBBridge()
        }
        
        // Bind to UWB Bridge Service only in remote modes (Render/GitHub)
        // Local mode uses native file APIs, not the UWB WebSocket bridge
        if (!uwbServiceBound && isRemoteMode()) {
            val intent = Intent(this, UWBBridgeService::class.java)
            bindService(intent, uwbServiceConnection, Context.BIND_AUTO_CREATE)
        }
        if (pendingStorageAccessPicker && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) {
            pendingStorageAccessPicker = false
            val start = pendingStorageResumeDir?.takeIf { it.isDirectory } ?: Environment.getExternalStorageDirectory()
            pendingStorageResumeDir = null
            showDeviceFolderPicker(start)
        }
    }

    override fun onPause() {
        super.onPause()
        // Don't unbind here - keep service running in background
    }

    private fun chooseWorkspaceFolderSaf() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            try { putExtra("android.provider.extra.INITIAL_URI", Uri.parse("content://com.android.externalstorage.documents/root/primary")) } catch (_: Exception) {}
        }
        try { startActivityForResult(intent, REQ_WORKSPACE_TREE) }
        catch (e: Exception) { status.text = "No system folder picker: ${e.message}" }
    }

    private fun shortStoragePath(dir: File): String =
        dir.absolutePath.replace("/storage/emulated/0", "Internal storage").replace("/storage/emulated/0/", "Internal storage/")

    private fun showDeviceFolderPicker(start: File) {
        fun render(dir: File) {
            val canonical = try { dir.canonicalFile } catch (_: Exception) { dir }
            val rawList = try { canonical.listFiles() } catch (_: Exception) { null }
            val blocked = rawList == null
            val children: List<File> = rawList
                ?.filter { it.isDirectory && !it.isHidden && !it.isSymbolicLinkCompat() }
                ?.sortedBy { it.name.lowercase() } ?: emptyList()
            val storageRoot = try { Environment.getExternalStorageDirectory().canonicalFile } catch (_: Exception) { null }
            val up = canonical.parentFile?.takeIf { storageRoot == null || canonical.absolutePath != storageRoot.absolutePath }
            val titles = ArrayList<String>()
            val actions = ArrayList<() -> Unit>()
            titles.add("✓  Use this folder"); actions.add { setWorkspaceFolder(canonical) }
            if (blocked) {
                titles.add("⚠  Allow “All files access” for CodeSpace"); actions.add { requestAllFilesAccess(canonical) }
            }
            if (up != null) {
                titles.add("⬆  Up: " + (up.name.ifBlank { up.absolutePath })); actions.add { render(up) }
            }
            children.take(400).forEach { child -> titles.add("▸  " + child.name); actions.add { render(child) } }
            android.app.AlertDialog.Builder(this)
                .setTitle(shortStoragePath(canonical) + if (blocked) "  ·  not readable" else "")
                .setItems(titles.toTypedArray()) { _, which -> actions.getOrNull(which)?.invoke() }
                .setNeutralButton("System picker") { _, _ -> chooseWorkspaceFolderSaf() }
                .setNegativeButton("Cancel", null)
                .show()
        }
        render(start)
    }

    private fun setWorkspaceFolder(dir: File) {
        runOnUiThread {
            try {
                val canonical = dir.canonicalFile
                require(canonical.isDirectory) { "This is not a folder" }
                require(canonical.listFiles() != null) { "Android did not allow reading this folder. Grant “All files access” in Settings → Apps → CodeSpace → Special app access, then pick it again." }
                prefs.edit().putString("workspace_dir", canonical.path).remove("workspace_tree_uri").apply()
                val label = shortStoragePath(canonical)
                status.text = "Workspace: $label"
                CrashLog.write(this, "workspace", "picked device folder: ${canonical.path}")
                notifyWorkspacePicked(true, label, canonical.path, "")
                syncBridgeConfig(false)
            } catch (e: Exception) {
                status.text = "Could not use folder: ${e.message}"
                CrashLog.write(this, "workspace", "folder rejected: ${dir.path} — ${e.message}")
                notifyWorkspacePicked(false, "", "", e.message ?: "Could not use folder")
            }
        }
    }

    private fun notifyWorkspacePicked(ok: Boolean, name: String, path: String, error: String, cancelled: Boolean = false) {
        if (!::appWeb.isInitialized) return
        val detail = JSONObject().put("ok", ok).put("cancelled", cancelled)
            .put("path", path).put("name", name).put("error", error)
        appWeb.evaluateJavascript("window.dispatchEvent(new CustomEvent('codespace-native-workspace-picked',{detail:${JSONObject.quote(detail.toString())}}))", null)
    }

    private fun safRoot(): DocumentFile {
        val raw = prefs.getString("workspace_tree_uri", "") ?: ""
        require(raw.isNotBlank()) { "Choose a workspace folder first" }
        val uri = Uri.parse(raw)
        require(contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }) { "Workspace folder permission expired; choose it again" }
        return DocumentFile.fromTreeUri(this, uri) ?: throw IllegalStateException("Cannot open selected workspace folder")
    }

    private fun safRelative(path: String): String {
        val p = path.trim()
        if (p.isBlank() || p == "." || p == "saf://workspace") return ""
        val rel = if (p.startsWith("saf://workspace/")) p.removePrefix("saf://workspace/") else p.trimStart('/')
        val parts = rel.split('/')
        require(parts.size <= 64 && parts.all { it.isNotBlank() && it != "." && it != ".." && !it.contains('\\') && it.length <= 255 }) { "Invalid workspace path" }
        return parts.joinToString("/")
    }

    private fun safDocument(path: String): DocumentFile {
        var node = safRoot()
        val rel = safRelative(path)
        if (rel.isEmpty()) return node
        for (part in rel.split('/')) node = node.findFile(part) ?: throw IllegalArgumentException("Path not found: $path")
        return node
    }

    private fun safParentAndName(path: String): Pair<DocumentFile, String> {
        val rel = safRelative(path)
        require(rel.isNotEmpty()) { "Workspace root cannot be changed" }
        val parts = rel.split('/')
        var parent = safRoot()
        for (part in parts.dropLast(1)) parent = parent.findFile(part) ?: throw IllegalArgumentException("Parent folder not found")
        return parent to parts.last()
    }

    private fun safPath(doc: DocumentFile): String {
        val rootUri = prefs.getString("workspace_tree_uri", "") ?: ""
        if (doc.uri == Uri.parse(rootUri) || doc.parentFile == null) return "saf://workspace"
        // SAF document IDs are opaque; construct stable virtual paths from the selected tree's relative display names.
        val chain = mutableListOf<String>(); var current: DocumentFile? = doc
        val root = safRoot(); var guard = 0
        while (current != null && current.uri != root.uri && guard++ < 64) { chain.add(current.name ?: "item"); current = current.parentFile }
        return "saf://workspace/" + chain.asReversed().joinToString("/")
    }

    private fun safWorkspaceDirs(path: String): JSONObject {
        val dir = safDocument(path); require(dir.isDirectory) { "Folder not found" }
        val children = dir.listFiles().filter { it.isDirectory }.sortedBy { (it.name ?: "").lowercase() }
        val dirs = org.json.JSONArray(); children.take(500).forEach { dirs.put(it.name ?: "") }
        val parent = if (safRelative(path).isEmpty()) JSONObject.NULL else "saf://workspace/" + safRelative(path).substringBeforeLast('/', "")
        return JSONObject().put("path", safPath(dir)).put("sep", "/").put("parent", parent)
            .put("dirs", dirs).put("truncated", children.size > 500)
            .put("places", org.json.JSONArray().put(JSONObject().put("name", "Selected Android folder").put("path", "saf://workspace")))
            .put("recent", org.json.JSONArray().put("saf://workspace")).put("current", "saf://workspace")
    }

    private fun safFsList(path: String, recursive: Boolean): JSONObject {
        val dir = safDocument(path); require(dir.isDirectory) { "Folder not found" }
        val entries = org.json.JSONArray(); var count = 0
        fun walk(folder: DocumentFile, prefix: String) {
            folder.listFiles().sortedBy { (it.name ?: "").lowercase() }.forEach { child ->
                val name = child.name ?: return@forEach
                if (name in setOf(".git", "node_modules", ".gradle") || count >= 300) return@forEach
                val rel = if (prefix.isEmpty()) name else "$prefix/$name"
                entries.put(rel + if (child.isDirectory) "/" else ""); count++
                if (recursive && child.isDirectory && count < 300) walk(child, rel)
            }
        }
        walk(dir, ""); return JSONObject().put("entries", entries)
    }

    private fun safFsStat(path: String): JSONObject {
        val doc = safDocument(path)
        require(doc.exists()) { "Path not found: $path" }
        return JSONObject().put("path", path).put("size", doc.length()).put("mtime", doc.lastModified())
            .put("isFile", doc.isFile).put("isDirectory", doc.isDirectory)
            .put("mode", if (doc.isDirectory) "0755" else "0644")
            .put("mimeType", if (doc.isDirectory) "inode/directory" else (contentResolver.getType(doc.uri) ?: "application/octet-stream"))
    }

    private fun safFsRead(path: String): JSONObject {
        val doc = safDocument(path); require(doc.isFile) { "File not found" }
        require((doc.length()) in 0..1_000_000L) { "File is larger than 1 MB" }
        val name = (doc.name ?: "").lowercase()
        require(!name.matches(Regex(".*\\.(png|jpe?g|gif|webp|pdf|zip|7z|exe|dll|so|apk|mp[34]|gguf|bin)$"))) { "Refusing to read a binary file" }
        val content = contentResolver.openInputStream(doc.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        return JSONObject().put("content", content)
    }

    private fun safFsWrite(path: String, content: String, base64: String = ""): JSONObject {
        require(!(content.isNotEmpty() && base64.isNotEmpty())) { "Send either text content or Base64 binary data, not both" }
        val bytes = if (base64.isNotEmpty()) {
            require(base64.length <= 11 * 1024 * 1024) { "Binary upload exceeds the 8 MB limit" }
            try { Base64.decode(base64, Base64.DEFAULT) } catch (_: IllegalArgumentException) { throw IllegalArgumentException("Invalid Base64 binary upload") }
        } else content.toByteArray(Charsets.UTF_8)
        require(bytes.size <= if (base64.isNotEmpty()) 8 * 1024 * 1024 else 1_000_000) { "Write exceeds the file size limit" }
        val (parent, name) = safParentAndName(path)
        if (!requestLocalApproval("Write ${if (base64.isNotEmpty()) "binary" else "text"} file", "$path (${bytes.size} bytes)")) throw SecurityException("Write permission denied")
        val existing = parent.findFile(name)
        if (existing != null) localHistoryPush(path, true, if (base64.isEmpty() && existing.isFile && existing.length() <= 400_000L) contentResolver.openInputStream(existing.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } else null) else localHistoryPush(path, false, null)
        val target = existing ?: parent.createFile("application/octet-stream", name) ?: throw IllegalStateException("Could not create file")
        require(target.isFile) { "Destination is not a file" }
        contentResolver.openOutputStream(target.uri, "wt")?.use { it.write(bytes) } ?: throw IllegalStateException("Could not open file for writing")
        return JSONObject().put("bytes", bytes.size).put("binary", base64.isNotEmpty())
    }

    private fun safFsMkdir(path: String): JSONObject {
        val (parent, name) = safParentAndName(path)
        if (!requestLocalApproval("Create folder", path)) throw SecurityException("Folder creation denied")
        require(parent.findFile(name) == null) { "Folder already exists" }
        require(parent.createDirectory(name) != null) { "Could not create folder" }
        return JSONObject().put("created", true)
    }

    private fun safFsDelete(path: String, recursive: Boolean): JSONObject {
        val doc = safDocument(path); require(doc.uri != safRoot().uri) { "Cannot delete workspace root" }
        if (doc.isDirectory && !recursive) require(doc.listFiles().isEmpty()) { "Folder is not empty" }
        if (!requestLocalApproval("Delete ${if (doc.isDirectory) "folder" else "file"}", path)) throw SecurityException("Delete denied")
        if (doc.isFile && doc.length() <= 400_000L) localHistoryPush(path, true, contentResolver.openInputStream(doc.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() })
        require(doc.delete()) { "Could not delete selected item" }; return JSONObject().put("deleted", true)
    }

    private fun safFsRename(path: String, to: String): JSONObject {
        val source = safDocument(path); require(source.uri != safRoot().uri) { "Cannot rename workspace root" }
        val (parent, name) = safParentAndName(to)
        require(source.parentFile?.uri == parent.uri) { "Moving items between folders is not supported by this document provider; rename within the same folder" }
        require(parent.findFile(name) == null) { "Destination already exists" }
        if (!requestLocalApproval("Move or rename", "$path → $to")) throw SecurityException("Rename denied")
        require(source.renameTo(name)) { "Provider does not support rename for this item" }
        return JSONObject().put("renamed", true)
    }

    private fun safFsSearch(path: String, query: String): JSONObject {
        val q = query.trim().lowercase(); require(q.isNotEmpty() && q.length <= 200) { "Invalid search query" }
        val results = org.json.JSONArray(); var scanned = 0
        fun walk(dir: DocumentFile, prefix: String) {
            dir.listFiles().forEach { child ->
                val name = child.name ?: return@forEach
                if (name in setOf(".git", "node_modules", ".gradle", ".agent")) return@forEach
                if (child.isDirectory) walk(child, if (prefix.isEmpty()) name else "$prefix/$name")
                else if (child.isFile && child.length() <= 1_000_000L && ++scanned <= 400 && !name.lowercase().matches(Regex(".*\\.(png|jpe?g|gif|webp|pdf|zip|7z|exe|dll|so|apk|mp[34]|gguf|bin)$"))) {
                    val lines = try { contentResolver.openInputStream(child.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readLines() } ?: emptyList() } catch (_: Exception) { emptyList() }
                    lines.forEachIndexed { i, line -> if (results.length() < 60 && line.lowercase().contains(q)) results.put("${if (prefix.isEmpty()) name else "$prefix/$name"}:${i+1}: ${line.trim().take(200)}") }
                }
                if (results.length() >= 60 || scanned > 400) return
            }
        }
        walk(safDocument(path), ""); return JSONObject().put("matches", results)
    }

    /**
     * Start the UWB bridge service for the current SAF workspace.
     * This allows remote AI agents to access the Android folder via WebSocket.
     * Only starts in remote modes (Render/GitHub), not Local mode.
     */
    private fun startUWBBridgeForCurrentWorkspace() {
        if (!hasSafWorkspace()) return
        if (uwbBridgeService == null) return
        if (!isRemoteMode()) return // Don't start bridge in Local mode

        val uriString = prefs.getString("workspace_tree_uri", "") ?: return
        val intent = Intent(this, UWBBridgeService::class.java).apply {
            action = UWBBridgeService.ACTION_START
            putExtra(UWBBridgeService.EXTRA_WORKSPACE_URI, uriString)
            putExtra(UWBBridgeService.EXTRA_PORT, 8080)
        }
        try {
            startForegroundService(intent)
        } catch (e: Exception) {
            Log.w("MainActivity", "Failed to start UWB bridge service", e)
        }
    }

    private fun getLocalIpAddress(): String {
        try {
            for (iface in java.net.NetworkInterface.getNetworkInterfaces()) {
                for (addr in iface.inetAddresses) {
                    if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                        return addr.hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            Log.w("MainActivity", "Failed to get local IP", e)
        }
        return "127.0.0.1"
    }

    private fun applySandboxMode(index: Int, syncSpinner: Boolean = true, reload: Boolean = true): Boolean {
        val idx = index.coerceIn(0, sandboxModes.lastIndex)
        if (idx == 1 && !renderConfigured) return false
        if (idx == 2 && !githubConfigured) return false
        
        val previousMode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
        prefs.edit().putInt("sandbox_mode", idx).apply()
        
        if (syncSpinner && ::sandbox.isInitialized) {
            syncingSandboxSpinner = true
            sandbox.setSelection(idx)
            syncingSandboxSpinner = false
        }
        if (::status.isInitialized) status.text = if (idx == 0) "Sandbox: Local" else "Sandbox: ${sandboxModes[idx]} · remote"
        
        // Update UWB bridge based on new mode
        updateUWBBridgeForMode(idx, previousMode)
        
        syncBridgeConfig(reload)
        return true
    }

    /** Start or stop UWB bridge based on sandbox mode */
    private fun updateUWBBridgeForMode(newMode: Int, previousMode: Int) {
        val wasRemote = previousMode == 1 || previousMode == 2
        val nowRemote = newMode == 1 || newMode == 2

        if (wasRemote && !nowRemote) {
            // Switching from remote to Local: stop UWB bridge
            stopUWBBridge()
        } else if (!wasRemote && nowRemote) {
            // Switching from Local to remote: start UWB bridge if SAF workspace exists
            if (hasSafWorkspace() && uwbServiceBound && uwbBridgeService != null) {
                startUWBBridgeForCurrentWorkspace()
            } else if (hasSafWorkspace() && !uwbServiceBound) {
                // Bind service first, it will auto-start on connection
                val intent = Intent(this, UWBBridgeService::class.java)
                bindService(intent, uwbServiceConnection, Context.BIND_AUTO_CREATE)
            }
        }
        // If staying in remote mode, bridge stays as-is
    }

    /** Stop the UWB bridge service */
    private fun stopUWBBridge() {
        if (uwbBridgeService != null) {
            val intent = Intent(this, UWBBridgeService::class.java).apply {
                action = UWBBridgeService.ACTION_STOP
            }
            startService(intent)
        }
    }

    private fun restoreModeAfterRemoteTest(previousMode: Int) {
        // A failed test disables the candidate's verified flag. Keep the last working
        // provider if it is still valid; otherwise fall back to Local instead of a blank bridge.
        val fallback = when {
            previousMode == 1 && renderConfigured -> 1
            previousMode == 2 && githubConfigured -> 2
            else -> 0
        }
        applySandboxMode(fallback, syncSpinner = true, reload = true)
    }

    private fun openProviderDialogSoon(index: Int) {
        val anchor: View? = if (::root.isInitialized) root else null
        val open = {
            when (index.coerceIn(0, sandboxModes.lastIndex)) {
                1 -> configureRender()
                2 -> configureGithub()
            }
        }
        // A Spinner or a WebView <select> is still dismissing when this is requested.
        // Let that popup close before showing the AlertDialog, otherwise Android can
        // immediately dismiss the new dialog on some devices.
        if (anchor != null) {
            anchor.postDelayed({ if (!isFinishing && !isDestroyed) open() }, 180)
        } else {
            runOnUiThread { if (!isFinishing && !isDestroyed) open() }
        }
    }

    private fun openRenderDialogSoon() = openProviderDialogSoon(1)
    private fun openGithubDialogSoon() = openProviderDialogSoon(2)

    private fun configureRender() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 8, 24, 0) }
        val urlInput = EditText(this).apply { hint = "https://your-service.onrender.com"; setSingleLine(true); setText(renderBase) }
        val tokenInput = EditText(this).apply { hint = "CODESPACE_API_TOKEN"; setSingleLine(true); inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD; setText(renderToken) }
        val error = TextView(this).apply { setTextColor(0xFFFF8A80.toInt()); textSize = 12f; setPadding(0, 8, 0, 0) }
        panel.addView(urlInput); panel.addView(tokenInput); panel.addView(error)
        val dialog = android.app.AlertDialog.Builder(this).setTitle("Render Agent Server")
            .setMessage("Use your existing Render Agent Server URL and API token. The token is CODESPACE_API_TOKEN from Render and is stored in app-private preferences.")
            .setView(panel)
            .setPositiveButton("Save and test", null)
            .setNeutralButton("Clear") { _, _ ->
                prefs.edit().remove("render_url").remove("render_token").remove("render_verified").apply()
                if (prefs.getInt("sandbox_mode", 0) == 1) applySandboxMode(0, reload = true) else syncBridgeConfig(false)
                status.text = "Render configuration cleared"
            }.setNegativeButton("Cancel", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val value = urlInput.text.toString().trim().trimEnd('/')
                val token = tokenInput.text.toString().trim()
                val parsed = try { Uri.parse(value) } catch (_: Exception) { null }
                if (!value.startsWith("https://") || parsed?.host.isNullOrBlank()) {
                    error.text = "Enter a valid HTTPS URL"; return@setOnClickListener
                }
                if (token.isBlank()) {
                    error.text = "Enter the CODESPACE_API_TOKEN value"; return@setOnClickListener
                }
                error.text = ""
                dialog.dismiss()
                val previousMode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
                // Save the candidate credentials, but keep the current sandbox active until
                // /info succeeds. This avoids reloading the IDE into a broken Render bridge.
                prefs.edit().putString("render_url", value).putString("render_token", token).putBoolean("render_verified", false).apply()
                status.text = "Testing Render connection (cold start can take up to 60 s)…"
                executor.execute {
                    val result = try { renderRequest("/info", "{}") } catch (e: Exception) { "Connection failed: ${e.message}" }
                    val connected = try { JSONObject(result).optString("root").isNotBlank() } catch (_: Exception) { false }
                    runOnUiThread {
                        if (connected) {
                            prefs.edit().putBoolean("render_verified", true).apply()
                            applySandboxMode(1, syncSpinner = true, reload = true)
                            status.text = "Render connected"
                        } else {
                            prefs.edit().putBoolean("render_verified", false).apply()
                            restoreModeAfterRemoteTest(previousMode)
                            status.text = result.take(220)
                        }
                    }
                }
            }
        }
        dialog.show()
    }

    private fun configureGithub() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 8, 24, 0) }
        val urlInput = EditText(this).apply { hint = "https://your-codespace-8787.app.github.dev"; setSingleLine(true); setText(githubBase) }
        val tokenInput = EditText(this).apply { hint = "CODESPACE_API_TOKEN"; setSingleLine(true); inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD; setText(githubToken) }
        val error = TextView(this).apply { setTextColor(0xFFFF8A80.toInt()); textSize = 12f; setPadding(0, 8, 0, 0) }
        panel.addView(urlInput); panel.addView(tokenInput); panel.addView(error)
        val dialog = android.app.AlertDialog.Builder(this).setTitle("GitHub Codespace Agent Server")
            .setMessage("Run the CodeSpace agent server inside a GitHub Codespace on port 8787, set that port to Public, then paste the forwarded https://…-8787.app.github.dev URL and its CODESPACE_API_TOKEN. Enable the Docker-in-Docker devcontainer feature if you want real container sandboxes. Render remains available as a separate option.")
            .setView(panel)
            .setPositiveButton("Save and test", null)
            .setNeutralButton("Clear") { _, _ ->
                prefs.edit().remove("github_url").remove("github_token").remove("github_verified").apply()
                if (prefs.getInt("sandbox_mode", 0) == 2) applySandboxMode(0, reload = true) else syncBridgeConfig(false)
                status.text = "GitHub Codespace configuration cleared"
            }.setNegativeButton("Cancel", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val value = urlInput.text.toString().trim().trimEnd('/')
                val token = tokenInput.text.toString().trim()
                val parsed = try { Uri.parse(value) } catch (_: Exception) { null }
                if (!value.startsWith("https://") || parsed?.host.isNullOrBlank()) {
                    error.text = "Enter the public HTTPS port URL from the Codespace Ports panel"; return@setOnClickListener
                }
                if (token.isBlank()) {
                    error.text = "Enter the CODESPACE_API_TOKEN value"; return@setOnClickListener
                }
                error.text = ""
                dialog.dismiss()
                val previousMode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
                prefs.edit().putString("github_url", value).putString("github_token", token).putBoolean("github_verified", false).apply()
                status.text = "Testing GitHub Codespace connection…"
                executor.execute {
                    val result = try { githubRequest("/info", "{}") } catch (e: Exception) { "Connection failed: ${e.message}" }
                    val connected = try { JSONObject(result).optString("root").isNotBlank() } catch (_: Exception) { false }
                    runOnUiThread {
                        if (connected) {
                            prefs.edit().putBoolean("github_verified", true).apply()
                            applySandboxMode(2, syncSpinner = true, reload = true)
                            status.text = "GitHub Codespace connected"
                        } else {
                            prefs.edit().putBoolean("github_verified", false).apply()
                            restoreModeAfterRemoteTest(previousMode)
                            status.text = result.take(220)
                        }
                    }
                }
            }
        }
        dialog.show()
    }

    private fun syncBridgeConfig(reload: Boolean) {
        if (!::appWeb.isInitialized) return
        val mode = prefs.getInt("sandbox_mode", 0).coerceIn(0, sandboxModes.lastIndex)
        // Never hand the WebView a blank bridge: a remote provider needs both a URL and a token.
        // A verified flag can become false after a failed connection test without changing the
        // saved URL/token, so the configured getters are the source of truth here.
        val remote: Pair<String, String>? = when (mode) {
            1 -> if (renderConfigured) renderBase to renderToken else null
            2 -> if (githubConfigured) githubBase to githubToken else null
            else -> null
        }
        val url = remote?.first ?: "codespace-native://local"
        val token = remote?.second ?: "android-local-native"
        val config = JSONObject().put("bridgeUrl", url).put("bridgeToken", token)
        val js = "(function(){try{localStorage.setItem('agent3.local',JSON.stringify($config));}catch(e){} })();"
        appWeb.evaluateJavascript(js) {
            if (reload) appWeb.reload()
        }
    }

    private fun remoteRequest(base: String, token: String, path: String, body: String): String {
        require(path.matches(Regex("^/(info|workspace/dirs|fs/list|fs/read|tools/installed)$"))) { "Endpoint is not allowed in connection test" }
        require(base.startsWith("https://") && token.isNotBlank()) { "Remote provider is not configured" }
        val conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
            // Render's free instances sleep. A cold start can take 30–60 seconds, so the
            // old 10 s/15 s limits made a perfectly healthy service look disconnected.
            requestMethod = "POST"; connectTimeout = 30000; readTimeout = 120000; doOutput = true; useCaches = false
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("HTTP $code: ${text.take(300)}")
            text.take(100000)
        } finally { conn.disconnect() }
    }

    private fun renderRequest(path: String, body: String): String = remoteRequest(renderBase, renderToken, path, body)
    private fun githubRequest(path: String, body: String): String = remoteRequest(githubBase, githubToken, path, body)

    private fun saveScreenshot() {
        val web = currentBrowser() ?: return
        val width = web.width.coerceAtLeast(1).coerceAtMost(4096)
        val height = web.height.coerceAtLeast(1).coerceAtMost(4096)
        require(width.toLong() * height.toLong() <= 16_000_000L) { "Browser screenshot exceeds the 16 MP limit" }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        web.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        val encoded = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "image/png"; putExtra(Intent.EXTRA_TITLE, "codespace-browser-${System.currentTimeMillis()}.png") }
        pendingScreenshot = encoded; startActivityForResult(intent, REQ_SCREENSHOT)
    }
    private var pendingScreenshot: String? = null

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == AndroidOpenCodeRuntime.REQ_TERMUX_PERMISSION) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
            CrashLog.write(this, "termux", "RUN_COMMAND permission result: " + (if (granted) "granted" else "denied"))
            // Notify the WebView so Settings can refresh without a manual reload.
            appWeb.evaluateJavascript("window.dispatchEvent(new CustomEvent('codespace-termux-permission',{detail:${JSONObject().put("granted", granted).toString().let { JSONObject.quote(it) }}}))", null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_WORKSPACE_TREE) {
            var pickedPath = ""
            var pickedName = ""
            var pickError = ""
            if (resultCode == RESULT_OK && data?.data != null) {
                val uri = data.data!!
                val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                try {
                    require((flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 && (flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0) { "The file picker did not grant read/write access" }
                    contentResolver.takePersistableUriPermission(uri, flags)
                    prefs.edit().putString("workspace_tree_uri", uri.toString()).remove("workspace_dir").apply()
                    pickedName = DocumentFile.fromTreeUri(this, uri)?.name ?: "Selected folder"
                    pickedPath = "saf://workspace"
                    status.text = "Local workspace: $pickedName"
                    syncBridgeConfig(false)
                    // Start UWB bridge for this workspace
                    startUWBBridgeForCurrentWorkspace()
                } catch (e: Exception) {
                    pickError = e.message ?: "Could not retain folder access"
                    status.text = "Could not retain folder access: $pickError"
                }
            }
            if (::appWeb.isInitialized) {
                val detail = JSONObject().put("ok", pickedPath.isNotBlank() && pickError.isBlank())
                    .put("cancelled", resultCode != RESULT_OK).put("path", pickedPath)
                    .put("name", pickedName).put("error", pickError)
                appWeb.evaluateJavascript("window.dispatchEvent(new CustomEvent('codespace-native-workspace-picked',{detail:${JSONObject.quote(detail.toString())}}))", null)
            }
        }
        if (requestCode == REQ_FILE) {
            val selected = mutableListOf<Uri>()
            if (resultCode == RESULT_OK && data != null) {
                data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(selected::add) }
                if (selected.isEmpty()) data.data?.let(selected::add)
            }
            fileCallback?.onReceiveValue(selected.take(20).toTypedArray().takeIf { it.isNotEmpty() }); fileCallback = null
        }
        if (requestCode == REQ_SAVE && resultCode == RESULT_OK && data?.data != null) {
            val url = pendingDownloadUrl; val target = data.data!!
            val downloadAgent = currentBrowser()?.settings?.userAgentString ?: ""
            if (url != null) executor.execute {
                try {
                    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 15000; readTimeout = 30000
                        setRequestProperty("User-Agent", downloadAgent)
                        CookieManager.getInstance().getCookie(url)?.let { setRequestProperty("Cookie", it) }
                    }
                    try {
                        if (conn.responseCode !in 200..299) throw IllegalStateException("Download HTTP ${conn.responseCode}")
                        if (conn.contentLengthLong > 100L * 1024L * 1024L) throw IllegalStateException("Download exceeds 100 MB limit")
                        contentResolver.openOutputStream(target)?.use { out -> conn.inputStream.use { input ->
                            val buf = ByteArray(64 * 1024); var total = 0L; while (true) { val n = input.read(buf); if (n < 0) break; total += n; if (total > 100L * 1024L * 1024L) throw IllegalStateException("Download exceeds 100 MB limit"); out.write(buf, 0, n) }
                        } }
                    } finally { conn.disconnect() }
                    runOnUiThread { status.text = "Download saved" }
                } catch (e: Exception) { runOnUiThread { status.text = "Download failed: ${e.message}" } }
            }
            pendingDownloadUrl = null
        }
        if (requestCode == REQ_SCREENSHOT && resultCode == RESULT_OK && data?.data != null) {
            val bytes = Base64.decode(pendingScreenshot ?: "", Base64.DEFAULT); contentResolver.openOutputStream(data.data!!)?.use { it.write(bytes) }; pendingScreenshot = null
        }
    }
    override fun onBackPressed() {
        // Back closes an open IDE dialog or navigates the visible browser; it never swaps
        // the application out of the CodeSpace workspace.
        if (browserHost.visibility == View.VISIBLE && currentBrowser()?.canGoBack() == true) {
            currentBrowser()?.goBack()
            return
        }
        if (::appWeb.isInitialized) {
            appWeb.evaluateJavascript("(()=>{const d=[...document.querySelectorAll('dialog[open]')].pop();if(d){d.close();return;}const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(e);if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();})()", null)
        }
    }
    override fun onDestroy() {
        if (uwbServiceBound) {
            unbindService(uwbServiceConnection)
            uwbServiceBound = false
        }
        nativeHttpCancelled.values.forEach { it.set(true) }
        nativeHttpJobs.values.forEach { it.disconnect() }
        nativeHttpJobs.clear()
        saveBrowserTabs()
        browserTabs.forEach { web -> try { web.stopLoading(); web.destroy() } catch (_: Exception) {} }
        try { appWeb.destroy() } catch (_: Exception) {}
        nativeTerminals.values.forEach { session ->
            try {
                if (session.ptyFd >= 0 && session.ptyPid > 0) NativePty.stop(session.ptyFd, session.ptyPid)
                else session.process?.let { process ->
                    if (process.isAlive) {
                        process.destroy()
                        if (!process.waitFor(300, TimeUnit.MILLISECONDS)) process.destroyForcibly()
                    }
                }
            } catch (_: Exception) {}
        }
        nativeTerminals.clear()
        AndroidLanguageServerHost.stopAll()
        AndroidNodeDapAdapter.clear()
        AndroidNodeInspector.clear()
        AndroidWebViewCdp.disconnect()
        WebView.setWebContentsDebuggingEnabled(false)
        AndroidLocalDatabase.closeAll()
        AndroidLocalMcp.clear()
        pythonExecutor.shutdownNow()
        executor.shutdownNow()
        bridgeExecutor.shutdownNow()
        super.onDestroy()
    }

    companion object { const val REQ_WORKSPACE_TREE = 200; const val REQ_FILE = 201; const val REQ_SAVE = 202; const val REQ_SCREENSHOT = 203; const val ID_TABBAR = 301 }
}

private object AlertDialogBuilder {
    fun show(activity: Activity, title: String, items: Array<String>, onPick: (Int) -> Unit) {
        android.app.AlertDialog.Builder(activity).setTitle(title).setItems(items) { _, which -> onPick(which) }.setNegativeButton("Close", null).show()
    }
}
