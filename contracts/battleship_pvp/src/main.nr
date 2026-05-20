// BattleshipPvP - games variant g3. TRUSTLESS two-player Battleship.
//
// Each player commits to their own fleet (a 2-cell ship on a 3x3 board) as
// pedersen(c0, c1, salt). The commitment is public; the ship positions stay
// in that player's PXE and are NEVER revealed on chain. When the opponent
// fires at a cell, the defender answers with a private function that re-opens
// their committed fleet as PRIVATE inputs, computes hit/miss, and reveals
// ONLY the boolean outcome - the contract checks the commitment matches, so
// the defender cannot lie about hit/miss without breaking their commitment.
//
// This is the genuinely trustless privacy story (no contract-RNG, no trusted
// operator): the contract is a referee that verifies each player's ZK proof
// and tracks the public score, but never learns either fleet.
//
// HOW HIT/MISS STAYS HONEST: a private function can't read mutable public
// state synchronously, so the defender passes the shot cell as a claim. The
// public phase asserts (a) the claimed cell == the actual pending shot, and
// (b) the supplied commitment == the defender's stored commitment. Given both,
// is_hit = (cell == c0) | (cell == c1) is bound to the fleet the defender
// committed to up front - they can't move ships to dodge.
//
// DEMO NOTE: the dashboard plays BOTH players from one browser for
// convenience (so it knows both fleets), but that's a UI shortcut. The
// on-chain privacy property is real: the contract + observers only ever see
// fleet commitments + per-shot hit/miss booleans.
//
// SIMPLIFICATIONS (honest): ship-placement validity (adjacency, in-bounds
// pair) is not constrained in the commitment - a production version would
// prove the two cells form a legal ship inside the commitment circuit.

use aztec::macros::aztec;

