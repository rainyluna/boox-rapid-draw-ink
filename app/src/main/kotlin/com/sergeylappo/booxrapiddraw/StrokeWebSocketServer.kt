package com.sergeylappo.booxrapiddraw

import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList

class StrokeWebSocketServer(port: Int = 8765) : WebSocketServer(InetSocketAddress("127.0.0.1", port)) {
    private val TAG = "StrokeWebSocketServer"
    private val connections = CopyOnWriteArrayList<WebSocket>()

    init {
        isReuseAddr = true
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
        Log.i(TAG, "New client connected: ${conn.remoteSocketAddress}")
        connections.add(conn)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
        Log.i(TAG, "Client disconnected: ${conn.remoteSocketAddress}, reason: $reason")
        connections.remove(conn)
    }

    override fun onMessage(conn: WebSocket, message: String?) {
        Log.d(TAG, "Received message from client: $message")
    }

    override fun onError(conn: WebSocket?, ex: Exception?) {
        Log.e(TAG, "WebSocket error: ${ex?.message}", ex)
        if (conn != null) {
            connections.remove(conn)
        }
    }

    override fun onStart() {
        Log.i(TAG, "Stroke WebSocket server started on ${address.address.hostAddress}:${address.port}")
    }

    fun broadcastStroke(widthPx: Int, heightPx: Int, points: List<FloatArray>) {
        if (connections.isEmpty()) return
        try {
            val json = JSONObject()
            json.put("type", "stroke")
            json.put("w", widthPx)
            json.put("h", heightPx)

            val ptsArray = JSONArray()
            for (p in points) {
                val pt = JSONArray()
                // p: [x, y, pressure, timestamp]
                pt.put(p[0].toDouble())
                pt.put(p[1].toDouble())
                pt.put(p[2].toDouble())
                pt.put(p[3].toLong())
                ptsArray.put(pt)
            }
            json.put("pts", ptsArray)

            val message = json.toString()
            for (conn in connections) {
                if (conn.isOpen) {
                    conn.send(message)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error broadcasting stroke", e)
        }
    }
}
