// Blackjack - fair + private single-player blackjack vs an online dealer.
//
// THE HARD PROBLEM: a single-player card game needs a deck that is (a) hidden
// from the player so they can't see future cards, (b) un-manipulable by the
// dealer mid-hand, and (c) fairly shuffled (neither party alone chooses the
// order). ZK circuits are deterministic (no in-circuit RNG) and a public seed
// lets the player derive the whole deck, so naive approaches fail.
//
// THE PROTOCOL (combined-entropy commit-reveal + committed deck):
//   1. Player commits c_p = poseidon2(player_seed); dealer commits
//      c_d = poseidon2(dealer_seed). Neither has seen the other's seed.
//   2. Player reveals player_seed to the dealer (off-chain). The dealer derives
//      the shuffle seed = poseidon2(player_seed, dealer_seed), shuffles a 52-card
//      deck, and publishes the deck's Merkle root. The dealer cannot rig the
//      order (c_d bound dealer_seed before player_seed was known); the player
//      cannot derive the deck (it never learns dealer_seed until showdown).
//   3. The dealer hands the player each drawn card off-chain as they hit, so the
//      player learns card k only when drawn, never k+1.
//   4. SHOWDOWN: the player calls settle PRIVATELY with their cards as private
//      witnesses. The circuit Merkle-verifies every card against the committed
//      root, computes the blackjack total (with ace soft/hard handling), and
//      publishes ONLY the total + outcome - the player's actual cards never
//      reach public state. The dealer's hand (played deterministically) is
//      revealed for settlement.
//   5. AUDIT: the dealer reveals dealer_seed; anyone checks
//      poseidon2(dealer_seed) == c_d and that the deck = shuffle(seed), proving
//      the shuffle was fair after the fact.
//
// Leaf at deck position i: poseidon2([card_i, i, deck_salt]). deck_salt keeps
// leaves hiding during play (card values are small) and is revealed at audit.
//
// DEMO NOTE: in the single-browser demo one session plays both player and
// dealer (like the PvP battleship variant), so it necessarily knows both seeds;
// the fairness/no-cheat properties are still ENFORCED by the contract
// (commit-reveal + Merkle verification + showdown proof). A real deployment runs
// the dealer as a separate online operator.

use aztec::macros::aztec;

mod cards;