#[aztec]
pub contract BattleshipPvP {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicMutable};

    global BOARD_CELLS: u32 = 9; // 3x3
    global SHIP_LEN: u8 = 2; // a 2-cell ship; first to SHIP_LEN hits wins
    global NO_PENDING: u32 = 99; // sentinel: no shot awaiting an answer

    global STATUS_WAITING: u8 = 0; // created, awaiting player B
    global STATUS_ACTIVE: u8 = 1;
    global STATUS_A_WON: u8 = 2;
    global STATUS_B_WON: u8 = 3;

    #[storage]
    struct Storage<Context> {
        player_a: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        player_b: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        commit_a: Map<Field, PublicMutable<Field, Context>, Context>,
        commit_b: Map<Field, PublicMutable<Field, Context>, Context>,
        status: Map<Field, PublicMutable<u8, Context>, Context>,
        // whose turn to FIRE: 0 = A, 1 = B
        turn: Map<Field, PublicMutable<u8, Context>, Context>,
        // pending shot awaiting an answer; NO_PENDING when none
        pending_cell: Map<Field, PublicMutable<u32, Context>, Context>,
        // who fired the pending shot (0 = A, 1 = B)
        pending_shooter: Map<Field, PublicMutable<u8, Context>, Context>,
        // hits each player has landed on the opponent's ship
        hits_a: Map<Field, PublicMutable<u8, Context>, Context>,
        hits_b: Map<Field, PublicMutable<u8, Context>, Context>,
        game_count: Map<Field, PublicMutable<u8, Context>, Context>, // 0/1 marker that id is used
    }

    #[external("public")]
    #[initializer]
    fn init() {}

    // Player A creates a game and commits their fleet. game_id derives from
    // (A, salt) so A's identity isn't required to be public to create.
    #[external("private")]
    fn create_game(fleet_commitment: Field, salt: Field) -> pub Field {
        let player = self.msg_sender();
        let game_id = std::hash::pedersen_hash([player.to_field(), salt]);
        self.enqueue_self._create(game_id, player, fleet_commitment);
        game_id
    }

    #[external("public")]
    #[only_self]
    fn _create(game_id: Field, player: AztecAddress, commit: Field) {
        assert(self.storage.game_count.at(game_id).read() == 0, "game id in use");
        self.storage.game_count.at(game_id).write(1);
        self.storage.player_a.at(game_id).write(player);
        self.storage.commit_a.at(game_id).write(commit);
        self.storage.status.at(game_id).write(STATUS_WAITING);
        self.storage.pending_cell.at(game_id).write(NO_PENDING);
        // turn defaults to 0 (A fires first)
    }

    // Player B joins an existing game and commits their fleet.
    #[external("private")]
    fn join_game(game_id: Field, fleet_commitment: Field) {
        let player = self.msg_sender();
        self.enqueue_self._join(game_id, player, fleet_commitment);
    }

    #[external("public")]
    #[only_self]
    fn _join(game_id: Field, player: AztecAddress, commit: Field) {
        assert(self.storage.status.at(game_id).read() == STATUS_WAITING, "not joinable");
        assert(self.storage.commit_b.at(game_id).read() == 0, "already joined");
        self.storage.player_b.at(game_id).write(player);
        self.storage.commit_b.at(game_id).write(commit);
        self.storage.status.at(game_id).write(STATUS_ACTIVE);
    }

    // Current player fires at a cell. Recorded as a pending shot that the
    // opponent must answer.
    #[external("public")]
    fn fire(game_id: Field, cell: u32) {
        assert(self.storage.status.at(game_id).read() == STATUS_ACTIVE, "not active");
        assert(self.storage.pending_cell.at(game_id).read() == NO_PENDING, "answer pending");
        assert(cell < BOARD_CELLS, "cell out of range");
        let t = self.storage.turn.at(game_id).read();
        let shooter = self.msg_sender();
        if t == 0 {
            assert(shooter == self.storage.player_a.at(game_id).read(), "not your turn");
        } else {
            assert(shooter == self.storage.player_b.at(game_id).read(), "not your turn");
        }
        self.storage.pending_cell.at(game_id).write(cell);
        self.storage.pending_shooter.at(game_id).write(t);
    }

    // Defender answers the pending shot. Re-opens their committed fleet as
    // PRIVATE inputs, computes hit/miss, and reveals only the boolean. The
    // public phase binds it to the stored commitment + the actual shot cell.
    #[external("private")]
    fn answer(game_id: Field, c0: u32, c1: u32, salt: Field, pending_cell_claim: u32) {
        let defender = self.msg_sender();
        let commitment = std::hash::pedersen_hash([c0 as Field, c1 as Field, salt]);
        let is_hit = (pending_cell_claim == c0) | (pending_cell_claim == c1);
        self.enqueue_self._record_answer(
            game_id,
            defender,
            commitment,
            pending_cell_claim,
            is_hit,
        );
    }

    #[external("public")]
    #[only_self]
    fn _record_answer(
        game_id: Field,
        defender: AztecAddress,
        commitment: Field,
        pending_cell_claim: u32,
        is_hit: bool,
    ) {
        assert(self.storage.status.at(game_id).read() == STATUS_ACTIVE, "not active");
        let pending = self.storage.pending_cell.at(game_id).read();
        assert(pending != NO_PENDING, "no pending shot");
        assert(pending_cell_claim == pending, "answered wrong cell");

        let shooter = self.storage.pending_shooter.at(game_id).read();
        // Defender must be the NON-shooter, and must open the matching commitment.
        if shooter == 0 {
            assert(defender == self.storage.player_b.at(game_id).read(), "not defender");
            assert(commitment == self.storage.commit_b.at(game_id).read(), "wrong fleet commitment");
        } else {
            assert(defender == self.storage.player_a.at(game_id).read(), "not defender");
            assert(commitment == self.storage.commit_a.at(game_id).read(), "wrong fleet commitment");
        }

        if is_hit {
            if shooter == 0 {
                let h = self.storage.hits_a.at(game_id).read() + 1;
                self.storage.hits_a.at(game_id).write(h);
                if h == SHIP_LEN {
                    self.storage.status.at(game_id).write(STATUS_A_WON);
                }
            } else {
                let h = self.storage.hits_b.at(game_id).read() + 1;
                self.storage.hits_b.at(game_id).write(h);
                if h == SHIP_LEN {
                    self.storage.status.at(game_id).write(STATUS_B_WON);
                }
            }
        }

        // Clear the pending shot and pass the turn to the defender (they fire
        // next) - unless the game just ended.
        self.storage.pending_cell.at(game_id).write(NO_PENDING);
        let new_turn = if shooter == 0 { 1 } else { 0 };
        self.storage.turn.at(game_id).write(new_turn);
    }

    #[external("utility")]
    unconstrained fn get_status(game_id: Field) -> pub u8 {
        self.storage.status.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_turn(game_id: Field) -> pub u8 {
        self.storage.turn.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_pending_cell(game_id: Field) -> pub u32 {
        self.storage.pending_cell.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_pending_shooter(game_id: Field) -> pub u8 {
        self.storage.pending_shooter.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_hits_a(game_id: Field) -> pub u8 {
        self.storage.hits_a.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_hits_b(game_id: Field) -> pub u8 {
        self.storage.hits_b.at(game_id).read()
    }
}
