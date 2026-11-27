package com.yoda.pet.logic

data class MailAlert(val sender: String, val subject: String?)

object MailAlerts {
    const val GMAIL_PACKAGE = "com.google.android.gm"

    private val countTitle = Regex("""^\d+\s+new\s+(messages?|emails?)$""", RegexOption.IGNORE_CASE)

    /**
     * Turns one Gmail notification into "who it's from". Gmail puts the
     * sender in the title and the subject in the text. Group summaries and
     * "3 new messages" roll-ups carry no single sender and are skipped.
     */
    fun parse(packageName: String, isGroupSummary: Boolean, title: CharSequence?, text: CharSequence?): MailAlert? {
        if (packageName != GMAIL_PACKAGE || isGroupSummary) return null
        val sender = title?.toString()?.trim().orEmpty()
        if (sender.isEmpty() || countTitle.matches(sender)) return null
        val subject = text?.toString()?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        return MailAlert(sender, subject)
    }
}
