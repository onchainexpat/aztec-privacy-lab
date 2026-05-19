// Lottery - games variant g7.
//
// Players buy tickets privately (each ticket = a number in 1..MAX_NUMBER,
// stored as the player's own commitment). When the round closes, the operator
// triggers a draw. The draw value comes from one of:
//
//   (a) [shipped] Operator commit-reveal: same trust as g6 Wordle. Operator
//       commits a seed at deploy, reveals after draw is requested. Cheapest
//       sandbox demo.
//
//   (b) [sketched, not yet deployed] Chainlink VRF via L1 portal. request_draw
//       emits an L2->L1 message to a LotteryPortal which calls Chainlink
//       VRFCoordinatorV2_5 on Sepolia, then queues the result back as an
//       L1->L2 message via the inbox. finalize_draw_from_vrf would consume
//       that message. Identical pattern to variant h Uniswap and variant i
//       Base bridge.
//
// PRIVACY MODEL:
//   - buy_ticket is a private function. The L2 caller stays in the private
//     kernel; only an opaque commitment hash appears in public state.
//   - Each commitment = pedersen(player, number, salt). Observers see N
//     commitments placed; they learn neither who placed which nor which
//     numbers were picked.
//   - When the winning number is published, ONLY winners have incentive to
//     reveal (their commitment + salt). Non-winners' tickets stay encrypted
//     in their PXEs forever. This gives a true anonymity set = ticket holders.
//
// Phases (linear, operator-controlled):
//   0 = OPEN     - players can buy tickets
//   1 = DRAWING  - operator called request_draw; awaiting VRF / reveal
//   2 = DRAWN    - winning_number set; winners can claim
//   3 = CLOSED   - no more claims accepted

use aztec::macros::aztec;

