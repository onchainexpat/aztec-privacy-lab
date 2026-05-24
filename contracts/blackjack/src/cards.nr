// Blackjack card scoring helpers. Kept in a sibling module so the #[aztec]
// contract macro doesn't treat them as entry-point functions.

// Blackjack value of a card 0..51: rank = card % 13 (0 = Ace, 1..8 = 2..9,
// 9..12 = 10/J/Q/K = 10). Ace returned as 11 here; soft/hard reduction happens
// in hand_total.
pub fn card_base_value(card: Field) -> u8 {
    let rank = (card as u64 % 13) as u8;
    if rank == 0 {
        11 // ace (soft)
    } else if rank <= 8 {
        rank + 1 // 2..9
    } else {
        10 // 10, J, Q, K
    }
}

pub fn is_ace(card: Field) -> bool {
    (card as u64 % 13) == 0
}

// Total a hand with ace soft/hard handling: count aces as 11, then demote to 1
// (subtract 10) while the total is over 21.
pub fn hand_total(cards: [Field; 5], count: u32) -> u8 {
    let mut total: u8 = 0;
    let mut aces: u8 = 0;
    for i in 0..5 {
        if i < count {
            total += card_base_value(cards[i]);
            if is_ace(cards[i]) {
                aces += 1;
            }
        }
    }
    for _ in 0..5 {
        if (total > 21) & (aces > 0) {
            total -= 10;
            aces -= 1;
        }
    }
    total
}
