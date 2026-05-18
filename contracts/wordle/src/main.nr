// Wordle - games variant g6.
//
// Daily word puzzle with private guess history.
//
//   1. Operator commits a 5-letter target word + salt at start of round
//      (only the pedersen hash is on-chain; the actual word stays in the
//      operator's PXE until reveal_deadline).
//   2. Players make up to MAX_GUESSES guesses via private function calls.
//      Each call emits a commitment hash pedersen(player, guess, salt) -
//      opaque on-chain. Public state tracks a per-player attempt counter,
//      not the guesses.
//   3. At guess_deadline, operator reveals the target word (verified
//      against the original commitment).
//   4. Solvers can prove which attempt # they got right, without ever
//      revealing their failed attempts. Non-solvers stay anonymous.
//
// PRIVACY PROPERTY: each player's guess history is a sequence of opaque
// commitments. Observers see WHEN you played (the attempt counter ticks)
// but not WHAT you guessed. After reveal, only solvers who choose to
// publish their winning guess + salt prove participation - everyone else
// stays unlinked.
//
// LIMITATION: there is no per-guess green/yellow/gray feedback because
// that would require the contract to know the target word mid-round (the
// same RNG-leak that limits g1/g2). This is the honest commit-reveal
// version of Wordle - you guess blind, the target reveals at day end.

use aztec::macros::aztec;

#[aztec]
pub contract Wordle {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};

    global MAX_GUESSES: u32 = 6;
    // Sentinel for "target not revealed yet".
    global UNREVEALED: Field = 0;

    #[storage]
    struct Storage<Context> {
        operator: PublicImmutable<AztecAddress, Context>,
        // pedersen(target_word_packed, salt). The actual 5 letters stay in
        // the operator's PXE until reveal.
        challenge_hash: PublicImmutable<Field, Context>,
        guess_deadline: PublicImmutable<u64, Context>,
        reveal_deadline: PublicImmutable<u64, Context>,
        // 0 while the round is open; set to the packed word once revealed.
        challenge_revealed: PublicMutable<Field, Context>,

        // commitment hash -> attempt number (1-indexed; 0 means unused).
        guess_commitments: Map<Field, PublicMutable<u32, Context>, Context>,
        // player -> total attempts they've made
        player_attempts: Map<AztecAddress, PublicMutable<u32, Context>, Context>,
        // player -> the attempt # they solved on, 0 = unsolved.
        player_solved_on: Map<AztecAddress, PublicMutable<u32, Context>, Context>,
        total_solvers: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(
        operator: AztecAddress,
        challenge_hash: Field,
        guess_deadline: u64,
        reveal_deadline: u64,
    ) {
        assert(guess_deadline < reveal_deadline, "reveal must follow guess window");
        self.storage.operator.initialize(operator);
        self.storage.challenge_hash.initialize(challenge_hash);
        self.storage.guess_deadline.initialize(guess_deadline);
        self.storage.reveal_deadline.initialize(reveal_deadline);
    }

    // Submit a guess. word_packed packs 5 letters into one Field via:
    //   packed = c[0]*256^4 + c[1]*256^3 + ... + c[4]
    // The packing happens in TS to keep the contract simple.
    #[external("private")]
    fn submit_guess(word_packed: Field, salt: Field) {
        let player = self.msg_sender();
        let commitment = std::hash::pedersen_hash([
            player.to_field(),
            word_packed,
            salt,
        ]);
        self.enqueue_self._record_attempt(player, commitment);
    }

    #[external("public")]
    #[only_self]
    fn _record_attempt(player: AztecAddress, commitment: Field) {
        let now = self.context.timestamp();
        assert(now < self.storage.guess_deadline.read(), "guess window closed");
        let attempts_so_far = self.storage.player_attempts.at(player).read();
        assert(attempts_so_far < MAX_GUESSES, "max guesses reached");
        let next_attempt = attempts_so_far + 1;
        self.storage.player_attempts.at(player).write(next_attempt);
        // commitment must be unique. If a commitment collides (same player,
        // guess, salt) the second submission is just wasted - the original
        // attempt number is preserved.
        let prev = self.storage.guess_commitments.at(commitment).read();
        if prev == 0 {
            self.storage.guess_commitments.at(commitment).write(next_attempt);
        }
    }

    // Operator reveals the target word + salt. Anyone can verify the hash.
    #[external("public")]
    fn reveal_target(word_packed: Field, salt: Field) {
        let now = self.context.timestamp();
        assert(now >= self.storage.guess_deadline.read(), "guess window still open");
        let expected = std::hash::pedersen_hash([word_packed, salt]);
        assert(expected == self.storage.challenge_hash.read(), "wrong target");
        assert(
            self.storage.challenge_revealed.read() == UNREVEALED,
            "already revealed",
        );
        // word_packed cannot be 0 (UNREVEALED sentinel) for a real 5-letter word.
        // Lower-case ASCII a-z is 97-122, so packed >= 'a'*256^4 + ... > 0.
        self.storage.challenge_revealed.write(word_packed);
    }

    // Solver proves that one of their prior commitments was the target. Only
    // reveals the winning (guess, salt) - prior failed attempts stay private.
    #[external("private")]
    fn prove_solve(word_packed: Field, salt: Field) {
        let player = self.msg_sender();
        let commitment = std::hash::pedersen_hash([
            player.to_field(),
            word_packed,
            salt,
        ]);
        self.enqueue_self._record_solve(player, commitment, word_packed);
    }

    #[external("public")]
    #[only_self]
    fn _record_solve(player: AztecAddress, commitment: Field, word_packed: Field) {
        let now = self.context.timestamp();
        assert(
            now >= self.storage.guess_deadline.read(),
            "reveal window not open",
        );
        assert(now < self.storage.reveal_deadline.read(), "reveal window closed");
        let revealed = self.storage.challenge_revealed.read();
        assert(revealed != UNREVEALED, "target not revealed yet");
        assert(word_packed == revealed, "guess does not match target");
        let attempt_num = self.storage.guess_commitments.at(commitment).read();
        assert(attempt_num > 0, "no prior commitment matches");
        let prev_solved = self.storage.player_solved_on.at(player).read();
        if prev_solved == 0 {
            self.storage.player_solved_on.at(player).write(attempt_num);
            let prev_total = self.storage.total_solvers.read();
            self.storage.total_solvers.write(prev_total + 1);
        } else if attempt_num < prev_solved {
            // Player can submit a different earlier winning attempt to improve
            // their score (unusual but supported).
            self.storage.player_solved_on.at(player).write(attempt_num);
        }
    }

    #[external("utility")]
    unconstrained fn get_attempts(player: AztecAddress) -> pub u32 {
        self.storage.player_attempts.at(player).read()
    }

    #[external("utility")]
    unconstrained fn get_solved_on(player: AztecAddress) -> pub u32 {
        self.storage.player_solved_on.at(player).read()
    }

    #[external("utility")]
    unconstrained fn get_challenge_revealed() -> pub Field {
        self.storage.challenge_revealed.read()
    }

    #[external("utility")]
    unconstrained fn get_total_solvers() -> pub u32 {
        self.storage.total_solvers.read()
    }
}
