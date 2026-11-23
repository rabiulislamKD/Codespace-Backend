package com.codespace.android

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Direct Chrome DevTools Protocol transport to this app's Android WebView devtools abstract socket. */
internal object AndroidWebViewCdp {
    private const val MAX_FRAME = 2 *  1024 * 1024
    private const val MAX_EVENTS = 1200
    private data class Session(
        val id: String,
        val socket: LocalSocket,
        val pending: ConcurrentHashMap<Long, CompletableFuture<JSONObject>> = ConcurrentHashMap(),
        val events: LinkedBlockingQueue<JSONObject> = LinkedBlockingQueue(MAX_EVENTS),
        val seq: AtomicLong = AtomicLong(1),
        @Volatile var closed: Boolean = false
    )
    private val random = SecureRandom()
    @Volatile private var session: Session? = null
    @Volatile private var connectedUrl: String = ""
    private val requests = ConcurrentHashMap<String, JSONObject>()

    private fun safeUrl(raw: String): String = try {
        val uri = android.net.Uri.parse(raw)
        val builder = uri.buildUpon().clearQuery()
        uri.queryParameterNames.forEach { key ->
            val lower = key.lowercase()
            val secret = lower.contains("token") || lower.contains("key") || lower.contains("auth") || lower.contains("secret") || lower.contains("password")
            builder.appendQueryParameter(key, if (secret) "[redacted]" else uri.getQueryParameter(key) ?: "")
        }
        builder.build().toString().take(3000)
    } catch (_: Exception) { raw.take(3000) }

    private fun safeHeaders(source: JSONObject): JSONObject {
        val out = JSONObject()
        val sensitive = setOf("authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "apikey", "x-auth-token")
        val keys = source.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = source.opt(key)
            out.put(key, if (key.lowercase() in sensitive || key.lowercase().contains("token") || key.lowercase().contains("secret")) "[redacted]" else value)
        }
        return out
    }

    private fun socketName() = "webview_devtools_remote_${Process.myPid()}"
    private fun openSocket(): LocalSocket = LocalSocket().apply {
        connect(LocalSocketAddress(socketName(), LocalSocketAddress.Namespace.ABSTRACT))
        soTimeout = 0
    }

    fun status(): JSONObject {
        val s = session
        return JSONObject().put("enabled", s != null && !s.closed)
            .put("socket", socketName()).put("pid", Process.myPid())
            .put("url", if (s != null && !s.closed) connectedUrl else "")
    }

    private fun http(path: String): String {
        val socket = openSocket()
        try {
            socket.soTimeout = 3000
            val out = socket.outputStream
            out.write("GET $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
            out.flush()
            val bytes = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (bytes.size() < 256 * 1024) {
                val n = try { socket.inputStream.read(buf) } catch (_: java.net.SocketTimeoutException) { break }
                if (n < 0) break
                bytes.write(buf, 0, n)
            }
            val raw = String(bytes.toByteArray(), StandardCharsets.UTF_8)
            val split = raw.indexOf("\r\n\r\n")
            require(split >= 0) { "WebView DevTools discovery returned malformed HTTP" }
            val head = raw.substring(0, split)
            require(head.startsWith("HTTP/1.1 200") || head.startsWith("HTTP/1.0 200")) { "WebView DevTools discovery failed: ${head.lineSequence().firstOrNull()}" }
            var body = raw.substring(split + 4)
            if (head.contains("transfer-encoding: chunked", true)) body = decodeChunked(body)
            return body
        } finally { runCatching { socket.close() } }
    }

    private fun decodeChunked(raw: String): String {
        val bytes = raw.toByteArray(StandardCharsets.ISO_8859_1)
        val out = ByteArrayOutputStream(); var p = 0
        while (p < bytes.size) {
            val end = indexOf(bytes, byteArrayOf(13, 10), p)
            if (end < 0) break
            val sizeText = String(bytes, p, end - p, StandardCharsets.US_ASCII).substringBefore(';').trim()
            val size = sizeText.toIntOrNull(16) ?: break
            p = end + 2
            if (size == 0) break
            if (size < 0 || out.size() + size > 256 * 1024 || p + size > bytes.size) throw IllegalStateException("Invalid DevTools chunked response")
            out.write(bytes, p, size); p += size + 2
        }
        return String(out.toByteArray(), StandardCharsets.UTF_8)
    }

    private fun indexOf(data: ByteArray, needle: ByteArray, from: Int): Int {
        for (i in from..(data.size - needle.size)) if (needle.indices.all { data[i + it] == needle[it] }) return i
        return -1
    }

    fun targets(): JSONObject {
        val arr = JSONArray(http("/json/list"))
        val safe = JSONArray()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            val ws = t.optString("webSocketDebuggerUrl")
            if (!ws.startsWith("ws://") || !ws.contains("/devtools/page/")) continue
            safe.put(JSONObject().put("id", t.optString("id")).put("type", t.optString("type"))
                .put("title", t.optString("title").take(300)).put("url", t.optString("url").take(2000)))
        }
        return JSONObject().put("socket", socketName()).put("targets", safe)
    }

