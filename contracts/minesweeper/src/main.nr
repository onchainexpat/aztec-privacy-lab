// Minesweeper - games variant g1.
//
// Pay-to-play single-player Minesweeper. The contract derives a board from a
// seed = pedersen(player, salt) and stores per-game state in public maps. The
// 5x5 board has 25 cells. A cell is a mine if low 3 bits of
// pedersen(seed, cell_index) == 0 (~12% probability, so ~3 mines per board).
//
// PRIVACY MODEL: start_game and reveal are private functions, so the CALLER's
// L2 identity is hidden from observers. The board itself sits in PUBLIC state
// (the seed is publicly visible) -- the games matrix card honestly calls out
// that anyone can recompute mine positions from the seed. This is a demo of
// "private gameplay against a public board"; production randomness would need
// a VRF oracle.

use aztec::macros::aztec;

#[aztec]
pub contract Minesweeper {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global BOARD_CELLS: u32 = 25; // 5x5
    global ENTRY_FEE: u128 = 1000;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        // game_id (= pedersen seed) -> revealed mask packed into u128
        revealed_mask: Map<Field, PublicMutable<u128, Context>, Context>,
        // game_id -> 0 = active, 1 = won, 2 = lost
        game_status: Map<Field, PublicMutable<u8, Context>, Context>,
        // game_id -> mines hit so far
        mines_hit: Map<Field, PublicMutable<u8, Context>, Context>,
        // game_id -> cells safely revealed
        safe_revealed: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress, operator: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.operator.initialize(operator);
    }

    // Caller pays ENTRY_FEE from their private balance. The seed is also the
    // game_id and is returned so the caller can call reveal() against it.
    #[external("private")]
    fn start_game(salt: Field, authwit_nonce: Field) -> pub Field {
        let player = self.msg_sender();
        let token = self.storage.payment_token.read();
        Token::at(token)
            .transfer_to_public(player, self.address, ENTRY_FEE, authwit_nonce)
            .call(self.context);

        let seed = std::hash::pedersen_hash([player.to_field(), salt]);
        self.enqueue_self._mark_started(seed);
        seed
    }

    #[external("public")]
    #[only_self]
    fn _mark_started(game_id: Field) {
        // status default is 0 = active; this write makes the game discoverable.
        self.storage.game_status.at(game_id).write(0);
    }

    // Reveal cell `cell_index` (0..24). Caller stays private.
    #[external("private")]
    fn reveal(game_id: Field, cell_index: u32) {
        // Compute mine flag from the public seed. The trust caveat (anyone can
        // recompute this) is documented in the games matrix card.
        let cell_hash = std::hash::pedersen_hash([game_id, cell_index as Field]);
        let is_mine = (cell_hash as u128) & 7 == 0;
        self.enqueue_self._record_reveal(game_id, cell_index, is_mine);
    }

    #[external("public")]
    #[only_self]
    fn _record_reveal(game_id: Field, cell_index: u32, is_mine: bool) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 0, "game is already over");
        assert(cell_index < BOARD_CELLS, "cell index out of range");

        let mask = self.storage.revealed_mask.at(game_id).read();
        let bit: u128 = (1 as u128) << (cell_index as u128);
        assert((mask & bit) == 0, "cell already revealed");
        self.storage.revealed_mask.at(game_id).write(mask | bit);

        if is_mine {
            let hits = self.storage.mines_hit.at(game_id).read();
            self.storage.mines_hit.at(game_id).write(hits + 1);
            self.storage.game_status.at(game_id).write(2); // lost
        } else {
            let safe = self.storage.safe_revealed.at(game_id).read();
            self.storage.safe_revealed.at(game_id).write(safe + 1);
        }
    }

    // Claim a win: prove all non-mine cells have been revealed. Caller provides
    // expected_mine_count from off-chain counting; contract re-counts mines via
    // the same seed and verifies safe_revealed == BOARD_CELLS - mine_count.
    #[external("public")]
    fn claim_win(game_id: Field, expected_mine_count: u8) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 0, "game is not active");

        let mut counted: u8 = 0;
        for i in 0..BOARD_CELLS {
            let cell_hash = std::hash::pedersen_hash([game_id, i as Field]);
            if (cell_hash as u128) & 7 == 0 {
                counted += 1;
            }
        }
        assert(counted == expected_mine_count, "wrong mine count");

        let safe = self.storage.safe_revealed.at(game_id).read();
        assert(safe == (BOARD_CELLS as u8) - expected_mine_count, "not all safe cells revealed");
        self.storage.game_status.at(game_id).write(1); // won
    }

    #[external("utility")]
    unconstrained fn get_status(game_id: Field) -> pub u8 {
        self.storage.game_status.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_revealed_mask(game_id: Field) -> pub u128 {
        self.storage.revealed_mask.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_safe_revealed(game_id: Field) -> pub u8 {
        self.storage.safe_revealed.at(game_id).read()
    }
}