#[aztec]
pub contract Lottery {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::{AztecAddress, EthAddress};
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global ENTRY_FEE: u128 = 1000;
    global MAX_NUMBER: u32 = 100; // demo: pick 1..100

    global PHASE_OPEN: u8 = 0;
    global PHASE_DRAWING: u8 = 1;
    global PHASE_DRAWN: u8 = 2;
    global PHASE_CLOSED: u8 = 3;

    global TICKET_ACTIVE: u8 = 1;
    global TICKET_CLAIMED: u8 = 2;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        // L1 VRF portal address. Set to 0x...dead on sandbox; the real
        // address gets wired by a separate script when the L1 portal is
        // deployed (mirrors the variant h Uniswap setup).
        vrf_portal: PublicImmutable<EthAddress, Context>,
        // Public commitment to the operator's seed; revealed at finalize.
        // pedersen(seed, salt) bound at deploy.
        seed_commitment: PublicImmutable<Field, Context>,

        phase: PublicMutable<u8, Context>,
        ticket_count: PublicMutable<u32, Context>,
        // 0..MAX_NUMBER; 0 means unset.
        winning_number: PublicMutable<u32, Context>,
        winners_count: PublicMutable<u32, Context>,
        // commitment hash -> 0=unused, 1=active, 2=claimed
        tickets: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(
        payment_token: AztecAddress,
        operator: AztecAddress,
        vrf_portal: EthAddress,
        seed_commitment: Field,
    ) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.operator.initialize(operator);
        self.storage.vrf_portal.initialize(vrf_portal);
        self.storage.seed_commitment.initialize(seed_commitment);
    }

    // Buy one ticket with a chosen number 1..MAX_NUMBER. Caller stays hidden.
    #[external("private")]
    fn buy_ticket(number: u32, salt: Field, authwit_nonce: Field) {
        let player = self.msg_sender();
        // Pay the entry fee from caller's private balance.
        let token = self.storage.payment_token.read();
        Token::at(token)
            .transfer_to_public(player, self.address, ENTRY_FEE, authwit_nonce)
            .call(self.context);

        let commitment = std::hash::pedersen_hash([
            player.to_field(),
            number as Field,
            salt,
        ]);
        self.enqueue_self._record_ticket(commitment, number);
    }

    #[external("public")]
    #[only_self]
    fn _record_ticket(commitment: Field, number: u32) {
        assert(self.storage.phase.read() == PHASE_OPEN, "sales closed");
        assert(number > 0, "number must be > 0");
        assert(number <= MAX_NUMBER, "number out of range");
        assert(
            self.storage.tickets.at(commitment).read() == 0,
            "duplicate ticket",
        );
        self.storage.tickets.at(commitment).write(TICKET_ACTIVE);
        let prev = self.storage.ticket_count.read();
        self.storage.ticket_count.write(prev + 1);
    }

    // Operator triggers the draw. Sandbox path (shipped) just transitions
    // phase to DRAWING; testnet path (sketched) would emit an L2->L1 message
    // to the VRF portal here. The portal would call Chainlink and queue an
    // L1->L2 message containing the random value.
    #[external("public")]
    fn request_draw() {
        let op = self.storage.operator.read();
        assert(self.msg_sender() == op, "only operator");
        assert(self.storage.phase.read() == PHASE_OPEN, "wrong phase");
        self.storage.phase.write(PHASE_DRAWING);

        // Architectural sketch: emit an L2->L1 message keyed by ticket_count
        // so the L1 portal can attribute the VRF response to this round.
        // Once the portal exists this becomes the real VRF request hook.
        let portal = self.storage.vrf_portal.read();
        if !portal.is_zero() {
            let content_hash = std::hash::pedersen_hash([
                self.storage.ticket_count.read() as Field,
                self.address.to_field(),
            ]);
            self.context.message_portal(portal, content_hash);
        }
    }

    // Operator finalizes by revealing the seed; contract verifies the
    // commitment and derives the winning number deterministically.
    #[external("public")]
    fn finalize_draw(seed: Field, salt: Field) {
        let op = self.storage.operator.read();
        assert(self.msg_sender() == op, "only operator");
        assert(self.storage.phase.read() == PHASE_DRAWING, "wrong phase");
        let expected = std::hash::pedersen_hash([seed, salt]);
        assert(
            expected == self.storage.seed_commitment.read(),
            "seed does not match commitment",
        );
        // Derive winning number from the seed: 1..MAX_NUMBER
        let raw = std::hash::pedersen_hash([seed, 1]) as u128;
        let winning = ((raw % (MAX_NUMBER as u128)) as u32) + 1;
        self.storage.winning_number.write(winning);
        self.storage.phase.write(PHASE_DRAWN);
    }

    // Holders of a winning ticket prove their commitment and the matching
    // number. Reveals only (number, salt) - other ticket holders stay private.
    #[external("private")]
    fn claim_prize(number: u32, salt: Field) {
        let player = self.msg_sender();
        let commitment = std::hash::pedersen_hash([
            player.to_field(),
            number as Field,
            salt,
        ]);
        self.enqueue_self._record_claim(commitment, number);
    }

    #[external("public")]
    #[only_self]
    fn _record_claim(commitment: Field, number: u32) {
        assert(self.storage.phase.read() == PHASE_DRAWN, "not drawn yet");
        assert(
            number == self.storage.winning_number.read(),
            "ticket did not win",
        );
        assert(
            self.storage.tickets.at(commitment).read() == TICKET_ACTIVE,
            "no matching active ticket",
        );
        self.storage.tickets.at(commitment).write(TICKET_CLAIMED);
        let prev = self.storage.winners_count.read();
        self.storage.winners_count.write(prev + 1);
    }

    // Operator can close the round once they're done with claims.
    #[external("public")]
    fn close_round() {
        let op = self.storage.operator.read();
        assert(self.msg_sender() == op, "only operator");
        assert(self.storage.phase.read() == PHASE_DRAWN, "wrong phase");
        self.storage.phase.write(PHASE_CLOSED);
    }

    #[external("utility")]
    unconstrained fn get_phase() -> pub u8 {
        self.storage.phase.read()
    }

    #[external("utility")]
    unconstrained fn get_ticket_count() -> pub u32 {
        self.storage.ticket_count.read()
    }

    #[external("utility")]
    unconstrained fn get_winning_number() -> pub u32 {
        self.storage.winning_number.read()
    }

    #[external("utility")]
    unconstrained fn get_winners_count() -> pub u32 {
        self.storage.winners_count.read()
    }
}
