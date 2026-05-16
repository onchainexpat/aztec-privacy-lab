// Battleship - games variant g2.
//
// Pay-to-play single-player Battleship. An 8x8 grid (64 cells) holds one
// 3-cell ship placed horizontally. Position is derived from a seed:
//   pos    = pedersen(seed, 1) as u128 % 48
//   start_x = pos % 6
//   start_y = pos / 6
//   ship   = [start_y*8 + start_x + i  for i in 0..3]
//
// PRIVACY MODEL: same as variant g1 (Minesweeper). start_game and fire are
// private function calls, so the player's L2 identity stays hidden, but the
// ship position is derivable from the public seed. The games matrix card
// calls out this limitation.

use aztec::macros::aztec;

#[aztec]
pub contract Battleship {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global BOARD_CELLS: u32 = 64; // 8x8
    global BOARD_WIDTH: u32 = 8;
    global SHIP_LEN: u32 = 3;
    global ENTRY_FEE: u128 = 1000;
    // 8 - SHIP_LEN + 1 = 6 horizontal start positions per row, 8 rows.
    global POS_RANGE: u32 = 48;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        // game_id -> bitmap of cells that have been fired at
        shots_mask: Map<Field, PublicMutable<u128, Context>, Context>,
        // game_id -> total shots fired
        shots_fired: Map<Field, PublicMutable<u8, Context>, Context>,
        // game_id -> hits scored so far (game won when hits == SHIP_LEN)
        hits: Map<Field, PublicMutable<u8, Context>, Context>,
        // game_id -> 0 = active, 1 = won (ship sunk)
        game_status: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress, operator: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.operator.initialize(operator);
    }

    // Caller pays ENTRY_FEE from private balance; returns game_id (= seed).
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
        self.storage.game_status.at(game_id).write(0);
    }

    // Fire at cell `cell_index` (0..63). Caller stays private.
    #[external("private")]
    fn fire(game_id: Field, cell_index: u32) {
        // Derive ship position from seed (game_id) and test hit.
        let pos = (std::hash::pedersen_hash([game_id, 1]) as u128) % (POS_RANGE as u128);
        let start_x = (pos % (6 as u128)) as u32;
        let start_y = (pos / (6 as u128)) as u32;
        let c0 = start_y * BOARD_WIDTH + start_x;
        let c1 = c0 + 1;
        let c2 = c0 + 2;
        let is_hit = (cell_index == c0) | (cell_index == c1) | (cell_index == c2);
        self.enqueue_self._record_fire(game_id, cell_index, is_hit);
    }

    #[external("public")]
    #[only_self]
    fn _record_fire(game_id: Field, cell_index: u32, is_hit: bool) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 0, "game is already over");
        assert(cell_index < BOARD_CELLS, "cell index out of range");

        let mask = self.storage.shots_mask.at(game_id).read();
        let bit: u128 = (1 as u128) << (cell_index as u128);
        assert((mask & bit) == 0, "cell already fired at");
        self.storage.shots_mask.at(game_id).write(mask | bit);

        let shots = self.storage.shots_fired.at(game_id).read();
        self.storage.shots_fired.at(game_id).write(shots + 1);

        if is_hit {
            let hits = self.storage.hits.at(game_id).read();
            let new_hits = hits + 1;
            self.storage.hits.at(game_id).write(new_hits);
            if new_hits == (SHIP_LEN as u8) {
                self.storage.game_status.at(game_id).write(1); // won (sunk)
            }
        }
    }

    #[external("utility")]
    unconstrained fn get_status(game_id: Field) -> pub u8 {
        self.storage.game_status.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_shots_mask(game_id: Field) -> pub u128 {
        self.storage.shots_mask.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_hits(game_id: Field) -> pub u8 {
        self.storage.hits.at(game_id).read()
    }
}