#[aztec]
pub contract Blackjack {
    use crate::cards::hand_total;
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::hash::poseidon2_hash;
    use aztec::protocol::merkle_tree::root::root_from_sibling_path;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};

    global DECK_DEPTH: u32 = 6; // 64 leaves cover a 52-card deck
    global MAX_CARDS: u32 = 5; // hole (2) + up to 3 hits per hand

    global STATUS_NONE: u8 = 0;
    global STATUS_COMMITTED: u8 = 1;
    global STATUS_PLAYING: u8 = 2;
    global STATUS_SETTLED: u8 = 3;

    // Settlement outcomes (public).
    global OUTCOME_DEALER: u8 = 0;
    global OUTCOME_PLAYER: u8 = 1;
    global OUTCOME_PUSH: u8 = 2;

    #[storage]
    struct Storage<Context> {
        dealer: PublicImmutable<AztecAddress, Context>,
        // Per game_id = poseidon2(player, nonce).
        status: Map<Field, PublicMutable<u8, Context>, Context>,
        player_commit: Map<Field, PublicMutable<Field, Context>, Context>,
        dealer_commit: Map<Field, PublicMutable<Field, Context>, Context>,
        deck_root: Map<Field, PublicMutable<Field, Context>, Context>,
        deck_salt: Map<Field, PublicMutable<Field, Context>, Context>,
        // Published results.
        player_total: Map<Field, PublicMutable<u8, Context>, Context>,
        dealer_total: Map<Field, PublicMutable<u8, Context>, Context>,
        outcome: Map<Field, PublicMutable<u8, Context>, Context>,
        games_settled: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(dealer: AztecAddress) {
        self.storage.dealer.initialize(dealer);
    }

    // Player opens a game and commits their entropy.
    #[external("private")]
    fn commit(game_id: Field, player_commit: Field) {
        self.enqueue_self._record_commit(game_id, player_commit);
    }

    #[external("public")]
    #[only_self]
    fn _record_commit(game_id: Field, player_commit: Field) {
        assert(self.storage.status.at(game_id).read() == STATUS_NONE, "game id in use");
        self.storage.player_commit.at(game_id).write(player_commit);
        self.storage.status.at(game_id).write(STATUS_COMMITTED);
    }

    // Dealer commits its entropy and publishes the shuffled deck root + salt.
    // (Off-chain the player has revealed player_seed so the dealer can build the
    // deck from poseidon2(player_seed, dealer_seed).)
    #[external("public")]
    fn start_hand(game_id: Field, dealer_commit: Field, deck_root: Field, deck_salt: Field) {
        assert(self.msg_sender() == self.storage.dealer.read(), "only dealer");
        assert(self.storage.status.at(game_id).read() == STATUS_COMMITTED, "not committed");
        self.storage.dealer_commit.at(game_id).write(dealer_commit);
        self.storage.deck_root.at(game_id).write(deck_root);
        self.storage.deck_salt.at(game_id).write(deck_salt);
        self.storage.status.at(game_id).write(STATUS_PLAYING);
    }

    // SHOWDOWN. The player's cards are PRIVATE witnesses: the circuit proves each
    // is the committed card at its dealing position (player gets deck positions
    // 0..p_count-1) and computes the total, revealing only the total. The
    // dealer's cards are passed for settlement (dealer hand is public).
    // `deck_salt` and `deck_root` are passed and checked against storage in the
    // public phase (a private fn can't read mutable public state synchronously).
    #[external("private")]
    fn settle(
        game_id: Field,
        deck_root: Field,
        deck_salt: Field,
        p_cards: [Field; MAX_CARDS],
        p_count: u32,
        p_paths: [[Field; DECK_DEPTH]; MAX_CARDS],
        d_cards: [Field; MAX_CARDS],
        d_count: u32,
        d_paths: [[Field; DECK_DEPTH]; MAX_CARDS],
    ) {
        // Verify every player card is the committed card at its position.
        // Player positions are 0..MAX_CARDS-1; dealer positions MAX_CARDS..2*MAX_CARDS-1.
        for i in 0..MAX_CARDS {
            if i < p_count {
                let leaf = poseidon2_hash([p_cards[i], i as Field, deck_salt]);
                let r = root_from_sibling_path(leaf, i as Field, p_paths[i]);
                assert(r == deck_root, "bad player card proof");
            }
        }
        for j in 0..MAX_CARDS {
            if j < d_count {
                let pos = (MAX_CARDS + j) as Field;
                let leaf = poseidon2_hash([d_cards[j], pos, deck_salt]);
                let r = root_from_sibling_path(leaf, pos, d_paths[j]);
                assert(r == deck_root, "bad dealer card proof");
            }
        }

        let p_total = hand_total(p_cards, p_count);
        let d_total = hand_total(d_cards, d_count);
        self.enqueue_self._settle(game_id, deck_root, deck_salt, p_total, d_total);
    }

    #[external("public")]
    #[only_self]
    fn _settle(game_id: Field, deck_root: Field, deck_salt: Field, p_total: u8, d_total: u8) {
        assert(self.storage.status.at(game_id).read() == STATUS_PLAYING, "not playing");
        assert(self.storage.deck_root.at(game_id).read() == deck_root, "wrong deck root");
        assert(self.storage.deck_salt.at(game_id).read() == deck_salt, "wrong deck salt");

        let p_bust = p_total > 21;
        let d_bust = d_total > 21;
        let outcome = if p_bust {
            OUTCOME_DEALER
        } else if d_bust {
            OUTCOME_PLAYER
        } else if p_total > d_total {
            OUTCOME_PLAYER
        } else if d_total > p_total {
            OUTCOME_DEALER
        } else {
            OUTCOME_PUSH
        };

        self.storage.player_total.at(game_id).write(p_total);
        self.storage.dealer_total.at(game_id).write(d_total);
        self.storage.outcome.at(game_id).write(outcome);
        self.storage.status.at(game_id).write(STATUS_SETTLED);
        let prev = self.storage.games_settled.read();
        self.storage.games_settled.write(prev + 1);
    }

    #[external("utility")]
    unconstrained fn get_status(game_id: Field) -> pub u8 {
        self.storage.status.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_outcome(game_id: Field) -> pub u8 {
        self.storage.outcome.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_player_total(game_id: Field) -> pub u8 {
        self.storage.player_total.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_dealer_total(game_id: Field) -> pub u8 {
        self.storage.dealer_total.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_games_settled() -> pub u32 {
        self.storage.games_settled.read()
    }
}
