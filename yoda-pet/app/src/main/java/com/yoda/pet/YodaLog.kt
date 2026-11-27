package com.yoda.pet

import android.content.Context
import org.json.JSONArray
import java.text.DateFormat
import java.util.Date

/** A short on-phone diary of what Yoda noticed (shown in the app, never sent anywhere). */
object YodaLog {
    private const val MAX = 40

    @Synchronized
    fun add(ctx: Context, line: String) {
        val sp = ctx.applicationContext.getSharedPreferences("yoda", Context.MODE_PRIVATE)
        val arr = runCatching { JSONArray(sp.getString("log", "[]")) }.getOrDefault(JSONArray())
        val stamp = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date())
        val out = JSONArray().put("$stamp  $line")
        for (i in 0 until minOf(arr.length(), MAX - 1)) out.put(arr.getString(i))
        sp.edit().putString("log", out.toString()).apply()
    }

    fun lines(ctx: Context): List<String> {
        val sp = ctx.applicationContext.getSharedPreferences("yoda", Context.MODE_PRIVATE)
        val arr = runCatching { JSONArray(sp.getString("log", "[]")) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getString(it) }
    }

    fun clear(ctx: Context) {
        ctx.applicationContext.getSharedPreferences("yoda", Context.MODE_PRIVATE).edit().remove("log").apply()
    }
}
