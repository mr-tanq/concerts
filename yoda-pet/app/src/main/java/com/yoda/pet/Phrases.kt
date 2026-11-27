package com.yoda.pet

object Phrases {
    val encourage = listOf(
        "You've handled every hard day so far. 100% record. Keep going! 💪",
        "Small steps still move you forward. I walk tiny steps all day and look where I am!",
        "You don't have to be perfect. You just have to keep showing up. 🐾",
        "I believe in you more than I believe in treats. And I REALLY believe in treats.",
        "Breathe in… breathe out… you've got this.",
        "Whatever you're working on — the fact that you're trying matters.",
        "Proud of you. Just saying. Woof.",
        "One thing at a time. I'll be right here at the bottom of the screen.",
        "Your best today is enough, even if today's best is small.",
        "Remember the last thing you thought you couldn't do? You did it.",
        "Big ears, big heart, big faith in you. 🐶",
        "Hard things get easier once you start. Start tiny. Right now.",
    )

    val funny = listOf(
        "Why did the Frenchie sit in the shade? Because he didn't want to be a hot dog. 🌭",
        "I'm not snoring. I'm dreaming loudly.",
        "What do you call a dog magician? A labracadabrador. ✨",
        "My ears can hear a cheese wrapper from three rooms away. Your meetings? Not so much.",
        "I tried to catch fog this morning. I mist.",
        "Why don't dogs make good dancers? Two left feet. And two more left feet.",
        "I'm on a seafood diet. I see food, I sit nicely.",
        "My workout routine: walk to the edge of your screen. Turn around. Repeat. Gains. 💪",
        "What's a dog's favourite pizza? Pupperoni. 🍕",
        "I'm technically a 'desktop pet', but I've never seen a desk. Suspicious.",
        "If you need me I'll be pretending I didn't hear you.",
        "Why did the dog cross the road? To get to the barking lot. 🚗",
    )

    val checkInQuestion = listOf(
        "Hey you. How are you feeling right now?",
        "Quick check-in from your favourite Frenchie: how's it going?",
        "Pause for a sec. How are you really doing?",
    )

    val replyGood = listOf(
        "Yay! That makes my tail wiggle. Keep that energy! 🐾",
        "Love that for you. Go enjoy it!",
        "Good vibes detected. Proceeding to do a happy little walk.",
    )
    val replyOkay = listOf(
        "Okay is okay. Maybe stretch, drink some water, and take a tiny break? 💧",
        "Meh days happen. A short walk or a favourite song might help — tap me for one!",
        "Thanks for being honest. Be gentle with yourself today.",
    )
    val replyRough = listOf(
        "I'm sorry it's hard right now. Let's take 3 slow breaths together… in… and out. 🤍",
        "That sounds tough. You don't have to fix everything today — just the next small thing.",
        "Sending you the biggest Frenchie hug. Maybe message someone you trust? You don't have to carry it alone.",
    )

    fun pick(list: List<String>): String = list.random()
}