    fun connect(preferredUrl: String = ""): JSONObject {
        disconnect()
        val raw = JSONArray(http("/json/list"))
        val want = preferredUrl.trim().trimEnd('/').lowercase(Locale.ROOT)
        val exact = ArrayList<JSONObject>()
        val pageFallbacks = ArrayList<JSONObject>()
        for (i in 0 until raw.length()) {
            val item = raw.optJSONObject(i) ?: continue
            if (!item.optString("webSocketDebuggerUrl").contains("/devtools/page/")) continue
            val url = item.optString("url")
            val norm = url.trim().trimEnd('/').lowercase(Locale.ROOT)
            // Exact (or same-document) match wins. A bare first-target fallback used to pick the
            // app's own UI WebView and expose the CodeSpace DOM instead of the requested page.
            if (want.isNotBlank() && (norm == want || (want.startsWith("http") && norm.startsWith(want)))) {
                exact.add(item)
                continue
            }
            if (norm.contains("android_asset") || norm.startsWith("file:///android_asset")) continue
            pageFallbacks.add(item)
        }
        val target = exact.firstOrNull() ?: pageFallbacks.firstOrNull()
            ?: throw IllegalStateException("No debuggable browser WebView page target was found. Open a page in the CodeSpace Browser first.")
        val ws = android.net.Uri.parse(target.optString("webSocketDebuggerUrl"))
        val path = (ws.encodedPath ?: "/") + (ws.encodedQuery?.let { "?$it" } ?: "")
        require(path.startsWith("/devtools/page/") && path.length < 2048) { "Unexpected WebView DevTools endpoint" }
        val socket = openSocket()
        try {
            val key = Base64.getEncoder().encodeToString(ByteArray(16).also { random.nextBytes(it) })
            socket.outputStream.write("GET $path HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
            socket.outputStream.flush()
            val response = readHeaders(socket.inputStream, 16384)
            require(response.startsWith("HTTP/1.1 101") || response.startsWith("HTTP/1.0 101")) { "WebView DevTools WebSocket handshake failed: ${response.lineSequence().firstOrNull()}" }
            val accept = response.lineSequence().firstOrNull { it.startsWith("Sec-WebSocket-Accept:", true) }?.substringAfter(':')?.trim()
            val expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.US_ASCII)))
            require(accept == expected) { "WebView DevTools WebSocket accept key mismatch" }
            val s = Session("webview-${Process.myPid()}", socket)
            session = s
            connectedUrl = target.optString("url")
            Thread({ readLoop(s) }, "codespace-webview-cdp").apply { isDaemon = true; start() }
            command("Page.enable")
            command("Runtime.enable")
            command("Network.enable", JSONObject().put("maxTotalBufferSize", 4 * 1024 * 1024).put("maxResourceBufferSize", 1024 * 1024).put("maxPostDataSize", 256 * 1024))
            command("Log.enable")
            return JSONObject().put("connected", true).put("target", JSONObject().put("id", target.optString("id"))
                .put("title", target.optString("title")).put("url", target.optString("url")))
        } catch (e: Exception) { runCatching { socket.close() }; throw e }
    }

    private fun readHeaders(input: java.io.InputStream, max: Int): String {
        val out = ByteArrayOutputStream(); var matched = 0
        val end = byteArrayOf(13, 10, 13, 10)
        while (out.size() < max) {
            val b = input.read(); if (b < 0) throw EOFException("WebView closed during DevTools handshake")
            out.write(b)
            if (b.toByte() == end[matched]) matched++ else matched = if (b.toByte() == end[0]) 1 else 0
            if (matched == end.size) return String(out.toByteArray(), StandardCharsets.US_ASCII)
        }
        throw IllegalStateException("WebView DevTools handshake headers exceeded limit")
    }

    private fun handleTextFrame(s: Session, payload: ByteArray) {
        require(payload.size <= MAX_FRAME) { "DevTools message exceeded 2 MB" }
        val msg = JSONObject(String(payload, StandardCharsets.UTF_8))
        if (msg.has("id")) s.pending.remove(msg.optLong("id"))?.complete(msg) ?: s.events.offer(msg)
        else s.events.offer(msg)
    }

    private fun readLoop(s: Session) {
        var fragments: ByteArrayOutputStream? = null
        try {
            val input = DataInputStream(s.socket.inputStream)
            while (!s.closed) {
                val first = input.readUnsignedByte(); val second = input.readUnsignedByte()
                val fin = first and 128 != 0
                val opcode = first and 15; val masked = second and 128 != 0
                var length = (second and 127).toLong()
                if (length == 126L) length = input.readUnsignedShort().toLong() else if (length == 127L) length = input.readLong()
                require(length in 0..MAX_FRAME.toLong()) { "DevTools frame exceeded 2 MB" }
                val mask = if (masked) ByteArray(4).also { input.readFully(it) } else null
                val payload = ByteArray(length.toInt()); input.readFully(payload)
                if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                when (opcode) {
                    0x1 -> {
                        if (fin) handleTextFrame(s, payload) else {
                            require(fragments == null) { "Unexpected nested DevTools WebSocket fragment" }
                            fragments = ByteArrayOutputStream().apply { write(payload) }
                        }
                    }
                    0x0 -> {
                        val buffer = fragments ?: throw IllegalStateException("Unexpected DevTools continuation frame")
                        require(buffer.size() + payload.size <= MAX_FRAME) { "Fragmented DevTools message exceeded 2 MB" }
                        buffer.write(payload)
                        if (fin) { handleTextFrame(s, buffer.toByteArray()); fragments = null }
                    }
                    0x8 -> break
                    0x9 -> writeFrame(s, 0xA, payload)
                    0xA -> Unit
                }
            }
        } catch (_: Exception) {
        } finally {
            s.closed = true
            s.pending.values.forEach { it.completeExceptionally(IllegalStateException("WebView DevTools connection closed")) }
            s.pending.clear(); runCatching { s.socket.close() }; if (session === s) { session = null; connectedUrl = "" }
        }
    }

    private fun writeFrame(s: Session, opcode: Int, payload: ByteArray) {
        require(payload.size <= MAX_FRAME) { "DevTools message exceeds 2 MB" }
        synchronized(s.socket) {
            val out = s.socket.outputStream
            out.write(0x80 or opcode)
            when {
                payload.size < 126 -> out.write(0x80 or payload.size)
                payload.size <= 65535 -> { out.write(0x80 or 126); out.write(payload.size shr 8); out.write(payload.size) }
                else -> { out.write(0x80 or 127); out.write(ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(payload.size.toLong()).array()) }
            }
            val mask = ByteArray(4).also { random.nextBytes(it) }; out.write(mask)
            out.write(ByteArray(payload.size) { i -> (payload[i].toInt() xor mask[i % 4].toInt()).toByte() }); out.flush()
        }
    }

    fun command(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 8000): JSONObject {
        val s = session ?: throw IllegalStateException("WebView DevTools is not connected")
        require(method.matches(Regex("^[A-Za-z][A-Za-z0-9_.]{0,127}$"))) { "Invalid CDP method" }
        require(params.toString().toByteArray(StandardCharsets.UTF_8).size <= 256 * 1024) { "CDP parameters exceed 256 KB" }
        val id = s.seq.getAndIncrement(); val future = CompletableFuture<JSONObject>(); s.pending[id] = future
        try {
            writeFrame(s, 1, JSONObject().put("id", id).put("method", method).put("params", params).toString().toByteArray(StandardCharsets.UTF_8))
            val response = future.get(timeoutMs.coerceIn(500, 20000), TimeUnit.MILLISECONDS)
            if (response.has("error")) throw IllegalStateException(response.optJSONObject("error")?.optString("message", "CDP request failed") ?: "CDP request failed")
            return response.optJSONObject("result") ?: JSONObject()
        } catch (e: Exception) { s.pending.remove(id); throw e }
    }

    /**
     * v47.5: capture the rendered page through DevTools. Unlike View.draw() this works even when
     * the browser overlay is hidden behind a dialog or the app is in the background, because it
     * reads the compositor surface rather than asking the View hierarchy to paint into a canvas.
     */
    fun capturePageJpeg(timeoutMs: Long = 12000): JSONObject {
        val preferred = JSONObject().put("format", "jpeg").put("quality", 70)
            .put("captureBeyondViewport", false).put("fromSurface", true)
        val result = try {
            command("Page.captureScreenshot", preferred, timeoutMs)
        } catch (_: Exception) {
            // Older WebView builds reject fromSurface/captureBeyondViewport; retry with the
            // universally supported argument set before giving up.
            command("Page.captureScreenshot", JSONObject().put("format", "jpeg").put("quality", 70), timeoutMs)
        }
        val data = result.optString("data", "")
        require(data.length in 200..1_600_000 && data.startsWith("/9j/")) {
            "WebView DevTools returned an empty or invalid screenshot"
        }
        val bytes = try { Base64.getMimeDecoder().decode(data).size } catch (_: Exception) { data.length * 3 / 4 }
        require(bytes <= 2_000_000) { "Screenshot exceeds 2 MB" }
        return JSONObject().put("data", "data:image/jpeg;base64,$data").put("bytes", bytes)
            .put("source", "cdp")
    }

    fun drain(limit: Int = 300, includeBodies: Boolean = true): JSONObject {
        val s = session ?: return JSONObject().put("connected", false).put("events", JSONArray())
        val out = JSONArray(); var bodyCount = 0; var bodyBytes = 0
        // v47.3: browserDiagnostics() runs on the UI thread with a 5s caller budget. Five body
        // fetches at 3.5s each could keep the main thread blocked for ~17s after the caller gave
        // up, so cap the whole drain and each individual CDP request.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        repeat(limit.coerceIn(1, 500)) {
            val event = s.events.poll() ?: return@repeat
            val method = event.optString("method")
            val p = event.optJSONObject("params") ?: JSONObject()
            val requestId = p.optString("requestId")
            if (method == "Network.requestWillBeSent" && requestId.isNotBlank()) {
                val req = p.optJSONObject("request") ?: JSONObject()
                requests[requestId] = JSONObject().put("requestId", requestId).put("url", req.optString("url"))
                    .put("method", req.optString("method")).put("requestHeaders", safeHeaders(req.optJSONObject("headers") ?: JSONObject()))
                    .put("type", p.optString("type")).put("timestamp", p.optDouble("timestamp")).put("wallTime", p.optDouble("wallTime"))
                if (includeBodies && req.has("postData")) requests[requestId]?.put("postData", req.optString("postData").take(256 * 1024))
                if (requests.size > 1200) requests.keys.firstOrNull()?.let { requests.remove(it) }
                event.put("requestRecord", JSONObject(requests[requestId].toString()))
            } else if (method == "Network.responseReceived" && requestId.isNotBlank()) {
                val row = requests[requestId] ?: JSONObject().put("requestId", requestId)
                val response = p.optJSONObject("response") ?: JSONObject()
                row.put("status", response.optInt("status")).put("statusText", response.optString("statusText"))
                    .put("mimeType", response.optString("mimeType")).put("protocol", response.optString("protocol"))
                    .put("responseHeaders", safeHeaders(response.optJSONObject("headers") ?: JSONObject()))
                    .put("remoteIPAddress", response.optString("remoteIPAddress"))
                requests[requestId] = row
                event.put("requestRecord", JSONObject(row.toString()))
            } else if (method == "Network.loadingFinished" && requestId.isNotBlank()) {
                val row = requests[requestId] ?: JSONObject().put("requestId", requestId)
                row.put("encodedDataLength", p.optDouble("encodedDataLength"))
                if (includeBodies && bodyCount < 5 && bodyBytes < 2 * 1024 * 1024) {
                    val remainingMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                    if (remainingMs < 300) row.put("responseBodyOmitted", "body capture time budget reached")
                    else {
                        bodyCount++
                        try {
                            val timeoutMs = minOf(600L, remainingMs - 50L).coerceAtLeast(100L)
                            val body = command("Network.getResponseBody", JSONObject().put("requestId", requestId), timeoutMs)
                            val text = body.optString("body")
                            val bytes = if (body.optBoolean("base64Encoded")) android.util.Base64.decode(text, android.util.Base64.DEFAULT) else text.toByteArray(StandardCharsets.UTF_8)
                            if (bytes.size <= 512 * 1024 && bodyBytes + bytes.size <= 2 * 1024 * 1024) {
                                row.put("responseBody", if (body.optBoolean("base64Encoded")) "base64:" + Base64.getEncoder().encodeToString(bytes) else text)
                                row.put("responseBodyBytes", bytes.size); bodyBytes += bytes.size
                            } else row.put("responseBodyOmitted", "body exceeded capture budget")
                        } catch (_: Exception) { row.put("responseBodyOmitted", "body unavailable or not retained by WebView") }
                    }
                }
                requests[requestId] = row
                event.put("requestRecord", JSONObject(row.toString()))
            } else if (method == "Network.loadingFailed" && requestId.isNotBlank()) {
                val row = requests[requestId] ?: JSONObject().put("requestId", requestId)
                row.put("error", p.optString("errorText")).put("blockedReason", p.optString("blockedReason"))
                event.put("requestRecord", JSONObject(row.toString()))
            } else if (method.startsWith("Network.webSocket")) {
                event.put("webSocket", true)
                if (method == "Network.webSocketFrameReceived" || method == "Network.webSocketFrameSent") {
                    val response = p.optJSONObject("response") ?: JSONObject()
                    val payload = response.optString("payloadData")
                    response.put("payloadData", payload.take(64 * 1024)).put("payloadTruncated", payload.length > 64 * 1024)
                }
            }
            // Raw event reads are safe by default: redact credential headers and omit POST data unless body capture was explicitly requested.
            val eventParams = event.optJSONObject("params")
            if (eventParams != null) {
                if (eventParams.has("url")) eventParams.put("url", safeUrl(eventParams.optString("url")))
                if (eventParams.has("documentURL")) eventParams.put("documentURL", safeUrl(eventParams.optString("documentURL")))
                val request = eventParams.optJSONObject("request")
                if (request != null) {
                    if (request.has("url")) request.put("url", safeUrl(request.optString("url")))
                    request.optJSONObject("headers")?.let { request.put("headers", safeHeaders(it)) }
                    if (!includeBodies) request.remove("postData")
                }
                val response = eventParams.optJSONObject("response")
                if (response != null) {
                    if (response.has("url")) response.put("url", safeUrl(response.optString("url")))
                    response.optJSONObject("headers")?.let { response.put("headers", safeHeaders(it)) }
                    response.remove("headersText")
                }
            }
            event.optJSONObject("requestRecord")?.let { record ->
                if (record.has("url")) record.put("url", safeUrl(record.optString("url")))
                record.optJSONObject("requestHeaders")?.let { record.put("requestHeaders", safeHeaders(it)) }
                record.optJSONObject("responseHeaders")?.let { record.put("responseHeaders", safeHeaders(it)) }
                if (!includeBodies) record.remove("postData")
            }
            if (method.startsWith("Runtime.consoleAPICalled") || method == "Runtime.exceptionThrown" || method.startsWith("Log.")) event.put("diagnostic", true)
            out.put(event)
        }
        return JSONObject().put("connected", !s.closed).put("events", out).put("pendingRequests", requests.size)
    }

    fun disconnect() {
        val old = session ?: return
        old.closed = true; runCatching { writeFrame(old, 8, ByteArray(0)) }; runCatching { old.socket.close() }
        old.pending.values.forEach { it.completeExceptionally(IllegalStateException("CDP disconnected")) }
        old.pending.clear(); session = null; connectedUrl = ""; requests.clear()
    }
}
