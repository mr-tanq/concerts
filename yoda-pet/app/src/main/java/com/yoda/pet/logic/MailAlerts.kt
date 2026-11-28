package com.yoda.pet.logic

data class MailAlert(
    val sender: String,
    val subject: String?,
    /** Which of your accounts it arrived in (Gmail's sub-text), if known. */
    val account: String? = null,
    /** >1 when Gmail bundled several unread emails into one notification. */
    val count: Int = 1,
) {
    /** Same email seen twice (Gmail posts a summary and a child for one message). */
    val dedupKey: String get() = "${account.orEmpty()}|$sender|${subject.orEmpty()}"
}

/** The first line of a bundled notification, split into sender and subject. */
data class MailLine(val sender: String?, val subject: String?)

object MailAlerts {
    const val GMAIL_PACKAGE = "com.google.android.gm"
    val PACKAGES = setOf(GMAIL_PACKAGE, "com.google.android.gm.lite")

    private val countTitle = Regex("""^(\d+)\s+(new\s+)?(messages?|emails?|μηνύματα|νέα\s+μηνύματα|νέα\s+email)$""", RegexOption.IGNORE_CASE)
    private val emailAddress = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""")

    /**
     * Turns one Gmail notification into "who it's from". A single email has
     * the sender as title and the subject as text. When an account already
     * has unread mail, Gmail bundles them ("2 new messages", lines of
     * "Sender  Subject", newest first) — then the newest line is used.
     */
    fun parse(
        packageName: String,
        isGroupSummary: Boolean,
        title: CharSequence?,
        text: CharSequence?,
        bigText: CharSequence? = null,
        account: CharSequence? = null,
        firstLine: MailLine? = null,
        lineCount: Int = 0,
    ): MailAlert? {
        if (packageName !in PACKAGES) return null
        val acct = account?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val t = title?.toString()?.trim().orEmpty()
        val count = countTitle.matchEntire(t)?.groupValues?.get(1)?.toIntOrNull()
        val isRollup = count != null || (acct != null && t.equals(acct, ignoreCase = true)) ||
            (isGroupSummary && emailAddress.matches(t) && lineCount > 0)
        if (isRollup) {
            val sender = firstLine?.sender?.takeIf { it.isNotBlank() } ?: return null
            return MailAlert(sender.trim(), firstLine.subject?.trim()?.takeIf { it.isNotEmpty() }, acct, count ?: lineCount.coerceAtLeast(2))
        }
        if (t.isEmpty()) return null
        val subject = firstLine(text) ?: firstLine(bigText)
        return MailAlert(t, subject, acct)
    }

    /** Splits a plain "Sender   Subject" line when Gmail gives no bold span to go by. */
    fun splitLine(line: String): MailLine {
        val parts = line.trim().split(Regex("""\s{2,}|\t"""), limit = 2)
        return if (parts.size == 2) MailLine(parts[0], parts[1]) else MailLine(null, line.trim())
    }

    private fun firstLine(s: CharSequence?): String? =
        s?.toString()?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }
}
