package com.yoda.pet.logic

data class MailAlert(val sender: String, val subject: String?) {
    /** Same email seen twice (Gmail posts a summary and a child for one message). */
    val dedupKey: String get() = "$sender|${subject.orEmpty()}"
}

object MailAlerts {
    const val GMAIL_PACKAGE = "com.google.android.gm"
    val PACKAGES = setOf(GMAIL_PACKAGE, "com.google.android.gm.lite")

    private val countTitle = Regex("""^\d+\s+(new\s+)?(messages?|emails?|μηνύματα|νέα\s+μηνύματα)$""", RegexOption.IGNORE_CASE)
    private val emailAddress = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""")

    /**
     * Turns one Gmail notification into "who it's from". Gmail puts the
     * sender in the title and the subject in the text. For a single new
     * email Gmail may post only a group summary, so summaries are accepted
     * too; roll-ups ("3 new messages", or titled with your own account
     * address) carry no single sender and are skipped.
     */
    fun parse(
        packageName: String,
        isGroupSummary: Boolean,
        title: CharSequence?,
        text: CharSequence?,
        bigText: CharSequence? = null,
        account: CharSequence? = null,
    ): MailAlert? {
        if (packageName !in PACKAGES) return null
        val sender = title?.toString()?.trim().orEmpty()
        if (sender.isEmpty() || countTitle.matches(sender)) return null
        if (isGroupSummary && account != null && sender.equals(account.toString().trim(), ignoreCase = true)) return null
        if (isGroupSummary && emailAddress.matches(sender) && text.isNullOrBlank() && bigText.isNullOrBlank()) return null
        val subject = firstLine(text) ?: firstLine(bigText)
        return MailAlert(sender, subject)
    }

    private fun firstLine(s: CharSequence?): String? =
        s?.toString()?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }
}
